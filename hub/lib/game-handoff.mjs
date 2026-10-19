// The owner's game handoff: the one switch that lets the conductor operate the
// game (state/studio/game-operator.json). Handing over is refused unless every
// check passes at that moment; taking it back ends any running game turn first,
// so its lease is settled (unresolved when it made world requests).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGameLease } from './game-lease.mjs';
import { createPlaytestClient } from './playtest.mjs';

// Advertised by the companion's fixed studio generation command
// (companion/lib/studio-generation.mjs, Codex's route).
export const GENERATION_CAPABILITY = 'studio_native_generation_v1';
const CHECK_TTL_MS = 10000;
const bad = (m, statusCode = 409) => Object.assign(new Error(m), { statusCode });

async function companionHealth(port = 8142) {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error(`Companion health answered ${r.status}`);
  const text = await r.text();
  if (text.length > 65536) throw Error('Companion health is too large');
  return JSON.parse(text);
}

export function createGameHandoff({ root, conductor, readHealth = () => companionHealth(), readGame = () => createPlaytestClient().status(), lease = createGameLease(root), now = Date.now }) {
  const file = join(root, 'state/studio/game-operator.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return { conductor: false }; } };
  const write = v => { mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(v, null, 2) + '\n'); renameSync(file + '.tmp', file); };
  let cached = null;

  // Each check says what it proves; none is assumed when its source cannot be read.
  async function checks({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < CHECK_TTL_MS) return cached.list;
    const list = [];
    try {
      const h = await readHealth(), caps = Array.isArray(h?.local_command_capabilities) ? h.local_command_capabilities : [];
      list.push({ id: 'route', ok: caps.includes(GENERATION_CAPABILITY), label: 'Companion offers the fixed studio generation command', detail: caps.includes(GENERATION_CAPABILITY) ? GENERATION_CAPABILITY : 'not advertised: the reviewed route is not installed' });
    } catch (e) { list.push({ id: 'route', ok: false, label: 'Companion offers the fixed studio generation command', detail: `companion unreachable: ${e.message}` }); }
    try {
      const g = await readGame();
      list.push({ id: 'game', ok: g?.ready === true, label: 'Game mailbox is live in a loaded save', detail: g?.ready ? `${g.session ?? 'save'} · revision ${g.revision ?? '?'}` : g?.reason ?? 'not ready' });
    } catch (e) { list.push({ id: 'game', ok: false, label: 'Game mailbox is live in a loaded save', detail: e.message }); }
    let l = null; try { l = lease.current(); } catch (e) { l = { unresolved: true, unresolvedReason: e.message }; }
    list.push({ id: 'transaction', ok: !l, label: 'No game transaction is open or unresolved', detail: !l ? 'clear' : l.unresolved ? `unresolved: ${l.unresolvedReason}` : `leased to ${l.worker} (${l.purpose})` });
    const running = conductor?.status?.().running;
    list.push({ id: 'turn', ok: !running, label: 'No conductor turn is running', detail: running ? `${running.worker}: ${running.kind}` : 'idle' });
    cached = { at: now(), list };
    return list;
  }

  return {
    mayOperate: () => read().conductor === true,
    state: read,
    checks,
    async view() { const s = read(); return { conductorMayOperateGame: s.conductor === true, since: s.at ?? null, checks: await checks() }; },
    // Hand the game to the conductor: every check must pass right now.
    async handOver() {
      const list = await checks({ fresh: true }), failing = list.filter(c => !c.ok);
      if (failing.length) throw bad(`Not handed over: ${failing.map(c => `${c.label} (${c.detail})`).join('; ')}`);
      const record = { conductor: true, at: new Date(now()).toISOString(), by: 'owner', checks: list.map(({ id, detail }) => ({ id, detail })) };
      write(record); cached = null;
      return { conductorMayOperateGame: true, since: record.at };
    },
    // Take it back: refuse new game requests at once, then end any running game turn.
    async takeBack() {
      write({ conductor: false, at: new Date(now()).toISOString(), by: 'owner' }); cached = null;
      const ended = await conductor?.abortGameTurn?.('The owner took game control back') ?? null;
      return { conductorMayOperateGame: false, endedTurn: ended };
    },
  };
}
