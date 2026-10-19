import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameHandoff, GENERATION_CAPABILITY } from '../lib/game-handoff.mjs';
import { createGameLease } from '../lib/game-lease.mjs';

const ROUTE = { local_command_capabilities: ['level_tunnel', GENERATION_CAPABILITY] };
const READY = { ready: true, session: 'bp builder', revision: 1469 };
function setup({ health = ROUTE, game = READY, running = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-')), aborted = [];
  const conductor = { status: () => ({ running }), abortGameTurn: async reason => { aborted.push(reason); return running ? { worker: running.worker, kind: running.kind } : null; } };
  const h = createGameHandoff({ root, conductor, readHealth: async () => { if (health instanceof Error) throw health; return health; }, readGame: async () => game });
  return { root, h, aborted, operator: () => JSON.parse(readFileSync(join(root, 'state/studio/game-operator.json'), 'utf8')) };
}

test('the game is handed over only when every readiness check passes, and the record says what was checked', async () => {
  const { h, operator } = setup();
  assert.equal(h.mayOperate(), false, 'off until the owner hands over');
  const r = await h.handOver();
  assert.equal(r.conductorMayOperateGame, true);
  assert.equal(operator().by, 'owner');
  assert.deepEqual(operator().checks.map(c => c.id), ['route', 'game', 'transaction', 'turn']);
  assert.equal(h.mayOperate(), true);
});

test('no fixed generation command, no handover', async () => {
  const { h } = setup({ health: { local_command_capabilities: ['level_tunnel'] } });
  await assert.rejects(h.handOver(), /fixed studio generation command \(not advertised/);
  assert.equal(h.mayOperate(), false);
  const { h: down } = setup({ health: new Error('connect ECONNREFUSED') });
  await assert.rejects(down.handOver(), /companion unreachable: connect ECONNREFUSED/);
});

test('no live game, an open or unresolved transaction, or a running turn each refuse the handover', async () => {
  await assert.rejects(setup({ game: { ready: false, reason: 'Native mailbox is disabled' } }).h.handOver(), /Game mailbox is live.*disabled/);
  await assert.rejects(setup({ running: { worker: 'claude', kind: 'critique' } }).h.handOver(), /No conductor turn is running \(claude: critique\)/);
  const { root, h } = setup();
  const lease = createGameLease(root, { mayOperate: () => true }), l = lease.acquire({ session: 's', worker: 'codex', purpose: 'build' });
  lease.unknown('s', l.token, { id: 'j', operation: 'generate' }, 'deadline passed');
  await assert.rejects(h.handOver(), /No game transaction is open or unresolved \(unresolved: deadline passed\)/);
});

test('taking control back refuses new game requests at once and ends a running game turn', async () => {
  const { h, aborted, operator } = setup({ running: null });
  await h.handOver();
  const { h: busy, aborted: busyAborted } = setup({ running: { worker: 'codex', kind: 'build' } });
  const r = await busy.takeBack();
  assert.equal(r.conductorMayOperateGame, false);
  assert.deepEqual(r.endedTurn, { worker: 'codex', kind: 'build' });
  assert.deepEqual(busyAborted, ['The owner took game control back']);
  assert.equal((await h.takeBack()).endedTurn, null);
  assert.equal(operator().conductor, false);
  assert.equal(aborted.length, 1);
});
