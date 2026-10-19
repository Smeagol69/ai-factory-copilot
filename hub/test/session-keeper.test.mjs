import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStalled, createSessionKeeper, RESUME_PROMPT } from '../lib/session-keeper.mjs';

const REPO = 'C:\\Users\\owner\\Documents\\satisfactory';
const STOP = new Date(2026, 9, 19, 8, 48, 45);
const ev = (t, payload, ordinal) => JSON.stringify({ timestamp: new Date(t).toISOString(), ordinal, type: 'event_msg', payload });
// A Codex rollout like the owner's: working on the project, then stopped by the usage limit.
function rollout(sessions, id, { cwd = join(REPO, 'hub', 'workspaces', 'auto-codex'), parent = null, stopped = true, message = "You've hit your usage limit. Upgrade to Pro or try again at 10:47 AM.", limits = null } = {}) {
  const dir = join(sessions, '2026', '10', '19'); mkdirSync(dir, { recursive: true });
  const f = join(dir, `rollout-2026-10-19T00-37-13-${id}.jsonl`);
  const rows = [JSON.stringify({ timestamp: new Date(STOP - 3600000).toISOString(), type: 'session_meta', payload: { id, cwd, originator: 'copilot_conductor', ...(parent ? { parent_thread_id: parent, thread_source: 'subagent' } : {}) } }),
    ev(STOP - 600000, { type: 'task_started' }, 10)];
  if (limits) rows.push(ev(STOP - 1000, { type: 'token_count', rate_limits: limits }, 11));
  rows.push(stopped ? ev(STOP, { type: 'task_complete', last_agent_message: null, error: { message, codex_error_info: 'usage_limit_exceeded' } }, 12) : ev(STOP, { type: 'task_complete', last_agent_message: 'done' }, 12));
  writeFileSync(f, rows.join('\n') + '\n');
  return f;
}

test('finds project Codex threads stopped by the usage limit, with the reset from the message or the full window', () => {
  const sessions = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  rollout(sessions, 'stalled-1');
  rollout(sessions, 'finished-2', { stopped: false });
  rollout(sessions, 'elsewhere-3', { cwd: 'C:\\Users\\owner\\Documents\\other-project' });
  rollout(sessions, 'subagent-5', { parent: 'stalled-1' });
  rollout(sessions, 'weekly-4', { message: "You've hit your usage limit.", limits: { primary: { used_percent: 12, resets_at: 1 }, secondary: { used_percent: 100, resets_at: Math.floor(new Date(2026, 9, 23, 9, 0) / 1000) } } });
  const now = new Date(2026, 9, 19, 9, 0).getTime();
  const found = Object.fromEntries(findStalled({ repo: REPO, sessionsDir: sessions, now }).map(t => [t.threadId, t]));
  assert.deepEqual(Object.keys(found).sort(), ['stalled-1', 'weekly-4'], 'finished, other-project and sub-agent threads are left alone');
  assert.equal(new Date(found['stalled-1'].resetsAt).getHours(), 10);
  assert.equal(new Date(found['stalled-1'].resetsAt).getMinutes(), 47);
  assert.equal(new Date(found['weekly-4'].resetsAt).getDate(), 23, 'a full weekly window waits for the weekly reset');
});

test('after the reset the keeper resumes the stalled thread once, with the continue message, and never twice for the same stop', async () => {
  const sessions = mkdtempSync(join(tmpdir(), 'codex-sessions-')), root = mkdtempSync(join(tmpdir(), 'keeper-'));
  const f = rollout(sessions, 'stalled-1');
  let t = new Date(2026, 9, 19, 10, 0).getTime();
  const resumed = [];
  const keeper = createSessionKeeper({ root, repo: REPO, now: () => t, find: o => findStalled({ ...o, sessionsDir: sessions }),
    resume: async thread => { resumed.push(thread.threadId); return { status: 'completed', text: 'continued' }; } });
  assert.deepEqual(await keeper.tick(), [], 'before the reset nothing is resumed');
  assert.equal(keeper.status().waiting[0].threadId, 'stalled-1');
  t = new Date(2026, 9, 19, 10, 49).getTime();
  assert.deepEqual(await keeper.tick(), ['stalled-1']);
  await keeper.settled();
  assert.deepEqual(resumed, ['stalled-1']);
  assert.equal(keeper.status().last.status, 'completed');
  assert.deepEqual(await keeper.tick(), [], 'the same stop is not resumed again');
  // A restarted hub remembers it too.
  const again = createSessionKeeper({ root, repo: REPO, now: () => t, find: o => findStalled({ ...o, sessionsDir: sessions }), resume: async () => { resumed.push('again'); } });
  assert.deepEqual(await again.tick(), []);
  // If the resumed turn runs out again, that is a new stop and it is resumed after its own reset.
  appendFileSync(f, ev(t + 60000, { type: 'task_started' }, 13) + '\n' + ev(t + 120000, { type: 'task_complete', error: { message: "You've hit your usage limit. Try again at 3:10 PM.", codex_error_info: 'usage_limit_exceeded' } }, 14) + '\n');
  t = new Date(2026, 9, 19, 15, 12).getTime();
  assert.deepEqual(await again.tick(), ['stalled-1']);
  await again.settled();
  assert.deepEqual(resumed, ['stalled-1', 'again']);
});

test('the keeper can be switched off, and its message tells the model to carry on, not start over', async () => {
  const sessions = mkdtempSync(join(tmpdir(), 'codex-sessions-')), root = mkdtempSync(join(tmpdir(), 'keeper-'));
  rollout(sessions, 'stalled-1');
  const keeper = createSessionKeeper({ root, repo: REPO, now: () => new Date(2026, 9, 19, 11, 0).getTime(), find: o => findStalled({ ...o, sessionsDir: sessions }), resume: async () => { throw new Error('must not run'); } });
  keeper.set(false);
  assert.deepEqual(await keeper.tick(), []);
  assert.match(RESUME_PROMPT, /Continue exactly where you left off/);
});
