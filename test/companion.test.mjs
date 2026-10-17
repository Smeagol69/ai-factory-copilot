import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, rmdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { companionStatus, startCompanion, stopCompanion } from '../lib/companion.mjs';

const base = resolve('state/companion');
const isolatedEnvironment = { AI_PROVIDER: 'mock', AIFACTORY_SNAPSHOT_CACHE: 'off', AIFACTORY_ARCHITECT_STORE: 'off',
  AIFACTORY_TERRAIN_CACHE: 'off', AIFACTORY_ROUTING_LOG: 'off' };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
async function workspace() { await mkdir(base, { recursive: true }); return mkdtemp(join(base, 'test-')); }
async function cleanup(path) { assert(resolve(path).startsWith(base + '\\') || resolve(path).startsWith(base + '/')); await rm(path, { recursive: true, force: true }); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }

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
    assert.equal(status.health.provider, 'mock');
    assert.equal(status.health.bridgeVersion, '1.0.0-beta.2');
    assert.equal(status.health.worldVerified, false);
    assert.deepEqual(status.identity.metadataStores, { snapshot: null, architect: null, terrain: null });
    assert.equal(status.model, null);
    assert.equal(status.startupModelCalls, 0);
    const stopped = await stopCompanion({ port, stateDirectory: directory });
    assert.equal(stopped.stopped, true);
    assert.throws(() => process.kill(first.pid, 0));
  } finally { await stopCompanion({ port, stateDirectory: directory }).catch(() => {}); await cleanup(directory); }
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
