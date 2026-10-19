// One recorded game owner per build/verify transaction (Codex #647, #652–653).
// - Acquisition is atomic across processes: the lease is a lock directory
//   (state/studio/game-lease.lock) created with mkdir, which only one process
//   can win; an expired lock is taken over by an atomic rename.
// - A lease belongs to one session and carries an opaque token. Every require,
//   renewal, receipt and release must present that token; the public view never
//   shows it.
// - Game requests made under the lease are recorded as receipts. If a turn ends
//   (timeout, Stop, crash) with requests whose outcome or readback was not
//   reported, the lease becomes an UNRESOLVED transaction: no new game work can
//   start until the owner resolves it.
// The lease exists only after Codex's live session hands game control to the
// conductor (game-operator.json).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEASE_MS = 20 * 60000;
const bad = (m, statusCode = 409) => Object.assign(new Error(m), { statusCode });

export function createGameLease(root, { now = Date.now, mayOperate = () => false } = {}) {
  const studio = join(root, 'state/studio'), lock = join(studio, 'game-lease.lock'), file = join(lock, 'lease.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
  const write = v => { writeFileSync(file + '.tmp', JSON.stringify(v, null, 2) + '\n'); renameSync(file + '.tmp', file); };
  const publicView = l => l && { session: l.session, worker: l.worker, purpose: l.purpose, job: l.job, agreedHash: l.agreedHash, proposalHash: l.proposalHash,
    acquiredAt: l.acquiredAt, expiresAt: l.expiresAt, unresolved: !!l.unresolved, unresolvedReason: l.unresolvedReason ?? null, requests: l.requests.length };
  const held = () => { const l = existsSync(lock) ? read() : null; return l && (l.unresolved || l.expiresAt > now()) ? l : null; };
  const check = (session, token) => {
    const l = held();
    if (!l) throw bad('Acquire the game lease (game_lease acquire) before any game request, and keep it until readback is done');
    if (l.unresolved) throw bad(`An unresolved game transaction blocks game work: ${l.unresolvedReason}. The owner must resolve it in the Design studio`);
    if (l.session !== session || l.token !== token) throw bad(`The game is leased to another session (${l.worker}, ${l.purpose}); wait for it to release`);
    return l;
  };
  return {
    current: () => publicView(held()),
    acquire({ session, worker, purpose, job = null, agreedHash = null, proposalHash = null, proposalFile = null }) {
      if (!mayOperate()) throw bad("Codex's live session is operating the game; the lease is available after it hands off");
      mkdirSync(studio, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try { mkdirSync(lock); } // atomic: exactly one process creates it
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const l = read();
          if (l?.unresolved) throw bad(`An unresolved game transaction blocks game work: ${l.unresolvedReason}. The owner must resolve it in the Design studio`);
          if (l && l.expiresAt > now()) throw bad(`The game is leased to ${l.worker} (${l.purpose}) until ${new Date(l.expiresAt).toLocaleTimeString()}`);
          // Expired or half-written: take it over atomically (one renamer wins), then retry.
          const stale = `${lock}.stale-${randomUUID()}`;
          try { renameSync(lock, stale); rmSync(stale, { recursive: true, force: true }); } catch { /* another process took it over first */ }
          continue;
        }
        const lease = { session, worker, purpose: String(purpose ?? 'game work').slice(0, 200), job, agreedHash, proposalHash, proposalFile, token: randomUUID(), acquiredAt: now(), expiresAt: now() + LEASE_MS, requests: [] };
        write(lease);
        return { ...publicView(lease), token: lease.token };
      }
      throw bad('Another session is taking the game lease right now; try again');
    },
    // Every game request presents the session token; the lease is extended while work continues.
    require(session, token) { const l = check(session, token); l.expiresAt = now() + LEASE_MS; write(l); return l; },
    record(session, token, receipt) { const l = check(session, token); l.requests.push({ at: now(), ...receipt }); l.expiresAt = now() + LEASE_MS; write(l); return l.requests.at(-1); },
    receipts(session, token) { return check(session, token).requests.slice(); },
    release(session, token) {
      const l = existsSync(lock) ? read() : null;
      if (!l || l.session !== session || l.token !== token || l.unresolved) return false;
      rmSync(lock, { recursive: true, force: true }); return true;
    },
    // The hub's cleanup when a turn ends without the transaction being reported:
    // a lease with game requests becomes unresolved; an unused one is dropped.
    settleAfterTurn(worker, reason) {
      const l = existsSync(lock) ? read() : null;
      if (!l || l.worker !== worker || l.unresolved) return null;
      if (l.requests.length) { l.unresolved = true; l.unresolvedReason = `${reason}; ${l.requests.length} game request(s) were made and their readback was not reported`; write(l); return 'unresolved'; }
      rmSync(lock, { recursive: true, force: true }); return 'released';
    },
    // The owner's decision after checking the game (Design studio button).
    resolve() { if (!existsSync(lock)) return false; rmSync(lock, { recursive: true, force: true }); return true; },
  };
}
