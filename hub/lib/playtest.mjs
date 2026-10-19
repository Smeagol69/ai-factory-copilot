import { readFile, stat, open, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scope = value => typeof value === 'string' && value.length > 0 && value.length < 256 && !/[\x00-\x1f]/.test(value);
async function json(path, limit) {
  if ((await stat(path)).size > limit) throw Error('Native mailbox file exceeds its bound');
  const bytes = await readFile(path); if (bytes.length > limit) throw Error('Native mailbox file exceeds its bound');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}
function receiptIdentity(receipt, job) {
  return receipt?.schema === 'aifactory.playtest-result/v1' && receipt.id === job.id && receipt.operation === job.operation && receipt.map === job.map && receipt.session === job.session && receipt.world_instance === job.worldInstance && receipt.player === job.player;
}

// The application uses the fixed default path. Directory/clock injection is for
// isolated fixture tests, never an HTTP-defined filesystem or command target.
export function createPlaytestClient({ directory = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'FactoryGame/Saved/AIFactoryCopilot/Diagnostics/Playtest') : null, now = Date.now } = {}) {
  const path = name => { if (!directory) throw Error('Native mailbox location unavailable'); return join(directory, name); };
  async function status() {
    try {
      const s = await json(path('status.json'), 16384), age = now() - Date.parse(s.last_tick_game_utc);
      const ready = s.schema === 'aifactory.playtest-status/v1' && s.enabled === true && s.live_world === true && s.accepting_requests === true &&
        scope(s.map) && scope(s.session) && uuid(s.world_instance) && scope(s.player) && Number.isFinite(age) && age >= -2000 && age <= 30000 && s.in_flight_id === '';
      return { ready, map: scope(s.map) ? s.map : null, session: scope(s.session) ? s.session : null,
        worldInstance: uuid(s.world_instance) ? s.world_instance : null, player: scope(s.player) ? s.player : null,
        revision: s.world_revision, ageMs: Number.isFinite(age) ? age : null,
        inFlight: s.in_flight_id || null, reason: ready ? null : 'Native mailbox is disabled, stale, busy or not in a loaded save' };
    } catch { return { ready: false, reason: 'Native mailbox status unavailable; no game request submitted' }; }
  }
  async function readResult(job) {
    let receipt; try { receipt = await json(path('results/' + job.id + '.json'), 1048576); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!receiptIdentity(receipt, job)) throw Error('Native result identity or world scope differs from submitted job');
    return receipt;
  }
  async function submit(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['operation', 'question'].includes(k)) ||
        !['capture', 'look', 'askall'].includes(input.operation)) throw Error('Unsupported typed playtest operation');
    if (input.operation === 'askall') {
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4000 || /[\x00-\x1f\x7f]/.test(input.question)) throw Error('Question must have 1–4000 characters without control characters');
    } else if (Object.hasOwn(input, 'question')) throw Error('Only askall accepts a question');
    const initial = await status(); if (!initial.ready) throw Error(initial.reason);
    let guard;
    try { guard = await open(path('client.lock'), 'wx'); }
    catch { throw Error('Another local client owns mailbox submission'); }
    try {
      const current = await status(); if (!current.ready || current.map !== initial.map || current.session !== initial.session || current.worldInstance !== initial.worldInstance || current.player !== initial.player) throw Error('Native world changed before submission');
      let prior, priorExists = false; try { prior = await json(path('request.json'), 16384); priorExists = true; } catch (error) { if (error.code !== 'ENOENT') throw Error('Existing request is unknown; it was preserved'); }
      if (priorExists) {
        if (!prior || typeof prior !== 'object' || Array.isArray(prior) || prior.schema !== 'aifactory.playtest-request/v1' || !uuid(prior.id) || !['capture', 'look', 'askall'].includes(prior.operation) || !scope(prior.expected_map) || !scope(prior.expected_session) || !uuid(prior.expected_world_instance) || !scope(prior.expected_player)) throw Error('Existing request identity is unknown; it was preserved');
        const result = await readResult({ id: prior.id, operation: prior.operation, map: prior.expected_map, session: prior.expected_session, worldInstance: prior.expected_world_instance, player: prior.expected_player });
        if (result?.terminal !== true) throw Error('An existing request is pending or its outcome is unknown; it was preserved');
      }
      const job = { id: randomUUID(), operation: input.operation, map: current.map, session: current.session, worldInstance: current.worldInstance, player: current.player };
      const request = { schema: 'aifactory.playtest-request/v1', id: job.id, operation: job.operation,
        expected_map: job.map, expected_session: job.session, expected_world_instance: job.worldInstance, expected_player: job.player, expires_at_utc: new Date(now() + 60000).toISOString(),
        ...(input.operation === 'askall' ? { question: input.question } : {}) };
      const bytes = JSON.stringify(request) + '\n'; if (Buffer.byteLength(bytes) > 16384) throw Error('Encoded native request exceeds 16 KiB');
      const temporary = path(job.id + '.tmp'); await writeFile(temporary, bytes, { flag: 'wx' });
      try { await rename(temporary, path('request.json')); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
      return { ...job, submitted: true, outcome: 'not_yet_observed' };
    } finally { try { await guard.close(); } finally { await rm(path('client.lock'), { force: true }); } }
  }
  async function wait(job, { timeoutMs = 90000, signal } = {}) {
    if (!uuid(job?.id) || !['capture', 'look', 'askall'].includes(job.operation) || !scope(job.map) || !scope(job.session) || !uuid(job.worldInstance) || !scope(job.player) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('Invalid submitted job or wait deadline');
    const deadline = Date.now() + timeoutMs;
    do {
      if (signal?.aborted) throw Error('Stopped waiting; submitted native work was not cancelled or replayed');
      const receipt = await readResult(job);
      if (receipt?.terminal === true) {
        const results = receipt.game_action_results;
        return { receipt, pipelineCompleted: receipt.state === 'completed',
          actionsAccepted: receipt.game_actions_refused === true ? false :
            Array.isArray(results) && results.length ? results.every(r => r.accepted === true) : null,
          committedActions: Array.isArray(results) ? results.filter(r => r.accepted === true && r.committed === true && r.dry_run !== true).length : 0,
          dryRunActions: Array.isArray(results) ? results.filter(r => r.dry_run === true).length : 0,
          worldMutationObserved: typeof receipt.game_world_was_mutated === 'boolean' ? receipt.game_world_was_mutated : null };
      }
      if (Date.now() >= deadline) break;
      await pause(Math.min(100, deadline - Date.now()));
    } while (Date.now() <= deadline);
    throw Error('Native result not observed before deadline; request remains submitted and must not be replayed');
  }
  return { status, submit, wait };
}
