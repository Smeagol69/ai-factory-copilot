import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStore } from '../lib/studio-store.mjs';
import { createStudioApi, attachStudio } from '../lib/studio-http.mjs';
import { createGameHandoff, GENERATION_CAPABILITY } from '../lib/game-handoff.mjs';
// Readiness sources stubbed: tests never reach the real companion or game.
const readyHandoff = (root, conductor, health = { local_command_capabilities: [GENERATION_CAPABILITY] }) => createGameHandoff({ root, conductor, readHealth: async () => health, readGame: async () => ({ ready: true, session: 'test', revision: 1 }) });

const F = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const pieces = [{ class_path: F, transform: { translation_cm: { x: 0, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } } }];

test('the studio page and API: brief, conductor switch, game handoff, renders, owner actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-http-')), store = createStudioStore(root);
  let enabled = false, pumps = 0;
  const conductor = { status: () => ({ enabled, running: null, waiting: null }), set: v => { enabled = v; return { enabled }; }, stop: async () => { enabled = false; return { enabled }; } };
  const server = createServer((req, res) => res.end('underlying'));
  attachStudio(server, createStudioApi({ root, store, conductor, pump: () => pumps++, handoff: readyHandoff(root, conductor) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  try {
    assert.match(await (await fetch(base + '/studio')).text(), /Design studio/);
    assert.equal(await (await fetch(base + '/api/status')).text(), 'underlying');
    const job = await (await post('/api/studio/jobs', { brief: 'Sweeping 90 joined to the walled tunnel' })).json();
    assert.deepEqual(job.next, { worker: 'codex', kind: 'candidate' });
    assert.equal(pumps, 1, 'a new brief wakes the conductor');
    store.addCandidate(job.id, 'codex', { title: 'Sweep', rationale: 'r', pieces });
    writeFileSync(join(store.dirOf(job.id), 'candidate-1.png'), Buffer.alloc(2000)); store.setRender(job.id, 1, 'candidate-1.png');
    const full = await (await fetch(`${base}/api/studio/jobs/${job.id}`)).json();
    assert.equal(full.candidates[0].renderUrl, `/api/studio/render/${job.id}/candidate-1.png`);
    const png = await fetch(base + full.candidates[0].renderUrl);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/api/studio/render/${job.id}/..%2Fjob.json`)).status, 404);
    assert.equal((await (await post(`/api/studio/jobs/${job.id}`, { action: 'pick', candidate: 1 })).json()).status, 'agreed');
    assert.equal((await (await post('/api/studio/conductor', { action: 'on' })).json()).enabled, true);
    assert.equal((await (await post('/api/studio/operator', { conductor: true })).json()).conductorMayOperateGame, true);
    const o = await (await fetch(base + '/api/studio')).json();
    assert.equal(o.jobs.length, 1); assert.equal(o.conductorMayOperateGame, true);
    // An unresolved game transaction shows in the overview until the owner resolves it.
    const { createGameLease } = await import('../lib/game-lease.mjs');
    const lease = createGameLease(root, { mayOperate: () => true }), l = lease.acquire({ session: 'conductor-codex:s', worker: 'codex', purpose: 'build' });
    lease.record('conductor-codex:s', l.token, { id: 'j1', operation: 'askall', outcome: 'submitted' });
    assert.equal(lease.settleAfterTurn('codex', 'Turn timed out'), 'unresolved');
    assert.equal((await (await fetch(base + '/api/studio')).json()).gameLease.unresolved, true);
    assert.equal((await (await post('/api/studio/conductor', { action: 'resolve-game' })).json()).resolved, true);
    assert.equal((await (await fetch(base + '/api/studio')).json()).gameLease, null);
    assert.equal((await post('/api/studio/jobs', { brief: 'x' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/studio/jobs', { brief: '' })).status, 400);
  } finally { server.close(); }
});

test('the studio shows milestone work and team work waiting for master; the owner merges and resumes', async () => {
  const { createMilestoneWork } = await import('../lib/milestone-work.mjs');
  const root = mkdtempSync(join(tmpdir(), 'studio-mw-')), store = createStudioStore(root), work = createMilestoneWork(root);
  const job = work.create({ milestone: { id: 'm1', title: 'Lighting' } });
  work.reportStep(job.id, 'codex', { summary: 'BeamLength for beams', commit: 'abcdef1' });
  let merged = 0, pumps = 0;
  const conductor = { status: () => ({ enabled: true, running: null, waiting: null }), set: () => ({}), stop: async () => ({}) };
  const server = createServer((req, res) => res.end('x'));
  attachStudio(server, createStudioApi({ root, store, conductor, work, pump: () => pumps++, handoff: readyHandoff(root, conductor),
    teamPending: async () => ['abc1234 Milestone step 1 by Codex, reviewed by Claude'], mergeTeam: async () => ({ merged: ++merged, mergeCommit: 'f00' }) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const o = await (await fetch(base + '/api/studio')).json();
    assert.equal(o.milestoneWork.milestone.title, 'Lighting');
    assert.deepEqual(o.milestoneWork.next, { worker: 'claude', kind: 'review', step: 1 });
    assert.equal(o.teamPending.length, 1);
    assert.equal((await (await post('/api/studio/team-merge', {})).json()).merged, 1);
    assert.equal((await (await post('/api/studio/milestone-work', { action: 'stop' })).json()).status, 'stopped');
    assert.equal((await (await post('/api/studio/milestone-work', { action: 'resume' })).json()).resumed, true);
    assert.equal(work.list()[0].status, 'closed', 'a fresh job takes over on the next turn');
    assert.equal(pumps, 1);
  } finally { server.close(); }
});
