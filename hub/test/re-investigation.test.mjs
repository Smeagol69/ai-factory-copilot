import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t, overrides = {}, policy = {}) {
  const { createReInvestigation } = await import('../lib/re-investigation.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-re-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const services = {
    target: async ({ targetId }) => ({ id: targetId, inventory: [{ id: 'game.exe', sha256: 'a'.repeat(64) }, { id: 'game.pak' }], build: 'fixture-build', fingerprints: [{ sha256: 'a'.repeat(64) }], headers: [] }),
    inspect: async () => ({ analyzedArtifacts: ['game.exe'], findings: [{ claim: 'PE observed', classification: 'verified', sources: ['evidence:pe'] }], unknowns: ['Packed assets remain unexamined.'] }),
    models: async () => ({ findings: [{ claim: 'Candidate input path', classification: 'inferred', sources: ['evidence:pe'] }], disagreements: ['Runtime behavior has not corroborated the static candidate.'] }),
    publish: async ({ report }) => ({ saved: true, findingCount: report.findings.length }),
    ...overrides,
  };
  const settings = { root, services, policy: { maxCostUsd: null, ...policy } };
  return { root, services, settings, createReInvestigation, service: createReInvestigation(settings) };
}

const savedPath = (root, id) => join(root, 'state/local-game-re/runs', id + '.json');
const readRun = (root, id) => JSON.parse(readFileSync(savedPath(root, id), 'utf8'));
async function settled(service, id) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = service.status(id);
    if (!state.busy) return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Investigation did not settle');
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('start persists identity before work, returns immediately and finishes only a partial pass', async t => {
  const gate = deferred(), entered = deferred();
  const { root, service } = await fixture(t, { inspect: async ({ onProgress }) => {
    onProgress({ message: 'Reading an artifact', evidenceId: 'evidence:pe' }); entered.resolve(); await gate.promise;
    return { analyzedArtifacts: ['game.exe'], findings: [{ claim: 'PE observed', classification: 'verified', sources: ['evidence:pe'] }], unknowns: ['Asset behavior unknown'] };
  } });
  const started = service.start();
  assert.match(started.id, /^[0-9a-f-]{36}$/);
  assert.equal(started.status, 'running');
  assert.equal(readRun(root, started.id).stage, 'inventory');
  assert.equal(JSON.parse(readFileSync(join(root, 'state/local-game-re/latest.json'))).id, started.id);
  await entered.promise;
  assert.equal(readRun(root, started.id).stage, 'inspection');
  assert.equal(readRun(root, started.id).progress.at(-1).detail.evidenceId, 'evidence:pe');
  gate.resolve();
  const result = await settled(service, started.id);
  assert.equal(result.status, 'partial');
  assert.equal(result.passCompleted, true);
  assert.equal(result.entireGameReverseEngineered, false);
  assert.deepEqual(result.coverage.claims, { verified: 1, inferred: 1, unknown: 0 });
  assert.equal(result.coverage.inventoryArtifacts, 2);
  assert.equal(result.coverage.analyzedArtifacts, 1);
  assert.equal(result.coverage.completeness, 'unknown');
  assert.equal(readRun(root, started.id).evidence.inventory.build, 'fixture-build');
  assert.deepEqual(readRun(root, started.id).stages.map(stage => stage.stage), ['inventory', 'inspection', 'collaboration', 'report']);
});

test('double click reuses one run and another target cannot overlap it', async t => {
  const gate = deferred(), entered = deferred();
  const { service } = await fixture(t, { target: async () => { entered.resolve(); await gate.promise; return { inventory: [] }; } });
  const first = service.start(); await entered.promise;
  const second = service.start();
  assert.equal(second.id, first.id); assert.equal(second.reused, true);
  assert.throws(() => service.start({ targetId: 'other-game' }), { code: 'RE_BUSY', statusCode: 409 });
  gate.resolve(); await settled(service, first.id);
});

test('cancel holds the slot until the adapter settles and late findings remain unknown outcomes', async t => {
  const gate = deferred(), entered = deferred(); let signal;
  const { service, root } = await fixture(t, { inspect: async args => { signal = args.signal; entered.resolve(); await gate.promise; return { findings: [{ claim: 'Late observation', classification: 'verified', sources: ['late'] }] }; } });
  const first = service.start(); await entered.promise;
  const cancelled = service.cancel(first.id);
  assert.equal(cancelled.status, 'cancelling'); assert.equal(signal.aborted, true);
  assert.equal(service.start().id, first.id);
  assert.equal(service.status().busy, true);
  gate.resolve();
  const result = await settled(service, first.id);
  assert.equal(result.status, 'cancelled'); assert.equal(result.lastError.outcome, 'unknown');
  assert.equal(result.lastError.stage, 'inspection');
  assert.equal(readRun(root, first.id).evidence.inspection.findings[0].claim, 'Late observation');
  assert.equal(result.passCompleted, false);
});

test('restart marks an unfinished pass interrupted, retains evidence and never replays it', async t => {
  const { service, root, settings, createReInvestigation } = await fixture(t);
  const first = service.start(); await settled(service, first.id);
  const raw = readRun(root, first.id); raw.status = 'running'; raw.stage = 'collaboration'; raw.finishedAt = null;
  writeFileSync(savedPath(root, first.id), JSON.stringify(raw));
  const restarted = createReInvestigation({ ...settings, services: { target: () => assert.fail('No automatic restart') } });
  assert.equal(restarted.status().status, 'interrupted');
  assert.equal(restarted.status().lastError.outcome, 'unknown');
  assert.equal(restarted.status().lastError.stage, 'collaboration');
  assert.equal(readRun(root, first.id).evidence.inspection.findings[0].claim, 'PE observed');
  assert.equal(readRun(root, first.id).status, 'interrupted');
});

test('failed stage preserves the original goal, exact failure and progress for the next explicit pass', async t => {
  let handoff;
  const { service, root, services } = await fixture(t, { models: async ({ onProgress }) => {
    onProgress({ status: 'waiting_capacity', provider: 'hosted', findings: [{ claim: 'Prior model observation', classification: 'unknown' }] });
    throw Object.assign(new Error('503 capacity unavailable after tool evidence abc'), { code: 'MODEL_CAPACITY' });
  } });
  const first = service.start(); const failure = await settled(service, first.id);
  assert.equal(failure.status, 'failed'); assert.equal(failure.lastError.code, 'MODEL_CAPACITY');
  assert.equal(failure.lastError.stage, 'collaboration');
  assert.equal(failure.lastError.message, '503 capacity unavailable after tool evidence abc');
  assert.equal(readRun(root, first.id).progress.at(-1).detail.status, 'waiting_capacity');
  services.models = async args => { handoff = args.handoff; return { unknowns: ['Capacity recovered for this explicit pass.'] }; };
  const next = service.start(); await settled(service, next.id);
  assert.equal(handoff.previousRunId, first.id);
  assert.equal(handoff.previousFailure.code, 'MODEL_CAPACITY');
  assert.equal(handoff.originalGoal, failure.originalGoal);
  assert.match(handoff.authority, /no.*additional.*access/i);
  assert.match(handoff.previousEvidencePath, new RegExp(first.id));
});

test('a missing external capability is blocked without claiming full reconstruction', async t => {
  const { service } = await fixture(t, { inspect: async () => ({ blocked: true, capabilitiesMissing: ['Native analysis engine'], findings: [], unknowns: ['Native functions not analyzed.'] }) });
  const started = service.start(); const result = await settled(service, started.id);
  assert.equal(result.status, 'blocked');
  assert(result.coverage.capabilitiesMissing.includes('Native analysis engine'));
  assert.equal(result.entireGameReverseEngineered, false);
});

test('finite empty results cannot be promoted by model claims of complete coverage', async t => {
  const { service } = await fixture(t, { target: async () => ({ name: 'game' }), inspect: async () => ({ complete: true, percent: 100 }), models: async () => ({ status: 'completed', coverage: { completeness: 'complete' }, findings: [{ claim: 'All reconstructed', classification: 'verified' }] }) });
  const result = await settled(service, service.start().id);
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.inventoryArtifacts, null);
  assert.equal(result.coverage.analyzedArtifacts, null);
  assert.equal(result.coverage.claims.verified, 0);
  assert.equal(result.coverage.claims.unknown, 1);
  assert.equal(result.entireGameReverseEngineered, false);
});

test('run policy is an immutable snapshot and status alone starts no services', async t => {
  let observed;
  const policy = { phaseTimeoutMs: 2000, maxCostUsd: null, maxToolCalls: 10, nested: { permitted: true } };
  const { service, settings, createReInvestigation } = await fixture(t, { models: async ({ policy: received }) => { observed = received; assert.throws(() => { received.nested.permitted = false; }, TypeError); return {}; } }, policy);
  const idle = service.status(); assert.equal(idle.status, 'idle');
  const started = service.start(); settings.policy.maxCostUsd = 5; settings.policy.nested.permitted = false;
  const result = await settled(service, started.id);
  assert.equal(result.policy.maxCostUsd, null); assert.equal(observed.nested.permitted, true);
  const quiet = createReInvestigation({ ...settings, services: { target: () => assert.fail('Status must be free') } });
  assert.equal(quiet.status(started.id).status, 'partial');
});

test('a phase deadline aborts the service but does not admit an overlapping run', async t => {
  const entered = deferred(), gate = deferred(); let signal;
  const { service } = await fixture(t, { inspect: async args => { signal = args.signal; entered.resolve(); await gate.promise; return {}; } }, { phaseTimeoutMs: 15 });
  const started = service.start(); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true); assert.equal(service.status().busy, true);
  assert.equal(service.start().id, started.id);
  gate.resolve(); const result = await settled(service, started.id);
  assert.equal(result.status, 'failed'); assert.equal(result.lastError.code, 'RE_PHASE_DEADLINE');
  assert.equal(result.lastError.stage, 'inspection');
});

test('full evidence over one MiB is retained while public status stays below 32 KiB', async t => {
  const content = 'observed byte range\n'.repeat(70000);
  const { service, root } = await fixture(t, { inspect: async () => ({ raw: content, findings: Array.from({ length: 100 }, (_, i) => ({ claim: `Finding ${i} ` + 'x'.repeat(1000), classification: 'unknown' })) }) });
  const result = await settled(service, service.start().id);
  assert.equal(readRun(root, result.id).evidence.inspection.raw, content);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert(result.omitted.publicBytes > 0);
  assert.equal(result.coverage.claims.unknown, 100);
});

test('oversized evidence records state their omission instead of claiming a complete retained result', async t => {
  const { service, root } = await fixture(t, { inspect: async () => ({ raw: 'x'.repeat(5 * 1024 * 1024), unknowns: ['Huge result'] }) });
  const result = await settled(service, service.start().id);
  const raw = readRun(root, result.id);
  assert(Buffer.byteLength(JSON.stringify(raw)) <= 4 * 1024 * 1024);
  assert(raw.omitted.evidenceBytes > 0);
  assert.equal(result.status, 'partial');
  assert(raw.evidence.inspection.omission.originalBytes > 4 * 1024 * 1024);
});

test('untrusted non-JSON service results fail with their stage and retain earlier evidence', async t => {
  const circular = {}; circular.self = circular;
  const { service, root } = await fixture(t, { inspect: async () => circular });
  const result = await settled(service, service.start().id);
  assert.equal(result.status, 'failed'); assert.equal(result.lastError.code, 'RE_INVALID_RESULT');
  assert.equal(result.lastError.stage, 'inspection');
  assert.equal(readRun(root, result.id).evidence.inventory.build, 'fixture-build');
});

test('IDs reject paths and commands before any adapter or storage access', async t => {
  const { service } = await fixture(t, { target: () => assert.fail('Invalid identifiers never resolve') });
  for (const targetId of ['../game', 'C:\\game.exe', 'game;whoami', '', 'a'.repeat(65)]) assert.throws(() => service.start({ targetId }), { code: 'INVALID_TARGET_ID' });
  assert.throws(() => service.start({ path: 'C:\\game.exe' }), { code: 'INVALID_RE_REQUEST' });
  assert.throws(() => service.status('../latest'), { code: 'INVALID_RE_ID' });
  assert.throws(() => service.cancel('not-an-id'), { code: 'INVALID_RE_ID' });
  assert.equal(service.status().status, 'idle');
});

test('unsafe storage is rejected and malformed records remain untouched without replay', async t => {
  const { root, service, settings, createReInvestigation } = await fixture(t);
  const result = await settled(service, service.start().id);
  const invalidPath = join(root, 'state/local-game-re/runs', '00000000-0000-4000-8000-000000000000.json');
  writeFileSync(invalidPath, '{invalid');
  const restarted = createReInvestigation(settings);
  assert.equal(restarted.status(result.id).status, 'partial');
  assert(restarted.status().warnings.length > 0);
  assert.equal(readFileSync(invalidPath, 'utf8'), '{invalid');
  const outside = mkdtempSync(join(tmpdir(), 'copilot-re-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(root, 'state/local-game-re/runs'), { recursive: true });
  try { symlinkSync(outside, join(root, 'state/local-game-re/runs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.throws(() => createReInvestigation(settings), { code: 'UNSAFE_RE_STORAGE' });
  assert.deepEqual(readdirSync(outside), []);
});

test('oversized progress and source metadata are bounded without losing stage failure provenance', async t => {
  const { service, root } = await fixture(t, { inspect: async ({ onProgress }) => {
    onProgress({ raw: 'p'.repeat(5 * 1024 * 1024), status: 'tool_running' });
    return { findings: [{ claim: 'Observed metadata', classification: 'verified', sources: [{ evidenceId: 'pe:1', raw: 's'.repeat(5 * 1024 * 1024) }] }] };
  } });
  const result = await settled(service, service.start().id);
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.claims.verified, 1);
  assert(readRun(root, result.id).progress.at(-1).detail.omission.originalBytes > 4 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 32768);
});

test('malformed saved coverage is quarantined rather than crashing status or overwriting the record', async t => {
  const { service, root, settings, createReInvestigation } = await fixture(t);
  const result = await settled(service, service.start().id);
  const raw = readRun(root, result.id); raw.report.coverage.capabilitiesMissing = null;
  writeFileSync(savedPath(root, result.id), JSON.stringify(raw));
  const restarted = createReInvestigation(settings);
  assert.equal(restarted.status().status, 'idle');
  assert(restarted.status().warnings.length > 0);
  assert.equal(readRun(root, result.id).report.coverage.capabilitiesMissing, null);
});

test('unavailable services and failed final persistence never claim a successful pass', async t => {
  const first = await fixture(t, { inspect: undefined });
  const unavailable = await settled(first.service, first.service.start().id);
  assert.equal(unavailable.status, 'blocked'); assert.equal(unavailable.lastError.stage, 'inspection');
  const broken = await fixture(t, { publish: async () => {
    rmSync(join(broken.root, 'state/local-game-re/runs'), { recursive: true });
    writeFileSync(join(broken.root, 'state/local-game-re/runs'), 'unavailable');
    return { saved: true };
  } });
  const result = await settled(broken.service, broken.service.start().id);
  assert.equal(result.status, 'failed'); assert.equal(result.lastError.code, 'RE_STORAGE_FAILED');
  assert.equal(result.passCompleted, false); assert.equal(result.lastError.outcome, 'unknown');
});

test('stage history exposes exact failure outcomes and model activity only from service evidence', async t => {
  const { service } = await fixture(t, { models: async ({ onProgress }) => {
    onProgress({ models: Array.from({ length: 14 }, (_, i) => ({ provider: 'real-provider', model: `model-${i}`, role: 'reviewer', status: 'waiting_capacity' })) });
    throw Object.assign(new Error('Peer evidence transport ended'), { code: 'PEER_TRANSPORT' });
  } });
  const result = await settled(service, service.start().id);
  assert.equal(result.stages.at(-1).stage, 'collaboration');
  assert.equal(result.stages.at(-1).outcome, 'failed');
  assert.equal(result.stages.at(-1).error.code, 'PEER_TRANSPORT');
  assert.equal(result.modelActivity.length, 12);
  assert.equal(result.modelActivity[0].model, 'model-2');
  assert.equal(result.modelActivity.at(-1).status, 'waiting_capacity');
  assert.equal(result.omitted.modelActivity, 2);
  const quiet = await fixture(t, { models: async () => ({}) });
  assert.deepEqual((await settled(quiet.service, quiet.service.start().id)).modelActivity, []);
});

test('incomplete saved handoff shape is rejected before public status reads it', async t => {
  const { service, root, settings, createReInvestigation } = await fixture(t);
  const result = await settled(service, service.start().id);
  const raw = readRun(root, result.id); delete raw.handoff;
  writeFileSync(savedPath(root, result.id), JSON.stringify(raw));
  const restarted = createReInvestigation(settings);
  assert.equal(restarted.status().status, 'idle');
  assert(restarted.status().warnings.length > 0);
});
