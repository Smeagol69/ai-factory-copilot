import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import * as rea from '../lib/rea.mjs';
import { reaStatus, runReaCheck, reaEnvironment } from '../lib/rea.mjs';

// Catches an installation/README claim being presented as verified tool execution.
test('REA status identifies the actual pinned package and distinguishes native engine verification', async () => {
  const status = await reaStatus();
  assert.equal(status.installed, true);
  assert.equal(status.package.name, 'rea-agents');
  assert.equal(status.version, '6.5.0');
  assert.equal(status.package.pinMatched, true);
  assert.deepEqual(status.mcp.args, ['mcp']);
  assert.equal(status.native.allEnginesVerified, false);
  assert(status.limitations.some(item => /native/i.test(item)));
  assert.equal(status.modelCalls, 0);
});

// Catches a broken local launcher, catalog-only success, target execution, or discarded uncertainty.
test('real REA MCP analysis reads the owned fixture and saves bounded structured evidence', { timeout: 90000 }, async () => {
  const result = await runReaCheck();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.packageVersion, '6.5.0');
  assert.equal(result.mcp.handshake, true);
  assert(result.mcp.toolNames.includes('analyze_javascript_application'));
  assert.equal(result.mcp.toolCount, result.mcp.toolNames.length);
  assert.equal(result.analysis.tool, 'analyze_javascript_application');
  assert.equal(result.analysis.executedTarget, false);
  assert.equal(result.analysis.structured, true);
  assert(result.analysis.modules.includes('index.js'));
  assert(result.analysis.modules.includes('rates.js'));
  assert(result.analysis.imports.some(item => item.includes('./rates.js')));
  assert(Array.isArray(result.analysis.limitations));
  assert(Array.isArray(result.analysis.unknowns));
  assert(result.analysis.limitations.length > 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.gameWrites, 0);
  const saved = JSON.parse(await readFile(resolve('state/rea/latest-check.json'), 'utf8'));
  assert.equal(saved.checkId, result.checkId);
  assert.equal(saved.ok, true);
  const status = await reaStatus();
  assert.equal(status.mcp.verified, true);
  assert.equal(status.staticJavaScript.verified, true);
  assert.equal(status.native.allEnginesVerified, false);
});

// Catches stale execution receipts being displayed as current verification.
test('REA status rejects a receipt for different fixture bytes', async () => {
  const path = resolve('state/rea/latest-check.json');
  const original = await readFile(path, 'utf8');
  const receipt = JSON.parse(original);
  receipt.identity.fixtureSha256 = '0'.repeat(64);
  try {
    await writeFile(path, JSON.stringify(receipt));
    const status = await reaStatus();
    assert.equal(status.mcp.verified, false);
    assert.equal(status.staticJavaScript.verified, false);
  } finally { await writeFile(path, original); }
});

// Catches installed implementation changes hidden behind an unchanged CLI dispatcher.
test('REA verification expires when the installed runtime implementation changes', async () => {
  const path = resolve('tools/rea/node_modules/rea-agents/dist/config/environment.js');
  const original = await readFile(path);
  assert.equal((await reaStatus()).mcp.verified, true);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('\n// Controlled stale-evidence test.\n')]));
    const status = await reaStatus();
    assert.equal(status.mcp.verified, false);
    assert.equal(status.staticJavaScript.verified, false);
  } finally { await writeFile(path, original); }
});

// Catches a wrapper rebasing caller-supplied relative target paths to its output folder.
test('REA CLI forwards relative input paths and format arguments', { timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve('scripts/rea.mjs'),
    'analyze-javascript-application', 'test/fixtures/rea/app', '--format', 'json'],
  { cwd: resolve('.'), env: await reaEnvironment(), windowsHide: true, timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  const output = JSON.parse(stdout);
  assert(JSON.stringify(output).includes('productionSummary'));
  assert(JSON.stringify(output).includes('./rates.js'));
});

// Native launches cannot be used to reproduce visible windows on the user's desktop.
// This earned boundary double captures only the options sent to child_process.
test('REA quiet policy forces hidden non-detached launches across child-process overloads', () => {
  assert.equal(typeof rea.installReaQuietProcessPolicy, 'function');
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
  const originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  const calls = [];
  try {
    for (const name of names) childProcess[name] = (...args) => { calls.push({ name, args }); return {}; };
    rea.installReaQuietProcessPolicy();
    for (const name of names) {
      const args = name.startsWith('exec') && !name.startsWith('execFile') ? [] : [['fixture']];
      childProcess[name]('unused-owned-fixture', ...args, { windowsHide: false, detached: true });
    }
    childProcess.execFile('unused-owned-fixture', () => {});
    for (const call of calls) {
      const options = call.args.find(value => value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(options.windowsHide, true, call.name);
      assert.equal(options.detached, false, call.name);
    }
    assert.equal(typeof calls.at(-1).args.at(-1), 'function');
  } finally {
    Object.assign(childProcess, originals);
    syncBuiltinESMExports();
  }
});

test('REA quiet policy preserves the real promisified execFile stdout and stderr contract', async () => {
  assert.equal(typeof rea.installReaQuietProcessPolicy, 'function');
  rea.installReaQuietProcessPolicy();
  const pending = promisify(childProcess.execFile)(process.execPath,
    ['-e', "process.stdout.write('owned-out');process.stderr.write('owned-error')"],
    { windowsHide: false, detached: true, timeout: 5000 });
  assert.equal(typeof pending.child?.pid, 'number');
  const result = await pending;
  assert.equal(result.stdout, 'owned-out');
  assert.equal(result.stderr, 'owned-error');
});

test('failed REA checks link only receipts and evidence files that actually exist', { timeout: 15000 }, async () => {
  const latest = resolve('state/rea/latest-check.json');
  const saved = await readFile(latest, 'utf8');
  try {
    const result = await runReaCheck({ timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(typeof result.receiptFile, 'string');
    assert.equal(result.evidenceFile, undefined);
    const receipt = JSON.parse(await readFile(resolve(result.receiptFile), 'utf8'));
    assert.equal(receipt.checkId, result.checkId);
    assert.equal(receipt.evidenceFile, undefined);
  } finally { await writeFile(latest, saved); }
});

test('REA native environment uses only the project-pinned portable engine paths', async () => {
  const status = await reaStatus();
  assert.equal(status.native.installed, true);
  assert.equal(status.native.provider, 'ghidra');
  const environment = await reaEnvironment();
  assert.equal(environment.GHIDRA_INSTALL_DIR, resolve('tools/ghidra/ghidra_12.1.4_PUBLIC'));
  assert.equal(environment.JAVA_HOME, resolve('tools/java/jdk-21.0.12.1+1'));
  assert.equal(status.native.allEnginesVerified, false);
  assert.equal(typeof rea.runReaNativeCheck, 'function');
});

test('native check refuses an unbounded deadline without launching an engine', async () => {
  assert.equal(typeof rea.runReaNativeCheck, 'function');
  await assert.rejects(rea.runReaNativeCheck({ timeoutMs: 0 }), /1000\.\.180000/);
});

// No engine is launched: modify and restore bytes in one owned executable JAR.
// Catches a stale native receipt surviving changes beyond the install sentinels.
test('native verification expires when an executing Ghidra JAR changes', async () => {
  const jar = resolve('tools/ghidra/ghidra_12.1.4_PUBLIC/Ghidra/Framework/Utility/lib/Utility.jar');
  const original = await readFile(jar);
  const before = await reaStatus();
  assert.equal(before.native.installed, true);
  assert.match(before.native.implementationSha256, /^[a-f0-9]{64}$/);
  try {
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(jar, changed);
    const status = await reaStatus();
    assert.equal(status.native.verified, false);
    assert.notEqual(status.native.implementationSha256, before.native.implementationSha256);
  } finally { await writeFile(jar, original); }
  assert.equal((await reaStatus()).native.implementationSha256, before.native.implementationSha256);
});

test('explicit real Ghidra check decompiles the owned PE without executing it',
  { skip: process.env.REA_NATIVE_SMOKE !== '1', timeout: 210000 }, async () => {
    const result = await rea.runReaNativeCheck();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.provider, 'ghidra');
    assert.equal(result.analysis.executedTarget, false);
    assert(result.analysis.code.includes('copilot_scale'));
    assert.match(result.analysis.code, /\*\s*3/);
    assert.match(result.analysis.code, /\+\s*7/);
    assert(result.analysis.limitations.length > 0);
    assert(Array.isArray(result.analysis.unknowns));
    assert.equal(JSON.parse(await readFile(resolve(result.receiptFile), 'utf8')).ok, true);
    assert.equal((await reaStatus()).native.verified, true);
  });
