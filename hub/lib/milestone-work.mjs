// Milestone work the conductor runs with nobody prompting: when no design job is
// open and the owner has an ACTIVE milestone, the models take turns. One builds
// the next concrete step on its own branch and commits it; the other reviews
// that exact commit; an approved step is merged into the team branch (team/auto)
// by the hub; then the roles swap. The owner merges team/auto into master. It runs until the owner completes or changes the milestone or
// presses Stop. Jobs live under state/studio/milestone-jobs/<id>/job.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const STEPS_PER_JOB = 12; // then a fresh job starts, so history stays readable
const exec = promisify(execFile);
const bad = (m, statusCode = 400) => Object.assign(new Error(m), { statusCode });
const other = w => w === 'codex' ? 'claude' : 'codex';
const text = (v, max, field) => { if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`); const s = v.trim(); if (s.length > max) throw bad(`${field} is longer than ${max} characters`); return s; };
const COMMIT = /^[0-9a-f]{7,40}$/;

export function nextMilestoneStep(job) {
  if (!job || job.status !== 'working') return null;
  const last = job.steps.at(-1);
  if (!last) return { worker: job.firstBuilder, kind: 'work' };
  if (!last.review) return { worker: other(last.author), kind: 'review', step: last.n };
  if (last.review.verdict === 'changes') return { worker: last.author, kind: 'work', fixing: last.n };
  if (!last.merged) return { worker: 'hub', kind: 'merge', step: last.n };
  if (last.merged.error) return null;
  if (job.steps.length >= STEPS_PER_JOB) return null;
  return { worker: other(last.author), kind: 'work' }; // builders alternate: both models build and review
}

export function createMilestoneWork(root, { now = Date.now } = {}) {
  const base = join(root, 'state/studio/milestone-jobs');
  const dir = id => { if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw bad('Unknown milestone job', 404); return join(base, id); };
  const load = id => { const f = join(dir(id), 'job.json'); if (!existsSync(f)) throw bad('Unknown milestone job', 404); return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); };
  const save = job => { const d = dir(job.id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'job.json.tmp'), JSON.stringify(job, null, 2) + '\n'); renameSync(join(d, 'job.json.tmp'), join(d, 'job.json')); return job; };
  const log = (job, who, line) => { job.events.push({ t: now(), who, text: String(line).slice(0, 500) }); job.events = job.events.slice(-300); job.updatedAt = new Date(now()).toISOString(); };
  return {
    list() { if (!existsSync(base)) return []; return readdirSync(base).filter(n => existsSync(join(base, n, 'job.json'))).map(load).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    get: load,
    open() { return this.list().find(j => j.status === 'working') ?? null; },
    create({ milestone, firstBuilder = 'codex' }) {
      if (!milestone?.id || !milestone?.title) throw bad('A milestone is required');
      const job = { id: randomUUID(), kind: 'milestone', milestone: { id: milestone.id, title: milestone.title, notes: milestone.notes ?? '' }, firstBuilder, status: 'working',
        createdAt: new Date(now()).toISOString(), steps: [], events: [] };
      log(job, 'studio', `Working on the active milestone: ${milestone.title}`);
      return save(job);
    },
    reportStep(id, author, { summary, commit, branch }) {
      const job = load(id), step = nextMilestoneStep(job);
      if (!step || step.kind !== 'work' || step.worker !== author) throw bad(`It is not ${author}'s turn to build`, 409);
      if (!COMMIT.test(commit ?? '')) throw bad('commit must be the hash of the commit you made on your branch');
      job.steps.push({ n: job.steps.length + 1, author, branch: typeof branch === 'string' ? branch.slice(0, 120) : null, commit, summary: text(summary, 4000, 'Summary'), fixing: step.fixing ?? null, at: now(), review: null, merged: null });
      log(job, author, `Step ${job.steps.length}${step.fixing ? ` (fixes step ${step.fixing})` : ''}: ${commit.slice(0, 7)} ${job.steps.at(-1).summary.slice(0, 200)}`);
      return save(job);
    },
    reviewStep(id, author, { step: n, commit, verdict, review }) {
      const job = load(id), next = nextMilestoneStep(job);
      if (!next || next.kind !== 'review' || next.worker !== author || next.step !== Number(n)) throw bad(`It is not ${author}'s turn to review step ${n}`, 409);
      const s = job.steps[Number(n) - 1];
      // Exact-source review: the reviewer quotes the commit it reviewed.
      if (commit !== s.commit) throw bad(`Review the exact commit ${s.commit}; you quoted ${commit ?? 'none'}`, 409);
      if (!['approve', 'changes'].includes(verdict)) throw bad('verdict is approve or changes');
      s.review = { author, verdict, text: text(review, 6000, 'Review'), at: now() };
      log(job, author, `${verdict === 'approve' ? 'Approves' : 'Requests changes to'} step ${n} (${s.commit.slice(0, 7)})`);
      return save(job);
    },
    markMerged(id, n, result) {
      const job = load(id), s = job.steps[Number(n) - 1];
      s.merged = { at: now(), ...result };
      if (result.error) { job.status = 'needs-owner'; log(job, 'hub', `Could not merge step ${n}: ${result.error}`); }
      else log(job, 'hub', `Merged step ${n} into ${TEAM_BRANCH} (${String(result.mergeCommit ?? '').slice(0, 7)}); master waits for the owner`);
      if (!result.error && job.steps.length >= STEPS_PER_JOB) { job.status = 'closed'; log(job, 'studio', `Closed after ${STEPS_PER_JOB} steps; the next job continues the milestone`); }
      return save(job);
    },
    close(id, reason) { const job = load(id); job.status = 'closed'; log(job, 'studio', reason); return save(job); },
    needsOwner(id, reason) { const job = load(id); job.status = 'needs-owner'; log(job, 'studio', reason); return save(job); },
    stop(id) { const job = load(id); job.status = 'stopped'; log(job, 'owner', 'Stopped'); return save(job); },
    log(id, who, line) { const job = load(id); log(job, who, line); return save(job); },
  };
}

// Approved steps go to the team branch, never straight to master: the models
// keep building on each other's reviewed work there, and the owner decides when
// team/auto goes into master. The merge runs in a dedicated worktree
// (hub/workspaces/team-auto); any conflict is aborted and handed to the owner.
export const TEAM_BRANCH = 'team/auto';
export async function mergeApprovedStep({ repo, commit, message, worktree = join(repo, 'hub/workspaces/team-auto'), git = (args, cwd) => exec('git', args, { cwd, windowsHide: true, timeout: 120000 }) }) {
  const at = async (cwd, args) => (await git(args, cwd)).stdout.trim();
  try { await at(repo, ['cat-file', '-e', `${commit}^{commit}`]); } catch { return { error: `commit ${commit} not found` }; }
  if (!existsSync(join(worktree, '.git'))) {
    let exists = false; try { await at(repo, ['rev-parse', '--verify', `refs/heads/${TEAM_BRANCH}`]); exists = true; } catch { /* first step */ }
    await at(repo, exists ? ['worktree', 'add', worktree, TEAM_BRANCH] : ['worktree', 'add', '-b', TEAM_BRANCH, worktree, 'master']);
  }
  if (await at(worktree, ['status', '--porcelain', '--untracked-files=no'])) return { error: 'the team worktree has uncommitted changes' };
  try { await at(worktree, ['merge-base', '--is-ancestor', commit, 'HEAD']); return { mergeCommit: await at(worktree, ['rev-parse', 'HEAD']), alreadyMerged: true }; } catch { /* not merged yet */ }
  try { await at(worktree, ['-c', 'user.name=Copilot conductor', '-c', 'user.email=conductor@localhost', 'merge', '--no-ff', '-m', message, commit]); return { mergeCommit: await at(worktree, ['rev-parse', 'HEAD']), branch: TEAM_BRANCH }; }
  catch (e) { try { await at(worktree, ['merge', '--abort']); } catch { /* nothing to abort */ } return { error: `merge conflict or failure: ${String(e.stderr || e.message).slice(0, 300)}` }; }
}

// The owner's action (a button in the Design studio): bring the reviewed team
// work into master in the main checkout. Only on a clean master; a conflict is
// aborted and reported, never resolved blindly.
export async function mergeTeamIntoMaster({ repo, git = (args, cwd) => exec('git', args, { cwd, windowsHide: true, timeout: 120000 }) }) {
  const out = async args => (await git(args, repo)).stdout.trim();
  try { await out(['rev-parse', '--verify', `refs/heads/${TEAM_BRANCH}`]); } catch { return { error: 'There is no team work yet' }; }
  if (await out(['branch', '--show-current']) !== 'master') return { error: 'The main checkout is not on master' };
  if (await out(['status', '--porcelain', '--untracked-files=no'])) return { error: 'The main checkout has uncommitted changes' };
  const pending = (await out(['log', '--first-parent', '--format=%h %s', `master..${TEAM_BRANCH}`])).split('\n').filter(Boolean);
  if (!pending.length) return { merged: 0, mergeCommit: await out(['rev-parse', 'HEAD']) };
  try { await out(['merge', '--no-ff', '-m', `Merge reviewed team work (${TEAM_BRANCH}), approved by the owner\n\n${pending.join('\n')}`, TEAM_BRANCH]); return { merged: pending.length, mergeCommit: await out(['rev-parse', 'HEAD']) }; }
  catch (e) { try { await out(['merge', '--abort']); } catch { /* nothing to abort */ } return { error: `Merge conflict: ${String(e.stderr || e.message).slice(0, 300)}` }; }
}

// What is reviewed on team/auto but not yet in master, for the owner to decide on.
export async function teamPending({ repo, git = (args, cwd) => exec('git', args, { cwd, windowsHide: true, timeout: 60000 }) }) {
  try { const { stdout } = await git(['log', '--first-parent', '--format=%h %s', `master..${TEAM_BRANCH}`], repo); return stdout.trim().split('\n').filter(Boolean); }
  catch { return []; }
}
