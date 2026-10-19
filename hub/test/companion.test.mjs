import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, rmdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { companionStatus, startCompanion, stopCompanion } from '../lib/companion.mjs';

const base = resolve('state/companion');
const isolatedEnvironment = { AI_PROVIDER: 'mock', AIFACTORY_SNAPSHOT_CACHE: 'off', AIFACTORY_ARCHITECT_STORE: 'off',
  AIFACTORY_TERRAIN_CACHE: 'off', AIFACTORY_ROUTING_LOG: 'off' };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
async function workspace() { await mkdir(base, { recursive: true }); return mkdtemp(join(base, 'test-')); }
async function cleanup(path) { assert(resolve(path).startsWith(base + '\\') || resolve(path).startsWith(base + '/')); await rm(path, { recursive: true, force: true }); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }
// Observe the real child environment and replace only its external HTTP boundary.
// The bridge still runs its real bootstrap, configuration, health and ownership.
async function auditedEnvironment(directory) {
  const preload = join(directory, 'audit.mjs'), auditPath = join(directory, 'audit.json');
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
const inspect = () => ({ provider: process.env.AI_PROVIDER, endpoint: process.env.LOCAL_AI_BASE_URL,
  model: process.env.LOCAL_AI_MODEL, reasoning: process.env.LOCAL_AI_REASONING_EFFORT,
  tools: process.env.LOCAL_AI_TOOLS, maxTokens: process.env.LOCAL_AI_MAX_TOKENS,
  forbiddenPresent: ['ANTHROPIC_API_KEY','OPENAI_API_KEY','LOCAL_AI_API_KEY','GOOGLE_API_KEY','ANTHROPIC_MODEL','OPENAI_MODEL','AIFACTORY_STRONG_PROVIDER','AIFACTORY_CHEAP_PROVIDER'].filter(name => process.env[name] !== undefined) });
const atImport = inspect(), calls = [];
const save = () => writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ atImport, current: inspect(), calls }));
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET'; calls.push({ url: String(url), method }); save();
  if (String(url) !== 'http://127.0.0.1:11436/v1/models' || method !== 'GET') throw Error('Unexpected network during companion startup');
  return new Response(JSON.stringify({ data: [{ id: 'copilot-hauhau-game:latest' }] }), { status: 200 });
};
save();
`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, auditPath };
}
function assertLocalEnvironment(value) {
  assert.deepEqual(value, { provider: 'local', endpoint: 'http://127.0.0.1:11436/v1',
    model: 'copilot-hauhau-game:latest', reasoning: 'none',
    tools: 'true', maxTokens: '1024', forbiddenPresent: [] });
}

test('companion startup refuses a foreign listener without claiming or stopping it', async () => {
  const directory = await workspace();
  const foreign = createServer((req, res) => res.end(JSON.stringify({ schema: 'aifactory.bridge.health', bridge_version: '1.0.0-beta.2', status: 'ok', readiness: { operational_ready: true } })));
  const port = await listen(foreign);
  try {
    await assert.rejects(startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment }), /foreign|unverified|unknown/i);
    assert.equal((await companionStatus({ port, stateDirectory: directory })).owned, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally { await close(foreign); await cleanup(directory); }
});

test('hidden owned companion starts once, reuses its identity and preserves world uncertainty', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort();
  try {
    const [first, concurrent] = await Promise.all([startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment }), startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment })]);
    assert.equal(first.ok, true);
    assert.equal(first.pid, concurrent.pid);
    const again = await startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment });
    assert.equal(again.reused, true);
    assert.equal(again.pid, first.pid);
    const other = await workspace();
    try {
      await assert.rejects(startCompanion({ port, stateDirectory: other, environment: isolatedEnvironment }), /foreign|unverified|unknown/i);
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally { await cleanup(other); }
    const status = await companionStatus({ port, stateDirectory: directory });
    assert.equal(status.owned, true);
    assert.equal(status.health.provider, 'local');
    assert.equal(status.provider, 'local');
    assert.equal(status.policyMatches, true);
    assert.equal(status.health.bridgeVersion, '1.0.0-beta.2');
    assert.equal(status.health.worldVerified, false);
    assert.deepEqual(status.identity.metadataStores, { snapshot: null, architect: null, terrain: null });
    assert.equal(status.model, 'copilot-hauhau-game:latest');
    assert.equal(status.startupModelCalls, 0);
    const stopped = await stopCompanion({ port, stateDirectory: directory });
    assert.equal(stopped.stopped, true);
    assert.throws(() => process.kill(first.pid, 0));
  } finally { await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory); }
});

test('inherited paid configuration and internal environment injection cannot change the service local policy', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort();
  const previous = process.env.AIFACTORY_STRONG_PROVIDER;
  process.env.AIFACTORY_STRONG_PROVIDER = 'anthropic';
  const environment = { ...isolatedEnvironment, AI_PROVIDER: 'hybrid', OPENAI_API_KEY: 'test-key-never-send',
    ANTHROPIC_API_KEY: 'test-key-never-send', LOCAL_AI_API_KEY: 'test-key-never-send',
    LOCAL_AI_BASE_URL: 'https://paid.invalid/v1', LOCAL_AI_MODEL: 'paid-model', LOCAL_AI_REASONING_EFFORT: 'high',
    AIFACTORY_CHEAP_PROVIDER: 'openai', AIFACTORY_STRONG_PROVIDER: 'anthropic' };
  try {
    const started = await startCompanion({ port, stateDirectory: directory, environment });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(started.status.provider, 'local');
    assert.equal(health.provider, 'local');
    assert.equal(health.readiness.endpoint, 'http://127.0.0.1:11436/v1');
    assert.equal(health.readiness.model, 'copilot-hauhau-game:latest');
    assert.equal(started.status.identity.localOnly, true);
    assert.equal(started.status.startupModelCalls, 0);
    for (const name of ['launch.json', 'owned-service.json', 'last-start.json', 'stdout.log', 'stderr.log']) {
      assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /test-key-never-send/);
    }
  } finally {
    if (previous === undefined) delete process.env.AIFACTORY_STRONG_PROVIDER;
    else process.env.AIFACTORY_STRONG_PROVIDER = previous;
    await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory);
  }
});

test('an owned companion with the old hybrid policy stays identifiable but cannot be reused', async () => {
  const directory = await workspace();
  const lock = JSON.parse(await readFile(resolve('runtime/satisfactory-companion/install-lock.json'), 'utf8'));
  const observed = { application: 'copilot-owned-companion/v1', root: resolve('.'), project: 'satisfactory-mcp-lab',
    runtimeSha256: lock.runtimeSha256, bridgeVersion: lock.version, instanceId: '00000000-0000-4000-8000-000000000001',
    pid: process.pid, parentPid: process.ppid, provider: 'hybrid', model: null };
  const server = createServer((req, res) => res.end(JSON.stringify(req.url === '/copilot/identity' ? observed : {
    schema: 'aifactory.bridge.health', bridge_version: lock.version, status: 'ok', provider: 'hybrid', readiness: { operational_ready: true },
  })));
  const port = await listen(server), options = { port, stateDirectory: directory, environment: isolatedEnvironment };
  try {
    await writeFile(join(directory, 'owned-service.json'), JSON.stringify({ ...observed, port }));
    const status = await companionStatus(options);
    assert.equal(status.owned, true);
    assert.equal(status.runtimeMatches, true);
    assert.equal(status.policyMatches, false);
    assert.equal(status.provider, 'hybrid');
    await assert.rejects(startCompanion(options), /policy|restart|local/i);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally { await close(server); await cleanup(directory); }
});

test('legacy configuration cannot restore cloud billing and keeps its relative metadata stores', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort(), legacyDirectory = join(directory, 'legacy');
  const { NODE_OPTIONS, auditPath } = await auditedEnvironment(directory);
  const legacy = `AI_PROVIDER=hybrid\nANTHROPIC_MODEL=old-model\nOPENAI_API_KEY=test-key-never-send\nLOCAL_AI_API_KEY=test-key-never-send\nLOCAL_AI_BASE_URL=https://paid.invalid/v1\nLOCAL_AI_MODEL=paid-model\nLOCAL_AI_REASONING_EFFORT=high\nLOCAL_AI_TOOLS=false\nLOCAL_AI_MAX_TOKENS=99999\nAIFACTORY_CHEAP_PROVIDER=openai\nAIFACTORY_STRONG_PROVIDER=anthropic\nAIFACTORY_SNAPSHOT_CACHE=captured-world\nAIFACTORY_ARCHITECT_STORE=revisions\nAIFACTORY_TERRAIN_CACHE=off\nAIFACTORY_ROUTING_LOG=off\nNODE_OPTIONS=${NODE_OPTIONS}\n`;
  try {
    await mkdir(legacyDirectory);
    await writeFile(join(legacyDirectory, '.env'), legacy);
    const started = await startCompanion({ port, stateDirectory: directory }, { legacyDirectory });
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    assertLocalEnvironment(audit.atImport);
    assertLocalEnvironment(audit.current);
    assert(audit.calls.length > 0);
    assert(audit.calls.every(call => call.url === 'http://127.0.0.1:11436/v1/models' && call.method === 'GET'));
    assert.deepEqual(started.status.identity.metadataStores, {
      snapshot: join(legacyDirectory, 'captured-world'), architect: join(legacyDirectory, 'revisions'), terrain: null,
    });
    assert.equal(await readFile(join(legacyDirectory, '.env'), 'utf8'), legacy);
    for (const name of ['launch.json', 'owned-service.json', 'last-start.json', 'stdout.log', 'stderr.log']) {
      assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /test-key-never-send/);
    }
  } finally { await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory); }
});

test('direct service entry sanitizes inherited credentials before the real bridge reads its environment', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort();
  const { NODE_OPTIONS, auditPath } = await auditedEnvironment(directory);
  let child;
  try {
    await startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment });
    await stopCompanion({ port, stateDirectory: directory });
    child = spawn(resolve('runtime/node/node.exe'), [resolve('scripts/start-companion.mjs'), '--serve', join(directory, 'launch.json')], {
      cwd: resolve('runtime/satisfactory-companion'), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ...isolatedEnvironment, NODE_OPTIONS, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key-never-send',
        ANTHROPIC_API_KEY: 'test-key-never-send', GOOGLE_API_KEY: 'test-key-never-send', LOCAL_AI_API_KEY: 'test-key-never-send',
        ANTHROPIC_MODEL: 'old-model', OPENAI_MODEL: 'paid-model', AIFACTORY_CHEAP_PROVIDER: 'openai', AIFACTORY_STRONG_PROVIDER: 'anthropic',
        LOCAL_AI_BASE_URL: 'https://paid.invalid/v1', LOCAL_AI_MODEL: 'paid-model', LOCAL_AI_REASONING_EFFORT: 'high',
        LOCAL_AI_TOOLS: 'false', LOCAL_AI_MAX_TOKENS: '99999' },
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    let identity;
    for (let n = 0; n < 100; n++) {
      try { identity = await (await fetch(`http://127.0.0.1:${port}/copilot/identity`)).json(); break; } catch {}
      if (child.exitCode !== null) throw Error('Direct companion service exited before readiness');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(identity?.provider, 'local');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.provider, 'local');
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(audit.atImport.provider, 'openai');
    assert(audit.atImport.forbiddenPresent.includes('OPENAI_API_KEY'));
    assertLocalEnvironment(audit.current);
    assert(audit.calls.length > 0);
    assert(audit.calls.every(call => call.url === 'http://127.0.0.1:11436/v1/models' && call.method === 'GET'));
    child.kill(); await exited;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory);
  }
});

test('an occupied port that never serves HTTP is refused without starting a companion', { timeout: 6000 }, async () => {
  const directory = await workspace();
  const foreign = createServer(() => {}), port = await listen(foreign);
  try {
    await assert.rejects(startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment }), /foreign|unverified|unknown/i);
  } finally { foreign.closeAllConnections(); await close(foreign); await cleanup(directory); }
});

test('failed startup cleans only its own process and saves a bounded failure receipt', { timeout: 20000 }, async () => {
  const directory = await workspace(), port = await freePort();
  try {
    await assert.rejects(startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment, startupTimeoutMs: 1 }), /start|ready|timeout/i);
    const failure = JSON.parse(await readFile(join(directory, 'last-start.json'), 'utf8'));
    assert.equal(failure.ok, false);
    assert.equal(failure.cleanupConfirmed, true);
    assert.equal(typeof failure.launcherPid, 'number');
    assert.throws(() => process.kill(failure.launcherPid, 0));
    assert.equal((await companionStatus({ port, stateDirectory: directory })).owned, false);
  } finally { await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory); }
});

test('a blocked startup receipt releases the guard and stops its newly launched service', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort(), options = { port, stateDirectory: directory, environment: isolatedEnvironment };
  try {
    await mkdir(join(directory, 'last-start.json'));
    await assert.rejects(startCompanion(options));
    await assert.rejects(access(join(directory, 'start.lock')));
    assert.equal((await companionStatus(options)).owned, false);
    await rmdir(join(directory, 'last-start.json'));
    assert.equal((await startCompanion(options)).ok, true);
  } finally { await stopCompanion(options).catch(() => {}); await cleanup(directory); }
});

test('bundled startup uses its own working directory when the optional legacy directory is absent', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort();
  const legacyDirectory = join(directory, 'legacy-does-not-exist');
  try {
    const started = await startCompanion({ port, stateDirectory: directory, environment: isolatedEnvironment }, { legacyDirectory });
    assert.equal(started.ok, true);
    const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
    assert.equal(launch.sourceDirectory, legacyDirectory);
    assert.equal(started.status.identity.workingDirectory, resolve('runtime/satisfactory-companion'));
    assert.equal(started.status.runtimeMatches, true);
  } finally { await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory); }
});

test('a changed desired bundle never erases live ownership, silently reuses old bytes or blocks an owned stop', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort();
  const options = { port, stateDirectory: directory, environment: isolatedEnvironment };
  try {
    const started = await startCompanion(options);
    const installed = JSON.parse(await readFile(resolve('runtime/satisfactory-companion/install-lock.json'), 'utf8'));
    const desired = { ...installed, runtimeSha256: 'a'.repeat(64), version: '1.0.0-next' };
    assert.notEqual(installed.runtimeSha256, desired.runtimeSha256);
    const dependencies = { readBundle: async () => desired };
    const status = await companionStatus(options, dependencies);
    assert.equal(status.owned, true);
    assert.equal(status.runtimeMatches, false);
    assert.equal(status.identity.pid, started.pid);
    assert.equal(status.identity.runtimeSha256, installed.runtimeSha256);
    assert.equal(status.version, desired.version);
    await assert.rejects(startCompanion(options, dependencies), /runtime|restart|update/i);
    assert.equal((await companionStatus(options)).identity.pid, started.pid);
    assert.equal((await stopCompanion(options, dependencies)).stopped, true);
    assert.throws(() => process.kill(started.pid, 0));
  } finally { await stopCompanion(options).catch(() => {}); await cleanup(directory); }
});

test('ownership also requires the live nonce, root, project and runtime to match the saved receipt', { timeout: 30000 }, async () => {
  const directory = await workspace(), port = await freePort(), options = { port, stateDirectory: directory };
  try {
    await startCompanion({ ...options, environment: isolatedEnvironment });
    const receiptPath = join(directory, 'owned-service.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    for (const field of ['instanceId', 'root', 'project', 'runtimeSha256', 'bridgeVersion']) {
      await writeFile(receiptPath, JSON.stringify({ ...receipt, [field]: 'different' }));
      try {
        assert.equal((await companionStatus(options)).owned, false, field);
        assert.equal((await stopCompanion(options)).stopped, false, field);
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      } finally { await writeFile(receiptPath, JSON.stringify(receipt)); }
    }
  } finally { await stopCompanion(options).catch(() => {}); await cleanup(directory); }
});
