import { readFile, writeFile, mkdir, open, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { companionHealth } from './project.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE = join(ROOT, 'state/companion');
const RUNTIME = join(ROOT, 'runtime/satisfactory-companion');
const NODE = join(ROOT, 'runtime/node/node.exe');
const SCRIPT = join(ROOT, 'scripts/start-companion.mjs');
const PROJECT = 'satisfactory-mcp-lab';
const SOURCE = 'D:/Modding/Satisfactory/Companion';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// This application's in-game bridge has no billable-provider mode. The
// separately pinned bridge runtime retains its upstream provider support.
const LOCAL_ONLY_ENV = Object.freeze({ AI_PROVIDER: 'local', LOCAL_AI_BASE_URL: 'http://127.0.0.1:11436/v1',
  LOCAL_AI_MODEL: 'copilot-hauhau-game:latest', LOCAL_AI_REASONING_EFFORT: 'none',
  LOCAL_AI_TOOLS: 'true', LOCAL_AI_MAX_TOKENS: '1024' });
const POLICY_SHA256 = digest(JSON.stringify({ schema: 'copilot.companion-local-only/v1', environment: LOCAL_ONLY_ENV }));
const NON_LOCAL_ENV = /^(?:OPENAI_|ANTHROPIC_|AIFACTORY_(?:CHEAP|STRONG)_PROVIDER$)|(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIAL)/i;
function enforceLocalOnlyEnvironment(env) {
  for (const key of Object.keys(env)) if (NON_LOCAL_ENV.test(key) || Object.hasOwn(LOCAL_ONLY_ENV, key.toUpperCase())) delete env[key];
  return Object.assign(env, LOCAL_ONLY_ENV);
}
const runFile = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function settings({ port = 8142, stateDirectory = STATE, startupTimeoutMs = 15000 } = {}) {
  stateDirectory = resolve(stateDirectory);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000 ||
      (stateDirectory !== STATE && !stateDirectory.startsWith(STATE + '/') && !stateDirectory.startsWith(STATE + '\\'))) throw new Error('Invalid companion port, state directory or startup timeout');
  return { port, stateDirectory, startupTimeoutMs };
}
async function json(path, maximum = 512 * 1024) {
  if ((await stat(path)).size > maximum) throw new Error('Companion metadata exceeds its bound');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}
async function bundle({ verify = false } = {}) {
  const lock = await json(join(RUNTIME, 'install-lock.json'));
  if (lock.schema !== 'copilot.companion-bundle/v1' || lock.sourceDirectory !== SOURCE || lock.version !== '1.0.0-beta.2' ||
      !Array.isArray(lock.files) || lock.files.length > 10000 || digest(JSON.stringify(lock.files)) !== lock.runtimeSha256) throw new Error('Installed companion bundle identity is unavailable');
  if (verify) for (const file of lock.files) {
    if (typeof file.path !== 'string' || file.path.includes('..') || isAbsolute(file.path) || file.path.includes('\\') || file.path.includes(':') ||
        digest(await readFile(join(RUNTIME, file.path))) !== file.sha256) throw new Error('Bundled companion runtime bytes changed');
  }
  return lock;
}
async function responseJson(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1000) });
  let size = 0; const chunks = [];
  for await (const bytes of response.body ?? []) { size += bytes.length; if (size > 8192) throw new Error('Unverified companion identity'); chunks.push(bytes); }
  if (!response.ok) throw new Error('Unverified companion identity');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function identity(port) { try { return await responseJson(`http://127.0.0.1:${port}/copilot/identity`); } catch { return null; } }
function matches(value, receipt, port) {
  return value?.application === 'copilot-owned-companion/v1' && value.root === ROOT && value.project === PROJECT &&
    receipt?.application === value.application && receipt.root === ROOT && receipt.project === PROJECT && receipt.port === port &&
    /^[a-f0-9]{64}$/.test(value.runtimeSha256) && value.runtimeSha256 === receipt.runtimeSha256 &&
    typeof value.bridgeVersion === 'string' && value.bridgeVersion === receipt.bridgeVersion &&
    /^[a-f0-9-]{36}$/.test(value.instanceId) && value.instanceId === receipt.instanceId &&
    Number.isInteger(value.pid) && value.pid > 0 && value.pid === receipt.pid;
}
async function occupied(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
  });
}

// The second argument is internal dependency injection. App routes accept no
// caller-defined paths, lock objects or environment values.
export async function companionStatus(options = {}, { readBundle = bundle } = {}) {
  const { port, stateDirectory } = settings(options);
  const [health, observed, lock, receipt] = await Promise.all([
    companionHealth(port), identity(port), readBundle().catch(() => null), json(join(stateDirectory, 'owned-service.json')).catch(() => null),
  ]);
  const owned = Boolean(matches(observed, receipt, port));
  const runtimeMatches = Boolean(owned && lock && observed.runtimeSha256 === lock.runtimeSha256 && observed.bridgeVersion === lock.version);
  const policyMatches = Boolean(owned && observed.policySha256 === POLICY_SHA256 && observed.localOnly === true &&
    observed.provider === 'local' && observed.model === LOCAL_ONLY_ENV.LOCAL_AI_MODEL && observed.endpoint === LOCAL_ONLY_ENV.LOCAL_AI_BASE_URL);
  return { schema: 'copilot.companion-status/v1', port, url: `http://127.0.0.1:${port}`, owned, health,
    identity: owned ? observed : null, version: lock?.version ?? null, bundled: Boolean(lock), runtimeMatches, policyMatches,
    runningVersion: owned ? observed.bridgeVersion : null,
    provider: owned ? observed.provider : null,
    model: owned ? observed.model : null, providerVerification: owned ? 'configuration_only' : 'unverified',
    worldVerified: false, startupModelCalls: 0, startupGameWrites: 0, scheduledTasksAdded: 0,
    limitation: 'Health verifies bridge/provider configuration only. It does not prove a loaded save, provider billing or model inference.' };
}

const starts = new Map();
export function startCompanion(options = {}, dependencies = {}) {
  const config = settings(options), key = `${config.stateDirectory}:${config.port}`;
  if (!starts.has(key)) starts.set(key, performStart({ ...options, ...config }, dependencies).finally(() => starts.delete(key)));
  return starts.get(key);
}
function baseEnvironment() {
  const result = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PROGRAMFILES', 'USERNAME']) if (typeof process.env[key] === 'string') result[key] = process.env[key];
  // Store paths may be newer than the deployed .env.example. Retain process
  // overrides, then let persisted User/local settings take the same precedence
  // as the existing installed runner.
  for (const key of Object.keys(process.env)) if (key.startsWith('AIFACTORY_')) result[key] = process.env[key];
  return result;
}
async function terminateOwnedLauncher(child) {
  if (!child || child.exitCode !== null) return true;
  if (process.platform === 'win32') await runFile(join(process.env.SYSTEMROOT || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, detached: false, timeout: 5000, maxBuffer: 8192 }).catch(() => {});
  else child.kill('SIGTERM');
  for (let n = 0; n < 30; n++) { if (child.exitCode !== null) return true; await pause(50); }
  return false;
}
async function performStart({ port, stateDirectory, startupTimeoutMs, environment }, { readBundle = bundle, legacyDirectory = SOURCE } = {}) {
  if (legacyDirectory !== null && (typeof legacyDirectory !== 'string' || !isAbsolute(legacyDirectory))) throw new Error('Invalid optional legacy companion directory');
  const lock = await readBundle({ verify: true });
  await mkdir(stateDirectory, { recursive: true });
  const existing = await companionStatus({ port, stateDirectory }, { readBundle });
  if (existing.owned && existing.runtimeMatches && existing.policyMatches && existing.health.bridgeVersion === lock.version) return { ok: true, reused: true, pid: existing.identity.pid, status: existing };
  if (existing.owned && !existing.runtimeMatches) throw new Error('Owned companion is running a different runtime; stop it before starting the installed update');
  if (existing.owned && !existing.policyMatches) throw new Error('Owned companion is running a different provider policy; stop it before starting the local-only update');
  if (existing.health.reachable || await occupied(port)) throw new Error('Port is occupied by a foreign or unverified service; nothing was stopped');
  let guard;
  try { guard = await open(join(stateDirectory, 'start.lock'), 'wx'); }
  catch { throw new Error('Another companion startup owns this state directory; retry after it finishes'); }
  const config = { schema: 'copilot.companion-start/v1', root: ROOT, project: PROJECT, port, stateDirectory,
    instanceId: randomUUID(), runtimeDirectory: RUNTIME, runtimeSha256: lock.runtimeSha256, bridgeVersion: lock.version, policySha256: POLICY_SHA256,
    nodePath: NODE, scriptPath: SCRIPT, sourceDirectory: legacyDirectory };
  const configPath = join(stateDirectory, 'launch.json');
  const attempt = { ok: false, startedAt: new Date().toISOString(), port, instanceId: config.instanceId, modelCalls: 0, gameWrites: 0 };
  let child, stdout, stderr;
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    stdout = await open(join(stateDirectory, 'stdout.log'), 'a'); stderr = await open(join(stateDirectory, 'stderr.log'), 'a');
    let command = NODE, args = [SCRIPT, '--serve', configPath];
    if (environment === undefined) {
      const helper = join(stateDirectory, 'bootstrap.ps1'); await writeFile(helper, bootstrapSource);
      command = join(process.env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-ConfigPath', configPath];
    }
    child = spawn(command, args, { cwd: RUNTIME, env: enforceLocalOnlyEnvironment({ ...baseEnvironment(), ...environment }), windowsHide: true, detached: false, stdio: ['ignore', stdout.fd, stderr.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    attempt.launcherPid = child.pid;
    const until = Date.now() + startupTimeoutMs;
    while (Date.now() < until) {
      const observed = await identity(port);
      if (observed && observed.instanceId === config.instanceId && observed.root === ROOT && observed.project === PROJECT && observed.runtimeSha256 === lock.runtimeSha256 && observed.policySha256 === POLICY_SHA256) {
        const health = await companionHealth(port);
        if (health.reachable && health.bridgeVersion === lock.version && ['ok', 'degraded'].includes(health.status)) {
          const receipt = { ...observed, launcherPid: child.pid, observedAt: new Date().toISOString(), port };
          await writeFile(join(stateDirectory, 'owned-service.json'), JSON.stringify(receipt, null, 2) + '\n');
          attempt.ok = true; attempt.pid = observed.pid;
          child.unref();
          return { ok: true, reused: false, pid: observed.pid, status: await companionStatus({ port, stateDirectory }, { readBundle }) };
        }
      }
      if (child.exitCode !== null) break;
      await pause(Math.min(100, Math.max(1, until - Date.now())));
    }
    throw new Error('Companion did not become ready within the startup timeout');
  } catch {
    attempt.cleanupConfirmed = await terminateOwnedLauncher(child);
    throw new Error('Companion startup failed; inspect state/companion logs and last-start.json');
  } finally {
    attempt.finishedAt = new Date().toISOString();
    try {
      const closed = await Promise.allSettled([stdout?.close(), stderr?.close()]);
      if (closed.some(result => result.status === 'rejected')) throw new Error('Companion log handle could not be closed');
      await writeFile(join(stateDirectory, 'last-start.json'), JSON.stringify(attempt, null, 2) + '\n');
    } catch {
      // A ready child without its durable startup audit must not become an
      // orphaned success while the caller sees a failure. This reference is
      // only the process launched in this attempt, never a pre-existing one.
      if (attempt.ok) await terminateOwnedLauncher(child);
      throw new Error('Companion startup audit could not be saved; inspect state/companion storage');
    } finally {
      try { await guard.close(); }
      finally { await rm(join(stateDirectory, 'start.lock'), { force: true }); }
    }
  }
}

export async function stopCompanion(options = {}, dependencies = {}) {
  const { port, stateDirectory } = settings(options);
  const status = await companionStatus({ port, stateDirectory }, dependencies);
  if (!status.owned) return { stopped: false, reason: 'No verified owned companion is listening' };
  const receipt = await json(join(stateDirectory, 'owned-service.json'));
  const launcherPid = receipt.launcherPid;
  if (launcherPid !== status.identity.pid && launcherPid !== status.identity.parentPid) throw new Error('Owned companion launcher identity differs; nothing was stopped');
  // The live nonce identifies this server process. Its bootstrap exits after
  // WaitForExit; do not kill a parent PID that could have been recycled.
  if (process.platform === 'win32') await runFile(join(process.env.SYSTEMROOT || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(status.identity.pid), '/T', '/F'], { windowsHide: true, detached: false, timeout: 5000, maxBuffer: 8192 });
  else process.kill(status.identity.pid, 'SIGTERM');
  for (let n = 0; n < 40; n++) { if (!await occupied(port)) return { stopped: true, pid: status.identity.pid }; await pause(50); }
  throw new Error('Owned companion stop could not be confirmed');
}

// Runs only in the single hidden service process, never during status/start preflight.
export async function runCompanionService(configPath) {
  // Also guard direct service entry: inherited variables and bootstrap/test
  // injection must never re-enable a paid provider in this dedicated process.
  enforceLocalOnlyEnvironment(process.env);
  const config = await json(configPath, 32768), checked = settings(config);
  const lock = await bundle({ verify: true });
  if (config.root !== ROOT || config.project !== PROJECT || config.runtimeDirectory !== RUNTIME || config.runtimeSha256 !== lock.runtimeSha256 || config.policySha256 !== POLICY_SHA256 ||
      resolve(configPath) !== join(checked.stateDirectory, 'launch.json') || !/^[a-f0-9-]{36}$/.test(config.instanceId)) throw new Error('Invalid owned companion service configuration');
  const env = { ...process.env, AIFACTORY_PORT: String(config.port) };
  const { createBridgeServer } = await import(pathToFileURL(join(RUNTIME, 'server.mjs')).href);
  const [{ resolveSnapshotCacheDirectory }, { resolveArchitectStoreDirectory }, { defaultCachePath }] = await Promise.all([
    import(pathToFileURL(join(RUNTIME, 'lib/snapshot-cache.mjs')).href),
    import(pathToFileURL(join(RUNTIME, 'lib/architect-revisions.mjs')).href),
    import(pathToFileURL(join(RUNTIME, 'lib/terrain-cache.mjs')).href),
  ]);
  const server = createBridgeServer({ env });
  const handlers = server.listeners('request'); server.removeAllListeners('request');
  const service = { application: 'copilot-owned-companion/v1', root: ROOT, project: PROJECT, pid: process.pid, parentPid: process.ppid,
    instanceId: config.instanceId, runtimeSha256: lock.runtimeSha256, bridgeVersion: lock.version,
    policySha256: POLICY_SHA256, localOnly: true, endpoint: env.LOCAL_AI_BASE_URL,
    workingDirectory: process.cwd(),
    provider: String(env.AI_PROVIDER || 'mock').toLowerCase(),
    model: env.AI_PROVIDER === 'anthropic' ? env.ANTHROPIC_MODEL || null : env.AI_PROVIDER === 'openai' ? env.OPENAI_MODEL || null : ['local', 'ollama'].includes(env.AI_PROVIDER) ? env.LOCAL_AI_MODEL || null : null,
    metadataStores: { snapshot: resolveSnapshotCacheDirectory(env), architect: resolveArchitectStoreDirectory(env), terrain: defaultCachePath(env) } };
  server.on('request', (request, response) => {
    if (request.url === '/copilot/identity') {
      if (request.method !== 'GET' || request.headers.origin || request.headers.host !== `127.0.0.1:${config.port}`) { response.writeHead(403).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(service)); return;
    }
    for (const handler of handlers) handler.call(server, request, response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  process.stdout.write(`Owned AI Factory Copilot companion ${lock.version} listening on 127.0.0.1:${config.port}; provider=${service.provider}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
}

const bootstrapSource = String.raw`param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
try {
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$names.Add('AI_PROVIDER')
  foreach ($name in @('AIFACTORY_SNAPSHOT_CACHE','AIFACTORY_ARCHITECT_STORE','AIFACTORY_TERRAIN_SCAN')) { [void]$names.Add($name) }
  foreach ($line in Get-Content -LiteralPath (Join-Path $config.runtimeDirectory '.env.example')) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { [void]$names.Add($Matches[1]) }
  }
  foreach ($name in $names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($null -ne $value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
  }
  $local = if ($config.sourceDirectory) { Join-Path $config.sourceDirectory '.env' } else { $null }
  if ($local -and (Test-Path -LiteralPath $local -PathType Leaf)) {
    foreach ($line in Get-Content -LiteralPath $local) {
      $text = $line.Trim()
      if (-not $text -or $text.StartsWith('#') -or -not $text.Contains('=')) { continue }
      $name, $value = $text.Split('=', 2); $name = $name.Trim(); $value = $value.Trim()
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
      if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
        if ($name -in @('AIFACTORY_SNAPSHOT_CACHE','AIFACTORY_ARCHITECT_STORE','AIFACTORY_TERRAIN_CACHE','AIFACTORY_TERRAIN_SCAN','AIFACTORY_ROUTING_LOG','AIFACTORY_BLUEPRINT_DIR','AIFACTORY_VISION_DIR') -and $value -and $value -notin @('off','false','none','0') -and -not [IO.Path]::IsPathRooted($value)) {
          $value = [IO.Path]::GetFullPath((Join-Path $config.sourceDirectory $value))
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }
  foreach ($name in @('AIFACTORY_SNAPSHOT_CACHE','AIFACTORY_ARCHITECT_STORE','AIFACTORY_TERRAIN_CACHE','AIFACTORY_TERRAIN_SCAN','AIFACTORY_ROUTING_LOG','AIFACTORY_BLUEPRINT_DIR','AIFACTORY_VISION_DIR')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($value -and $value -notin @('off','false','none','0') -and -not [IO.Path]::IsPathRooted($value)) {
      [Environment]::SetEnvironmentVariable($name, [IO.Path]::GetFullPath((Join-Path $config.runtimeDirectory $value)), 'Process')
    }
  }
  # Apply after all User/legacy configuration. Never read the secure API-key
  # store here: this application always uses the dedicated local Ollama server.
  foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($name -match '${NON_LOCAL_ENV.source}') { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
${Object.entries(LOCAL_ONLY_ENV).map(([name, value]) => `  [Environment]::SetEnvironmentVariable('${name}', '${value}', 'Process')`).join('\n')}
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $config.nodePath
  $start.Arguments = '"' + $config.scriptPath + '" --serve "' + $ConfigPath + '"'
  $start.WorkingDirectory = $config.runtimeDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($start)
  $process.WaitForExit()
  exit $process.ExitCode
} catch { [Console]::Error.WriteLine('Companion secure environment startup failed.'); exit 1 }
`;
