// One recorded game owner per build/verify transaction (Codex #647, #652–653, #656).
// - The lease is one file (state/studio/game-lease.json). Every read-modify-write
//   happens inside a short mutex (a directory created with mkdir, which only one
//   process can create), so two sessions can never both acquire.
// - A lease belongs to one session and carries an opaque token. Every require,
//   receipt and release must present that token; the public view never shows it.
// - Game requests made under the lease are recorded as receipts. A world-changing
//   request is a transaction: the lease can then only end through a build report
//   whose readback is known. An unknown outcome, an explicit release, an expiry
//   or a turn that ends without that report all leave an UNRESOLVED transaction:
//   no game work starts until the owner checks the game and resolves it.
// The lease exists only after Codex's live session hands game control to the
// conductor (game-operator.json).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEASE_MS = 20 * 60000;
const MUTEX_STALE_MS = 10000, MUTEX_WAIT_MS = 5000;
const bad = (m, statusCode = 409) => Object.assign(new Error(m), { statusCode });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const WORLD = new Set(['generate']); // operations that may change the world or write a native file

// Requests whose outcome nobody knows: submitted with no completion, or reported unknown.
export const openRequests = l => (l?.requests ?? []).filter(r => r.outcome === 'unknown' || (r.outcome === 'submitted' && !l.requests.some(x => x.id === r.id && x.outcome === 'completed')));
const changedWorld = l => (l?.requests ?? []).some(r => WORLD.has(r.operation));

export function createGameLease(root, { now = Date.now, mayOperate = () => false } = {}) {
  const studio = join(root, 'state/studio'), file = join(studio, 'game-lease.json'), mutex = join(studio, 'game-lease.mutex');
  // The critical section only does a few synchronous file operations; a mutex older
  // than MUTEX_STALE_MS belongs to a crashed process and is broken.
  const locked = fn => {
    mkdirSync(studio, { recursive: true });
    const start = Date.now();
    for (;;) {
      try { mkdirSync(mutex); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS) { rmSync(mutex, { recursive: true, force: true }); continue; } } catch { continue; }
        if (Date.now() - start > MUTEX_WAIT_MS) throw bad('The game lease is busy; try again');
        Atomics.wait(sleeper, 0, 0, 15);
      }
    }
    try { return fn(); } finally { rmSync(mutex, { recursive: true, force: true }); }
  };
  const read = () => {
    let text; try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(text.replace(/^﻿/, '')); }
    catch { return { worker: 'unknown', purpose: 'unknown', requests: [], unresolved: true, unresolvedReason: 'The lease record is unreadable', expiresAt: 0 }; }
  };
  const write = v => { writeFileSync(file + '.tmp', JSON.stringify(v, null, 2) + '\n'); renameSync(file + '.tmp', file); };
  const unresolve = (l, reason) => { l.unresolved = true; l.unresolvedReason = reason; write(l); return l; };
  // The lease as it stands now: an expired lease that made world requests is not
  // free, it is an unresolved transaction.
  const effective = () => {
    const l = read();
    if (!l || l.unresolved) return l;
    if (l.expiresAt > now()) return l;
    if (changedWorld(l) || openRequests(l).length) return unresolve(l, `The lease expired with ${l.requests.length} recorded game request(s) and no build report`);
    rmSync(file, { force: true }); return null;
  };
  const publicView = l => l && { session: l.session ?? null, worker: l.worker, purpose: l.purpose, job: l.job ?? null, agreedHash: l.agreedHash ?? null, proposalHash: l.proposalHash ?? null,
    acquiredAt: l.acquiredAt ?? null, expiresAt: l.expiresAt, unresolved: !!l.unresolved, unresolvedReason: l.unresolvedReason ?? null, requests: l.requests.length, open: openRequests(l).length };
  const blocked = l => bad(`An unresolved game transaction blocks game work: ${l.unresolvedReason}. The owner must check the game and resolve it in the Design studio`);
  const mine = (session, token) => {
    const l = effective();
    if (!l) throw bad('Acquire the game lease (game_lease acquire) before any game request, and keep it until readback is done');
    if (l.unresolved) throw blocked(l);
    if (l.session !== session || l.token !== token) throw bad(`The game is leased to another session (${l.worker}, ${l.purpose}); wait for it to release`);
    return l;
  };
  return {
    current: () => locked(() => publicView(effective())),
    acquire({ session, worker, purpose, job = null, agreedHash = null, proposalHash = null, proposalFile = null, blueprintName = null }) {
      if (!mayOperate()) throw bad("Codex's live session is operating the game; the lease is available after it hands off");
      return locked(() => {
        const l = effective();
        if (l?.unresolved) throw blocked(l);
        if (l) throw bad(`The game is leased to ${l.worker} (${l.purpose}) until ${new Date(l.expiresAt).toLocaleTimeString()}`);
        const lease = { session, worker, purpose: String(purpose ?? 'game work').slice(0, 200), job, agreedHash, proposalHash, proposalFile, blueprintName, token: randomUUID(), acquiredAt: now(), expiresAt: now() + LEASE_MS, requests: [] };
        write(lease);
        return { ...publicView(lease), token: lease.token };
      });
    },
    // Every game request presents the session token; the lease is extended while work continues.
    require: (session, token) => locked(() => { const l = mine(session, token); l.expiresAt = now() + LEASE_MS; write(l); return l; }),
    record: (session, token, receipt) => locked(() => { const l = mine(session, token); l.requests.push({ at: now(), ...receipt }); l.expiresAt = now() + LEASE_MS; write(l); return l.requests.at(-1); }),
    // An outcome nobody can know: recorded, and the transaction is unresolved at once.
    unknown: (session, token, receipt, reason) => locked(() => { const l = mine(session, token); l.requests.push({ at: now(), ...receipt, outcome: 'unknown' }); unresolve(l, reason); return 'unresolved'; }),
    receipts: (session, token) => locked(() => mine(session, token).requests.slice()),
    // Explicit release by the owning session. After a world request it is not a way
    // out of the transaction: the lease becomes unresolved instead.
    release: (session, token) => locked(() => {
      const l = read();
      if (!l || l.session !== session || l.token !== token || l.unresolved) return false;
      if (changedWorld(l) || openRequests(l).length) { unresolve(l, `Released without a build report after ${l.requests.length} recorded game request(s)`); return 'unresolved'; }
      rmSync(file, { force: true }); return true;
    }),
    // The build report closes the transaction when every recorded outcome is known.
    close: (session, token) => locked(() => {
      const l = read();
      if (!l || l.session !== session || l.token !== token || l.unresolved) return null;
      const open = openRequests(l);
      if (open.length) { unresolve(l, `The build was reported with ${open.length} game request(s) whose outcome is unknown`); return 'unresolved'; }
      rmSync(file, { force: true }); return 'released';
    }),
    // The hub's cleanup when a turn ends: a lease that made world requests becomes
    // unresolved; an unused or read-only one is dropped.
    settleAfterTurn: (worker, reason) => locked(() => {
      const l = read();
      if (!l || l.worker !== worker) return null;
      if (l.unresolved) return 'unresolved'; // e.g. an unknown outcome during the turn
      if (changedWorld(l) || openRequests(l).length) { unresolve(l, `${reason}; ${l.requests.length} game request(s) were made and no build report closed them`); return 'unresolved'; }
      rmSync(file, { force: true }); return 'released';
    }),
    // The owner's decision after checking the game (Design studio button).
    resolve: () => locked(() => { const had = !!read(); rmSync(file, { force: true }); return had; }),
  };
}
