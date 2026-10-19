// One recorded game owner for a whole build/verify transaction (Codex #647): a
// conductor worker must hold this lease before its first game request and keeps
// it through readback, so two workers can never interleave placement, capture
// and undo. Stored in state/studio/game-lease.json; a lease expires on its own
// if its holder disappears. The lease is only available after Codex's live
// session hands game control to the conductor (game-operator.json).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEASE_MS = 20 * 60000;
const bad = (m, statusCode = 409) => Object.assign(new Error(m), { statusCode });

export function createGameLease(root, { now = Date.now, mayOperate = () => false } = {}) {
  const file = join(root, 'state/studio/game-lease.json');
  const read = () => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : null; } catch { return null; } };
  const write = v => { mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(v, null, 2) + '\n'); renameSync(file + '.tmp', file); };
  const live = () => { const l = read(); return l && l.expiresAt > now() ? l : null; };
  return {
    current: live,
    acquire(owner, { purpose, job = null }) {
      if (!mayOperate()) throw bad("Codex's live session is operating the game; the lease is available after it hands off");
      const held = live();
      if (held && held.owner !== owner) throw bad(`The game is leased to ${held.owner} (${held.purpose}) until ${new Date(held.expiresAt).toLocaleTimeString()}`);
      const lease = { owner, purpose: String(purpose ?? 'game work').slice(0, 200), job, token: held?.owner === owner ? held.token : randomUUID(), acquiredAt: held?.acquiredAt ?? now(), expiresAt: now() + LEASE_MS };
      write(lease);
      return lease;
    },
    // Every game request checks the lease and extends it while work continues.
    require(owner) {
      if (!mayOperate()) throw bad("Codex's live session is operating the game; conductor game requests wait for its handoff");
      const held = live();
      if (!held) throw bad('Acquire the game lease (game_lease with action "acquire") before any game request, and keep it until readback is done');
      if (held.owner !== owner) throw bad(`The game is leased to ${held.owner}; wait for it to release`);
      held.expiresAt = now() + LEASE_MS; write(held);
      return held;
    },
    release(owner) { const held = read(); if (held && held.owner === owner) { write({ ...held, expiresAt: 0, releasedAt: now() }); return true; } return false; },
  };
}
