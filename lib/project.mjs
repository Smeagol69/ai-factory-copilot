import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true }).trim();
const port = n => Number.isInteger(n) && n >= 1024 && n <= 65535;
const localDirectory = s => typeof s === 'string' && s.length > 0 && s.length < 400 && !/[\\:\x00-\x1f]/.test(s) && !s.startsWith('/');

export function loadProject(root = ROOT) {
  const raw = readFileSync(join(root, 'project.json'), 'utf8');
  if (raw.length > 16000) throw new Error('Project configuration exceeds its bound');
  const config = JSON.parse(raw);
  if (config.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(config.project ?? '') ||
      !localDirectory(config.runtime?.directory) || !/^[a-f0-9]{40}$/.test(config.runtime?.commit ?? '') ||
      !localDirectory(config.game?.directory) || config.game?.id !== 'satisfactory' ||
      !port(config.game.companionPort) || !port(config.progressPort) || !port(config.appPort) ||
      new Set([config.game.companionPort, config.progressPort, config.appPort]).size !== 3 ||
      config.startup?.modelCalls !== 0 || config.startup?.gameWrites !== 0 || config.startup?.scheduledTasks !== 0)
    throw new Error('Invalid project paths, runtime pin, ports or startup policy');
  return { root: resolve(root), config, runtime: resolve(root, config.runtime.directory), game: resolve(root, config.game.directory) };
}

export function verifyRuntime(directory, expected) {
  const commit = git(directory, ['rev-parse', 'HEAD']);
  if (commit !== expected) throw new Error('Runtime commit differs from the reviewed project pin');
  if (git(directory, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Runtime has changed tracked source');
  return { commit, trackedSourceClean: true, pinMatched: true };
}

export async function runtimeContext(root = ROOT) {
  const project = loadProject(root);
  const verified = verifyRuntime(project.runtime, project.config.runtime.commit);
  const moduleAt = relative => import(pathToFileURL(resolve(project.runtime, relative)).href);
  const [{ defaultDatabase }, { subscriptionEnvironment }] = await Promise.all([moduleAt('store.mjs'), moduleAt('process.mjs')]);
  if (!defaultDatabase || !existsSync(defaultDatabase)) throw new Error('Existing shared MCP database is unavailable; no new database was created');
  return { ...project, verified, database: defaultDatabase, moduleAt, subscriptionEnvironment };
}

export async function companionHealth(companionPort, { offline = false, fetchImpl = globalThis.fetch } = {}) {
  if (!port(companionPort)) throw new Error('Invalid companion port');
  const base = { worldVerified: false, operationalReady: false };
  if (offline) return { ...base, reachable: null, status: 'not-checked' };
  let reachable = false;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${companionPort}/health`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    reachable = true;
    if (!response.ok || !response.body) throw new Error('Health response unavailable');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) throw new Error('Health response too large');
      chunks.push(chunk);
    }
    const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (health.schema !== 'aifactory.bridge.health' || typeof health.bridge_version !== 'string' ||
        !['ok', 'degraded'].includes(health.status) || typeof health.readiness?.operational_ready !== 'boolean')
      throw new Error('Unexpected health schema');
    return { ...base, reachable, status: health.status, bridgeVersion: health.bridge_version.slice(0,100),
      provider: typeof health.provider === 'string' ? health.provider.slice(0,60) : null,
      operationalReady: health.status === 'ok' && health.readiness.operational_ready === true };
  } catch {
    return { ...base, reachable, status: reachable ? 'unverified-service' : 'unavailable' };
  }
}

export async function projectStatus({ offline = false } = {}) {
  const context = await runtimeContext();
  const { SuperpowersPackage } = await context.moduleAt('superpowers/package.mjs');
  const powers = new SuperpowersPackage().verify();
  const gameSource = { commit: git(context.game, ['rev-parse', 'HEAD']), branch: git(context.game, ['branch', '--show-current']),
    trackedSourceClean: !git(context.game, ['status', '--porcelain', '--untracked-files=no']) };
  return { project: context.config.project, runtime: context.verified, superpowers: powers, gameSource,
    companion: await companionHealth(context.config.game.companionPort, { offline }),
    team: { coordinatorConfigured: false, activeWorkers: null, activity: 'unknown' },
    statusModelCalls: 0, statusGameWrites: 0, scheduledTasksAdded: 0,
    nextStep: 'Choose a bounded Satisfactory team task; verify the existing companion before a live benchmark.' };
}
