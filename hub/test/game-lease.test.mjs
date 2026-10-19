import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGameLease, LEASE_MS } from '../lib/game-lease.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'lease-'));
const LEASE_URL = new URL('../lib/game-lease.mjs', import.meta.url).href;

test('many processes acquire at the same moment: exactly one wins (Codex #656)', async () => {
  const root = fresh();
  // Each child waits for the same start time, then tries once.
  const start = Date.now() + 600;
  const script = `import { createGameLease } from ${JSON.stringify(LEASE_URL)};
    const l = createGameLease(${JSON.stringify(root)}, { mayOperate: () => true });
    while (Date.now() < ${start}) {}
    try { l.acquire({ session: 's' + process.pid, worker: 'codex', purpose: 'race' }); console.log('won'); } catch (e) { console.log('lost'); }`;
  const run = () => new Promise((res, rej) => { const p = spawn(process.execPath, ['--input-type=module', '-e', script]); let out = ''; p.stdout.on('data', d => { out += d; }); p.on('error', rej); p.on('close', () => res(out.trim())); });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(results.filter(r => r === 'won').length, 1, results.join(','));
  assert.equal(results.filter(r => r === 'lost').length, 7);
});

test('a crashed mutex holder does not block forever; a live one is waited for', () => {
  const root = fresh(), lease = createGameLease(root, { mayOperate: () => true });
  mkdirSync(join(root, 'state/studio/game-lease.mutex'), { recursive: true });
  const old = new Date(Date.now() - 60000); utimesSync(join(root, 'state/studio/game-lease.mutex'), old, old);
  assert.equal(lease.acquire({ session: 'a', worker: 'codex', purpose: 'x' }).worker, 'codex');
});

test('an expired lease that made a world request is an unresolved transaction, not free', () => {
  let t = 1000;
  const root = fresh(), lease = createGameLease(root, { mayOperate: () => true, now: () => t });
  const a = lease.acquire({ session: 'a', worker: 'codex', purpose: 'build' });
  lease.record('a', a.token, { id: 'j1', operation: 'generate', outcome: 'submitted' });
  lease.record('a', a.token, { id: 'j1', operation: 'generate', outcome: 'completed', committedActions: 1 });
  t += LEASE_MS + 1;
  assert.throws(() => lease.acquire({ session: 'b', worker: 'codex', purpose: 'build' }), /unresolved game transaction.*expired/);
  assert.equal(lease.current().unresolved, true);
  // An expired lease that only looked is simply free.
  const root2 = fresh(), lease2 = createGameLease(root2, { mayOperate: () => true, now: () => t });
  const c = lease2.acquire({ session: 'c', worker: 'claude', purpose: 'verify' });
  lease2.record('c', c.token, { id: 'k', operation: 'capture', outcome: 'submitted' });
  lease2.record('c', c.token, { id: 'k', operation: 'capture', outcome: 'completed' });
  t += LEASE_MS + 1;
  assert.equal(lease2.acquire({ session: 'd', worker: 'codex', purpose: 'build' }).worker, 'codex');
});

test('a build report closes only a transaction whose outcomes are all known', () => {
  const root = fresh(), lease = createGameLease(root, { mayOperate: () => true });
  const a = lease.acquire({ session: 'a', worker: 'codex', purpose: 'build' });
  lease.record('a', a.token, { id: 'j1', operation: 'generate', outcome: 'submitted' });
  assert.equal(lease.close('a', a.token), 'unresolved');
  assert.match(lease.current().unresolvedReason, /1 game request\(s\) whose outcome is unknown/);
  assert.equal(lease.resolve(), true);
  const b = lease.acquire({ session: 'b', worker: 'codex', purpose: 'build' });
  lease.record('b', b.token, { id: 'j2', operation: 'generate', outcome: 'submitted' });
  lease.record('b', b.token, { id: 'j2', operation: 'generate', outcome: 'completed', committedActions: 1 });
  assert.equal(lease.close('b', b.token), 'released');
  assert.equal(lease.current(), null);
});

test('an unreadable lease record blocks game work until the owner resolves it', () => {
  const root = fresh(), lease = createGameLease(root, { mayOperate: () => true });
  mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(join(root, 'state/studio/game-lease.json'), '{half');
  assert.throws(() => lease.acquire({ session: 'a', worker: 'codex', purpose: 'x' }), /unreadable/);
  assert.equal(lease.resolve(), true);
  assert.equal(lease.acquire({ session: 'a', worker: 'codex', purpose: 'x' }).worker, 'codex');
});
