// Starts the conductor's workers on first use and keeps them for later turns.
// Each works in its own worktree (hub/workspaces/auto-<name>, branch <name>/auto,
// cut from master) and loads the two MCP servers: agent_pair and studio.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ClaudeWorker, CodexWorker } from './conductor-workers.mjs';
import { createSessionKeeper, RESUME_PROMPT } from './session-keeper.mjs';

const exec = promisify(execFile);
export const worktreeOf = (repo, name) => ({ worktree: join(repo, 'hub/workspaces', `auto-${name}`), branch: `${name}/auto` });

export function createWorkerPool({ root, repo, runtimeDir, node = process.execPath, git = (args, cwd) => exec('git', args, { cwd, windowsHide: true, timeout: 60000 }), onUsage = () => {}, keepSessions = true, keeperIntervalMs = 60000, resumeTimeoutMs = 6 * 3600000 }) {
  const live = new Map(), starting = new Map();
  let runtime;
  const loadRuntime = async () => runtime ??= (async () => {
    const [proc, cli] = await Promise.all([import(pathToFileURL(join(runtimeDir, 'process.mjs')).href), import(pathToFileURL(join(runtimeDir, 'cli-path.mjs')).href)]);
    return { launch: proc.launch, terminate: proc.terminate, runJson: proc.runJson, resolveClientCommand: cli.resolveClientCommand };
  })();
  async function ensureWorktree(name) {
    const { worktree, branch } = worktreeOf(repo, name);
    if (existsSync(join(worktree, '.git'))) return worktree;
    const { stdout } = await git(['branch', '--list', branch], repo);
    await git(stdout.trim() ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, 'master'], repo);
    const deps = join(repo, 'companion/node_modules');
    if (existsSync(deps)) cpSync(deps, join(worktree, 'companion/node_modules'), { recursive: true }); // a copy, never a link
    return worktree;
  }
  const mcpServers = name => ({
    agent_pair: { command: node, args: [join(root, 'scripts/mcp.mjs'), '--provider', name] },
    studio: { command: node, args: [join(root, 'scripts/studio-mcp.mjs'), '--worker', name] },
  });
  async function start(name) {
    const [rt, cwd] = await Promise.all([loadRuntime(), ensureWorktree(name)]);
    const worker = name === 'claude'
      ? new ClaudeWorker({ runtime: rt, cwd, mcpServers: mcpServers(name), addDirs: [join(root, 'state/studio')],
          guidance: 'You are a conductor-run Claude worker in the owner\'s Satisfactory repo. The owner supervises live in the hub Team room. Work only in your worktree and on your branch; use the studio and agent_pair tools for design and coordination. Either model may build an agreed design through the game lease (the other verifies).' })
      : new CodexWorker({ runtime: rt, cwd, mcpServers: mcpServers(name) });
    worker.on('usage', u => onUsage(name, u));
    worker.on('fault', () => live.delete(name));
    await worker.start();
    live.set(name, worker);
    return worker;
  }
  // Codex threads on this project that stopped on a usage limit continue by themselves
  // after the reset (session-keeper.mjs), with the owner's own Codex configuration.
  const keeper = createSessionKeeper({ root, repo, resume: async t => {
    const worker = new CodexWorker({ runtime: await loadRuntime(), cwd: t.cwd, mcpServers: {}, resumeThreadId: t.threadId, ownConfig: true });
    worker.on('usage', u => onUsage('codex', u));
    await worker.start();
    let timer;
    try { return await Promise.race([worker.run(RESUME_PROMPT), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Resumed turn still running after the time limit')), resumeTimeoutMs); })]); }
    finally { clearTimeout(timer); await worker.stop().catch(() => {}); }
  } });
  const keeperTimer = keepSessions ? setInterval(() => { keeper.tick().catch(() => {}); }, keeperIntervalMs) : null;
  keeperTimer?.unref?.();
  return {
    keeper,
    async get(name) {
      if (live.has(name)) return live.get(name);
      if (!starting.has(name)) starting.set(name, start(name).finally(() => starting.delete(name)));
      return starting.get(name);
    },
    forget(name) { live.delete(name); },
    status() { return { ...Object.fromEntries(['codex', 'claude'].map(n => [n, live.has(n) ? { running: true, busy: live.get(n).busy, usage: live.get(n).usage } : { running: false }])), keeper: keeper.status() }; },
    async stopAll() { clearInterval(keeperTimer); for (const w of live.values()) await w.stop().catch(() => {}); live.clear(); },
  };
}
