import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createShiftTools } from '../lib/shift-tools.mjs';
import { shouldRun, parseSummary, stepPrompt, createBackupShift, SHIFT } from '../lib/backup-shift.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'shift-repo-'));
  git(dir, 'init', '-q', '-b', 'master');
  mkdirSync(join(dir, 'companion/lib'), { recursive: true }); mkdirSync(join(dir, 'companion/test'), { recursive: true }); mkdirSync(join(dir, 'hub'), { recursive: true });
  writeFileSync(join(dir, 'companion/lib/turn.mjs'), 'export const angle = 45;\n');
  writeFileSync(join(dir, 'companion/test/turn.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {angle} from '../lib/turn.mjs';test('angle',()=>assert.equal(angle,90));\n");
  writeFileSync(join(dir, 'hub/.gitignore'), 'state/\n');
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}
const sub = (name, state) => ({ kind: 'subscription', name, status: { state } });
const NOW = 1792380000000;

test('the shift runs only when on, a milestone is active, everyone is out, and not too often', () => {
  const m = { id: 'm', title: 'Turn', status: 'active' };
  const out = [sub('Codex', 'out'), sub('Claude', 'out')];
  assert.equal(shouldRun({ enabled: false, milestone: m, columns: out, outageSteps: 0 }, NOW).run, false);
  assert.equal(shouldRun({ enabled: true, milestone: null, columns: out, outageSteps: 0 }, NOW).reason, 'No active milestone');
  assert.match(shouldRun({ enabled: true, milestone: m, columns: [sub('Codex', 'out'), sub('Claude', 'working')], outageSteps: 0 }, NOW).reason, /Claude still has usage/);
  assert.equal(shouldRun({ enabled: true, running: {}, milestone: m, columns: out, outageSteps: 0 }, NOW).run, false);
  assert.match(shouldRun({ enabled: true, milestone: m, columns: out, outageSteps: 0, lastStepAt: NOW - 60000 }, NOW).reason, /Next step after/);
  assert.match(shouldRun({ enabled: true, milestone: m, columns: out, outageSteps: SHIFT.maxStepsPerOutage }, NOW).reason, /Paused after/);
  assert.equal(shouldRun({ enabled: true, milestone: m, columns: out, outageSteps: 0, lastStepAt: NOW - SHIFT.cooldownMs }, NOW).run, true);
});

test('the step prompt carries the milestone and the summary is read back', () => {
  const p = stepPrompt({ title: 'Sweeping turn', notes: 'join the walled tunnel' }, [{ summary: 'added a test' }]);
  assert.match(p, /Active milestone: Sweeping turn\nOwner notes: join the walled tunnel/);
  assert.match(p, /- added a test/);
  assert.deepEqual(parseSummary('Done.\nCHANGED: fixed the angle\nREVIEW: check turn.mjs'), { changed: 'fixed the angle', review: 'check turn.mjs' });
  assert.equal(parseSummary('').changed, 'No summary');
});

test('shift tools stay inside the worktree and only edit source folders', async () => {
  const dir = repo(), events = [];
  const t = createShiftTools({ worktree: dir, onEvent: e => events.push(e) });
  const read = await t.dispatch('shift_read_file', { path: 'companion/lib/turn.mjs' });
  assert.equal(read.text, '1: export const angle = 45;\n2: ');
  assert.match((await t.dispatch('shift_read_file', { path: '../outside.mjs' })).error, /literal repo path/);
  assert.match((await t.dispatch('shift_read_file', { path: 'companion/node_modules/x.js' })).error, /not part of the shift workspace/);
  assert.match((await t.dispatch('shift_edit_file', { path: 'README.md', expected_sha256: null, content: 'x' })).error, /limited to text files under/);
  assert.match((await t.dispatch('shift_edit_file', { path: 'companion/lib/turn.mjs', expected_sha256: 'stale', old_text: '45', new_text: '90' })).error, /read it again/);
  const edit = await t.dispatch('shift_edit_file', { path: 'companion/lib/turn.mjs', expected_sha256: read.sha256, old_text: '45', new_text: '90' });
  assert.equal(edit.written, true);
  assert.equal(readFileSync(join(dir, 'companion/lib/turn.mjs'), 'utf8'), 'export const angle = 90;\n');
  const ran = await t.dispatch('shift_run_test', { path: 'companion/test/turn.test.mjs' });
  assert.equal(ran.passed, true);
  assert.match((await t.dispatch('shift_run_test', { path: 'companion/lib/turn.mjs' })).error, /one test file/);
  assert.match(await t.context(), /branch master/);
  assert.ok(events.some(e => e.kind === 'tool' && e.text === 'shift_edit_file: companion/lib/turn.mjs'));
});

test('a shift step works in its own branch, commits, asks for review, and shows as needing review until merged', async () => {
  const dir = repo(), hub = join(dir, 'hub'), reviews = [];
  let t = NOW;
  const shift = createBackupShift({ root: hub, repo: dir, now: () => t,
    readColumns: () => [sub('Codex', 'out'), sub('Claude', 'out')],
    readMilestones: () => [{ id: 'm1', title: 'Sweeping turn', status: 'active' }],
    postReview: async r => { reviews.push(r); },
    runnerFor: ({ worktree, onEvent }) => async () => {
      const tools = createShiftTools({ worktree, onEvent });
      const r = await tools.dispatch('shift_read_file', { path: 'companion/lib/turn.mjs' });
      await tools.dispatch('shift_edit_file', { path: 'companion/lib/turn.mjs', expected_sha256: r.sha256, old_text: '45', new_text: '90' });
      return { content: 'CHANGED: set the turn angle to 90\nREVIEW: check turn.mjs' };
    } });
  assert.equal(await shift.tick(), null, 'off by default');
  await shift.set(true);
  const step = await shift.tick();
  assert.equal(step.outcome, 'done');
  assert.equal(git(join(dir, 'hub/workspaces/local-shift'), 'branch', '--show-current'), 'local/shift');
  assert.equal(git(dir, 'log', '-1', '--format=%an|%s', 'local/shift'), 'HauhauCS (local)|HauhauCS shift step: set the turn angle to 90');
  assert.equal(readFileSync(join(dir, 'companion/lib/turn.mjs'), 'utf8'), 'export const angle = 45;\n', 'master is untouched');
  assert.equal(reviews[0].commit, step.commit);
  let s = await shift.status();
  assert.equal(s.needsReview.length, 1);
  assert.equal(await shift.tick(), null, 'cooldown');
  git(dir, 'merge', '-q', 'local/shift');
  s = await shift.status();
  assert.equal(s.needsReview.length, 0, 'merged by a reviewer');
  const log = readFileSync(join(hub, 'state/team/local-events.jsonl'), 'utf8');
  assert.match(log, /Backup shift started on: Sweeping turn/);
  assert.match(log, /review requested/);
});

test('Stop aborts a running step and turns the shift off', async () => {
  const dir = repo(), hub = join(dir, 'hub');
  let release;
  const shift = createBackupShift({ root: hub, repo: dir, readColumns: () => [sub('Codex', 'out'), sub('Claude', 'out')],
    readMilestones: () => [{ id: 'm1', title: 'Turn', status: 'active' }], postReview: async () => {},
    runnerFor: () => ({ signal }) => new Promise((_, reject) => { release = reject; signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  await shift.set(true);
  const pending = shift.tick();
  await new Promise(r => setTimeout(r, 300));
  assert.ok((await shift.status()).running);
  await shift.stop();
  const step = await pending;
  assert.equal(step.outcome, 'stopped');
  const s = await shift.status();
  assert.equal(s.enabled, false);
  assert.equal(s.running, null);
  assert.ok(existsSync(join(hub, 'state/team/shift.json')));
});

test('reads stay small enough for the local model\'s 8K context', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'companion/lib/big.mjs'), Array.from({ length: 400 }, (_, i) => `export const line${i} = '${'x'.repeat(120)}';`).join('\n'));
  const t = createShiftTools({ worktree: dir });
  const r = await t.dispatch('shift_read_file', { path: 'companion/lib/big.mjs' });
  assert.ok(r.text.length <= 3500);
  assert.equal(r.more, true);
  assert.match((await t.dispatch('shift_read_file', { path: 'companion/lib/big.mjs', start: 1, end: 200 })).error, /1\.\.80/);
});
