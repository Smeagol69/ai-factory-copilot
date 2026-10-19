import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

async function fixture(t, options = {}) {
  assert(existsSync(new URL('../lib/local-chat.mjs', import.meta.url)), 'Persistent local chat service must exist');
  const { createLocalChat } = await import('../lib/local-chat.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-chat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = { root, runModel: async () => ({ content: 'I can examine the captured evidence.', model: 'local-project-peer' }),
    readModelStatus: async () => ({ installed: true, available: true, model: 'local-project-peer' }), ...options };
  return { root, settings, createLocalChat, chat: createLocalChat(settings) };
}

test('local chat persists a real completed exchange across restart and lists only metadata', async t => {
  const { root, chat, settings, createLocalChat } = await fixture(t);
  const saved = await chat.send({ message: 'Help check the site evidence.' });
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.messages.map(m => [m.role, m.content]), [
    ['user', 'Help check the site evidence.'], ['assistant', 'I can examine the captured evidence.'],
  ]);
  assert.equal(saved.model, 'local-project-peer');
  const onDisk = JSON.parse(readFileSync(join(root, 'state/local-worker/chats', saved.id + '.json'), 'utf8'));
  assert.equal(onDisk.messages.length, 2);
  const restarted = createLocalChat(settings);
  assert.equal(restarted.get(saved.id).messages[1].content, 'I can examine the captured evidence.');
  const listed = restarted.list();
  assert.equal(listed.conversations.length, 1);
  assert.equal(listed.conversations[0].messageCount, 2);
  assert.equal(listed.conversations[0].messages, undefined);
  assert.equal(listed.conversations[0].originalGoal, undefined);
  assert.equal(readdirSync(join(root, 'state/local-worker/chats')).some(n => n.endsWith('.tmp')), false);
  saved.messages[0].content = 'mutated by caller';
  assert.equal(chat.get(saved.id).messages[0].content, 'Help check the site evidence.');
});

test('busy sends are rejected and the user turn is durable before inference starts', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { root, chat } = await fixture(t, { runModel: async () => { entered(); await gate; return { content: 'done', model: 'local' }; } });
  const first = chat.send({ message: 'Check this once.' });
  await began;
  const { activeConversationId } = await chat.status();
  const persisted = JSON.parse(readFileSync(join(root, 'state/local-worker/chats', activeConversationId + '.json'), 'utf8'));
  assert.equal(persisted.status, 'running');
  assert.deepEqual(persisted.messages.map(m => m.role), ['user']);
  await assert.rejects(chat.send({ conversationId: activeConversationId, message: 'Check this once.' }), { code: 'CHAT_BUSY', statusCode: 409 });
  await assert.rejects(chat.send({ message: 'Another conversation.' }), { code: 'CHAT_BUSY' });
  assert.equal(chat.list().conversations.length, 1);
  release();
  assert.equal((await first).status, 'completed');
});

test('cancellation aborts only the active conversation and keeps unknown outcomes visible', async t => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const { chat } = await fixture(t, { runModel: ({ signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const pending = chat.send({ message: 'Read captured evidence.' });
  await began;
  const { activeConversationId: id } = await chat.status();
  assert.deepEqual(chat.cancel(randomUUID()), { cancelled: false, conversationId: null });
  assert.deepEqual(chat.cancel(id), { cancelled: true, conversationId: id });
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.messages.some(m => m.role === 'assistant'), false);
  assert.equal(result.lastError.outcome, 'unknown');
  assert.equal((await chat.status()).busy, false);
});

test('invalid input and unknown conversations never issue inference or create records', async t => {
  const { chat } = await fixture(t, { runModel: async () => { assert.fail('Invalid input must not run a model'); } });
  for (const message of ['', '   ', 'x'.repeat(6001), 123, null]) {
    await assert.rejects(chat.send({ message }), { code: 'INVALID_MESSAGE', statusCode: 400 });
  }
  await assert.rejects(chat.send({ conversationId: '../outside', message: 'hello' }), { code: 'INVALID_CONVERSATION_ID' });
  await assert.rejects(chat.send({ conversationId: randomUUID(), message: 'hello' }), { code: 'CHAT_NOT_FOUND', statusCode: 404 });
  assert.equal(chat.list().conversations.length, 0);
  assert.throws(() => chat.get('../outside'), { code: 'INVALID_CONVERSATION_ID' });
});

test('long conversations retain their original goal and explicitly label omitted history and context', async t => {
  const seen = [];
  const { chat } = await fixture(t, { tools: [{ name: 'read_project', description: 'Read current shared project context' }],
    runModel: async ({ messages }) => { seen.push(messages); return { content: 'r'.repeat(1800), model: 'local' }; } });
  let saved = await chat.send({ message: 'Original goal: inspect the entrance.' });
  for (let index = 0; index < 17; index++) {
    saved = await chat.send({ conversationId: saved.id, message: `${index}: ${'u'.repeat(1600)}`, sharedContext: 'e'.repeat(9000) });
  }
  assert(saved.messages.length <= 24);
  assert(saved.messages.reduce((sum, m) => sum + m.content.length, 0) <= 16000);
  assert(saved.omitted.messages > 0);
  const modelContext = seen.at(-1).map(m => m.content).join('\n');
  assert.match(modelContext, /Original goal: inspect the entrance\./);
  assert.match(modelContext, /omitted/i);
  assert.match(modelContext, /read_project/);
  assert.match(modelContext, /game.*authoritative/i);
  assert.match(modelContext, /unknown outcomes.*replay/i);
  assert(modelContext.length < 32000);
});

test('model failure persists a truthful failed user turn and restart never replays it', async t => {
  const { chat, settings, createLocalChat } = await fixture(t, { runModel: async () => { throw new Error('Ollama disconnected after tool call'); } });
  const saved = await chat.send({ message: 'Read the task.' });
  assert.equal(saved.status, 'failed');
  assert.match(saved.lastError.message, /disconnected/);
  assert.equal(saved.lastError.outcome, 'unknown');
  assert.deepEqual(saved.messages.map(m => m.role), ['user']);
  const restarted = createLocalChat({ ...settings, runModel: () => assert.fail('Restart or status must not replay inference') });
  assert.equal(restarted.get(saved.id).status, 'failed');
  assert.equal((await restarted.status()).busy, false);
  assert.equal(restarted.list().conversations.length, 1);
});

test('a process-interrupted running record becomes unknown without automatic replay', async t => {
  const { root, settings, createLocalChat, chat } = await fixture(t);
  const saved = await chat.send({ message: 'One explicit request.' });
  const path = join(root, 'state/local-worker/chats', saved.id + '.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.status = 'running'; raw.messages = raw.messages.slice(0, 1);
  writeFileSync(path, JSON.stringify(raw));
  const restarted = createLocalChat({ ...settings, runModel: () => assert.fail('Interrupted work must not be replayed') });
  assert.equal(restarted.get(saved.id).status, 'interrupted');
  assert.equal(restarted.get(saved.id).lastError.outcome, 'unknown');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'interrupted');
});

test('malformed, oversized and symlinked chat files are skipped with warnings', async t => {
  const { root, settings, createLocalChat, chat } = await fixture(t);
  const saved = await chat.send({ message: 'Preserve this valid exchange.' });
  const directory = join(root, 'state/local-worker/chats');
  writeFileSync(join(directory, randomUUID() + '.json'), '{not-json');
  const oversizedId = randomUUID();
  const oversized = { ...JSON.parse(readFileSync(join(directory, saved.id + '.json'), 'utf8')), id: oversizedId, padding: 'x'.repeat(262144) };
  writeFileSync(join(directory, oversizedId + '.json'), JSON.stringify(oversized));
  const outside = join(root, 'outside.json');
  writeFileSync(outside, JSON.stringify({ sentinel: 'must not be overwritten' }));
  let linked = false;
  try { symlinkSync(outside, join(directory, randomUUID() + '.json'), 'file'); linked = true; }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  const restarted = createLocalChat(settings);
  assert.deepEqual(restarted.list().conversations.map(c => c.id), [saved.id]);
  assert(restarted.list().warnings.length >= (linked ? 3 : 2));
  assert.equal(JSON.parse(readFileSync(outside, 'utf8')).sentinel, 'must not be overwritten');
});

test('a symlinked storage directory is rejected rather than written outside the project', async t => {
  const { root, settings, createLocalChat } = await fixture(t);
  const directory = join(root, 'state/local-worker/chats');
  const outside = mkdtempSync(join(tmpdir(), 'copilot-chat-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(directory, { recursive: true });
  symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createLocalChat(settings), { code: 'UNSAFE_CHAT_STORAGE' });
  assert.deepEqual(readdirSync(outside), []);
});

test('the fifty conversation limit preserves existing history and refuses another model run', async t => {
  let runs = 0;
  const { chat } = await fixture(t, { runModel: async () => ({ content: `reply ${++runs}`, model: 'local' }) });
  const first = await chat.send({ message: 'first' });
  for (let index = 1; index < 50; index++) await chat.send({ message: `conversation ${index}` });
  await assert.rejects(chat.send({ message: 'over limit' }), { code: 'CHAT_LIMIT', statusCode: 409 });
  assert.equal(runs, 50);
  assert.equal(chat.list().conversations.length, 50);
  const continued = await chat.send({ conversationId: first.id, message: 'continue existing' });
  assert.equal(continued.messages.at(-1).content, 'reply 51');
});

test('tool evidence is bounded, durable and visible without inventing an assistant result', async t => {
  const { chat, settings, createLocalChat } = await fixture(t, { runModel: async ({ onTool }) => {
    await onTool({ name: 'read_project', content: JSON.stringify({ source: 'shared MCP', outcome: 'read only' }) });
    throw new Error('transport lost');
  } });
  const saved = await chat.send({ message: 'Read the shared project context.' });
  assert.equal(saved.status, 'failed');
  assert.equal(saved.messages[1].role, 'tool');
  assert.equal(saved.messages[1].name, 'read_project');
  assert.match(saved.messages[1].content, /shared MCP/);
  assert.equal(saved.messages.some(m => m.role === 'assistant'), false);
  assert.equal(createLocalChat(settings).get(saved.id).messages[1].role, 'tool');
});

test('storage failure prevents inference and does not expose a falsely saved conversation', async t => {
  const { root, chat } = await fixture(t, { runModel: () => assert.fail('Storage must precede inference') });
  rmSync(join(root, 'state/local-worker/chats'), { recursive: true });
  writeFileSync(join(root, 'state/local-worker/chats'), 'not a directory');
  await assert.rejects(chat.send({ message: 'hello' }), { code: 'UNSAFE_CHAT_STORAGE' });
  assert.equal(chat.list().conversations.length, 0);
  assert.equal((await chat.status()).busy, false);
});

test('the local adapter receives the saved conversation identity for its shared MCP handoff', async t => {
  let identity;
  const { chat } = await fixture(t, { runModel: async ({ conversationId }) => {
    identity = conversationId; return { content: 'Saved shared context.', model: 'local' };
  } });
  const saved = await chat.send({ message: 'Check the project handoff.' });
  assert.equal(identity, saved.id);
});

test('a failed final save cannot leave an inactive chat falsely labelled as running or complete', async t => {
  let directory;
  const { chat, root } = await fixture(t, { runModel: async () => {
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'storage unavailable');
    return { content: 'Actual model answer, not durably saved.', model: 'local' };
  } });
  directory = join(root, 'state/local-worker/chats');
  await assert.rejects(chat.send({ message: 'Save this exchange.' }), { code: 'CHAT_STORAGE_FAILED', statusCode: 503 });
  const saved = chat.get(chat.list().conversations[0].id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.lastError.outcome, 'unknown');
  assert.equal(saved.messages.some(message => message.role === 'assistant'), false);
  assert.equal((await chat.status()).busy, false);
});

test('cancelling a slow adapter does not admit a second inference before the first settles', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { chat } = await fixture(t, { runModel: async () => { entered(); await gate; return { content: 'late answer', model: 'local' }; } });
  const pending = chat.send({ message: 'Read once.' });
  await began;
  chat.cancel((await chat.status()).activeConversationId);
  assert.equal((await chat.status()).busy, true);
  await assert.rejects(chat.send({ message: 'overlapping inference' }), { code: 'CHAT_BUSY' });
  release();
  const saved = await pending;
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.messages.some(message => message.role === 'assistant'), false);
});

test('status and loading failures do not start inference and malformed model results stay failed', async t => {
  const { chat } = await fixture(t, { runModel: async () => ({ content: '', model: 'local' }),
    readModelStatus: async () => { throw new Error('server offline'); } });
  assert.equal((await chat.status()).modelStatus.available, false);
  const saved = await chat.send({ message: 'Explain the available evidence.' });
  assert.equal(saved.status, 'failed');
  assert.equal(saved.lastError.code, 'INVALID_MODEL_RESPONSE');
  assert.deepEqual(saved.messages.map(message => message.role), ['user']);
});

test('bounded output reports the exact omitted length and JSON escaping does not break supported message lengths', async t => {
  const { chat, settings, createLocalChat } = await fixture(t, { runModel: async () => ({ content: '\u0001'.repeat(20000), model: 'local' }) });
  const saved = await chat.send({ message: '\u0002'.repeat(6000) });
  const output = saved.messages.at(-1).content;
  assert.equal(saved.status, 'completed');
  const marker = output.match(/\n\[(\d+) characters omitted from this saved excerpt\]$/);
  assert(marker);
  assert.equal(Number(marker[1]), 20000 - (output.length - marker[0].length));
  assert.equal(createLocalChat(settings).get(saved.id).status, 'completed');
});
