import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyRuntime, companionHealth, loadProject } from '../lib/project.mjs';

test('a changed runtime commit or tracked file prevents launch verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sat-mcp-pin-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  try {
    git(['init', '-b', 'codex/fixture']);
    writeFileSync(join(dir, 'server.mjs'), 'export const revision = 1;\n');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial runtime fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    assert.equal(verifyRuntime(dir, commit).commit, commit);
    assert.throws(() => verifyRuntime(dir, '0'.repeat(40)), /commit/i);
    writeFileSync(join(dir, 'server.mjs'), 'export const revision = 2;\n');
    assert.throws(() => verifyRuntime(dir, commit), /tracked|changed|dirty/i);
  } finally {
    assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline health does not contact a service or imply a loaded world', async () => {
  const result = await companionHealth(8142, { offline: true, fetchImpl() { throw new Error('Unexpected network call'); } });
  assert.equal(result.reachable, null);
  assert.equal(result.status, 'not-checked');
  assert.equal(result.worldVerified, false);
});

test('the fixed localhost GET requires the real bridge schema and preserves degraded readiness', async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify({ status: 'degraded', schema: 'aifactory.bridge.health', bridge_version: '1.0.0-beta.2', provider: 'anthropic', model: 'configured-model', readiness: { operational_ready: false }, unexpectedSecret: 'never echo this' }));
  };
  const result = await companionHealth(8142, { fetchImpl });
  assert.equal(seen.url, 'http://127.0.0.1:8142/health');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(result.reachable, true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.operationalReady, false);
  assert.equal(result.worldVerified, false);
  assert(!JSON.stringify(result).includes('never echo this'));
});

test('unrelated, malformed, oversized and unavailable services never become a ready adapter', async () => {
  for (const fetchImpl of [
    async () => new Response('{"status":"ok"}'),
    async () => new Response('not json'),
    async () => new Response('x'.repeat(65537)),
    async () => new Response('{}', { status: 503 }),
    async () => { throw new Error('private service details'); },
  ]) {
    const r = await companionHealth(8142, { fetchImpl });
    assert.equal(r.operationalReady, false);
    assert.equal(r.worldVerified, false);
    assert.notEqual(r.status, 'ok');
    assert(!JSON.stringify(r).includes('private service details'));
  }
});

test('project configuration refuses invalid pins, ports and paid startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sat-mcp-config-'));
  try {
    const base = loadProject().config;
    for (const changed of [
      { ...base, progressPort: 70000 },
      { ...base, runtime: { ...base.runtime, commit: 'HEAD' } },
      { ...base, runtime: { ...base.runtime, charterSha256: 'not-a-content-hash' } },
      { ...base, game: { ...base.game, companionPort: '8142' } },
      { ...base, startup: { ...base.startup, modelCalls: 1 } },
    ]) {
      writeFileSync(join(dir, 'project.json'), JSON.stringify(changed));
      assert.throws(() => loadProject(dir));
    }
  } finally {
    assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
