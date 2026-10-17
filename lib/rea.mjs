import { readFile, writeFile, mkdir, rename, stat, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import childProcess, { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = resolve(ROOT, 'tools/rea/node_modules/rea-agents');
const ENTRY = join(PACKAGE, 'scripts/rea.mjs');
const WRAPPER = resolve(ROOT, 'scripts/rea.mjs');
const STATE = resolve(ROOT, 'state/rea');
const FIXTURE = resolve(ROOT, 'test/fixtures/rea/app');
const VERSION = '6.5.0';
const INTEGRITY = 'sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==';
const runFile = promisify(execFile);
const nativeLimitation = 'Native verification covers only an explicitly checked owned fixture. Other engines, live applications and device workflows remain unverified; registration is not proof of usability.';
const NATIVE = {
  ghidra: { version: '12.1.4', directory: 'tools/ghidra/ghidra_12.1.4_PUBLIC', sha256: 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db', files: ['support/analyzeHeadless.bat', 'Ghidra/application.properties', 'Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe', 'LICENSE'] },
  java: { version: '21.0.12.1+1', directory: 'tools/java/jdk-21.0.12.1+1', sha256: 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e', files: ['bin/java.exe', 'bin/javac.exe', 'release', 'legal/java.base/LICENSE'] },
};

const quietLaunch = Symbol.for('satisfactory-lab.rea.quiet-process');
export function installReaQuietProcessPolicy() {
  if (process.platform !== 'win32') return;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const original = childProcess[name];
    if (original[quietLaunch]) continue;
    const optionsAt = args => (name.startsWith('spawn') || name.startsWith('execFile')) && Array.isArray(args[1]) ? 2 : 1;
    const withQuietOptions = input => {
      const args = [...input], index = optionsAt(args), options = args[index];
      if (typeof options === 'function') args.splice(index, 0, { windowsHide: true, detached: false });
      else if (options == null || (typeof options === 'object' && !Array.isArray(options))) args[index] = { ...options, windowsHide: true, detached: false };
      // Invalid overloads retain Node's own validation rather than becoming launches.
      return args;
    };
    const wrapped = function (...args) { return Reflect.apply(original, this, withQuietOptions(args)); };
    Object.defineProperty(wrapped, quietLaunch, { value: true });
    if (original[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, {
      value: function (...args) { return Reflect.apply(original[promisify.custom], this, withQuietOptions(args)); },
    });
    childProcess[name] = wrapped;
  }
  // The official package uses named ESM imports; synchronize those bindings too.
  syncBuiltinESMExports();
}

async function json(path, maxBytes = 1024 * 1024) {
  if ((await stat(path)).size > maxBytes) throw new Error('Bounded JSON input exceeded');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}
const sha256 = data => createHash('sha256').update(data).digest('hex');

let nativeFingerprintCache;
async function nativeImplementationIdentity() {
  const files = [];
  async function inventory(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await inventory(path, relative);
      else if (entry.isFile()) files.push({ path, relative });
      else throw new Error('Unexpected linked native engine content');
    }
  }
  for (const [id, engine] of Object.entries(NATIVE)) await inventory(resolve(ROOT, engine.directory), id);
  files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const metadata = [];
  for (let start = 0; start < files.length; start += 64) {
    metadata.push(...await Promise.all(files.slice(start, start + 64).map(async file => {
      const info = await stat(file.path, { bigint: true });
      return [file.relative, String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
    })));
  }
  const metadataKey = sha256(JSON.stringify(metadata));
  // Stat all installed files on every read, but re-read their contents only
  // when a path, size or timestamp changed. No JVM/process runs for status.
  if (nativeFingerprintCache?.metadataKey === metadataKey) return nativeFingerprintCache.promise;
  const promise = (async () => {
    const manifest = [];
    for (let start = 0; start < files.length; start += 8) {
      manifest.push(...await Promise.all(files.slice(start, start + 8).map(async (file, offset) => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file.path)) hash.update(chunk);
        const after = await stat(file.path, { bigint: true });
        const expected = metadata[start + offset];
        if (String(after.size) !== expected[1] || String(after.mtimeNs) !== expected[2] || String(after.ctimeNs) !== expected[3]) throw new Error('Native file changed while hashing');
        return [file.relative, hash.digest('hex')];
      })));
    }
    return { implementationSha256: sha256(JSON.stringify(manifest)), implementationFileCount: manifest.length };
  })();
  nativeFingerprintCache = { metadataKey, promise };
  try { return await promise; }
  catch (error) { if (nativeFingerprintCache?.promise === promise) nativeFingerprintCache = undefined; throw error; }
}

async function nativeInstallation() {
  try {
    const lock = await json(resolve(ROOT, 'tools/native-engines-lock.json'), 32768);
    if (lock.schemaVersion !== 1 || lock.platform !== process.platform || lock.architecture !== process.arch || !Array.isArray(lock.engines)) throw new Error('Native lock mismatch');
    for (const [id, expected] of Object.entries(NATIVE)) {
      const engine = lock.engines.find(item => item.id === id);
      if (engine?.version !== expected.version || engine.directory !== expected.directory || engine.sha256 !== expected.sha256 || engine.files?.length !== expected.files.length) throw new Error('Native pin mismatch');
      for (const path of expected.files) {
        const pinned = engine.files.find(item => item.path === path);
        if (!pinned || pinned.sha256 !== sha256(await readFile(resolve(ROOT, expected.directory, path)))) throw new Error('Native runtime changed');
      }
    }
    return { installed: true, provider: 'ghidra', lockSha256: sha256(JSON.stringify(lock)), ...await nativeImplementationIdentity(),
      ghidraDirectory: resolve(ROOT, NATIVE.ghidra.directory), javaDirectory: resolve(ROOT, NATIVE.java.directory),
      ghidraVersion: NATIVE.ghidra.version, javaVersion: NATIVE.java.version };
  } catch { return { installed: false, provider: 'ghidra' }; }
}

async function identities() {
  const files = ['index.js', 'package.json', 'rates.js'];
  const fixture = await Promise.all(files.map(async path => [path, sha256(await readFile(join(FIXTURE, path)))]));
  // The dispatcher imports bundled implementation chunks and native controls.
  // Bind evidence to the complete published module, not only its tiny entry.
  const packageFiles = [];
  async function inventory(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue;
      const relative = prefix + item.name;
      if (item.isDirectory()) await inventory(join(directory, item.name), relative + '/');
      else if (item.isFile()) packageFiles.push(relative);
      else throw new Error('Unexpected linked package content');
    }
  }
  await inventory(PACKAGE);
  packageFiles.sort();
  const manifest = [];
  for (let start = 0; start < packageFiles.length; start += 32) {
    manifest.push(...await Promise.all(packageFiles.slice(start, start + 32).map(async path => [path, sha256(await readFile(join(PACKAGE, path)))])));
  }
  const integration = await Promise.all(['lib/rea.mjs', 'scripts/rea.mjs', 'scripts/check-rea.mjs'].map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]));
  return { entrySha256: sha256(await readFile(ENTRY)), integrationSha256: sha256(JSON.stringify(integration)), packageSha256: sha256(JSON.stringify(manifest)),
    packageFileCount: manifest.length, fixtureSha256: sha256(JSON.stringify(fixture)) };
}

// Child defaults are project-local. API credentials, NODE_OPTIONS, and unrelated
// agent configuration are deliberately absent from this tool's environment.
export async function reaEnvironment() {
  const paths = {
    XDG_CACHE_HOME: join(STATE, 'cache'), XDG_CONFIG_HOME: join(STATE, 'config'),
    XDG_DATA_HOME: join(STATE, 'data'), XDG_STATE_HOME: join(STATE, 'data'),
    APPDATA: join(STATE, 'appdata'), LOCALAPPDATA: join(STATE, 'localappdata'),
    TEMP: join(STATE, 'tmp'), TMP: join(STATE, 'tmp'), TMPDIR: join(STATE, 'tmp'),
    PLAYWRIGHT_BROWSERS_PATH: join(STATE, 'browsers'), npm_config_cache: join(STATE, 'npm-cache'),
  };
  await Promise.all([...new Set(Object.values(paths)), join(STATE, 'output')].map(path => mkdir(path, { recursive: true })));
  const environment = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROCESSOR_ARCHITECTURE',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM']) {
    if (typeof process.env[key] === 'string' && !process.env[key].startsWith('()')) environment[key] = process.env[key];
  }
  const native = await nativeInstallation();
  return { ...environment, ...paths, REA_LOG_LEVEL: 'error', REA_MCP_MAX_RESPONSE_BYTES: '10485760', NO_UPDATE_NOTIFIER: '1',
    ...(native.installed ? { GHIDRA_INSTALL_DIR: native.ghidraDirectory, JAVA_HOME: native.javaDirectory, REA_GHIDRA_STARTUP_TIMEOUT_MS: '120000' } : {}) };
}

export async function reaStatus() {
  let pkg, lock;
  try { [pkg, lock] = await Promise.all([json(join(PACKAGE, 'package.json')), json(resolve(ROOT, 'tools/rea/package-lock.json'))]); }
  catch { /* Missing installations are a status, not a reason to start npm. */ }
  const installed = pkg?.name === 'rea-agents' && existsSync(ENTRY) && existsSync(join(PACKAGE, 'dist/mcp/main.js')) && existsSync(join(PACKAGE, 'LICENSE'));
  const pinned = lock?.packages?.['node_modules/rea-agents'];
  const pinMatched = installed && pkg.version === VERSION && pinned?.version === VERSION && pinned?.integrity === INTEGRITY;
  let lastCheck = null, currentIdentity;
  if (pinMatched) {
    try {
      const saved = await json(join(STATE, 'latest-check.json'));
      const current = currentIdentity = await identities();
      if (saved.schema === 'satisfactory-lab.rea-check.v1' && saved.packageVersion === pkg.version &&
          saved.identity?.entrySha256 === current.entrySha256 && saved.identity?.integrationSha256 === current.integrationSha256 && saved.identity?.packageSha256 === current.packageSha256 && saved.identity?.fixtureSha256 === current.fixtureSha256 &&
          Array.isArray(saved.mcp?.toolNames) && saved.mcp.toolCount === saved.mcp.toolNames.length) lastCheck = saved;
    } catch { /* Evidence is optional and may be stale after a fixture/package change. */ }
  }
  const verified = lastCheck?.ok === true;
  const toolNames = lastCheck?.mcp?.handshake ? lastCheck.mcp.toolNames : [];
  const native = await nativeInstallation();
  let nativeCheck = null;
  if (pinMatched && native.installed) {
    try {
      const saved = await json(join(STATE, 'latest-native-check.json'));
      const current = currentIdentity ?? await identities();
      if (saved.schema === 'satisfactory-lab.rea-native-check.v1' && saved.packageVersion === pkg.version &&
          saved.identity?.packageSha256 === current.packageSha256 && saved.identity?.integrationSha256 === current.integrationSha256 &&
          saved.identity?.nativeLockSha256 === native.lockSha256 && saved.identity?.nativeImplementationSha256 === native.implementationSha256 &&
          saved.identity?.sourceSha256 === sha256(await readFile(resolve(ROOT, 'test/fixtures/rea/native.c'))) &&
          saved.identity?.binarySha256 === sha256(await readFile(join(STATE, 'native-fixture/copilot-fixture.exe')))) nativeCheck = saved;
    } catch { /* Native probes are explicit; status never starts a JVM. */ }
  }
  return {
    installed, version: pkg?.version ?? null,
    package: { name: pkg?.name ?? 'rea-agents', path: PACKAGE, version: pkg?.version ?? null, expectedVersion: VERSION, pinMatched: Boolean(pinMatched), integrity: pinned?.integrity ?? null },
    cli: { entry: ENTRY, wrapper: WRAPPER, verified: verified && lastCheck.cli?.helpVerified === true },
    mcp: { entry: WRAPPER, args: ['mcp'], verified: verified && lastCheck.mcp.handshake === true, toolCount: toolNames.length || null, toolNames },
    staticJavaScript: { verified, status: verified ? 'verified-owned-fixture' : installed ? 'installed-unverified' : 'not-installed', evidenceFile: join(STATE, 'latest-check.json') },
    native: { ...native, verified: nativeCheck?.ok === true, status: nativeCheck?.ok ? 'verified-owned-native-fixture' : native.installed ? 'installed-unverified' : 'not-installed', allEnginesVerified: false, limitation: nativeLimitation, lastCheck: nativeCheck },
    ready: Boolean(pinMatched && verified), verifiedTools: toolNames,
    limitations: [nativeLimitation, 'Static JavaScript relationships do not prove runtime behavior. The check analyzes only the owned synthetic fixture.', 'Cache/temp defaults are local; explicit user CLI paths and external engines can use their own locations.'],
    lastCheck, modelCalls: 0, gameWrites: 0,
  };
}

function sanitize(value) {
  // The fixed owned fixture contains no secrets. Persist only this analysis and
  // the tool names, never inherited environment, stderr, or arbitrary targets.
  const serialized = JSON.stringify(value).replaceAll(ROOT.replaceAll('\\', '\\\\'), '<project>').replaceAll(ROOT.replaceAll('\\', '/'), '<project>');
  return JSON.parse(serialized);
}

function summarize(evidence) {
  const result = evidence?.normalized_result;
  if (evidence?.operation !== 'analyze_javascript_application' || result?.graph?.schema !== 'JavaScriptApplicationGraph') throw new Error('Unexpected static Evidence schema');
  const observations = result.graph.nodes.flatMap(node => node.observations ?? []);
  const modules = [...new Set(observations.flatMap(observation => {
    const props = observation.properties ?? {};
    return [props.module_path, props.path].filter(path => typeof path === 'string' && /\.js$/.test(path));
  }))].sort();
  const imports = [...new Set(result.graph.edges.filter(edge => edge.relation === 'imports').map(edge => edge.properties?.specifier).filter(item => typeof item === 'string'))].sort();
  const limitations = [...new Set([...(evidence.limitations ?? []), ...(result.limitations ?? []), ...(result.graph.limitations ?? []), ...(result.semantic_graph?.limitations ?? [])])];
  return { tool: evidence.operation, structured: true, executedTarget: false,
    evidenceId: evidence.evidence_id, provider: evidence.provider.id,
    artifactSha256: result.root_artifact_sha256, modules, imports,
    nodeCount: result.graph.nodes.length, edgeCount: result.graph.edges.length,
    coverage: result.graph.coverage, limitations, unknowns: result.semantic_graph?.unknowns ?? [],
  };
}

async function saveReceipt(receipt, evidence, latestName = 'latest-check.json') {
  await mkdir(STATE, { recursive: true });
  if (evidence) await writeFile(join(STATE, `${receipt.checkId}-evidence.json`), JSON.stringify(sanitize(evidence), null, 2) + '\n');
  const content = JSON.stringify(sanitize(receipt), null, 2) + '\n';
  await writeFile(join(STATE, `${receipt.checkId}.json`), content);
  const temporary = join(STATE, `${receipt.checkId}.latest.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, join(STATE, latestName));
}

let runningCheck;
export function runReaCheck(options = {}) {
  // A control room double-click shares one bounded check rather than racing
  // analyses and competing writes to latest-check.json.
  if (!runningCheck) runningCheck = performCheck(options).finally(() => { runningCheck = undefined; });
  return runningCheck;
}

async function performCheck({ timeoutMs = 45000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('REA check timeout must be 1000..60000 milliseconds');
  const receipt = { schema: 'satisfactory-lab.rea-check.v1', checkId: `${Date.now()}-${randomUUID()}`,
    startedAt: new Date().toISOString(), packageVersion: null, ok: false,
    mcp: { handshake: false, toolCount: 0, toolNames: [] }, cli: { helpVerified: false },
    analysis: null, nativeVerified: false, modelCalls: 0, gameWrites: 0 };
  let client, evidence, timer, stage = 'installation';
  const controller = new AbortController();
  try {
    const status = await reaStatus();
    receipt.packageVersion = status.version;
    if (!status.package.pinMatched) throw new Error('Pinned REA installation unavailable');
    receipt.identity = await identities();
    const environment = await reaEnvironment();
    timer = setTimeout(() => controller.abort(new Error('REA check timed out')), timeoutMs);
    stage = 'cli-help';
    const { stdout } = await runFile(process.execPath, [WRAPPER, '--help'], { cwd: ROOT, env: environment, windowsHide: true, timeout: Math.min(timeoutMs, 15000), signal: controller.signal, maxBuffer: 256 * 1024 });
    if (!stdout.includes('rea@6.5.0') || !stdout.includes('analyze-javascript-application')) throw new Error('CLI help missing installed capabilities');
    receipt.cli.helpVerified = true;
    stage = 'mcp-handshake';
    const sdk = path => import(pathToFileURL(resolve(ROOT, 'tools/rea/node_modules/@modelcontextprotocol/client/dist', path)).href);
    const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('index.mjs'), sdk('stdio.mjs')]);
    client = new Client({ name: 'satisfactory-lab-owned-rea-check', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [WRAPPER], cwd: STATE,
      env: environment, stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024 });
    // SDK transport starts hidden on Windows. The wrapper imports the official
    // runtime in-process, so there is no orphanable wrapper child.
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    receipt.mcp.handshake = true;
    stage = 'mcp-catalog';
    const { tools } = await client.listTools({}, { signal: controller.signal, timeout: timeoutMs });
    receipt.mcp.toolNames = tools.map(tool => tool.name).sort();
    receipt.mcp.toolCount = tools.length;
    if (!receipt.mcp.toolNames.includes('analyze_javascript_application')) throw new Error('Static JS tool missing');
    stage = 'static-analysis';
    const response = await client.callTool({ name: 'analyze_javascript_application', arguments: {
      input_path: FIXTURE, format: 'directory', max_heap_mb: 256, analysis_timeout_ms: 15000,
      max_semantic_nodes: 1000, max_semantic_nodes_per_file: 500,
    } }, { signal: controller.signal, timeout: timeoutMs });
    if (response.isError || !response.structuredContent) throw new Error('REA did not return structured static Evidence');
    evidence = response.structuredContent;
    receipt.analysis = summarize(evidence);
    if (!receipt.analysis.modules.includes('index.js') || !receipt.analysis.modules.includes('rates.js') || !receipt.analysis.imports.includes('./rates.js')) throw new Error('Owned fixture relationships were not recovered');
    receipt.ok = true;
  } catch {
    // Raw errors can contain environment-specific paths or arguments. The
    // bounded stage and cancellation state are sufficient for this fixed check.
    receipt.error = { stage, reason: controller.signal.aborted ? 'Check timed out or was cancelled' : 'REA check failed; inspect the local installation and retry' };
  } finally {
    clearTimeout(timer);
    try { await client?.close(); } catch { receipt.ok = false; receipt.error = { stage: 'cleanup', reason: 'MCP cleanup could not be confirmed' }; }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.receiptFile = `state/rea/${receipt.checkId}.json`;
  if (evidence) receipt.evidenceFile = `state/rea/${receipt.checkId}-evidence.json`;
  await saveReceipt(receipt, evidence);
  return sanitize(receipt);
}

let runningNativeCheck;
export function runReaNativeCheck(options = {}) {
  if (!runningNativeCheck) runningNativeCheck = performNativeCheck(options).finally(() => { runningNativeCheck = undefined; });
  return runningNativeCheck;
}

async function performNativeCheck({ timeoutMs = 180000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('REA native timeout must be 1000..180000 milliseconds');
  const receipt = { schema: 'satisfactory-lab.rea-native-check.v1', checkId: `native-${Date.now()}-${randomUUID()}`,
    startedAt: new Date().toISOString(), ok: false, packageVersion: null, provider: 'ghidra',
    mcp: { handshake: false }, analysis: null, modelCalls: 0, gameWrites: 0 };
  const controller = new AbortController();
  let client, connected = false, evidence, stage = 'installation', timer;
  try {
    const status = await reaStatus();
    receipt.packageVersion = status.version;
    if (!status.package.pinMatched || !status.native.installed) throw new Error('Pinned engines unavailable');
    const build = await json(join(STATE, 'native-fixture/build.json'), 32768);
    const sourceSha256 = sha256(await readFile(resolve(ROOT, 'test/fixtures/rea/native.c')));
    const binary = join(STATE, 'native-fixture/copilot-fixture.exe');
    const binarySha256 = sha256(await readFile(binary));
    if (build.sourceSha256 !== sourceSha256 || build.binarySha256 !== binarySha256 || build.executedTarget !== false) throw new Error('Owned fixture build identity mismatch');
    receipt.identity = { ...await identities(), nativeLockSha256: status.native.lockSha256, nativeImplementationSha256: status.native.implementationSha256, sourceSha256, binarySha256 };
    timer = setTimeout(() => controller.abort(new Error('Native check timed out')), timeoutMs);
    stage = 'mcp-handshake';
    const sdk = path => import(pathToFileURL(resolve(ROOT, 'tools/rea/node_modules/@modelcontextprotocol/client/dist', path)).href);
    const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('index.mjs'), sdk('stdio.mjs')]);
    client = new Client({ name: 'satisfactory-lab-owned-native-check', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [WRAPPER], cwd: STATE,
      env: { ...await reaEnvironment(), REA_ANALYSIS_PROVIDER: 'ghidra' }, stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024 });
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    connected = true;
    receipt.mcp.handshake = true;
    receipt.mcp.serverPid = transport.pid;
    stage = 'open-owned-native-fixture';
    const opened = await client.callTool({ name: 'open_binary', arguments: { path: binary, provider_id: 'ghidra' } }, { signal: controller.signal, timeout: timeoutMs });
    if (opened.isError || opened.structuredContent?.result?.sha256 !== binarySha256) throw new Error('Native fixture admission failed');
    evidence = { opened: opened.structuredContent };
    stage = 'ghidra-decompile';
    const response = await client.callTool({ name: 'procedure_pseudo_code', arguments: { procedure: 'copilot_scale' } }, { signal: controller.signal, timeout: timeoutMs });
    const decompiled = response.structuredContent;
    if (response.isError || decompiled?.provider?.id !== 'ghidra' || decompiled.provider.version !== NATIVE.ghidra.version ||
        decompiled.subject?.digest?.sha256 !== binarySha256 || typeof decompiled.normalized_result !== 'string') throw new Error('Native structured Evidence unavailable');
    evidence.decompiled = decompiled;
    const code = decompiled.normalized_result;
    if (!code.includes('copilot_scale') || !/\*\s*3/.test(code) || !/\+\s*7/.test(code)) throw new Error('Fixture arithmetic was not recovered');
    receipt.analysis = { tool: 'procedure_pseudo_code', structured: true, executedTarget: false,
      providerVersion: decompiled.provider.version, javaVersion: NATIVE.java.version, evidenceId: decompiled.evidence_id,
      artifactSha256: binarySha256, function: 'copilot_scale', code,
      limitations: decompiled.limitations,
      unknowns: [{ source: 'copilot-check', reason: 'runtime-unobserved', detail: 'Runtime invocation and behavior were not observed. This static fixture does not verify arbitrary native targets or other engines.' }],
    };
    receipt.ok = true;
  } catch {
    receipt.error = { stage, reason: controller.signal.aborted ? 'Native check timed out or was cancelled' : 'Native check failed; verify the pinned engines and owned fixture' };
  } finally {
    clearTimeout(timer);
    if (connected) {
      try {
        const closed = await client.callTool({ name: 'close_binary', arguments: {} }, { timeout: 15000 });
        if (closed.isError) throw new Error('Native close refused');
        if (evidence) evidence.closed = closed.structuredContent ?? null;
        receipt.mcp.targetClosed = true;
      } catch { receipt.ok = false; receipt.error = { stage: 'cleanup', reason: 'Native target cleanup could not be confirmed' }; }
    }
    try { await client?.close(); } catch { receipt.ok = false; receipt.error = { stage: 'cleanup', reason: 'Native MCP cleanup could not be confirmed' }; }
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.receiptFile = `state/rea/${receipt.checkId}.json`;
  if (evidence) receipt.evidenceFile = `state/rea/${receipt.checkId}-evidence.json`;
  await saveReceipt(receipt, evidence, 'latest-native-check.json');
  return sanitize(receipt);
}
