import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioGateway, newestSave } from '../lib/studio-gateway.mjs';

const F = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const pieces = n => Array.from({ length: n }, (_, i) => ({ class_path: F, transform: { translation_cm: { x: i * 800, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } } }));
const fakeRender = async (p, file) => { writeFileSync(file, 'png'); return { file, pieces: p.length, skipped: 0 }; };

function setup(worker, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gw-')), root = join(home, 'hub'), repo = home;
  mkdirSync(root, { recursive: true });
  return { home, root, repo, gw: createStudioGateway({ root, repo, worker, render: fakeRender, ...extra }) };
}

test('two workers take turns through the gateway and see what is next', async () => {
  const { root, repo, gw: codex } = setup('codex');
  const claude = createStudioGateway({ root, repo, worker: 'claude', render: fakeRender });
  const job = codex.store.create({ brief: 'Sweeping turn' });
  const c1 = await codex.dispatch('studio_post_candidate', { title: 'Sweep A', rationale: 'from the walled tunnel', pieces: pieces(3) });
  assert.equal(c1.candidate, 1);
  assert.ok(c1.render_png.endsWith('candidate-1.png'));
  assert.deepEqual(c1.next, { worker: 'claude', kind: 'critique', candidate: 1 });
  const view = await claude.dispatch('studio_job', {});
  assert.equal(view.id, job.id);
  assert.ok(existsSync(view.candidates[0].render_png));
  assert.ok(existsSync(view.candidates[0].pieces_file));
  const r = await claude.dispatch('studio_post_critique', { candidate: 1, verdict: 'agree', critique: 'Clean joints' });
  assert.equal(r.status, 'agreed');
});

test('pieces can come from a file inside the repo, never from outside it', async () => {
  const { repo, gw } = setup('claude');
  gw.store.create({ brief: 'x' });
  writeFileSync(join(repo, 'draft.json'), JSON.stringify({ pieces: pieces(2) }));
  const draft = await gw.dispatch('studio_render', { pieces_file: 'draft.json', title: 'Draft' });
  assert.equal(draft.pieces, 2);
  const outside = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'p.json'); writeFileSync(outside, '[]');
  await assert.rejects(gw.dispatch('studio_render', { pieces_file: outside }), /inside the repo/);
  await assert.rejects(gw.dispatch('studio_nope', {}), /Unknown studio tool/);
});

test('a saved blueprint becomes a reference piece list', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-')), bpDir = join(home, 'blueprints', 'Bp Builder');
  mkdirSync(bpDir, { recursive: true }); writeFileSync(join(bpDir, 'walled tunnel.sbp'), 'sbp');
  const { gw } = setup('codex', { blueprintDir: join(home, 'blueprints'),
    inspectSaved: async () => ({ header: { designer_dimensions: { x: 4, y: 2, z: 1 } }, reference_traits: { poses: pieces(5) } }) });
  const r = await gw.dispatch('studio_read_blueprint', { name: 'Walled Tunnel' });
  assert.equal(r.pieces, 5);
  assert.equal(JSON.parse(readFileSync(r.pieces_file, 'utf8')).pieces.length, 5);
  await assert.rejects(gw.dispatch('studio_read_blueprint', { name: '../secret' }), /without a path/);
  await assert.rejects(gw.dispatch('studio_read_blueprint', { name: 'missing' }), /No saved blueprint/);
});

test('asking the game backs up the newest save first, logs, and refuses without a save', async () => {
  const saves = mkdtempSync(join(tmpdir(), 'saves-')), user = join(saves, '7656');
  mkdirSync(user); writeFileSync(join(user, 'old.sav'), 'old'); writeFileSync(join(user, 'new.sav'), 'new');
  utimesSync(join(user, 'old.sav'), new Date(2020, 1, 1), new Date(2020, 1, 1));
  assert.equal(newestSave(saves), join(user, 'new.sav'));
  const calls = [];
  const playtest = { status: async () => ({ ready: true }), submit: async i => { calls.push(i); return { id: 'job-1' }; }, wait: async () => ({ pipelineCompleted: true, committedActions: 1, worldMutationObserved: true }) };
  const { root, gw } = setup('codex', { playtest, saveDir: saves, mayOperate: () => true });
  await assert.rejects(gw.dispatch('game_ask', { question: 'x' }), /Acquire the game lease/);
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build AI Sweep B' });
  const r = await gw.dispatch('game_ask', { question: 'Generate native blueprint AI Sweep B' });
  assert.equal(readFileSync(r.saveBackup, 'utf8'), 'new');
  assert.deepEqual(calls, [{ operation: 'askall', question: 'Generate native blueprint AI Sweep B' }]);
  assert.match(readFileSync(join(root, 'state/studio/game-actions.jsonl'), 'utf8'), /"worker":"codex".*"question"/);
  const { gw: noSave } = setup('codex', { playtest, saveDir: mkdtempSync(join(tmpdir(), 'empty-')), mayOperate: () => true });
  await noSave.dispatch('game_lease', { action: 'acquire', purpose: 'x' });
  await assert.rejects(noSave.dispatch('game_ask', { question: 'x' }), /No save file found/);
  await assert.rejects(gw.dispatch('game_capture', { operation: 'delete' }), /capture or look/);
});

test('game requests are Codex-only and wait for the live operator to hand off', async () => {
  const playtest = { status: async () => ({ ready: true }), submit: async () => ({ id: 'x' }), wait: async () => ({}) };
  const { gw: claude } = setup('claude', { playtest, mayOperate: () => true });
  await assert.rejects(claude.dispatch('game_ask', { question: 'place it' }), /belong to Codex/);
  const { gw: codexBefore } = setup('codex', { playtest });
  await assert.rejects(codexBefore.dispatch('game_capture', {}), /wait for its handoff/);
  const status = await codexBefore.dispatch('game_status', {});
  assert.equal(status.conductorMayOperate, false);
  assert.equal(status.ready, true, 'reading status is always allowed');
});

test('one game owner at a time: the lease is exclusive, needs the handoff, and the build report frees it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lease-')), root = join(home, 'hub'); mkdirSync(root, { recursive: true });
  const playtest = { status: async () => ({ ready: true }), submit: async () => ({ id: 'j' }), wait: async () => ({ pipelineCompleted: true }) };
  let handedOff = false;
  const codex = createStudioGateway({ root, repo: home, worker: 'codex', playtest, render: fakeRender, mayOperate: () => handedOff });
  const claude = createStudioGateway({ root, repo: home, worker: 'claude', playtest, render: fakeRender, mayOperate: () => handedOff });
  await assert.rejects(codex.dispatch('game_lease', { action: 'acquire', purpose: 'build' }), /after it hands off/);
  handedOff = true;
  await codex.dispatch('game_lease', { action: 'acquire', purpose: 'build' });
  await assert.rejects(claude.dispatch('game_lease', { action: 'acquire', purpose: 'verify' }), /leased to conductor-codex/);
  await assert.rejects(claude.dispatch('game_capture', {}), /leased to conductor-codex|Acquire the game lease/);
  assert.equal((await codex.dispatch('game_status', {})).lease.owner, 'conductor-codex');
  assert.deepEqual(await codex.dispatch('game_lease', { action: 'release' }), { released: true });
  await claude.dispatch('game_lease', { action: 'acquire', purpose: 'verify' });
  assert.equal((await claude.dispatch('game_capture', {})).pipelineCompleted, true, 'read-only capture is open to Claude with the lease');
});
