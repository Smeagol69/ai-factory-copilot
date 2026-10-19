import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPlaytestClient } from '../lib/playtest.mjs';
const NOW = Date.parse('2026-10-17T05:00:00Z');
async function fixture(alter = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'architect-playtest-'));
  const status = { schema: 'aifactory.playtest-status/v1', enabled: true, live_world: true, accepting_requests: true,
    map: 'Persistent_Level', session: 'Test save', world_instance: '12acf222-4321-4234-9234-123456789abc', player: '/Game/Maps/Persistent_Level.PlayerController_4', world_revision: '24', in_flight_id: '', last_tick_game_utc: new Date(NOW).toISOString() };
  alter(status); await writeFile(join(directory, 'status.json'), JSON.stringify(status));
  return { directory, client: createPlaytestClient({ directory, now: () => NOW }) };
}
async function cleanup(directory) { assert(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); await rm(directory, { recursive: true, force: true }); }
test('stale, disabled, missing or busy native state cannot submit a game request', async () => {
  for (const alter of [s => { s.enabled = false; }, s => { s.live_world = false; }, s => { s.accepting_requests = false; s.reason = 'consumed_marker_invalid'; }, s => { delete s.accepting_requests; }, s => { s.last_tick_game_utc = new Date(NOW - 120000).toISOString(); }, s => { s.in_flight_id = 'busy'; }]) {
    const f = await fixture(alter); try { await assert.rejects(f.client.submit({ operation: 'capture' })); await assert.rejects(readFile(join(f.directory, 'request.json'))); } finally { await cleanup(f.directory); }
  }
  const f = await fixture(); try { await rm(join(f.directory, 'status.json')); assert.equal((await f.client.status()).ready, false); } finally { await cleanup(f.directory); }
});
test('a fresh native scope produces one bounded typed request and pending work is never overwritten', async () => {
  const f = await fixture(); try {
    const job = await f.client.submit({ operation: 'askall', question: 'Inspect the current native shell; do not build.' });
    const request = JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8'));
    assert.equal(request.expected_session, 'Test save'); assert.equal(request.expected_map, 'Persistent_Level');
    assert.equal(request.id, job.id); assert.equal(request.schema, 'aifactory.playtest-request/v1');
    assert.equal(request.expected_world_instance, job.worldInstance); assert.equal(request.expected_player, job.player);
    assert.equal(Date.parse(request.expires_at_utc) - NOW, 60000);
    await assert.rejects(f.client.submit({ operation: 'look' }), /pending|unknown/i);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).id, job.id);
    await mkdir(join(f.directory, 'results'));
    await writeFile(join(f.directory, 'results', job.id + '.json'), JSON.stringify({ schema: 'aifactory.playtest-result/v1', id: job.id, operation: 'askall', map: request.expected_map, session: request.expected_session, world_instance: job.worldInstance, player: job.player, terminal: true, accepted: true, state: 'completed', game_actions_refused: true }));
    const result = await f.client.wait(job, { timeoutMs: 50 });
    assert.equal(result.pipelineCompleted, true); assert.equal(result.actionsAccepted, false); assert.equal(result.committedActions, 0);
    assert.notEqual((await f.client.submit({ operation: 'look' })).id, job.id);
  } finally { await cleanup(f.directory); }
});
test('native acceptance and dry runs never claim a committed world change', async () => {
  const f = await fixture(); try {
    const job = await f.client.submit({ operation: 'askall', question: 'Dry run the native foundation placement.' });
    const base = { schema: 'aifactory.playtest-result/v1', id: job.id, operation: job.operation, map: job.map, session: job.session, world_instance: job.worldInstance, player: job.player, terminal: true, state: 'completed', accepted: true };
    await mkdir(join(f.directory, 'results'));
    const receiptPath = join(f.directory, 'results', job.id + '.json');
    await writeFile(receiptPath, JSON.stringify({ ...base, game_world_was_mutated: false, game_action_results: [{ accepted: true, committed: false, dry_run: true }] }));
    const dry = await f.client.wait(job, { timeoutMs: 50 });
    assert.equal(dry.actionsAccepted, true); assert.equal(dry.committedActions, 0); assert.equal(dry.dryRunActions, 1); assert.equal(dry.worldMutationObserved, false); assert.equal(Object.hasOwn(dry, 'actionsSucceeded'), false);
    await writeFile(receiptPath, JSON.stringify({ ...base, game_world_was_mutated: true, game_action_results: [{ accepted: true, committed: true, dry_run: false }] }));
    const real = await f.client.wait(job, { timeoutMs: 50 });
    assert.equal(real.committedActions, 1); assert.equal(real.worldMutationObserved, true);
    for (const changed of [{ world_instance: '21acf222-4321-4234-9234-123456789abc' }, { player: '/Game/Maps/Persistent_Level.PlayerController_7' }]) {
      await writeFile(receiptPath, JSON.stringify({ ...base, ...changed }));
      await assert.rejects(f.client.wait(job, { timeoutMs: 50 }), /scope|identity/i);
    }
  } finally { await cleanup(f.directory); }
});
test('a heartbeat without a loaded-world nonce and player identity is not ready', async () => {
  for (const alter of [s => { delete s.world_instance; }, s => { delete s.player; }, s => { s.world_instance = 'not-a-uuid'; }]) {
    const f = await fixture(alter); try { assert.equal((await f.client.status()).ready, false); await assert.rejects(f.client.submit({ operation: 'capture' })); } finally { await cleanup(f.directory); }
  }
});
test('existing JSON primitives remain unknown requests and are never overwritten', async () => {
  const f = await fixture(); try {
    for (const prior of [null, false, 0, '', [], { id: 'not-a-uuid' }]) {
      const bytes = JSON.stringify(prior);
      await writeFile(join(f.directory, 'request.json'), bytes);
      await assert.rejects(f.client.submit({ operation: 'capture' }), /unknown|preserved/i);
      assert.equal(await readFile(join(f.directory, 'request.json'), 'utf8'), bytes);
    }
  } finally { await cleanup(f.directory); }
});
test('malformed commands, control characters and mismatched native receipts are refused', async () => {
  const f = await fixture(); try {
    for (const input of [{ operation: 'console' }, { operation: 'look', question: 'extra' }, { operation: 'askall', question: 'hello\n/undo' }, { operation: 'askall', question: 'x'.repeat(4001) }, { operation: 'capture', path: 'arbitrary' }]) await assert.rejects(f.client.submit(input));
    const job = await f.client.submit({ operation: 'capture' }); await mkdir(join(f.directory, 'results'));
    await writeFile(join(f.directory, 'results', job.id + '.json'), JSON.stringify({ schema: 'aifactory.playtest-result/v1', id: job.id, operation: job.operation, terminal: true, map: 'other', session: job.session, state: 'completed' }));
    await assert.rejects(f.client.wait(job, { timeoutMs: 50 }), /scope|identity/i);
  } finally { await cleanup(f.directory); }
});
