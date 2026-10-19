import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { runReModels, runNativeReReview } from '../lib/re-models.mjs';
import { createLocalChat } from '../lib/local-chat.mjs';
import { executeHostedReRequest } from '../scripts/re-hosted-worker.mjs';

async function fixture() {
  const parent = resolve('state/local-game-re'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'models-test-'));
  await mkdir(join(root, 'settings'));
  await writeFile(join(root, 'settings/reverse-engineering.json'), await readFile(resolve('settings/reverse-engineering.json')));
  return root;
}
const goal = 'Reverse engineer Satisfactory using exact supplied REA evidence.';
const evidence = { inspection: { evidenceFiles: ['state/rea/real.json'], findings: [{ claim: 'Observed import', sources: ['state/rea/real.json'] }] } };
const complete = content => ({ content: JSON.stringify(content), usage: { input_tokens: 12, output_tokens: 4, costUsd: null } });
const args = root => ({ root, runId: 'test-run', target: { id: 'satisfactory' }, evidence, originalGoal: goal });

test('actual runner results are retained and unsupported model verification stays unknown', async () => {
  const root = await fixture(), events = [], requests = [];
  try {
    const runner = provider => async request => {
      requests.push({ provider, ...request });
      return complete({ findings: [{ claim: provider + ' observed something', classification: 'verified', sources: provider === 'local' ? [] : ['state/rea/real.json'] }], unknowns: ['Coverage is incomplete'], disagreements: [] });
    };
    const result = await runReModels({ ...args(root), onProgress: event => events.push(event) }, {
      runners: { local: runner('local'), claude: runner('claude'), codex: runner('codex') },
    });
    assert.deepEqual(result.models.map(model => [model.provider, model.status]), [['local', 'completed'], ['claude', 'completed'], ['codex', 'completed']]);
    assert.equal(result.findings.find(finding => finding.claim.startsWith('local')).classification, 'unknown');
    assert(result.findings.filter(finding => !finding.claim.startsWith('local')).every(finding => finding.classification === 'inferred'));
    assert(requests.every(request => request.prompt.length <= 8000 && request.maxOutputTokens === 16384 && request.purpose === 'reverse-engineering'));
    assert(requests[2].prompt.includes('local observed something'));
    assert(events.some(event => event.models?.some(model => model.status === 'running')));
    for (const model of result.models) assert.equal(JSON.parse(await readFile(model.evidenceFile, 'utf8')).provider, model.provider);
    assert(result.unknowns.includes('Coverage is incomplete'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local capacity waiting retries only a rejected send and keeps the original goal and evidence', async () => {
  const root = await fixture(), sends = [], waits = [], events = [];
  try {
    const localChat = { async send(request) {
      sends.push(request);
      if (sends.length === 1) throw Object.assign(Error('Existing local request is running'), { statusCode: 409, code: 'CHAT_BUSY' });
      return { id: 'conversation', status: 'completed', messages: [{ role: 'assistant', content: JSON.stringify({ findings: [], unknowns: ['Need more imports'], disagreements: [] }) }] };
    } };
    const result = await runReModels({ ...args(root), localChat, onProgress: event => events.push(event) }, {
      wait: async milliseconds => waits.push(milliseconds), runners: { claude: async () => { throw Error('Hosted offline'); }, codex: async () => complete({ findings: [] }) },
    });
    assert.equal(sends.length, 2); assert.equal(waits.length, 1);
    assert.deepEqual(sends[0], sends[1]);
    assert(sends[0].message.includes(goal));
    assert((sends[0].message + sends[0].sharedContext).includes('state/rea/real.json'));
    assert(sends[0].message.length <= 6000 && sends[0].sharedContext.length <= 6000);
    assert(sends[0].message.length + sends[0].sharedContext.length <= 8000);
    assert(events.some(event => event.models?.some(model => model.status === 'waiting_capacity')));
    assert.equal(result.models[0].status, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('RE purpose and on-disk authorization are checked before any provider runner', async () => {
  const root = await fixture(); let calls = 0;
  const runner = async () => { calls++; return complete({ findings: [] }); };
  try {
    await assert.rejects(runReModels({ ...args(root), purpose: 'in-game' }, { runners: { local: runner, claude: runner, codex: runner } }), /reverse-engineering/);
    await writeFile(join(root, 'settings/reverse-engineering.json'), '{}');
    await assert.rejects(runReModels(args(root), { runners: { local: runner, claude: runner, codex: runner } }), /policy/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pre-cancelled investigations do not start or retry model work', async () => {
  const root = await fixture(), controller = new AbortController(); let calls = 0; controller.abort();
  try {
    const runner = async () => { calls++; throw Error('Must not run'); };
    const result = await runReModels({ ...args(root), signal: controller.signal }, { runners: { local: runner, claude: runner, codex: runner } });
    assert.equal(calls, 0); assert(result.models.every(model => model.status === 'cancelled'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a native rate limit gets one independent reassessment with the exact failure and original context', async () => {
  const root = await fixture(), reassessments = []; let codexCalls = 0;
  try {
    const result = await runReModels(args(root), { runners: {
      local: async () => complete({ findings: [] }),
      claude: async request => { reassessments.push(request); return complete({ findings: [], unknowns: ['Reassess independently'] }); },
      codex: async () => { codexCalls++; throw Error('Usage limit reached; reset at 20:31 UTC'); },
    } });
    assert.equal(codexCalls, 1); assert.equal(reassessments.length, 2);
    assert(reassessments[1].prompt.includes(goal));
    assert(reassessments[1].prompt.includes('Usage limit reached; reset at 20:31 UTC'));
    assert(reassessments[1].prompt.includes('state/rea/real.json'));
    assert(reassessments[1].prompt.includes('no additional access'));
    assert.equal(result.models.find(model => model.provider === 'codex').status, 'unavailable');
    assert.equal(result.models.at(-1).role, 'independent_reassessment');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capacity exhaustion is bounded and never retries a failed or unknown local outcome', async () => {
  const root = await fixture(); let sends = 0, waits = 0;
  try {
    const result = await runReModels({ ...args(root), localChat: { async send() { sends++; return { status: 'failed', lastError: { code: 'LOCAL_FAILED', message: 'Unknown local outcome' } }; } } }, {
      wait: async () => { waits++; }, runners: { claude: async () => complete({ findings: [] }), codex: async () => complete({ findings: [] }) },
    });
    assert.equal(sends, 1); assert.equal(waits, 0); assert.equal(result.models[0].status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local cancellation targets only the accepted conversation and waits for the adapter to settle', async () => {
  const root = await fixture(), controller = new AbortController(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  try {
    const localChat = createLocalChat({ root, runModel: async ({ signal }) => {
      entered(); await new Promise(resolve => { const guard = setTimeout(resolve, 250); signal.addEventListener('abort', () => { clearTimeout(guard); resolve(); }, { once: true }); });
      throw Error('Cancelled local adapter');
    } });
    const pending = runReModels({ ...args(root), localChat, signal: controller.signal }, {
      runners: { claude: async () => complete({ findings: [] }), codex: async () => complete({ findings: [] }) },
    });
    await started; controller.abort();
    const result = await pending;
    assert.equal(result.models[0].status, 'cancelled');
    assert.equal((await localChat.status()).busy, false);
    assert.equal(localChat.list().conversations[0].status, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('seven rejected capacity sends stop without model polling or a billable fallback retry', async () => {
  const root = await fixture(); let sends = 0, waits = 0, hosted = 0;
  try {
    const result = await runReModels({ ...args(root), localChat: { async send() { sends++; throw Object.assign(Error('Busy'), { code: 'CHAT_BUSY', statusCode: 409 }); } } }, {
      wait: async () => { waits++; }, runners: { claude: async () => { hosted++; return complete({ findings: [] }); }, codex: async () => complete({ findings: [] }) },
    });
    assert.equal(sends, 7); assert.equal(waits, 6); assert.equal(hosted, 1);
    assert.equal(result.models[0].status, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hosted worker checks purpose before SDK construction and retains actual usage with unknown cost', async () => {
  const root = await fixture(), runId = 'worker-test', nonce = '00000000-0000-4000-8000-000000000001';
  const home = join(root, 'state/local-game-re/models', runId); await mkdir(home, { recursive: true });
  const requestPath = join(home, `claude-${nonce}.request.json`), resultPath = join(home, `claude-${nonce}.result.json`);
  const request = { schema: 'copilot.re-hosted-request/v1', root, runId, purpose: 'in-game', prompt: goal, resultPath, maxOutputTokens: 4096, timeoutMs: 5000 };
  let constructed = 0, actualRequest;
  const createClient = async options => {
    constructed++; assert.equal(options.maxRetries, 0); assert.equal(options.baseURL, 'https://api.anthropic.com');
    return { messages: { create: async body => { actualRequest = body; return { model: 'claude-sonnet-5-5', id: 'actual-response', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"findings":[]}' }], usage: { input_tokens: 101, output_tokens: 17, cache_read_input_tokens: 12 } }; } } };
  };
  try {
    await writeFile(requestPath, JSON.stringify(request));
    await assert.rejects(executeHostedReRequest(requestPath, { root, createClient }), /reverse-engineering/);
    assert.equal(constructed, 0);
    await writeFile(requestPath, JSON.stringify({ ...request, purpose: 'reverse-engineering' }));
    const result = await executeHostedReRequest(requestPath, { root, createClient });
    assert.equal(constructed, 1); assert.equal(actualRequest.max_tokens, 4096); assert.equal(actualRequest.model, 'claude-sonnet-5-5');
    assert.equal(result.usage.input_tokens, 101); assert.equal(result.usage.output_tokens, 17); assert.equal(result.usage.costUsd, null);
    assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).responseId, 'actual-response');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a truncated hosted answer retains actual text and usage as partial without claiming completion or replaying', async () => {
  const root = await fixture(), runId = 'partial-test';
  const home = join(root, 'state/local-game-re/models', runId); await mkdir(home, { recursive: true });
  const requestPath = join(home, 'claude-00000000-0000-4000-8000-000000000002.request.json');
  const resultPath = requestPath.replace('.request.json', '.result.json'); let calls = 0;
  try {
    await writeFile(requestPath, JSON.stringify({ schema:'copilot.re-hosted-request/v1',root,runId,purpose:'reverse-engineering',prompt:goal,resultPath,maxOutputTokens:16384,timeoutMs:5000 }));
    const result = await executeHostedReRequest(requestPath, {root,createClient:async()=>({messages:{create:async()=>{
      calls++; return {model:'claude-sonnet-5-5',id:'actual-truncated-response',stop_reason:'max_tokens',content:[{type:'text',text:'Partial: native writer calls disk write.'}],usage:{input_tokens:99,output_tokens:16384}};
    }}})});
    assert.equal(calls,1); assert.equal(result.status,'partial');
    assert.equal(result.content,'Partial: native writer calls disk write.');
    assert.equal(result.usage.output_tokens,16384); assert.equal(result.responseId,'actual-truncated-response');
    assert.equal(JSON.parse(await readFile(resultPath,'utf8')).status,'partial');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('native review fixes the read-only project actor and retains subscription usage and completion', async () => {
  let options, stopped = 0;
  class Client extends EventEmitter {
    async start() { this.emit('usage', { primary: { usedPercent: 31 } }); this.sessionId = 'native-session'; }
    async prompt(prompt) { assert(prompt.includes(goal)); queueMicrotask(() => this.emit('done', { status: 'completed', text: '{"findings":[]}' })); }
    async stop() { stopped++; }
  }
  const result = await runNativeReReview({ root: resolve('.'), runId: 'test-run', prompt: goal, maxToolCalls: 8 }, {
    context: async root => ({ database: 'existing-ledger.db', runtime: join(root, 'runtime/agent-pair') }),
    createCodexClient: actual => { options = actual; return new Client(); },
  });
  assert.equal(options.readOnly, true); assert.equal(options.mcpConfig.instance, 'codex-re-test-run');
  assert.equal(options.mcpConfig.database, 'existing-ledger.db'); assert.equal(stopped, 1);
  assert.equal(result.usage.rateLimits.primary.usedPercent, 31); assert.equal(result.usage.costUsd, null);
  assert.equal(result.sessionId, 'native-session');
});
