// The conductor: runs open design jobs without the owner prompting anyone. Each
// tick finds the oldest open job, asks nextStep() whose turn it is, checks that
// worker's live usage, and starts its turn with a prompt for that step. Usage is
// the only brake: an out-of-usage worker's step waits for its reset. A turn that
// does not move the job forward twice in a row hands the job to the owner.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextStep } from './studio-store.mjs';
import { nextMilestoneStep } from './milestone-work.mjs';

export const TURN_TIMEOUT_MS = 45 * 60000;
// With no reset time reported, look again after this long.
export const LIMIT_RECHECK_MS = 15 * 60000;

// Did a turn end on a subscription usage limit? Claude says e.g. "Claude AI usage
// limit reached|1792400000" or "You've hit your session limit · resets 10:20am";
// Codex "You've hit your usage limit" (usageLimitExceeded). Returns when to resume.
export function usageLimit(text, { now = Date.now(), known = null } = {}) {
  const t = String(text ?? '');
  if (!/usage limit|session limit|weekly limit|hit your limit|usageLimitExceeded|rate[_ ]limit(ed| reached| exceeded)|out of (usage|credits)/i.test(t)) return null;
  const epoch = /\|(\d{10,13})\b/.exec(t)?.[1];
  if (epoch) { const ms = +epoch < 1e12 ? +epoch * 1000 : +epoch; if (ms > now) return { resetsAt: ms, estimated: false }; }
  // A weekly limit names the date: "try again at Oct 24th, 2026 4:44 PM".
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dated = /(?:resets?|try again)\s+(?:at|on)?\s*([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  if (dated && MONTHS.includes(dated[1].toLowerCase())) {
    let h = +dated[4] % 12; if (/pm/i.test(dated[6])) h += 12;
    const d = new Date(+(dated[3] ?? new Date(now).getFullYear()), MONTHS.indexOf(dated[1].toLowerCase()), +dated[2], h, +(dated[5] ?? 0));
    if (d.getTime() > now) return { resetsAt: d.getTime(), estimated: false };
  }
  const clock = /(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  if (clock) {
    let h = +clock[1] % 12; if (/pm/i.test(clock[3])) h += 12;
    const d = new Date(now); d.setHours(h, +(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { resetsAt: d.getTime(), estimated: false };
  }
  if (Number.isFinite(known) && known > now) return { resetsAt: known, estimated: false };
  return { resetsAt: now + LIMIT_RECHECK_MS, estimated: true };
}
const other = w => w === 'codex' ? 'claude' : 'codex';
const NAME = { codex: 'Codex', claude: 'Claude' };
// The owner's style references: the direction for any brief that does not name a style.
export const STYLE_GUIDE = 'docs/designs/inspiration/README.md';

export function stepPrompt(job, step, { worktree, branch }) {
  const notes = job.notes.length ? `\nOwner notes (follow these):\n${job.notes.map(n => `- ${n.text}`).join('\n')}` : '';
  const head = [`You are ${NAME[step.worker]}, one of two designers in the Satisfactory AI Architect design studio. Your partner is ${NAME[other(step.worker)]}. The owner is watching live but is not prompting; the hub runs your turns.`,
    `Design job ${job.id}. Owner's brief: ${job.brief}${notes}`,
    `Your worktree is ${worktree} on branch ${branch}. Read AGENTS.md and docs/STATUS.md if you have not this session. Use studio_job to see every candidate (render PNGs and piece files), critique and owner note. The game is the authority: never claim an in-game result without a tool receipt.`,
    `Style: unless the brief names one, design in the direction of the owner's inspiration board, ${STYLE_GUIDE} (read it and look at its images). They are inspiration, not designs to copy: take the language (stacked and stepped massing, deep horizontal bands, light that outlines the form, a crown, a dark or white palette, logistics as part of the composition) and make something new that fits the brief and the measured pieces. Use only buildings the game can place: the classes in hub/catalog/game-buildables.json (the studio refuses anything else); never invent an asset to get a look.`].join('\n\n');
  const body = {
    candidate: step.revising
      ? `Your candidate ${step.revising} got a "revise" critique. Read it with studio_job, then post an improved candidate with studio_post_candidate that answers every point.`
      : 'Make the first candidate design for the brief. Build the piece list with the project\'s own compilers (companion/lib, e.g. level-tunnel.mjs for tunnels; see how Codex built "AI Walled Sweep 90" in docs/history and git log). Read reference blueprints with studio_read_blueprint. Render drafts with studio_render and look at them before posting. Post with studio_post_candidate: a short title, and a rationale saying what you checked and which inspiration references you drew on and how you changed them.',
    critique: `Critique candidate ${step.candidate} by ${NAME[other(step.worker)]}. Open its render PNG and piece file (paths in studio_job). Check proportions, joints and seams, clashes and gaps, fit to the brief and to any reference, whether it reads as designed in the owner's style language (when the brief names no other style), and that it only uses buildable pieces. Then studio_post_critique with verdict "agree" if it should be built, or "revise" with concrete changes. If you have a better concrete variant, post it with studio_post_candidate after your critique.`,
    build: `Both of you agreed on candidate ${step.candidate} (pinned ${job.agreedHash ?? 'hash in studio_job'}). Build exactly that piece list. Write the typed generate_native_blueprint action for exactly those pieces to a file in your worktree, then take the game lease with game_lease acquire, job_id ${job.id} and proposal_file (that file), (the hub checks it piece for piece against the agreed list). Generate it with game_generate (the newest save is backed up automatically); it is refused if the pieces or the proposal changed, and refused outright while the companion has no typed-generation route. Check the saved blueprint with studio_read_blueprint, then studio_report_build with built: true, candidate_sha256, the blueprint_name the game reported, and saved only if the receipt shows the native readback (the hub checks against what it recorded under your lease). The other model verifies; you cannot verify your own build. Never replay a world-changing request whose outcome is unknown; report it instead. If the game refuses something or you cannot build, call studio_report_build with built: false and report exactly what it said.`,
    verify: `${NAME[other(step.worker)]} reported building candidate ${step.candidate}. Verify it: compare the saved blueprint (studio_read_blueprint) against the agreed candidate's piece file. For a fresh world capture, take the game lease first (game_lease acquire), use game_capture, then release it. Then studio_post_critique with candidate "build", verdict "agree" if it matches, or "revise" with exactly what differs.`,
  }[step.kind];
  return `${head}\n\nYOUR STEP: ${body}\n\nEnd your turn when the step is posted.`;
}

export function milestonePrompt(job, step, { worktree, branch }) {
  const m = job.milestone, last = job.steps.at(-1);
  const head = [`You are ${NAME[step.worker]}, working with ${NAME[other(step.worker)]} on the owner's Satisfactory project. The owner is watching live but is not prompting; the hub runs your turns.`,
    `ACTIVE MILESTONE (set by the owner): ${m.title}${m.notes ? `\nOwner notes: ${m.notes}` : ''}`,
    `Your worktree is ${worktree} on branch ${branch}. Read AGENTS.md, docs/STATUS.md and hub/AGENTS.md if you have not this session. studio_milestone shows every step and review so far. The game is the authority: never claim an in-game result without a tool receipt; game actions need the game lease; either model may build an agreed design and the other verifies.`].join('\n\n');
  const body = step.kind === 'review'
    ? `Review step ${step.step} by ${NAME[last.author]}: commit ${last.commit}${last.branch ? ` on ${last.branch}` : ''}. "${last.summary.slice(0, 600)}". In your worktree look at exactly that commit (git show ${last.commit}; check it out detached to run its tests), check it really moves the milestone forward, is correct and tested, and keeps every working feature. Do not change files. Then studio_review_step with commit ${last.commit}, verdict "approve" or "changes" with concrete fixes.`
    : `${step.fixing ? `Your step ${step.fixing} got "changes requested": read the review in studio_milestone and fix every point.` : 'Take ONE concrete, reviewable step toward the milestone: the most useful next thing, small enough to review in one sitting.'} First bring your branch up to date: git merge team/auto (or git merge master if team/auto does not exist yet). Make the change with tests, run them, commit on your branch, then studio_report_step with a summary (what changed, how you verified it), the commit hash (git rev-parse HEAD) and your branch.`;
  return `${head}\n\nYOUR STEP: ${body}\n\nEnd your turn when the step is reported.`;
}

// Peer requests on the shared ledger (agent_pair messages). A request from one model
// that the other has not answered in the same thread gets the other model a turn, so
// reviews and questions move without the owner relaying them.
const ASKS = /review|request|question|please|wanted|answer|\?/i;
// A verdict or note closes the loop: it never wakes the other model.
const VERDICT = /^\W*(approve|approved|approval|lgtm|fyi|done|thanks|ack)\b/i;
// Automatic turns per thread before the owner looks (a ping-pong guard).
export const MAX_THREAD_TURNS = 6;
export const familyOf = sender => /^claude/i.test(sender ?? '') ? 'claude' : /^codex/i.test(sender ?? '') ? 'codex' : null;
export function pendingRequest(messages, { since = 0, handled = [] } = {}) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const root = m => { let r = m; for (let i = 0; i < 100 && r.reply_to && byId.has(r.reply_to); i++) r = byId.get(r.reply_to); return r.id; };
  for (const m of messages) {
    if (m.id <= since || handled.includes(m.id)) continue;
    const from = familyOf(m.sender); if (!from) continue;
    const to = m.recipient ? familyOf(m.recipient) : other(from);
    if (to !== other(from) || !ASKS.test(m.subject ?? '') || VERDICT.test(m.subject ?? '')) continue;
    const thread = root(m);
    if (messages.some(x => x.id > m.id && familyOf(x.sender) === to && root(x) === thread)) continue;
    return { worker: to, kind: 'mail', message: m.id, thread, from: m.sender, subject: String(m.subject).slice(0, 200) };
  }
  return null;
}

export function mailPrompt(step, { worktree, branch }) {
  return [`You are ${NAME[step.worker]}, working with ${NAME[other(step.worker)]} on the owner's Satisfactory project. The owner is watching live but is not prompting; the hub runs your turns.`,
    `${step.from} sent a request on the shared ledger (agent_pair, project satisfactory-mcp-lab), message #${step.message}: "${step.subject}". Nobody on your side has answered it yet.`,
    `Your worktree is ${worktree} on branch ${branch}. Read AGENTS.md and docs/STATUS.md if you have not this session.`,
    `YOUR STEP: read message #${step.message} and the messages it replies to (pair_read_messages; use after_id to page). Do what it asks within your role. For a review: check exactly the named commit and hashes in your worktree (git fetch is not needed: the repo is local; check out the commit detached), run the tests or reproducers it names, and do not change master. For changes requested of you: first bring your branch up to date (git merge master), then make them on your branch with tests and commit. Never use the game unless the request is a game step that is yours and the hub allows it. Then answer with pair_send_message, reply_to ${step.message}: what you checked or changed (exact commit/hashes) and your verdict.`,
    'End your turn when the reply is sent.'].join('\n\n');
}

export function createConductor({ readMail = null, root, store, workers, worktrees, now = Date.now, log = () => {}, mayOperate = () => true, lease = null, work = null, readMilestones = null, merge = async () => ({ error: 'merging is not configured' }) }) {
  const file = join(root, 'state/studio/conductor.json');
  let state = { enabled: false };
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }; } catch { state.enabled = false; }
  const save = () => { mkdirSync(join(root, 'state/studio'), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); renameSync(file + '.tmp', file); };
  let running = null, waiting = null;
  const stale = new Map(); // jobId → turns that did not change the next step

  function mail() {
    if (!readMail) return null;
    let messages; try { messages = readMail(); } catch { return null; }
    // The first look starts from now: older threads are history, not requests.
    if (state.mailSince == null) { state.mailSince = messages.reduce((m, x) => Math.max(m, x.id), 0); save(); return null; }
    for (;;) {
      const step = pendingRequest(messages, { since: state.mailSince, handled: state.mailHandled ?? [] });
      if (!step) return null;
      if ((state.mailThreads?.[step.thread] ?? 0) < MAX_THREAD_TURNS) return { source: 'mail', job: { id: `mail-${step.message}` }, step };
      state.mailHandled = [...(state.mailHandled ?? []), step.message].slice(-200);
      mailLog(null, 'studio', `Thread #${step.thread} had ${MAX_THREAD_TURNS} automatic turns; message #${step.message} waits for the owner`);
    }
  }
  const mailLog = (...a) => { state.mailLog = [...(state.mailLog ?? []), { t: new Date(now()).toISOString(), who: a[1], text: a[2] }].slice(-30); save(); };

  // Peer requests come first, then design jobs; with none open, the models work on the owner's
  // ACTIVE milestone in build → review cycles (milestone-work.mjs).
  function pick() {
    // Oldest first, but a job whose build waits for game control does not hold up
    // the others: it waits without spending a turn while the next design goes on.
    const open = store.list().filter(j => ['designing', 'agreed', 'building'].includes(j.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of open) {
      const step = nextStep(job);
      if (!step) continue;
      if (step.kind === 'build' && !mayOperate()) { waiting ??= { job: job.id, worker: step.worker, reason: "The build waits for game control: Codex's live session has not handed off yet" }; continue; }
      return { source: 'design', job, step };
    }
    if (!work || !readMilestones) return null;
    const active = readMilestones().find(m => m.status === 'active') ?? null;
    let mj = work.open();
    if (mj && (!active || mj.milestone.id !== active.id)) { work.close(mj.id, active ? 'The owner made another milestone active' : 'The owner completed or paused this milestone'); mj = null; }
    if (!mj && active) {
      const last = work.list().find(j => j.milestone.id === active.id);
      if (last && ['needs-owner', 'stopped'].includes(last.status)) { waiting = { job: last.id, reason: `Milestone work waits for you: ${last.events.at(-1)?.text ?? last.status}` }; return null; }
      mj = work.create({ milestone: active });
    }
    if (!mj) return null;
    const step = nextMilestoneStep(mj);
    return step ? { source: 'milestone', job: mj, step } : null;
  }

  async function tick() {
    if (!state.enabled || running) return null;
    waiting = null;
    const picked = mail() ?? pick();
    if (!picked) return null;
    const { source, job } = picked;
    let step = picked.step;
    const planned = JSON.stringify(step); // progress is judged against the planned step
    const S = source === 'mail'
      ? { get: () => step, log: mailLog, needsOwner: (id, text) => mailLog(id, 'studio', text), next: () => null, prompt: () => mailPrompt(step, worktrees[step.worker]) }
      : source === 'design'
      ? { get: id => store.get(id), log: (...a) => store.log(...a), needsOwner: (...a) => store.needsOwner(...a), next: nextStep, prompt: j => stepPrompt(j, step, worktrees[step.worker]) }
      : { get: id => work.get(id), log: (...a) => work.log(...a), needsOwner: (...a) => work.needsOwner(...a), next: nextMilestoneStep, prompt: j => milestonePrompt(j, step, worktrees[step.worker]) };
    if (step.kind === 'merge') {
      // No model turn: the hub adds the approved step to the team branch.
      const s = job.steps[step.step - 1];
      const result = await merge({ commit: s.commit, message: `Milestone step ${s.n} by ${NAME[s.author]}, reviewed by ${NAME[s.review.author]}: ${s.summary.replace(/\s+/g, ' ').slice(0, 120)}` });
      work.markMerged(job.id, s.n, result);
      return step;
    }
    // A build needs game control; until Codex's live session hands off, wait without spending a turn.
    if (step.kind === 'build' && !mayOperate()) { waiting = { job: job.id, worker: step.worker, reason: "The build waits for game control: Codex's live session has not handed off yet" }; return null; }
    // Either model may build an agreed design (owner, 2026-10-19): when the planned
    // builder is out of usage and the other is not, the other builds; the model that
    // did not build verifies.
    if (step.kind === 'build') {
      const outOfUsage = async n => {
        if ((state.outUntil?.[n] ?? 0) > now()) return true;
        const u = (await workers.get(n).catch(() => null))?.usage;
        return !!(u?.out && (!u.resetsAt || u.resetsAt > now()));
      };
      const alt = other(step.worker);
      if (await outOfUsage(step.worker) && !(await outOfUsage(alt))) {
        S.log(job.id, 'studio', `${NAME[step.worker]} is out of usage, so ${NAME[alt]} builds instead (owner decision 2026-10-19); ${NAME[step.worker]} verifies`);
        step = { ...step, worker: alt };
      }
    }
    const worker = await workers.get(step.worker);
    // A limit hit during an earlier turn outlives that worker process (state.outUntil).
    const until = state.outUntil?.[step.worker] ?? 0;
    const u = until > now() ? { out: true, resetsAt: until } : worker.usage;
    if (u?.out && (!u.resetsAt || u.resetsAt > now())) {
      waiting = { job: job.id, worker: step.worker, reason: `${NAME[step.worker]} is out of usage${u.resetsAt ? ` until ${new Date(u.resetsAt).toLocaleTimeString()}` : ''}` };
      return null;
    }
    if (source === 'mail') { state.mailHandled = [...(state.mailHandled ?? []), step.message].slice(-200); state.mailThreads = { ...state.mailThreads, [step.thread]: (state.mailThreads?.[step.thread] ?? 0) + 1 }; save(); }
    if (step.kind === 'build' && job.status === 'agreed') store.startBuild(job.id);
    const before = planned;
    running = { job: job.id, source, worker: step.worker, kind: step.kind, candidate: step.candidate ?? null, step: step.step ?? null, message: step.message ?? null, startedAt: now() };
    S.log(job.id, 'studio', `${NAME[step.worker]}'s turn: ${step.kind}${step.candidate ? ` (candidate ${step.candidate})` : ''}${step.step ? ` (step ${step.step})` : ''}${step.message ? ` (message #${step.message} from ${step.from})` : ''}`);
    const prompt = S.prompt(S.get(job.id));
    let timer;
    // Stop must end the wait even if the worker never answers.
    const stopped = new Promise((_, reject) => { running.abort = reject; });
    let settledTurn; running.settled = new Promise(r => { settledTurn = r; });
    let ended = 'turn ended', said = '';
    try {
      const result = await Promise.race([worker.run(prompt), stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Turn timed out')), TURN_TIMEOUT_MS); })]);
      S.log(job.id, step.worker, `Turn ${result.status}: ${String(result.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (result.status !== 'completed') said = `${result.text ?? ''} ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? '')}`;
    } catch (error) {
      ended = `turn ended: ${error.message}`; said = error.message;
      S.log(job.id, step.worker, `Turn failed: ${error.message}`);
      // A timed-out or stopped turn may still be running: end the worker process before
      // anything else may touch the game (Codex #652).
      await worker.stop?.().catch(() => {}); workers.forget?.(step.worker);
    } finally {
      clearTimeout(timer);
      running = null;
    }
    // A turn never leaves the game leased behind it. A lease with game requests whose
    // readback was not reported stays as an unresolved transaction for the owner.
    const settled = lease?.settleAfterTurn(step.worker, `${NAME[step.worker]}'s ${ended}`);
    settledTurn();
    if (settled === 'released') S.log(job.id, 'studio', `Released ${NAME[step.worker]}'s unused game lease at the end of its turn`);
    // Only game steps wait on it; milestone and mail work go on (they never use the game).
    if (settled === 'unresolved' && ['build', 'verify'].includes(step.kind)) {
      S.needsOwner(job.id, `${NAME[step.worker]}'s game transaction is unresolved (${ended}). Check the game, then resolve it in the Design studio; nothing is replayed automatically`);
      stale.delete(job.id); log({ job: job.id, step }); return step;
    }
    // A usage limit is not a failed step: the step waits for the reset and runs again
    // by itself (usage is the only brake). A peer request keeps its turn.
    const limit = usageLimit(said, { now: now(), known: worker.usage?.resetsAt });
    if (limit) {
      state.outUntil = { ...state.outUntil, [step.worker]: limit.resetsAt };
      if (source === 'mail') { state.mailHandled = (state.mailHandled ?? []).filter(id => id !== step.message); state.mailThreads = { ...state.mailThreads, [step.thread]: Math.max(0, (state.mailThreads?.[step.thread] ?? 1) - 1) }; }
      save(); stale.delete(job.id);
      S.log(job.id, 'studio', `${NAME[step.worker]} hit its usage limit; its ${step.kind} step resumes by itself at ${new Date(limit.resetsAt).toLocaleTimeString()}${limit.estimated ? ' (reset time not reported; checking again then)' : ''}`);
      log({ job: job.id, step, usageLimit: limit }); return step;
    }
    // A peer request gets one turn; an unanswered one stays visible in the log.
    if (source === 'mail') { log({ job: job.id, step }); return step; }
    // A turn that leaves the same next step has not moved the job forward.
    const again = JSON.stringify(S.next(S.get(job.id)));
    if (again === before) {
      const n = (stale.get(job.id) ?? 0) + 1; stale.set(job.id, n);
      if (n >= 2) { S.needsOwner(job.id, `${NAME[step.worker]} did not finish its ${step.kind} step in two turns`); stale.delete(job.id); }
    } else stale.delete(job.id);
    log({ job: job.id, step });
    return step;
  }

  return {
    tick,
    status: () => ({ enabled: state.enabled, running, waiting, mail: (state.mailLog ?? []).slice(-8) }),
    set(enabled) { state.enabled = !!enabled; save(); return { enabled: state.enabled }; },
    // The owner took game control back: end a running build/verify turn (its worker
    // is stopped and its lease settled) but keep the conductor on for design work.
    async abortGameTurn(reason) {
      const r = running;
      if (!r || !['build', 'verify'].includes(r.kind)) return null;
      r.abort?.(new Error(reason)); await r.settled;
      return { worker: r.worker, kind: r.kind, job: r.job };
    },
    async stop() {
      state.enabled = false; save();
      // Aborting the wait makes tick() stop the worker and settle its game lease.
      // Stop returns once the worker has ended and its lease is settled.
      if (running) { const r = running; r.abort?.(new Error('Stopped by the owner')); await r.settled; }
      return { enabled: false };
    },
  };
}
