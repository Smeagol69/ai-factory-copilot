import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, tailLines, summariseTool, parseCodex, parseClaude, createFeedReader, columnStatus, inProject } from '../lib/team-feeds.mjs';

const ROOT = 'C:\\Users\\owner\\Documents\\satisfactory';
const iso = s => new Date(Date.UTC(2026, 9, 19, 2, 30, s)).toISOString();
const NOW = Date.UTC(2026, 9, 19, 2, 31, 0);

test('key-shaped strings are redacted', () => {
  assert.equal(redact('key sk-ant-abcdefghijklmnop1234 and AIzaSyA1234567890123456789012345678901 ok'), 'key [redacted] and [redacted] ok');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx'), 'Authorization: Bearer [redacted]');
});

test('project folders match by prefix, including the legacy satisfactory-* folders', () => {
  assert.ok(inProject('C:\\Users\\owner\\Documents\\satisfactory\\hub', [ROOT]));
  assert.ok(inProject('c:/users/owner/documents/satisfactory-mcp-lab', [ROOT]));
  assert.ok(!inProject('C:\\Users\\owner\\Documents\\civ6-copilot', [ROOT]));
  assert.ok(!inProject(null, [ROOT]));
});

test('only the tail of a large file is read and the cut first line is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-')), file = join(dir, 'big.jsonl');
  writeFileSync(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
  const lines = tailLines(file, undefined, 1000);
  assert.ok(lines.length < 120);
  assert.equal(JSON.parse(lines.at(-1)).i, 1999);
  assert.doesNotThrow(() => lines.forEach(l => JSON.parse(l)));
});

test('tool calls are summarised by description, command, file or Codex exec cmd', () => {
  assert.equal(summariseTool('Bash', { command: 'git status', description: 'Show status' }), 'Bash: Show status');
  assert.equal(summariseTool('Edit', { file_path: 'C:\\a\\b\\c\\d.mjs' }), 'Edit: b/c/d.mjs');
  assert.equal(summariseTool('exec', 'text(await tools.exec_command({cmd:"git log -4 --oneline",workdir:"x"}))'), 'exec: git log -4 --oneline');
  assert.equal(summariseTool('mcp__agent_pair__pair_send_message', { subject: 'hi' }), 'pair_send_message: subject=hi');
});

const codexLines = [
  { timestamp: iso(1), type: 'session_meta', payload: { id: 'abc123', cwd: ROOT } },
  { timestamp: iso(2), type: 'event_msg', payload: { type: 'task_started' } },
  { timestamp: iso(3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions…' }] } },
  { timestamp: iso(4), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Make a 90 degree sweeping turn' }] } },
  { timestamp: iso(5), type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret' } },
  { timestamp: iso(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will match the walled tunnel.' }] } },
  { timestamp: iso(7), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'tools.exec_command({cmd:"npm test"})' } },
  { timestamp: iso(8), type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Error: 1 failed' }] } },
  { timestamp: iso(9), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, resets_at: NOW / 1000 + 3600 }, secondary: { used_percent: 63, resets_at: NOW / 1000 + 86400 } } } },
  { timestamp: iso(10), type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You’ve hit your usage limit. Try again at 1 AM.' } } },
].map(j => JSON.stringify(j));

test('Codex events: prompt, words, tools, results, usage and limit; never reasoning or injected context', () => {
  const v = parseCodex(codexLines);
  assert.deepEqual(v.events.map(e => e.kind), ['turn', 'prompt', 'say', 'tool', 'result', 'turn']);
  assert.equal(v.events[1].text, 'Make a 90 degree sweeping turn');
  assert.equal(v.events[3].text, 'exec: npm test');
  assert.equal(v.events[4].error, true);
  assert.ok(!JSON.stringify(v).includes('secret'));
  assert.equal(v.usage.usedPercent, 100);
  assert.equal(v.usage.resetsAt, NOW + 3600000);
  assert.equal(v.limitAt, Date.parse(iso(10)));
});

const claudeLines = [
  { type: 'custom-title', customTitle: 'Team room build' },
  { type: 'user', cwd: 'C:\\Users\\owner\\Documents\\civ6-copilot', timestamp: iso(1), message: { role: 'user', content: 'other project' } },
  { type: 'user', cwd: ROOT, sessionId: 's1234567', timestamp: iso(2), message: { role: 'user', content: 'Keep working' } },
  { type: 'assistant', cwd: ROOT, timestamp: iso(3), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thoughts' }] } },
  { type: 'assistant', cwd: ROOT, timestamp: iso(4), message: { role: 'assistant', content: [{ type: 'text', text: 'Building the feed reader.' }] } },
  { type: 'assistant', cwd: ROOT, timestamp: iso(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, wireToolInputs: { t1: { command: 'ls', description: 'List files' } } },
  { type: 'user', cwd: ROOT, timestamp: iso(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] } },
  { type: 'assistant', cwd: ROOT, timestamp: iso(7), isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Claude AI usage limit reached' }] } },
].map(j => JSON.stringify(j));

test('Claude events: only this project, never thinking, tool input from the wire copy, usage limit', () => {
  const v = parseClaude(claudeLines, [ROOT]);
  assert.equal(v.title, 'Team room build');
  assert.deepEqual(v.events.map(e => e.kind), ['prompt', 'say', 'tool', 'result', 'turn']);
  assert.equal(v.events[2].text, 'Bash: List files');
  assert.ok(!JSON.stringify(v).includes('private thoughts'));
  assert.ok(!JSON.stringify(v).includes('other project'));
  assert.equal(v.limitAt, Date.parse(iso(7)));
});

test('the reader finds recent sessions in this project, merges and caches them', () => {
  const home = mkdtempSync(join(tmpdir(), 'homes-'));
  const codexDir = join(home, 'codex', 'sessions', '2026', '10', '19'), claudeDir = join(home, 'claude', 'projects', 'C--x');
  mkdirSync(codexDir, { recursive: true }); mkdirSync(claudeDir, { recursive: true });
  const rollout = join(codexDir, 'rollout-a.jsonl');
  writeFileSync(rollout, codexLines.join('\n') + '\n');
  const other = join(codexDir, 'rollout-b.jsonl');
  writeFileSync(other, JSON.stringify({ timestamp: iso(1), type: 'session_meta', payload: { id: 'zzz', cwd: 'C:\\elsewhere' } }) + '\n');
  writeFileSync(join(claudeDir, 's.jsonl'), claudeLines.join('\n') + '\n');
  const old = join(claudeDir, 'old.jsonl');
  writeFileSync(old, claudeLines.join('\n') + '\n');
  utimesSync(old, new Date(NOW - 5 * 86400000), new Date(NOW - 5 * 86400000));
  const reader = createFeedReader({ codexHome: join(home, 'codex'), claudeHome: join(home, 'claude'), roots: [ROOT] });
  const a = reader.read(Date.now());
  assert.equal(a.codex.events.length, 6);
  assert.equal(a.codex.sessions.length, 1);
  assert.equal(a.claude.events.length, 5); // the old transcript is outside the window
  assert.equal(a.codex.usage.usedPercent, 100);
  appendFileSync(rollout, JSON.stringify({ timestamp: iso(20), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Back again.' }] } }) + '\n');
  const b = reader.read(Date.now());
  assert.equal(b.codex.events.at(-1).text, 'Back again.');
});

test('status comes from real timestamps: out, working, idle, standby', () => {
  assert.equal(columnStatus({ lastAt: NOW - 1000, usage: { usedPercent: 100, resetsAt: NOW + 60000, at: NOW - 2000 } }, NOW).state, 'out');
  assert.equal(columnStatus({ lastAt: NOW - 1000, usage: { usedPercent: 100, resetsAt: NOW - 60000, at: NOW - 900000 } }, NOW).state, 'working');
  assert.equal(columnStatus({ lastAt: NOW - 600000 }, NOW).state, 'idle');
  assert.equal(columnStatus({ lastAt: null, standby: true }, NOW).state, 'standby');
  assert.equal(columnStatus({ lastAt: NOW - 1000, manualOut: { until: null } }, NOW).state, 'out');
  assert.equal(columnStatus({ lastAt: NOW - 1000, limitAt: NOW - 1000 }, NOW).state, 'out');
  // A later turn after the limit means it is back.
  assert.equal(columnStatus({ lastAt: NOW - 1000, limitAt: NOW - 3600000, usage: { usedPercent: 12, at: NOW - 2000 } }, NOW).state, 'working');
});

test('local model activity comes from the hub\'s own chat records', async () => {
  const { readLocalChats } = await import('../lib/team-feeds.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chats-'));
  writeFileSync(join(dir, 'c1.json'), JSON.stringify({ id: 'conv-123456', model: 'copilot-hauhau-game:latest', status: 'completed', messages: [
    { role: 'user', content: 'Review the lighting fit', createdAt: iso(1) },
    { role: 'tool', name: 'project_context', content: '{…}', createdAt: iso(2) },
    { role: 'assistant', content: '{"verdict":"approve"}', createdAt: iso(3) }] }));
  writeFileSync(join(dir, 'broken.json'), '{nope');
  const v = readLocalChats(dir);
  assert.deepEqual(v.events.map(e => e.kind), ['prompt', 'tool', 'say']);
  assert.equal(v.events[0].model, 'copilot-hauhau-game:latest');
  assert.equal(readLocalChats(join(dir, 'missing')).events.length, 0);
});

test('Codex shell results read as exit code plus output', () => {
  const line = o => JSON.stringify({ timestamp: iso(1), type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify(o) }] } });
  const v = parseCodex([line({ chunk_id: 'a', exit_code: 0, output: 'ok done' }), line({ exit_code: 2, output: 'boom' })]);
  assert.deepEqual(v.events.map(e => [e.text, e.error]), [['exit 0: ok done', false], ['exit 2: boom', true]]);
});

test('a cut-off Codex shell result still shows its exit code', () => {
  const s = '{"chunk_id":"8e1162","wall_time_seconds":0.18,"exit_code":0,"original_token_count":1234,"output":"line one\nline two that goes on and o';
  const v = parseCodex([JSON.stringify({ timestamp: iso(1), type: 'response_item', payload: { type: 'function_call_output', output: s } })]);
  assert.equal(v.events[0].text, 'exit 0: line one line two that goes on and o');
  assert.equal(v.events[0].error, false);
});

test('conductor-run sessions are tagged auto', () => {
  const v = parseClaude([JSON.stringify({ type: 'assistant', cwd: ROOT + '/hub/workspaces/auto-claude', sessionId: 'abcdef12', timestamp: iso(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Critiquing candidate 1' }] } })], [ROOT]);
  assert.equal(v.auto, true);
  assert.equal(parseClaude([JSON.stringify({ type: 'assistant', cwd: ROOT, timestamp: iso(1), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } })], [ROOT]).auto, undefined);
});
