import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStore } from '../lib/studio-store.mjs';
import { createConductor, stepPrompt } from '../lib/conductor.mjs';
import { normaliseUsage } from '../lib/conductor-workers.mjs';

const F = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const pieces = [{ class_path: F, transform: { translation_cm: { x: 0, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } } }];
const worktrees = { codex: { worktree: 'C:/w/codex', branch: 'codex/auto' }, claude: { worktree: 'C:/w/claude', branch: 'claude/auto' } };

// Fake workers act like the models would, through the store.
function fakes(store, behaviour) {
  const prompts = [];
  const make = name => ({ name, usage: null, busy: false, stopped: false,
    async run(prompt) { prompts.push({ name, prompt }); await behaviour(name, prompt, store); return { status: 'completed', text: `${name} done` }; },
    async stop() { this.stopped = true; } });
  const w = { codex: make('codex'), claude: make('claude') };
  return { prompts, w, workers: { get: async name => w[name] } };
}

test('the conductor runs a whole design without anyone prompting: candidate, critique, agree, build, verify', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Sweeping 90 joined to the walled tunnel' });
  const { prompts, workers } = fakes(store, async (name, prompt, s) => {
    if (/YOUR STEP: Make the first candidate/.test(prompt)) s.addCandidate(job.id, name, { title: 'Sweep', rationale: 'r', pieces });
    else if (/YOUR STEP: Critique candidate/.test(prompt)) s.addCritique(job.id, name, { candidate: 1, verdict: 'agree', critique: 'good' });
    else if (/YOUR STEP: Both of you agreed/.test(prompt)) s.reportBuild(job.id, name, { summary: 'saved and placed', blueprint_name: 'AI Sweep', candidate_sha256: s.get(job.id).agreedHash });
    else if (/YOUR STEP: .* reported building/.test(prompt)) s.addCritique(job.id, name, { candidate: 'build', verdict: 'agree', critique: 'matches' });
  });
  const c = createConductor({ root, store, workers, worktrees });
  assert.equal(await c.tick(), null, 'off until switched on');
  c.set(true);
  const steps = [];
  for (let i = 0; i < 6; i++) { const s = await c.tick(); if (s) steps.push(`${s.worker}:${s.kind}`); }
  assert.deepEqual(steps, ['codex:candidate', 'claude:critique', 'codex:build', 'claude:verify']);
  assert.equal(store.get(job.id).status, 'done');
  assert.match(prompts[0].prompt, /Owner's brief: Sweeping 90 joined to the walled tunnel/);
  assert.match(prompts[1].prompt, /Your worktree is C:\/w\/claude on branch claude\/auto/);
});

test('usage is the only brake: an out-of-usage worker waits, then goes when it resets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  store.create({ brief: 'Factory' });
  let t = 1_000_000;
  const { w, workers } = fakes(store, async (name, prompt, s) => { s.addCandidate(s.list()[0].id, name, { title: 'A', rationale: 'r', pieces }); });
  w.codex.usage = { out: true, resetsAt: t + 60000 };
  const c = createConductor({ root, store, workers, worktrees, now: () => t });
  c.set(true);
  assert.equal(await c.tick(), null);
  assert.match(c.status().waiting.reason, /Codex is out of usage until/);
  t += 61000;
  assert.equal((await c.tick()).kind, 'candidate');
});

test('two turns that do not move the job hand it to the owner; Stop ends the running turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Base' });
  const { w, workers } = fakes(store, async () => {});
  const c = createConductor({ root, store, workers, worktrees });
  c.set(true);
  await c.tick(); assert.equal(store.get(job.id).status, 'designing');
  await c.tick(); assert.equal(store.get(job.id).status, 'needs-owner');
  assert.match(store.get(job.id).events.at(-1).text, /did not finish its candidate step in two turns/);
  // Stop: a turn that never ends is cut off and the conductor switches off.
  const job2 = store.create({ brief: 'Tunnel' });
  w.codex.run = () => new Promise(() => {});
  const pending = c.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(c.status().running.job, job2.id);
  await c.stop();
  assert.equal(w.codex.stopped, true);
  assert.equal(c.status().enabled, false);
  await pending; // the conductor stops waiting on the dead turn
});

test('owner notes reach the next prompt; usage reports from both clients normalise', () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Tunnel' });
  store.note(job.id, 'Keep the floor flush');
  assert.match(stepPrompt(store.get(job.id), { worker: 'codex', kind: 'candidate' }, worktrees.codex), /Owner notes \(follow these\):\n- Keep the floor flush/);
  assert.deepEqual(normaliseUsage({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1792394993 } } }), { usedPercent: 100, resetsAt: 1792394993000, out: true });
  assert.deepEqual(normaliseUsage({ status: 'rejected', resetsAt: 1792394993, utilization: 1 }), { usedPercent: 100, resetsAt: 1792394993000, out: true });
  assert.equal(normaliseUsage({ status: 'allowed', utilization: 0.79 }).usedPercent, 79);
  assert.equal(normaliseUsage({}), null);
});

test('a build waits for game control without spending a turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Straight' });
  store.addCandidate(job.id, 'codex', { title: 'A', rationale: 'r', pieces });
  store.addCritique(job.id, 'claude', { candidate: 1, verdict: 'agree', critique: 'ok' });
  let handedOff = false;
  const { prompts, workers } = fakes(store, async (name, prompt, s) => s.reportBuild(job.id, name, { summary: 'built', blueprint_name: 'X', candidate_sha256: s.get(job.id).agreedHash }));
  const c = createConductor({ root, store, workers, worktrees, mayOperate: () => handedOff });
  c.set(true);
  assert.equal(await c.tick(), null);
  assert.match(c.status().waiting.reason, /waits for game control/);
  assert.equal(prompts.length, 0, 'no turn was spent');
  handedOff = true;
  assert.equal((await c.tick()).kind, 'build');
});

test('with no design open, the models work on the active milestone: build, review, team merge, swap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const { createMilestoneWork } = await import('../lib/milestone-work.mjs');
  const work = createMilestoneWork(root);
  let milestones = [{ id: 'm1', title: 'Tunnel lighting powered', status: 'active', notes: '' }];
  const merges = [];
  let n = 0;
  const { prompts, workers } = fakes(store, async (name, prompt) => {
    const job = work.open();
    if (/YOUR STEP: Review step/.test(prompt)) { const s = job.steps.at(-1); work.reviewStep(job.id, name, { step: s.n, commit: s.commit, verdict: 'approve', review: 'tests pass' }); }
    else work.reportStep(job.id, name, { summary: `step by ${name}`, commit: String(1000000 + ++n), branch: `${name}/auto` });
  });
  const c = createConductor({ root, store, workers, worktrees, work, readMilestones: () => milestones, merge: async ({ commit, message }) => { merges.push(message); return { mergeCommit: commit }; } });
  c.set(true);
  const kinds = [];
  for (let i = 0; i < 6; i++) { const s = await c.tick(); if (s) kinds.push(`${s.worker}:${s.kind}`); }
  assert.deepEqual(kinds, ['codex:work', 'claude:review', 'hub:merge', 'claude:work', 'codex:review', 'hub:merge']);
  assert.match(merges[0], /Milestone step 1 by Codex, reviewed by Claude/);
  assert.match(prompts[0].prompt, /ACTIVE MILESTONE \(set by the owner\): Tunnel lighting powered/);
  assert.match(prompts[0].prompt, /git merge team\/auto/);
  // The owner completes the milestone: the open job closes and nothing more runs.
  milestones = [{ ...milestones[0], status: 'complete' }];
  assert.equal(await c.tick(), null);
  assert.equal(work.list()[0].status, 'closed');
});

test('a design job always comes before milestone work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const { createMilestoneWork } = await import('../lib/milestone-work.mjs');
  const work = createMilestoneWork(root);
  store.create({ brief: 'Factory floor' });
  const { workers } = fakes(store, async (name, prompt, s) => s.addCandidate(s.list()[0].id, name, { title: 'A', rationale: 'r', pieces }));
  const c = createConductor({ root, store, workers, worktrees, work, readMilestones: () => [{ id: 'm1', title: 'X', status: 'active' }] });
  c.set(true);
  assert.equal((await c.tick()).kind, 'candidate');
  assert.equal(work.list().length, 0);
});
