// The session keeper: a Codex thread working on this project that stopped on a
// subscription usage limit is continued as soon as the limit resets, the way the
// Claude app resumes its own sessions. It reads Codex's session logs
// (~/.codex/sessions), finds project threads whose last turn ended with
// usage_limit_exceeded and nothing since, and after the reset resumes exactly that
// thread through the Codex app server with one "continue" message. It never starts
// new work, never resumes a thread twice for the same stop, and leaves any thread
// that has moved on alone.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { usageLimit } from './conductor.mjs';

export const RESUME_PROMPT = 'Your usage limit has reset. First read the shared ledger messages since you stopped (pair_read_messages): the owner or Claude may have taken over or changed decisions meanwhile. Then continue exactly where you left off: finish the task you were on, keep to the coordination rules (claims, reviews, game ownership) and report as you normally would. The owner is supervising but is not prompting.';
const DAY = 86400000, TAIL_BYTES = 512 * 1024;
const inside = (dir, root) => { const d = resolve(dir).toLowerCase(), r = resolve(root).toLowerCase(); return d === r || d.startsWith(r + '\\') || d.startsWith(r + '/'); };

function recentRollouts(sessionsDir, now, maxAgeMs) {
  const out = [];
  for (let back = 0; back * DAY <= maxAgeMs + DAY; back++) {
    const d = new Date(now - back * DAY), dir = join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = []; try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) { const f = join(dir, n); try { if (now - statSync(f).mtimeMs <= maxAgeMs) out.push(f); } catch { /* gone */ } }
  }
  return [...new Set(out)];
}
const lines = text => text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// One rollout: is it a project thread whose last turn stopped on the usage limit?
export function stalledThread(file, { repo, now = Date.now() } = {}) {
  let head; try { head = lines(readFileSync(file, 'utf8').slice(0, 64 * 1024))[0]; } catch { return null; }
  const meta = head?.type === 'session_meta' ? head.payload : null;
  if (!meta?.id || !meta.cwd || !inside(meta.cwd, repo)) return null;
  // Sub-agent threads belong to their parent: resuming the parent relaunches them.
  if (meta.parent_thread_id || meta.thread_source === 'subagent' || (meta.source && typeof meta.source === 'object' && meta.source.subagent)) return null;
  const size = statSync(file).size, text = readFileSync(file, 'utf8');
  const tail = lines(size > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text);
  let last = null, limits = null;
  for (const e of tail) {
    const p = e.payload ?? {};
    if (e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted', 'user_message'].includes(p.type)) last = e;
    if (e.type === 'event_msg' && p.type === 'token_count' && p.rate_limits) limits = p.rate_limits;
  }
  const err = last?.payload?.error;
  if (last?.payload?.type !== 'task_complete' || !(err?.codex_error_info === 'usage_limit_exceeded' || /usage limit/i.test(err?.message ?? ''))) return null;
  const at = Date.parse(last.timestamp);
  // The reset: the time in the message, or the window the logged limits say is full.
  const times = [usageLimit(err.message, { now: at })?.resetsAt];
  for (const w of [limits?.primary, limits?.secondary]) if (w?.used_percent >= 100 && Number.isFinite(w.resets_at)) times.push(w.resets_at * (w.resets_at < 1e12 ? 1000 : 1));
  const resetsAt = Math.max(...times.filter(Number.isFinite));
  return { threadId: meta.id, cwd: meta.cwd, file, stoppedAt: at, stopOrdinal: last.ordinal ?? null, resetsAt: Number.isFinite(resetsAt) ? resetsAt : at + 15 * 60000, message: String(err.message ?? '').slice(0, 300) };
}

export function findStalled({ repo, sessionsDir = join(homedir(), '.codex', 'sessions'), now = Date.now(), maxAgeMs = DAY } = {}) {
  return recentRollouts(sessionsDir, now, maxAgeMs).map(f => stalledThread(f, { repo, now })).filter(Boolean);
}

export function createSessionKeeper({ root, repo, resume, find = opts => findStalled(opts), now = Date.now, log = () => {}, graceMs = 60000 }) {
  const file = join(root, 'state/studio/session-keeper.json');
  let state = { resumed: [] };
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }; } catch { /* start clean */ }
  const save = () => { mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); renameSync(file + '.tmp', file); };
  const active = new Map(); // threadId → resume in progress
  const key = t => `${t.threadId}:${t.stopOrdinal ?? t.stoppedAt}`;
  let waiting = [];
  async function tick() {
    if (state.enabled === false) { waiting = []; return []; }
    const stalled = find({ repo, now: now() });
    waiting = stalled.filter(t => !state.resumed.some(r => r.key === key(t)) && !active.has(t.threadId)).map(t => ({ threadId: t.threadId, resetsAt: t.resetsAt }));
    const due = stalled.filter(t => t.resetsAt + graceMs <= now() && !active.has(t.threadId) && !state.resumed.some(r => r.key === key(t)));
    for (const t of due) {
      // Recorded before resuming: one resume per stop, even across a hub restart.
      state.resumed = [...state.resumed, { key: key(t), threadId: t.threadId, at: new Date(now()).toISOString() }].slice(-200); save();
      log({ threadId: t.threadId, resumedAfter: t.message });
      const run = Promise.resolve().then(() => resume(t)).catch(e => ({ status: 'failed', text: e.message }))
        .then(r => { state.last = { threadId: t.threadId, status: r?.status ?? 'unknown', text: String(r?.text ?? '').slice(0, 300), at: new Date(now()).toISOString() }; save(); return r; })
        .finally(() => active.delete(t.threadId));
      active.set(t.threadId, run);
    }
    return due.map(t => t.threadId);
  }
  return {
    tick,
    status: () => ({ enabled: state.enabled !== false, resuming: [...active.keys()], waiting, last: state.last ?? null }),
    set(enabled) { state.enabled = !!enabled; save(); return { enabled: state.enabled }; },
    settled: () => Promise.all(active.values()),
  };
}
