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

// An agreed design that is building, with a typed proposal for exactly its pieces in the repo.
const proposalFor = (n, extra = {}) => ({ action: 'generate_native_blueprint', blueprint_name: 'AI Straight', layout_schema: 'aifactory.generated-blueprint/v6', commit: true,
  buildables: pieces(n).map((p, i) => ({ part_id: `p${i + 1}`, role: 'floor', recipe_class: p.class_path.replace(/Build_(\w+)\.Build_\1_C$/, 'Recipe_$1.Recipe_$1_C'),
    relative_location: p.transform.translation_cm, rotation_quat: p.transform.rotation_quat, scale3d: p.transform.scale3d })), ...extra });
function building(gw, repo, n = 2) {
  const job = gw.store.create({ brief: 'Straight' });
  gw.store.addCandidate(job.id, 'codex', { title: 'A', rationale: 'r', pieces: pieces(n) });
  gw.store.addCritique(job.id, 'claude', { candidate: 1, verdict: 'agree', critique: 'ok' });
  gw.store.startBuild(job.id);
  writeFileSync(join(repo, 'proposal.json'), JSON.stringify(proposalFor(n)));
  return job;
}
// A fake deterministic companion route: the question names the proposal hash, and
// the result is checked against the proposal (in the real route, the receipt's actions).
const typedRoute = { question: ({ proposalHash }) => `studio generate ${proposalHash}`, verify: (r, proposal) => ({ matchesProposal: r.generated === proposal.blueprint_name, blueprintName: r.generated ?? null, savedReadback: r.readback === true }) };
const savesWithOne = () => { const d = mkdtempSync(join(tmpdir(), 'saves-')); writeFileSync(join(d, 'a.sav'), 's'); return d; };
const gamePlaytest = (calls, result = { pipelineCompleted: true, committedActions: 1, generated: 'AI Straight', readback: true }) =>
  ({ status: async () => ({ ready: true }), submit: async i => { calls.push(i); return { id: `j${calls.length}` }; }, wait: async () => result });

test('generation backs up the newest save first, submits only the route\'s typed request, and refuses without a save', async () => {
  const saves = mkdtempSync(join(tmpdir(), 'saves-')), user = join(saves, '7656');
  mkdirSync(user); writeFileSync(join(user, 'old.sav'), 'old'); writeFileSync(join(user, 'new.sav'), 'new');
  utimesSync(join(user, 'old.sav'), new Date(2020, 1, 1), new Date(2020, 1, 1));
  assert.equal(newestSave(saves), join(user, 'new.sav'));
  const calls = [];
  const { root, repo, gw } = setup('codex', { playtest: gamePlaytest(calls), saveDir: saves, mayOperate: () => true, typedRoute });
  const job = building(gw, repo);
  await assert.rejects(gw.dispatch('game_generate', {}), /Acquire the game lease/);
  const l = await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build A', job_id: job.id, proposal_file: 'proposal.json' });
  const r = await gw.dispatch('game_generate', { question: 'teleport me', anything: 1 });
  assert.equal(readFileSync(r.saveBackup, 'utf8'), 'new');
  assert.deepEqual(calls, [{ operation: 'askall', question: `studio generate ${l.proposalHash}` }], 'the model\'s words are never sent');
  assert.equal(r.matchesProposal, true);
  assert.match(readFileSync(join(root, 'state/studio/game-actions.jsonl'), 'utf8'), /"worker":"codex".*"operation":"generate"/);
  await assert.rejects(gw.dispatch('game_ask', { question: 'x' }), /Unknown studio tool/, 'there is no free-text game request');
  const { repo: repo2, gw: noSave } = setup('codex', { playtest: gamePlaytest([]), saveDir: mkdtempSync(join(tmpdir(), 'empty-')), mayOperate: () => true, typedRoute });
  const job2 = building(noSave, repo2);
  await noSave.dispatch('game_lease', { action: 'acquire', purpose: 'x', job_id: job2.id, proposal_file: 'proposal.json' });
  await assert.rejects(noSave.dispatch('game_generate', {}), /No save file found/);
  await assert.rejects(gw.dispatch('game_capture', { operation: 'delete' }), /capture or look/);
});

test('without a deterministic companion route nothing can change the world', async () => {
  const calls = [];
  const { repo, gw } = setup('codex', { playtest: gamePlaytest(calls), saveDir: savesWithOne(), mayOperate: () => true });
  const job = building(gw, repo);
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id, proposal_file: 'proposal.json' });
  await assert.rejects(gw.dispatch('game_generate', {}), /No deterministic typed-generation route/);
  assert.equal(calls.length, 0);
});

test('game requests are Codex-only and wait for the live operator to hand off', async () => {
  const playtest = { status: async () => ({ ready: true }), submit: async () => ({ id: 'x' }), wait: async () => ({}) };
  const { gw: claude } = setup('claude', { playtest, mayOperate: () => true, typedRoute });
  await assert.rejects(claude.dispatch('game_generate', {}), /belong to Codex/);
  const { gw: codexBefore } = setup('codex', { playtest });
  await assert.rejects(codexBefore.dispatch('game_capture', {}), /wait for its handoff/);
  const status = await codexBefore.dispatch('game_status', {});
  assert.equal(status.conductorMayOperate, false);
  assert.equal(status.ready, true, 'reading status is always allowed');
});

test('one game owner at a time: the lease is exclusive, needs the handoff, and only its session frees it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lease-')), root = join(home, 'hub'); mkdirSync(root, { recursive: true });
  const playtest = { status: async () => ({ ready: true }), submit: async () => ({ id: 'j' }), wait: async () => ({ pipelineCompleted: true }) };
  let handedOff = false;
  const codex = createStudioGateway({ root, repo: home, worker: 'codex', playtest, render: fakeRender, mayOperate: () => handedOff });
  const claude = createStudioGateway({ root, repo: home, worker: 'claude', playtest, render: fakeRender, mayOperate: () => handedOff });
  await assert.rejects(codex.dispatch('game_lease', { action: 'acquire', purpose: 'build' }), /after it hands off/);
  handedOff = true;
  await codex.dispatch('game_lease', { action: 'acquire', purpose: 'build' });
  await assert.rejects(claude.dispatch('game_lease', { action: 'acquire', purpose: 'verify' }), /leased to codex/);
  await assert.rejects(claude.dispatch('game_capture', {}), /leased to another session/);
  const view = (await codex.dispatch('game_status', {})).lease;
  assert.equal(view.worker, 'codex');
  assert.equal(view.token, undefined, 'the token never leaves the owning session');
  assert.deepEqual(await claude.dispatch('game_lease', { action: 'release' }), { released: false }, 'another session cannot release it');
  assert.deepEqual(await codex.dispatch('game_lease', { action: 'release' }), { released: true }, 'an unused lease is simply released');
  await claude.dispatch('game_lease', { action: 'acquire', purpose: 'verify' });
  assert.equal((await claude.dispatch('game_capture', {})).pipelineCompleted, true, 'read-only capture is open to Claude with the lease');
  assert.deepEqual(await claude.dispatch('game_lease', { action: 'release' }), { released: true }, 'a read-only capture does not hold the game');
});

test('a second session of the same worker cannot use its lease (Codex #653)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lease-')), root = join(home, 'hub'); mkdirSync(root, { recursive: true });
  const playtest = { status: async () => ({ ready: true }), submit: async () => ({ id: 'j' }), wait: async () => ({ pipelineCompleted: true }) };
  const a = createStudioGateway({ root, repo: home, worker: 'codex', playtest, render: fakeRender, mayOperate: () => true });
  const b = createStudioGateway({ root, repo: home, worker: 'codex', playtest, render: fakeRender, mayOperate: () => true });
  await a.dispatch('game_lease', { action: 'acquire', purpose: 'build' });
  await assert.rejects(b.dispatch('game_capture', {}), /leased to another session/);
  await assert.rejects(b.dispatch('game_lease', { action: 'acquire', purpose: 'build' }), /leased to codex/);
});

test('the proposal must be the agreed design piece for piece, and is re-checked before each submission (Codex #652, #656)', async () => {
  const calls = [];
  const { repo, gw } = setup('codex', { playtest: gamePlaytest(calls), saveDir: savesWithOne(), mayOperate: () => true, typedRoute });
  const job = building(gw, repo);
  const acquire = file => gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id, proposal_file: file });
  const tryProposal = async (name, proposal, re) => { writeFileSync(join(repo, name), JSON.stringify(proposal)); await assert.rejects(acquire(name), re); };
  // Same count, wrong place (Codex's x9000 case), wrong class, wrong rotation, extra topology, no name.
  const moved = proposalFor(2); moved.buildables[0].relative_location = { ...moved.buildables[0].relative_location, x: 9000 };
  await tryProposal('moved.json', moved, /buildable 1 is not at the agreed position/);
  const wall = proposalFor(2); wall.buildables[1].recipe_class = '/Game/X/Recipe_Wall.Recipe_Wall_C';
  await tryProposal('wall.json', wall, /buildable 2 is .*Recipe_Wall/);
  const turned = proposalFor(2); turned.buildables[0].rotation_quat = { x: 0, y: 0, z: 0.7071068, w: 0.7071068 };
  await tryProposal('turned.json', turned, /not at the agreed rotation/);
  await tryProposal('belts.json', proposalFor(2, { conveyors: [{}] }), /conveyors are not part of the agreed piece list/);
  await tryProposal('nameless.json', proposalFor(2, { blueprint_name: '' }), /blueprint_name is required/);
  await tryProposal('more.json', proposalFor(5), /5 buildables but the agreed piece list has 2/);
  // A lease without the job and proposal may capture, never generate.
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'look' });
  await assert.rejects(gw.dispatch('game_generate', {}), /tied to the agreed design job/);
  await gw.dispatch('game_lease', { action: 'release' });
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id });
  await assert.rejects(gw.dispatch('game_generate', {}), /Bind the typed generation proposal/);
  await gw.dispatch('game_lease', { action: 'release' });
  await acquire('proposal.json');
  // Edited after binding: refused before anything is submitted.
  writeFileSync(join(repo, 'proposal.json'), JSON.stringify(proposalFor(2, { description: 'changed' })));
  await assert.rejects(gw.dispatch('game_generate', {}), /typed proposal changed/);
  writeFileSync(join(repo, 'proposal.json'), JSON.stringify(proposalFor(2)));
  writeFileSync(join(gw.store.dirOf(job.id), 'candidate-1.json'), JSON.stringify(pieces(3)));
  await assert.rejects(gw.dispatch('game_generate', {}), /piece list changed since agreement/);
  assert.equal(calls.length, 0, 'nothing reached the game');
});

test('the build report is checked against the hub\'s generation receipt for the bound proposal, then closes the transaction', async () => {
  const calls = [];
  const { repo, gw } = setup('codex', { playtest: gamePlaytest(calls), saveDir: savesWithOne(), mayOperate: () => true, typedRoute });
  const job = building(gw, repo);
  const hash = gw.store.get(job.id).agreedHash;
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id, proposal_file: 'proposal.json' });
  await assert.rejects(gw.dispatch('studio_report_build', { job_id: job.id, summary: 'saved', built: true, saved: true, blueprint_name: 'AI Straight', candidate_sha256: hash }), /needs a committed game_generate receipt/);
  await gw.dispatch('game_generate', {});
  await assert.rejects(gw.dispatch('studio_report_build', { job_id: job.id, summary: 'saved', built: true, blueprint_name: 'Something Else', candidate_sha256: hash }), /named "Something Else"/);
  const r = await gw.dispatch('studio_report_build', { job_id: job.id, summary: 'saved', built: true, saved: true, blueprint_name: 'AI Straight', candidate_sha256: hash });
  assert.equal(r.stage, 'saved');
  assert.equal(r.transaction, 'released');
  assert.deepEqual(gw.store.get(job.id).build.receipts.map(x => x.outcome), ['submitted', 'completed']);
  assert.equal((await gw.dispatch('game_status', {})).lease, null, 'the report freed the game');
});

test('an unknown generation outcome is unresolved at once; neither a built:false report nor a release clears it (Codex #656)', async () => {
  const calls = [];
  const playtest = { status: async () => ({ ready: true }), submit: async i => { calls.push(i); return { id: 'j1' }; }, wait: async () => { throw new Error('Native result not observed before deadline'); } };
  const { repo, gw } = setup('codex', { playtest, saveDir: savesWithOne(), mayOperate: () => true, typedRoute });
  const job = building(gw, repo);
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id, proposal_file: 'proposal.json' });
  await assert.rejects(gw.dispatch('game_generate', {}), /outcome is unknown.*do not retry/);
  await assert.rejects(gw.dispatch('game_generate', {}), /unresolved game transaction/, 'no replay');
  await assert.rejects(gw.dispatch('studio_report_build', { job_id: job.id, summary: 'timed out', built: false }), /unresolved game transaction/);
  assert.equal((await gw.dispatch('game_lease', { action: 'release' })).released, false);
  const view = (await gw.dispatch('game_status', {})).lease;
  assert.equal(view.unresolved, true);
  assert.match(view.unresolvedReason, /outcome is unknown/);
  assert.equal(calls.length, 1);
});

test('releasing after a generation, without a report, leaves it unresolved (Codex #656)', async () => {
  const { repo, gw } = setup('codex', { playtest: gamePlaytest([]), saveDir: savesWithOne(), mayOperate: () => true, typedRoute });
  const job = building(gw, repo);
  await gw.dispatch('game_lease', { action: 'acquire', purpose: 'build', job_id: job.id, proposal_file: 'proposal.json' });
  await gw.dispatch('game_generate', {});
  assert.deepEqual(await gw.dispatch('game_lease', { action: 'release' }), { released: false, unresolved: true, reason: 'World requests were made; only a build report closes them. The owner must check the game and resolve it' });
  assert.equal((await gw.dispatch('game_status', {})).lease.unresolved, true);
});
