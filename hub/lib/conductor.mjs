// The conductor: runs open design jobs without the owner prompting anyone. Each
// tick finds the oldest open job, asks nextStep() whose turn it is, checks that
// worker's live usage, and starts its turn with a prompt for that step. Usage is
// the only brake: an out-of-usage worker's step waits for its reset. A turn that
// does not move the job forward twice in a row hands the job to the owner.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextStep } from './studio-store.mjs';

export const TURN_TIMEOUT_MS = 45 * 60000;
const other = w => w === 'codex' ? 'claude' : 'codex';
const NAME = { codex: 'Codex', claude: 'Claude' };

export function stepPrompt(job, step, { worktree, branch }) {
  const notes = job.notes.length ? `\nOwner notes (follow these):\n${job.notes.map(n => `- ${n.text}`).join('\n')}` : '';
  const head = [`You are ${NAME[step.worker]}, one of two designers in the Satisfactory AI Architect design studio. Your partner is ${NAME[other(step.worker)]}. The owner is watching live but is not prompting; the hub runs your turns.`,
    `Design job ${job.id}. Owner's brief: ${job.brief}${notes}`,
    `Your worktree is ${worktree} on branch ${branch}. Read AGENTS.md and docs/STATUS.md if you have not this session. Use studio_job to see every candidate (render PNGs and piece files), critique and owner note. The game is the authority: never claim an in-game result without a tool receipt.`].join('\n\n');
  const body = {
    candidate: step.revising
      ? `Your candidate ${step.revising} got a "revise" critique. Read it with studio_job, then post an improved candidate with studio_post_candidate that answers every point.`
      : 'Make the first candidate design for the brief. Build the piece list with the project\'s own compilers (companion/lib, e.g. level-tunnel.mjs for tunnels; see how Codex built "AI Walled Sweep 90" in docs/history and git log). Read reference blueprints with studio_read_blueprint. Render drafts with studio_render and look at them before posting. Post with studio_post_candidate: a short title, and a rationale saying what you checked.',
    critique: `Critique candidate ${step.candidate} by ${NAME[other(step.worker)]}. Open its render PNG and piece file (paths in studio_job). Check proportions, joints and seams, clashes and gaps, fit to the brief and to any reference, and that it only uses buildable pieces. Then studio_post_critique with verdict "agree" if it should be built, or "revise" with concrete changes. If you have a better concrete variant, post it with studio_post_candidate after your critique.`,
    build: `Both of you agreed on candidate ${step.candidate}. Build it: generate the native blueprint and place it in the game with game_ask (the newest save is backed up automatically), check the result with game_capture / game_ask readback and studio_read_blueprint, then studio_report_build with the receipts you observed. If the game refuses something, report exactly what it said.`,
    verify: `${NAME[other(step.worker)]} reported building candidate ${step.candidate}. Verify it: compare the saved blueprint (studio_read_blueprint) and a fresh game_capture against the agreed candidate's piece file. Then studio_post_critique with candidate "build", verdict "agree" if it matches, or "revise" with exactly what differs.`,
  }[step.kind];
  return `${head}\n\nYOUR STEP: ${body}\n\nEnd your turn when the step is posted.`;
}

export function createConductor({ root, store, workers, worktrees, now = Date.now, log = () => {} }) {
  const file = join(root, 'state/studio/conductor.json');
  let state = { enabled: false };
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }; } catch { state.enabled = false; }
  const save = () => { mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); renameSync(file + '.tmp', file); };
  let running = null, waiting = null;
  const stale = new Map(); // jobId → turns that did not change the next step

  async function tick() {
    if (!state.enabled || running) return null;
    const job = store.list().filter(j => ['designing', 'agreed', 'building'].includes(j.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) { waiting = null; return null; }
    const step = nextStep(job);
    if (!step) { waiting = null; return null; }
    const worker = await workers.get(step.worker);
    const u = worker.usage;
    if (u?.out && (!u.resetsAt || u.resetsAt > now())) {
      waiting = { job: job.id, worker: step.worker, reason: `${NAME[step.worker]} is out of usage${u.resetsAt ? ` until ${new Date(u.resetsAt).toLocaleTimeString()}` : ''}` };
      return null;
    }
    waiting = null;
    if (step.kind === 'build' && job.status === 'agreed') store.startBuild(job.id);
    const before = JSON.stringify(step);
    running = { job: job.id, worker: step.worker, kind: step.kind, candidate: step.candidate ?? null, startedAt: now() };
    store.log(job.id, 'studio', `${NAME[step.worker]}'s turn: ${step.kind}${step.candidate ? ` (candidate ${step.candidate})` : ''}`);
    const prompt = stepPrompt(store.get(job.id), step, worktrees[step.worker]);
    let timer;
    // Stop must end the wait even if the worker never answers.
    const stopped = new Promise((_, reject) => { running.abort = reject; });
    try {
      const result = await Promise.race([worker.run(prompt), stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Turn timed out')), TURN_TIMEOUT_MS); })]);
      store.log(job.id, step.worker, `Turn ${result.status}: ${String(result.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    } catch (error) {
      store.log(job.id, step.worker, `Turn failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
      running = null;
    }
    // A turn that leaves the same next step has not moved the job forward.
    const after = store.get(job.id), again = JSON.stringify(nextStep(after));
    if (again === before) {
      const n = (stale.get(job.id) ?? 0) + 1; stale.set(job.id, n);
      if (n >= 2) { store.needsOwner(job.id, `${NAME[step.worker]} did not finish its ${step.kind} step in two turns`); stale.delete(job.id); }
    } else stale.delete(job.id);
    log({ job: job.id, step });
    return step;
  }

  return {
    tick,
    status: () => ({ enabled: state.enabled, running, waiting }),
    set(enabled) { state.enabled = !!enabled; save(); return { enabled: state.enabled }; },
    async stop() {
      state.enabled = false; save();
      if (running) { const r = running, w = await workers.get(r.worker); await w.stop().catch(() => {}); workers.forget?.(r.worker); r.abort?.(new Error('Stopped by the owner')); }
      return { enabled: false };
    },
  };
}
