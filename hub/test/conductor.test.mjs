import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStore } from '../lib/studio-store.mjs';
import { createConductor, stepPrompt, pendingRequest, MAX_THREAD_TURNS } from '../lib/conductor.mjs';
import { normaliseUsage } from '../lib/conductor-workers.mjs';

const F = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const pieces = [{ class_path: F, transform: { translation_cm: { x: 0, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } } }];
const RECEIPT = [{ id: 'j1', operation: 'askall', outcome: 'completed', committedActions: 1 }];
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
    else if (/YOUR STEP: Both of you agreed/.test(prompt)) s.reportBuild(job.id, name, { summary: 'saved and placed', blueprint_name: 'AI Sweep', built: true, candidate_sha256: s.get(job.id).agreedHash, evidence: RECEIPT });
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
  const { prompts, workers } = fakes(store, async (name, prompt, s) => s.reportBuild(job.id, name, { summary: 'built', blueprint_name: 'X', built: true, candidate_sha256: s.get(job.id).agreedHash, evidence: RECEIPT }));
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

test('a stopped build turn ends the worker and leaves its game transaction unresolved for the owner (Codex #652)', async () => {
  const { createGameLease } = await import('../lib/game-lease.mjs');
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Straight' });
  store.addCandidate(job.id, 'codex', { title: 'A', rationale: 'r', pieces });
  store.addCritique(job.id, 'claude', { candidate: 1, verdict: 'agree', critique: 'ok' });
  const lease = createGameLease(root, { mayOperate: () => true });
  let entered;
  const inTurn = new Promise(r => { entered = r; });
  const { w, workers } = fakes(store, async () => {
    // The worker submits a world-changing request, then hangs before readback.
    const l = lease.acquire({ session: 'conductor-codex:t', worker: 'codex', purpose: 'build', job: job.id });
    lease.record('conductor-codex:t', l.token, { id: 'j9', operation: 'askall', outcome: 'submitted' });
    entered(); await new Promise(() => {});
  });
  const forgotten = [];
  workers.forget = name => forgotten.push(name);
  const c = createConductor({ root, store, workers, worktrees, lease });
  c.set(true);
  const turn = c.tick();
  await inTurn;
  await c.stop();
  assert.equal((await turn).kind, 'build');
  assert.equal(w.codex.stopped, true, 'the worker process was ended');
  assert.deepEqual(forgotten, ['codex']);
  assert.equal(lease.current().unresolved, true);
  assert.match(lease.current().unresolvedReason, /Stopped by the owner; 1 game request/);
  assert.equal(store.get(job.id).status, 'needs-owner');
  assert.throws(() => lease.acquire({ session: 'conductor-claude:x', worker: 'claude', purpose: 'verify' }), /unresolved game transaction/);
  assert.equal(lease.resolve(), true, 'the owner resolves it after checking the game');
  assert.equal(lease.current(), null);
});

test('an unused lease is simply released when a turn ends', async () => {
  const { createGameLease } = await import('../lib/game-lease.mjs');
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const job = store.create({ brief: 'Straight' });
  store.addCandidate(job.id, 'codex', { title: 'A', rationale: 'r', pieces });
  store.addCritique(job.id, 'claude', { candidate: 1, verdict: 'agree', critique: 'ok' });
  const lease = createGameLease(root, { mayOperate: () => true });
  const { workers } = fakes(store, async () => { lease.acquire({ session: 'conductor-codex:t', worker: 'codex', purpose: 'build' }); });
  const c = createConductor({ root, store, workers, worktrees, lease });
  c.set(true);
  await c.tick();
  assert.equal(lease.current(), null);
  assert.match(store.get(job.id).events.map(e => e.text).join(' | '), /Released Codex's unused game lease/);
});

// The ledger around the safeguards review, as it was on 2026-10-19.
const LEDGER = [
  { id: 650, sender: 'claude-40324', recipient: null, reply_to: 647, subject: '#647 safeguards built; please review 04a9e65 before any game handoff' },
  { id: 652, sender: 'codex-30460', recipient: 'claude-40324', reply_to: 650, subject: 'Request changes: three reproduced safeguards gaps before handoff' },
  { id: 653, sender: 'codex-30460', recipient: 'claude-40324', reply_to: 650, subject: 'Final request_changes aed6d53: timeout blocker; both suites pass' },
  { id: 655, sender: 'claude-40324', recipient: null, reply_to: 653, subject: 'Re-review: studio game safeguards repaired (#652/#653) at 77a5cf6' },
];

test('an unanswered peer request is the other model\'s turn; answered threads, notes and old history are not', () => {
  assert.deepEqual(pendingRequest(LEDGER, { since: 654 }), { worker: 'codex', kind: 'mail', message: 655, thread: 650, from: 'claude-40324', subject: LEDGER[3].subject });
  assert.equal(pendingRequest(LEDGER, { since: 600 }).message, 655, '650, 652 and 653 were answered later in the same thread');
  assert.equal(pendingRequest(LEDGER, { since: 654, handled: [655] }), null, 'one turn per request');
  const answered = [...LEDGER, { id: 656, sender: 'codex-1', recipient: 'claude-40324', reply_to: 655, subject: 'APPROVE 77a5cf6' }];
  assert.equal(pendingRequest(answered, { since: 654 }), null);
  assert.equal(pendingRequest([{ id: 700, sender: 'claude-1', recipient: null, reply_to: null, subject: 'master is current on GitHub' }]), null, 'a plain note asks for nothing');
  assert.equal(pendingRequest([{ id: 701, sender: 'codex-1', recipient: 'codex-2', reply_to: null, subject: 'please review' }]), null, 'same-model messages stay between them');
  assert.equal(pendingRequest([{ id: 702, sender: 'hauhaucs-local', recipient: null, reply_to: null, subject: 'Review requested: local/shift' }]), null);
});

test('the conductor wakes the addressed model for a peer request before any design work, once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  store.create({ brief: 'Factory floor' });
  let ledger = LEDGER.slice(0, 3);
  const { prompts, workers } = fakes(store, async () => {});
  const c = createConductor({ root, store, workers, worktrees, readMail: () => ledger });
  c.set(true);
  await c.tick(); // the first look only records where history ends
  prompts.length = 0;
  ledger = LEDGER;
  const s = await c.tick();
  assert.deepEqual([s.worker, s.kind, s.message], ['codex', 'mail', 655]);
  assert.match(prompts[0].prompt, /message #655: "Re-review: studio game safeguards repaired/);
  assert.match(prompts[0].prompt, /pair_send_message, reply_to 655/);
  assert.equal(prompts[0].name, 'codex');
  assert.equal((await c.tick()).kind, 'candidate', 'then the design work continues; the request is not repeated');
  assert.match(c.status().mail.map(m => m.text).join(' | '), /Codex's turn: mail \(message #655 from claude-40324\)/);
});

test('two models cannot ping-pong forever: a thread gets a few automatic turns, then waits for the owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-')), store = createStudioStore(root);
  const ledger = [];
  let id = 100;
  const { prompts, workers } = fakes(store, async name => { ledger.push({ id: ++id, sender: `${name}-1`, recipient: null, reply_to: id - 1, subject: 'Please review my answer?' }); });
  const c = createConductor({ root, store, workers, worktrees, readMail: () => ledger });
  c.set(true);
  await c.tick();
  ledger.push({ id: ++id, sender: 'claude-1', recipient: null, reply_to: null, subject: 'Please review this' });
  for (let i = 0; i < 20; i++) await c.tick();
  assert.equal(prompts.length, MAX_THREAD_TURNS);
  assert.match(c.status().mail.at(-1).text, /waits for the owner/);
});
