// The local model's backup shift. When the owner has it on, a milestone is
// active and every subscription model is out of usage, the local model takes
// ONE small step toward the milestone in its own worktree (branch local/shift).
// The engine commits the step and asks the team for review; it never merges,
// pushes or touches the game. Off by default; Stop aborts and turns it off.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export const SHIFT = { cooldownMs: 15 * 60000, maxStepsPerOutage: 8, branch: 'local/shift', model: 'copilot-hauhau-game:latest' };

// Pure decision, so the rules are easy to test and to read.
export function shouldRun({ enabled, running, milestone, columns, lastStepAt, outageSteps }, now = Date.now()) {
  if (!enabled) return { run: false, reason: 'The shift is off' };
  if (running) return { run: false, reason: 'A step is running' };
  if (!milestone) return { run: false, reason: 'No active milestone' };
  const subs = columns.filter(c => c.kind === 'subscription');
  const busy = subs.filter(c => c.status.state !== 'out');
  if (!subs.length || busy.length) return { run: false, reason: `Waiting: ${busy.map(c => c.name).join(' and ') || 'no subscription models'} still ${busy.length === 1 ? 'has' : 'have'} usage` };
  if (outageSteps >= SHIFT.maxStepsPerOutage) return { run: false, reason: `Paused after ${SHIFT.maxStepsPerOutage} steps in this outage` };
  if (lastStepAt && now - lastStepAt < SHIFT.cooldownMs) return { run: false, reason: `Next step after ${new Date(lastStepAt + SHIFT.cooldownMs).toLocaleTimeString()}` };
  return { run: true, reason: 'Every subscription model is out of usage' };
}

export function stepPrompt(milestone, previous) {
  return [
    'BACKUP SHIFT. Claude and Codex are out of usage, so you are working alone for now. Everything you do is reviewed by them before it is merged.',
    `Active milestone: ${milestone.title}${milestone.notes ? `\nOwner notes: ${milestone.notes}` : ''}`,
    `Earlier shift steps: ${previous.length ? previous.map(s => `- ${s.summary}`).join('\n') : 'none yet'}`,
    'Do ONE small, verifiable step toward this milestone that does not need the running game: for example a focused test for existing code, a small fix with a test, or a short write-up in docs/ of something you checked in the code. Look around with shift_list_files and shift_read_file first; shift_read_file gives the sha256 that shift_edit_file needs. Keep the change small. If you changed code, run its test with shift_run_test.',
    'Finish with exactly two lines:\nCHANGED: <what you changed, or nothing>\nREVIEW: <what a reviewer should check>',
  ].join('\n\n');
}

export function parseSummary(text) {
  const changed = String(text).match(/^\s*CHANGED:\s*(.+)$/im)?.[1]?.trim();
  const review = String(text).match(/^\s*REVIEW:\s*(.+)$/im)?.[1]?.trim();
  return { changed: (changed || String(text).trim().split('\n')[0] || 'No summary').slice(0, 200), review: (review || 'Check the diff and its test').slice(0, 300) };
}

export function createBackupShift({ root, repo, runnerFor, readColumns, readMilestones, postReview, node = process.execPath, now = Date.now, git = (args, cwd) => exec('git', args, { cwd, windowsHide: true, timeout: 60000 }) }) {
  const dir = join(root, 'state/team'), file = join(dir, 'shift.json'), events = join(dir, 'local-events.jsonl');
  const worktree = join(repo, 'hub/workspaces/local-shift');
  let state = { enabled: false, steps: [], lastStepAt: null, outageSteps: 0 };
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }; } catch { /* corrupt → off */ state.enabled = false; }
  let running = null, lastDecision = { run: false, reason: 'Not checked yet' };
  const save = () => { mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n'); renameSync(tmp, file); };
  const event = e => { mkdirSync(dir, { recursive: true }); appendFileSync(events, JSON.stringify({ t: now(), model: SHIFT.model, ...e }) + '\n'); };

  async function ensureWorktree() {
    if (existsSync(join(worktree, '.git'))) return;
    const { stdout } = await git(['branch', '--list', SHIFT.branch], repo);
    await git(stdout.trim() ? ['worktree', 'add', worktree, SHIFT.branch] : ['worktree', 'add', '-b', SHIFT.branch, worktree, 'master'], repo);
    // Its own copy of the companion's dependencies so tests run there. A copy,
    // not a link: deleting the worktree later can never reach the real folder.
    const deps = join(repo, 'companion/node_modules');
    if (existsSync(deps)) cpSync(deps, join(worktree, 'companion/node_modules'), { recursive: true });
  }

  async function runStep(milestone) {
    const controller = new AbortController(), id = randomUUID();
    running = { id, startedAt: now(), milestone: milestone.title, controller };
    const step = { id, startedAt: new Date(now()).toISOString(), milestoneId: milestone.id, milestone: milestone.title };
    event({ kind: 'turn', text: `Backup shift started on: ${milestone.title}` });
    try {
      await ensureWorktree();
      const run = runnerFor({ worktree, onEvent: event });
      event({ kind: 'prompt', text: `One step toward "${milestone.title}"` });
      const result = await run({ messages: [{ role: 'user', content: stepPrompt(milestone, state.steps.filter(s => s.commit).slice(-3)) }], signal: controller.signal, conversationId: `shift-${id.slice(0, 8)}` });
      const summary = parseSummary(result.content);
      event({ kind: 'say', text: `${summary.changed} · Review: ${summary.review}` });
      const { stdout: changes } = await git(['status', '--porcelain'], worktree);
      if (changes.trim()) {
        await git(['add', '-A', '--', ...['companion', 'hub', 'docs', 'scripts', 'Source'].filter(d => existsSync(join(worktree, d)))], worktree);
        await git(['-c', 'user.name=HauhauCS (local)', '-c', 'user.email=local-model@localhost', 'commit', '-q', '-m',
          `HauhauCS shift step: ${summary.changed}\n\nMilestone: ${milestone.title}\nReview: ${summary.review}\n\nMade by the local model during a backup shift (Claude and Codex out of usage). Not reviewed yet.`], worktree);
        step.commit = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
        try { await postReview({ commit: step.commit, branch: SHIFT.branch, milestone: milestone.title, ...summary }); step.reviewRequested = true; }
        catch (e) { step.reviewRequested = false; event({ kind: 'turn', text: `Review request not posted: ${e.message}`, error: true }); }
        event({ kind: 'turn', text: `Committed ${step.commit.slice(0, 7)} on ${SHIFT.branch}; review requested` });
      } else event({ kind: 'turn', text: 'No files changed in this step' });
      Object.assign(step, { outcome: 'done', summary: summary.changed, review: summary.review });
    } catch (error) {
      const stopped = controller.signal.aborted;
      Object.assign(step, { outcome: stopped ? 'stopped' : 'failed', summary: String(error?.message ?? error).slice(0, 200) });
      event({ kind: 'turn', text: stopped ? 'Stopped by the owner' : `Step failed: ${step.summary}`, error: !stopped });
    } finally {
      step.finishedAt = new Date(now()).toISOString();
      state.steps = [...state.steps, step].slice(-50);
      state.lastStepAt = now(); state.outageSteps += 1;
      running = null; save();
    }
    return step;
  }

  return {
    async tick() {
      const columns = readColumns();
      if (columns.filter(c => c.kind === 'subscription').some(c => c.status.state !== 'out') && state.outageSteps) { state.outageSteps = 0; save(); }
      const milestone = readMilestones().find(m => m.status === 'active');
      lastDecision = shouldRun({ ...state, running, milestone, columns }, now());
      if (!lastDecision.run) return null;
      return runStep(milestone);
    },
    set(enabled) { state.enabled = !!enabled; if (!enabled) running?.controller.abort(); save(); return this.status(); },
    stop() { running?.controller.abort(); state.enabled = false; save(); return this.status(); },
    async status() {
      const pending = [];
      for (const s of state.steps.filter(x => x.commit).slice(-10)) {
        let merged = false;
        try { await git(['merge-base', '--is-ancestor', s.commit, 'master'], repo); merged = true; } catch { /* not in master yet */ }
        if (!merged) pending.push({ commit: s.commit, summary: s.summary, review: s.review, at: s.finishedAt });
      }
      return { enabled: state.enabled, running: running ? { startedAt: new Date(running.startedAt).toISOString(), milestone: running.milestone } : null,
        decision: lastDecision.reason, branch: SHIFT.branch, needsReview: pending, lastStep: state.steps.at(-1) ?? null };
    },
    eventsFile: events,
  };
}
