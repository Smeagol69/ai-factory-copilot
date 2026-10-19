import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProject } from '../lib/project.mjs';

const project = loadProject();
const moduleFile = resolve(project.root, 'lib/local-worker-mcp.mjs');
const runtimeImport = name => import(pathToFileURL(resolve(project.runtime, name)).href);

test('real MCP file reads retain worker identity through the server envelope', async t => {
  const { adapter } = await fixture(t);
  const result = await adapter.dispatch('project_read_file', { path: 'README.md', start: 1, end: 5 });
  assert.equal(result.provider, 'local');
  assert.equal(result.modelIdentity, 'hauhaucs-local');
  assert.equal(result.path, 'README.md');
  assert.equal(result.exists, true);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('real MCP declared checks retain their actual effect and identity', async t => {
  const { adapter } = await fixture(t);
  const result = await adapter.dispatch('project_run_check', { check: 'companion' });
  assert.equal(result.provider, 'local');
  assert.equal(result.modelIdentity, 'hauhaucs-local');
  assert.equal(result.effect, 'checks-passed');
  assert.equal(result.exitCode, 0);
  assert.match(result.sourceHashes['test/companion.test.mjs'], /^[a-f0-9]{64}$/);
});

async function fixture(t, { crowded = false } = {}) {
  assert(existsSync(moduleFile), 'The bounded local-worker MCP adapter must exist');
  const { openLocalWorkerMcp } = await import(pathToFileURL(moduleFile).href);
  const [{ PairStore }, { OfficeMemory }] = await Promise.all([
    runtimeImport('store.mjs'), runtimeImport('office-memory.mjs'),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'sat-local-mcp-'));
  const database = join(dir, 'pair.sqlite');
  const store = new PairStore(database, 'fixture-codex', Date.now, 'codex');
  for (const id of ['satisfactory-mcp-lab', 'satisfactory-ai-architect', 'unrelated-private-project'])
    store.register({ project: id, name: id, workspace: project.root });
  const memory = new OfficeMemory(store);
  store.send({ project: 'satisfactory-mcp-lab', subject: 'Shared lab finding', body: 'Offline tests are evidence; loaded world remains unknown.' });
  store.send({ project: 'satisfactory-ai-architect', subject: 'Architect finding', body: 'Fresh site clearance and game readback remain open.' });
  store.send({ project: 'unrelated-private-project', subject: 'Cross-project sentinel', body: 'FORBIDDEN_OTHER_PROJECT_CONTENT' });
  memory.remember({ project: 'satisfactory-mcp-lab', key: 'fixture/lesson', value: 'Retain verified lessons.', evidence: ['Fixture isolated database, no inference.'] });
  store.claim({ project: 'satisfactory-mcp-lab', task: 'fixture-task', description: 'Preserve task ownership.', scopes: ['fixture.txt'] });
  if (crowded) {
    for (let i = 0; i < 25; i++) {
      store.claim({ project: 'satisfactory-ai-architect', task: `fixture-${i}`, description: 'Task '.repeat(150), scopes: [`task-${i}.txt`] });
      store.send({ project: 'satisfactory-ai-architect', subject: `Report ${i}`, body: 'Captured data is dated. '.repeat(300) });
      memory.remember({ project: 'satisfactory-ai-architect', key: `fixture/${i}`, value: 'Observation '.repeat(300), evidence: ['Author supplied, not verified truth.'] });
    }
  }
  let adapter;
  t.after(async () => {
    await adapter?.close();
    store.close();
    assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  adapter = await openLocalWorkerMcp({ root: project.root, conversationId: 'fixture-conversation', database });
  return { adapter, store, memory, database };
}

test('real MCP handshake exposes only scoped local context and evidence handoff tools', async t => {
  const { adapter } = await fixture(t);
  assert.deepEqual(adapter.tools.map(tool => tool.function.name).sort(), ['project_context','project_edit_file','project_handoff','project_read_file','project_run_check','project_team_request']);
  for (const tool of adapter.tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
  const result = await adapter.dispatch('project_context', {});
  assert.equal(result.provider, 'local');
  assert.equal(result.modelIdentity, 'hauhaucs-local');
  assert.match(result.context, /Shared lab finding/);
  assert.match(result.context, /Architect finding/);
  assert.match(result.context, /Retain verified lessons/);
  assert.match(result.context, /fixture-task/);
  assert(!result.context.includes('FORBIDDEN_OTHER_PROJECT_CONTENT'));
});

test('lean shared context labels omissions and unknown game outcomes within 7000 characters', async t => {
  const { adapter, store } = await fixture(t, { crowded: true });
  const secretClaim = store.claim({ project: 'satisfactory-mcp-lab', task: 'secret-token-task', description: 'An ordinary advisory claim.', scopes: ['secret-fixture.txt'] });
  const text = await adapter.context();
  assert.equal(typeof text, 'string');
  assert(text.length <= 7000, `Context is ${text.length} characters`);
  assert.match(text, /omitted/i);
  assert.match(text, /unknown/i);
  assert.match(text, /game.*authoritative/i);
  assert(!text.includes(secretClaim.claim_token));
  assert(!text.includes('FORBIDDEN_OTHER_PROJECT_CONTENT'));
  assert(!text.includes('pair_claim_task'));
});

test('automatic orientation reads recent visible lessons and summaries rather than replaying the oldest page', async t => {
  const {adapter,memory}=await fixture(t);
  for(let i=0;i<75;i++) memory.remember({project:'satisfactory-mcp-lab',key:`history/${i}`,value:`Superseded historical note ${i}.`,evidence:['Isolated chronological fixture.']});
  memory.updateSummary({project:'satisfactory-mcp-lab',text:'Old setup description.',evidence:['Fixture baseline.']});
  memory.updateSummary({project:'satisfactory-mcp-lab',text:'Current task: preserve explicit dismantle marks.',evidence:['Fixture current goal.']});
  memory.remember({project:'satisfactory-mcp-lab',key:'current/lesson',value:'RECENT_NATIVE_MARKS_LESSON',evidence:['Fixture most recent observation.']});
  const context=JSON.parse(await adapter.context());
  const section=context.projects.find(item=>item.project==='satisfactory-mcp-lab');
  assert(section.memory.some(entry=>entry.text.includes('RECENT_NATIVE_MARKS_LESSON')));
  assert(section.memory.some(entry=>entry.text.includes('Current task: preserve explicit dismantle marks.')));
  assert.equal(section.omitted.memoryMore,false);
  assert(section.omitted.memoryEntriesRead>=79);
});

test('MCP handoff appends attributed agent observation only in its configured project', async t => {
  const { adapter, store, memory } = await fixture(t);
  const before = store.db.prepare('SELECT count(*) AS n FROM tasks').get().n;
  const result = await adapter.dispatch('project_handoff', {
    summary: 'Propose a narrow next check against fresh captured evidence.',
    evidence: ['Isolated offline fixture; game verification was not performed.'],
    unknowns: ['Live game result remains unknown.'],
  });
  assert.equal(result.provider, 'local');
  assert.equal(result.author, 'hauhaucs-local');
  assert.equal(result.recorded, true);
  assert.equal(result.project, 'satisfactory-mcp-lab');
  assert.equal(result.receivedByPeer, false);
  const entries = memory.recall({ project: 'satisfactory-mcp-lab', key: 'local-worker/fixture-conversation' }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].author, 'hauhaucs-local');
  assert.match(entries[0].value, /Live game result remains unknown/);
  assert.deepEqual(entries[0].evidence, ['Isolated offline fixture; game verification was not performed.']);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_memory_entries WHERE project=?').get('unrelated-private-project').n, 0);
});

test('unknown tools, extra authority arguments and oversized handoffs cannot write the ledger', async t => {
  const { adapter, store } = await fixture(t);
  const before = store.db.prepare('SELECT count(*) AS n FROM office_memory_entries').get().n;
  for (const [name, args] of [
    ['pair_claim_task', { project: 'satisfactory-mcp-lab' }],
    ['project_context', { project: 'unrelated-private-project' }],
    ['project_handoff', { summary: 'Attempted override', evidence: ['test'], project: 'unrelated-private-project' }],
    ['project_handoff', { summary: 'Attempted override', evidence: ['test'], author: 'codex' }],
    ['project_handoff', { summary: 'x'.repeat(3000), evidence: ['test'] }],
    ['project_handoff', { summary: 'No evidence' }],
  ]) await assert.rejects(adapter.dispatch(name, args));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_memory_entries').get().n, before);
  await adapter.close();
  await assert.rejects(adapter.dispatch('project_context', {}), /closed/i);
});

test('server rejects cross-project arguments even when the client wrapper is bypassed', async t => {
  const { database, store } = await fixture(t);
  const sdk = name => runtimeImport(`node_modules/@modelcontextprotocol/sdk/dist/esm/${name}`);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('client/index.js'), sdk('client/stdio.js')]);
  const client = new Client({ name: 'isolated-untrusted-client', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve(project.root, 'scripts/local-mcp.mjs'), '--root', project.root,
        '--conversation', 'raw-client-fixture', '--database', database], stderr: 'ignore' }), { timeout: 10000 });
    const before = store.db.prepare('SELECT count(*) AS n FROM office_memory_entries').get().n;
    for (const name of ['project_context', 'project_handoff']) {
      const result = await client.callTool({ name, arguments: {
        ...(name === 'project_handoff' ? { summary: 'Unauthorized project override', evidence: ['test'] } : {}),
        project: 'unrelated-private-project',
      } }, undefined, { timeout: 10000 });
      assert.equal(result.isError, true);
      assert(!JSON.stringify(result).includes('FORBIDDEN_OTHER_PROJECT_CONTENT'));
    }
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_memory_entries').get().n, before);
  } finally { await client.close(); }
});

test('handoff and total tool budgets stop further work without replaying a stored observation', async t => {
  const { adapter, memory } = await fixture(t);
  for (let i = 0; i < 2; i++) await adapter.dispatch('project_handoff', { summary: `Proposal ${i}`, evidence: ['Offline test only.'] });
  await assert.rejects(adapter.dispatch('project_handoff', { summary: 'Must not persist', evidence: ['Offline test only.'] }), /budget/i);
  assert.equal(memory.recall({ project: 'satisfactory-mcp-lab', key: 'local-worker/fixture-conversation' }).entries.length, 2);
  // The rejected third handoff still consumes a tool call; thirteen reads remain.
  for (let i = 0; i < 13; i++) await adapter.context();
  await assert.rejects(adapter.context(), /budget/i);
});

test('adapter refuses a missing database or foreign root instead of creating a competing ledger', async t => {
  const { database } = await fixture(t);
  const { openLocalWorkerMcp } = await import(pathToFileURL(moduleFile).href);
  const missing = database + '.missing';
  await assert.rejects(openLocalWorkerMcp({ root: project.root, conversationId: 'missing-ledger', database: missing }), /existing.*database/i);
  assert.equal(existsSync(missing), false);
  await assert.rejects(openLocalWorkerMcp({ root: tmpdir(), conversationId: 'foreign-root', database }), /project root/i);
  await assert.rejects(openLocalWorkerMcp({ root: project.root, conversationId: '../other-project', database }), /conversation ID/i);
});
