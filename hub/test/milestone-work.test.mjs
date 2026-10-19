import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMilestoneWork, nextMilestoneStep, mergeApprovedStep, teamPending, TEAM_BRANCH, STEPS_PER_JOB } from '../lib/milestone-work.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const M = { id: 'm1', title: 'Tunnel lighting powered and placed', notes: 'unit-scale lamps' };
const work = () => { let t = 1000; return createMilestoneWork(mkdtempSync(join(tmpdir(), 'mw-')), { now: () => ++t }); };

test('build → exact-commit review → merge, then the roles swap', () => {
  const w = work(); let job = w.create({ milestone: M });
  assert.deepEqual(nextMilestoneStep(job), { worker: 'codex', kind: 'work' });
  assert.throws(() => w.reportStep(job.id, 'claude', { summary: 'x', commit: 'abcdef1' }), /not claude's turn/);
  w.reportStep(job.id, 'codex', { summary: 'BeamLength instead of scale for tunnel beams', commit: 'abcdef1234', branch: 'codex/auto' });
  assert.deepEqual(nextMilestoneStep(w.get(job.id)), { worker: 'claude', kind: 'review', step: 1 });
  assert.throws(() => w.reviewStep(job.id, 'claude', { step: 1, commit: 'abcdef9999', verdict: 'approve', review: 'ok' }), /exact commit abcdef1234/);
  w.reviewStep(job.id, 'claude', { step: 1, commit: 'abcdef1234', verdict: 'approve', review: 'Tests pass; BeamLength read back' });
  assert.deepEqual(nextMilestoneStep(w.get(job.id)), { worker: 'hub', kind: 'merge', step: 1 });
  job = w.markMerged(job.id, 1, { mergeCommit: 'fedcba9876' });
  assert.deepEqual(nextMilestoneStep(job), { worker: 'claude', kind: 'work' }, 'the reviewer builds next');
});

test('requested changes go back to the builder; a failed merge stops for the owner', () => {
  const w = work(), job = w.create({ milestone: M });
  w.reportStep(job.id, 'codex', { summary: 'A', commit: '1111111' });
  w.reviewStep(job.id, 'claude', { step: 1, commit: '1111111', verdict: 'changes', review: 'Missing test' });
  assert.deepEqual(nextMilestoneStep(w.get(job.id)), { worker: 'codex', kind: 'work', fixing: 1 });
  w.reportStep(job.id, 'codex', { summary: 'A with test', commit: '2222222' });
  assert.equal(w.get(job.id).steps[1].fixing, 1);
  w.reviewStep(job.id, 'claude', { step: 2, commit: '2222222', verdict: 'approve', review: 'ok' });
  const after = w.markMerged(job.id, 2, { error: 'merge conflict' });
  assert.equal(after.status, 'needs-owner');
  assert.equal(nextMilestoneStep(after), null);
});

test(`a job closes after ${STEPS_PER_JOB} merged steps so a fresh one continues`, () => {
  const w = work(), job = w.create({ milestone: M });
  let builder = 'codex';
  for (let i = 1; i <= STEPS_PER_JOB; i++) {
    const c = String(1000000 + i);
    w.reportStep(job.id, builder, { summary: `step ${i}`, commit: c });
    w.reviewStep(job.id, builder === 'codex' ? 'claude' : 'codex', { step: i, commit: c, verdict: 'approve', review: 'ok' });
    w.markMerged(job.id, i, { mergeCommit: c });
    builder = builder === 'codex' ? 'claude' : 'codex';
  }
  assert.equal(w.get(job.id).status, 'closed');
  assert.equal(w.open(), null);
});

test('approved steps go to the team branch, never master; conflicts are aborted', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mwrepo-'));
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@t');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const masterBefore = git(repo, 'rev-parse', 'master');
  git(repo, 'switch', '-q', '-c', 'codex/auto'); writeFileSync(join(repo, 'b.txt'), 'step\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'step 1');
  const step = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'master');
  const worktree = join(repo, 'team-wt');
  const ok = await mergeApprovedStep({ repo, commit: step, message: 'Merge milestone step 1', worktree });
  assert.equal(ok.branch, TEAM_BRANCH);
  assert.equal(git(repo, 'rev-parse', 'master'), masterBefore, 'master is untouched');
  assert.deepEqual((await teamPending({ repo })).map(l => l.split(' ').slice(1).join(' ')), ['Merge milestone step 1']);
  assert.equal((await mergeApprovedStep({ repo, commit: step, message: 'again', worktree })).alreadyMerged, true);
  git(repo, 'switch', '-q', '-c', 'claude/auto', 'master'); writeFileSync(join(repo, 'b.txt'), 'other\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'conflicting step');
  const clash = git(repo, 'rev-parse', 'HEAD'); git(repo, 'switch', '-q', 'master');
  assert.match((await mergeApprovedStep({ repo, commit: clash, message: 'x', worktree })).error, /merge conflict/);
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'the conflict was aborted; the team branch is clean');
  assert.match((await mergeApprovedStep({ repo, commit: 'deadbeef', message: 'x', worktree })).error, /not found/);
});
