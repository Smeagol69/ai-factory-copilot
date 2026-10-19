import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const digest = text => createHash('sha256').update(text).digest('hex');
const tools = ['inspect_pe_resources', 'open_binary', 'binary_overview', 'search_procedures', 'list_procedures', 'procedure_pseudo_code', 'close_binary']
  .map(name => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(
    ({ inspect_pe_resources: ['path', 'max_file_bytes', 'max_entries'], open_binary: ['path', 'provider_id'],
      search_procedures: ['pattern', 'mode', 'case_sensitive'], procedure_pseudo_code: ['procedure'] }[name] ?? []).map(key => [key, {}])), additionalProperties: false } }));
const evidence = (operation, normalized_result) => ({ structuredContent: { evidence_id: `fixture:${operation}`, operation, normalized_result,
  subject: { digest: { sha256: digest('main game') } }, provider: { id: 'ghidra', version: 'fixture' }, limitations: [] } });

test('production rejects fixture options despite spoofed test environment or application arguments', () => {
  const moduleUrl = new URL('../lib/re-game-adapter.mjs', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import { createReGameAdapter } from ${JSON.stringify(moduleUrl)};
    assert.throws(() => createReGameAdapter({ root: process.cwd(),
      _testTarget: { gameDirectory: 'fixture-game', sdkDirectory: 'fixture-sdk' } }),
      { code: 'RE_TEST_TARGET_FORBIDDEN' });
    assert.throws(() => createReGameAdapter({ root: process.cwd() },
      { gameDirectory: 'fixture-game', sdkDirectory: 'fixture-sdk' }), TypeError);`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  for (const scenario of [
    { name: 'ordinary production', env, args: [] },
    { name: 'spoofed test marker', env: { ...env, NODE_TEST_CONTEXT: 'child-v8', NODE_ENV: 'test' }, args: [] },
    { name: 'test-like application argument', env, args: ['--test', '--test-fixture-target'] },
  ]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, '--', ...scenario.args], {
      env: scenario.env, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, `${scenario.name}: ${child.error?.message ?? child.stderr}`);
  }
});

async function fixture(t, behavior = {}) {
  assert(existsSync(new URL('../lib/re-game-adapter.mjs', import.meta.url)), 'Real game RE adapter must exist');
  const { createReGameAdapter } = await import('../lib/re-game-adapter.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-game-re-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gameDirectory = join(root, 'fixture-game'), sdkDirectory = join(root, 'fixture-sdk');
  const put = (relative, text) => { const file = join(gameDirectory, relative); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file; };
  const main = put('FactoryGame/Binaries/Win64/FactoryGameSteam-FactoryGame-Win64-Shipping.dll', 'main game');
  put('FactoryGameSteam.exe', 'launcher');
  put('FactoryGame/Mods/AIFactoryCopilot/Binaries/Win64/FactoryGameSteam-AIFactoryCopilot-Win64-Shipping.dll', 'old mod');
  put('Engine/Binaries/Win64/FactoryGameSteam-Win64-Shipping.version', JSON.stringify({ GameVersion: '1.2.4.1', Changelist: 513885, BuildId: '513885' }));
  put('FactoryGame/Binaries/Win64/FactoryGameSteam-Win64-Shipping.modules', JSON.stringify({ BuildId: '513885', Modules: { FactoryGame: 'FactoryGameSteam-FactoryGame-Win64-Shipping.dll' } }));
  const headers = join(sdkDirectory, 'Source/FactoryGame/Public'); mkdirSync(headers, { recursive: true });
  writeFileSync(join(headers, 'FGBlueprintHologram.h'), 'class FACTORYGAME_API AFGBlueprintHologram { public: void Build(); };\n');
  writeFileSync(join(headers, 'FGData.h'), 'struct FData {};\nenum EMode { One };\n');
  const calls = []; let closed = false;
  const client = {
    listTools: async () => ({ tools }),
    callTool: async ({ name, arguments: args }, options) => {
      calls.push({ name, args, signal: options?.signal });
      if (behavior[name]) return behavior[name](args, options);
      if (name === 'open_binary') return { structuredContent: { result: { sha256: digest('main game') } } };
      if (name === 'binary_overview') return evidence(name, { procedure_count: 100, string_count: 200 });
      if (name === 'search_procedures') return evidence(name, [{ address: '0x100', value: 'AFGBlueprintHologram::Build' }, { address: '0x200', value: 'AFGBuildable::Tick' }]);
      if (name === 'procedure_pseudo_code') return evidence(name, `void ${args.procedure}() { /* recovered pseudocode */ }`);
      if (name === 'inspect_pe_resources') return evidence(name, { format: 'pe32-plus', coverage: { status: 'complete', resources: 1, examined_entries: 3 } });
      return { structuredContent: { result: null } };
    },
    close: async () => { closed = true; }
  };
  const adapter = createReGameAdapter({ root, openRea: async () => client }, () => ({ gameDirectory, sdkDirectory }));
  return { root, gameDirectory, sdkDirectory, main, calls, closed: () => closed, adapter, runId: randomUUID(), createReGameAdapter };
}

test('inventory fingerprints actual game files and indexes declared SDK APIs without claiming native addresses', async t => {
  const f = await fixture(t);
  const result = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  assert.equal(result.inventory.find(file => file.id === 'game-dll').sha256, digest('main game'));
  assert.equal(result.build.gameVersion, '1.2.4.1'); assert.equal(result.build.changelist, 513885);
  assert.equal(result.headers.headerCount, 2); assert.equal(result.headers.declarationCount, 3);
  assert.equal(result.headers.kind, 'declared-sdk-api'); assert.equal(result.headers.nativeAddressesEstablished, false);
  const index = JSON.parse(readFileSync(result.headers.indexFile, 'utf8'));
  assert.equal(index.headers.length, 2); assert(index.headers.every(header => /^[a-f0-9]{64}$/.test(header.sha256)));
  assert(!JSON.stringify(result).includes('void Build();'), 'model projection excludes full header source');
  assert.equal(f.calls.length, 0, 'inventory does not launch REA or inference');
});

test('only the registered target is accepted and captured paths cannot redirect inspection', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.target({ targetId: '../other', runId: f.runId }), { code: 'RE_UNKNOWN_TARGET' });
  await assert.rejects(f.adapter.target({ targetId: 'satisfactory', runId: f.runId, path: '/unowned.exe' }), { code: 'RE_TARGET_PATH_FORBIDDEN' });
  const target = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  target.inventory.find(file => file.id === 'game-dll').path = '/unowned.exe';
  await assert.rejects(f.adapter.inspect({ target, runId: f.runId }), { code: 'RE_TARGET_IDENTITY' });
  assert.equal(f.calls.length, 0);
});

test('native sampling uses only returned procedure names and saves complete evidence before lean publication', async t => {
  const f = await fixture(t);
  const target = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  const result = await f.adapter.inspect({ target, runId: f.runId });
  assert.equal(f.calls[0].name, 'inspect_pe_resources'); assert.equal(f.calls[1].name, 'open_binary');
  assert.equal(f.calls.find(call => call.name === 'open_binary').args.path, f.main);
  assert.equal(result.native.procedureCount, 100); assert.equal(result.native.sampledProcedures, 2);
  assert.equal(result.native.coverage, 'sampled'); assert.equal(result.entireGameReverseEngineered, false);
  assert(f.calls.filter(call => call.name === 'procedure_pseudo_code').every(call => ['AFGBlueprintHologram::Build', 'AFGBuildable::Tick'].includes(call.args.procedure)));
  assert(result.evidenceFiles.length >= 5); assert(result.evidenceFiles.every(file => existsSync(file.path)));
  assert.equal(f.calls.at(-1).name, 'close_binary'); assert.equal(f.closed(), true);
  assert(!JSON.stringify(result).includes('recovered pseudocode'), 'raw decompilation is not dumped into model context');
});

test('Ghidra resource errors remain exact typed unknowns while portable and header facts survive', async t => {
  const f = await fixture(t, { open_binary: async () => ({ isError: true, structuredContent: { error: { code: 'resource_constraint', message: 'Ghidra heap exhausted', details: { resource: 'memory' } } } }) });
  const target = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  const result = await f.adapter.inspect({ target, runId: f.runId });
  assert.equal(result.native.status, 'unknown'); assert.equal(result.native.error.code, 'resource_constraint');
  assert.equal(result.native.error.message, 'Ghidra heap exhausted');
  assert.equal(result.portable.status, 'observed'); assert.equal(result.headers.headerCount, 2);
  assert(result.capabilitiesMissing.length); assert(result.unknowns.some(text => /native/i.test(text)));
  assert.equal(f.calls.at(-1).name, 'close_binary'); assert.equal(f.closed(), true);
});

test('cancellation closes the active binary and client without replaying the aborted tool', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { binary_overview: async () => { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } });
  const target = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  await assert.rejects(f.adapter.inspect({ target, runId: f.runId, signal: controller.signal }), { code: 'RE_CANCELLED' });
  assert.equal(f.calls.filter(call => call.name === 'binary_overview').length, 1);
  assert.equal(f.calls.at(-1).name, 'close_binary'); assert.equal(f.calls.at(-1).signal, undefined, 'cleanup does not inherit aborted signal');
  assert.equal(f.closed(), true);
});

test('a changed captured binary is not sent to REA under its previous fingerprint', async t => {
  const f = await fixture(t); const target = await f.adapter.target({ targetId: 'satisfactory', runId: f.runId });
  writeFileSync(f.main, 'changed game');
  await assert.rejects(f.adapter.inspect({ target, runId: f.runId }), { code: 'RE_ARTIFACT_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('publish retains a sourced partial report and human summary without promoting whole-game completion', async t => {
  const f = await fixture(t);
  const result = await f.adapter.publish({ runId: f.runId, targetId: 'satisfactory', policy: { maxCostUsd: null }, report: {
    entireGameReverseEngineered: false, findings: [{ claim: 'Declared API', classification: 'verified', sources: ['headers:index'] }],
    unknowns: ['Runtime behavior unknown'], coverage: { completeness: 'unknown', analyzedArtifacts: 1 } } });
  assert.equal(result.saved, true); assert.equal(result.entireGameReverseEngineered, false);
  assert.match(readFileSync(result.summaryFile, 'utf8'), /partial|unknown/i);
  assert.equal(JSON.parse(readFileSync(result.reportFile, 'utf8')).report.findings[0].sources[0], 'headers:index');
});
