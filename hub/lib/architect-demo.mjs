import { open, readFile, readdir, stat, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditStructuralGeometry } from './geometry-audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE = join(ROOT, 'state/architect');
const COMPILER = join(ROOT, '../companion/lib');
const MAX_INPUT = 64 * 1024 * 1024, MAX_EXPANDED = 128 * 1024 * 1024, MAX_RECEIPT = 32768;
const STALE_AFTER_MS = 5 * 60 * 1000;
const inflate = promisify(gunzip);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.replace(/[\x00-\x1f]/g, ' ').trim() : null;
class UnknownCapture extends Error { constructor(reason) { super(reason); this.reason = reason; } }

async function compilerFingerprint() {
  const files = (await readdir(COMPILER, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).map(entry => entry.name).sort();
  if (files.length > 256) throw new UnknownCapture('compiler_file_inventory_exceeds_bound');
  const hashes = await Promise.all(files.map(async name => [name, sha256(await readFile(join(COMPILER, name)))]));
  return { sha256: sha256(JSON.stringify(hashes)), fileCount: files.length };
}
let compilerModules;
async function compiler() {
  const current = await compilerFingerprint();
  if (!compilerModules) {
    compilerModules = (async () => {
      const [{ buildGraph }, { compileArchitectStructuralRequest }] = await Promise.all([
        import(pathToFileURL(join(COMPILER, 'graph.mjs')).href),
        import(pathToFileURL(join(COMPILER, 'architect-structural.mjs')).href),
      ]);
      const after = await compilerFingerprint();
      if (after.sha256 !== current.sha256) throw new UnknownCapture('compiler_changed_during_load');
      return { buildGraph, compileArchitectStructuralRequest, identity: after };
    })();
  }
  const loaded = await compilerModules;
  if (loaded.identity.sha256 !== current.sha256) throw new UnknownCapture('compiler_changed_since_load_restart_required');
  return loaded;
}

async function selectCapture(directory) {
  if (!directory) throw new UnknownCapture('whole_world_capture_not_found');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { throw new UnknownCapture('whole_world_capture_not_found'); }
  if (entries.length > 1024) throw new UnknownCapture('capture_directory_exceeds_inventory_bound');
  const names = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}-world\.json\.gz$/.test(entry.name)).map(entry => entry.name);
  if (names.length > 128) throw new UnknownCapture('whole_world_capture_inventory_exceeds_bound');
  const hasWorldCache = names.length > 0;
  // The game's raw capture can be newer than the companion's cached ask-all.
  // Consider it at this one known location, using observation time rather than
  // when a cache happened to be copied or touched.
  if (entries.some(entry => entry.isFile() && entry.name === 'latest.json')) names.push('latest.json');
  if (!names.length) throw new UnknownCapture('whole_world_capture_not_found');
  let newest;
  for (const name of names.sort()) {
    const candidate = { path: join(directory, name), name, selection: 'newest_capture_timestamp_then_file_mtime' };
    candidate.modified = (await stat(candidate.path)).mtimeMs;
    candidate.observed = candidate.modified;
    try {
      candidate.captured = await readCapture(candidate);
      const value = candidate.captured.value;
      const snapshot = value?.schema === 'aifactory.snapshot-cache/v1' ? value.snapshot : value;
      // latest.json also carries nearby scans; those must not displace an
      // existing whole-world cache. When alone, validation still refuses them.
      if (name === 'latest.json' && hasWorldCache && Number(snapshot?.world?.scan_radius_meters) > 0) continue;
      const completed = Date.parse(text(snapshot?.capture_completed_at_utc));
      const generated = Date.parse(text(snapshot?.generated_at_utc));
      if (Number.isFinite(completed)) candidate.observed = completed;
      else if (Number.isFinite(generated)) candidate.observed = generated;
    } catch (error) { candidate.error = error; }
    if (!newest || candidate.observed > newest.observed ||
        (candidate.observed === newest.observed && candidate.modified > newest.modified)) newest = candidate;
  }
  // A selected unreadable/undated capture stays unknown rather than silently
  // presenting an older observation as the latest. Metadata validation follows.
  if (newest.error) throw newest.error;
  return newest;
}

async function readCapture(selected) {
  const info = await lstat(selected.path);
  if (!info.isFile() || info.isSymbolicLink()) throw new UnknownCapture('capture_must_be_a_regular_file');
  if (info.size > MAX_INPUT) throw new UnknownCapture('capture_file_exceeds_64_mib_bound');
  const handle = await open(selected.path, 'r');
  let bytes;
  try {
    const before = await handle.stat();
    if (before.size > MAX_INPUT) throw new UnknownCapture('capture_file_exceeds_64_mib_bound');
    const buffer = Buffer.alloc(before.size + 1); let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new UnknownCapture('capture_changed_while_reading');
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  let decoded;
  try { decoded = selected.name.endsWith('.gz') ? await inflate(bytes, { maxOutputLength: MAX_EXPANDED }) : bytes; }
  catch { throw new UnknownCapture('capture_decompression_failed_or_exceeds_128_mib_bound'); }
  let value;
  try { value = JSON.parse(decoded.toString('utf8')); }
  catch { throw new UnknownCapture('capture_is_not_valid_json'); }
  return { value, sha256: sha256(bytes), bytes: bytes.length, expandedBytes: decoded.length };
}

function captureMetadata(value, selected, digest, now) {
  const envelope = value?.schema === 'aifactory.snapshot-cache/v1' ? value : null;
  const snapshot = envelope ? envelope.snapshot : value;
  if (snapshot?.schema !== 'aifactory.snapshot' || snapshot.schema_version !== 1) throw new UnknownCapture('capture_schema_unsupported');
  if ((envelope && envelope.whole_world !== true) || Number(snapshot.world?.scan_radius_meters) > 0) throw new UnknownCapture('capture_is_not_whole_world');
  if (!envelope && (typeof snapshot.world?.scan_radius_meters !== 'number' || !Number.isFinite(snapshot.world.scan_radius_meters))) throw new UnknownCapture('capture_whole_world_scope_unknown');
  if (!Array.isArray(snapshot.actors) || snapshot.completeness?.actor_limit_reached !== false) throw new UnknownCapture('capture_world_completeness_unknown_or_truncated');
  const revision = snapshot.world_revision;
  const generated = text(snapshot.generated_at_utc), completed = text(snapshot.capture_completed_at_utc);
  const map = text(snapshot.world?.map), session = text(snapshot.world?.session_name);
  if (!Number.isInteger(revision) || revision < 0 || !generated || !Number.isFinite(Date.parse(generated)) || !map || !session) throw new UnknownCapture('capture_revision_date_or_session_missing');
  if (envelope && (envelope.world_revision !== revision || envelope.actor_count !== snapshot.actors.length || envelope.save?.map !== snapshot.world.map || envelope.save?.save_session_name !== snapshot.world.session_name)) throw new UnknownCapture('capture_envelope_metadata_mismatch');
  const validCompleted = completed && Number.isFinite(Date.parse(completed)) ? completed : null;
  const capturedAt = validCompleted ?? generated;
  const age = now - Date.parse(capturedAt);
  return { snapshot, metadata: {
    source: `%LOCALAPPDATA%/FactoryGame/Saved/AIFactoryCopilot/Snapshots/${selected.name}`,
    provenance: 'read_only_saved_game_capture', selectedBy: selected.selection,
    schema: snapshot.schema, schemaVersion: snapshot.schema_version, cacheSchema: envelope?.schema ?? null,
    worldRevision: revision, map, session, wholeWorld: true, actorLimitReached: false,
    generatedAtUtc: generated, completedAtUtc: validCompleted, storedAtUtc: text(envelope?.stored_at_utc),
    actorCount: snapshot.actors.length, sha256: digest.sha256, bytes: digest.bytes, expandedBytes: digest.expandedBytes,
    freshness: { status: age < 0 ? 'future_timestamp_unknown' : age > STALE_AFTER_MS ? 'stale' : 'recent_saved_capture',
      ageMs: age < 0 ? null : age, staleAfterMs: STALE_AFTER_MS, basis: validCompleted ? 'capture_completed_at_utc' : 'generated_at_utc' },
  } };
}

async function persist(receipt, directory) {
  await mkdir(directory, { recursive: true });
  receipt.receiptFile = relative(ROOT, join(directory, `${receipt.checkId}.json`)).replaceAll('\\', '/');
  receipt.evidenceFile = receipt.receiptFile;
  const data = JSON.stringify(receipt, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_RECEIPT) throw new Error('Architect demo receipt exceeds display bound');
  await writeFile(join(directory, `${receipt.checkId}.json`), data);
  const temporary = join(directory, `${receipt.checkId}.tmp`);
  await writeFile(temporary, data); await rename(temporary, join(directory, 'latest-demo.json'));
  return receipt;
}

// Dependency injection is confined to source/evidence roots and the clock for
// offline fixture tests. The app invokes only the fixed no-argument runner.
export function createArchitectDemoRunner({ captureDirectory, evidenceDirectory = STATE, now = Date.now } = {}) {
  return async function () {
    const observed = now();
    const receipt = { schema: 'copilot.architect-demo/v1', checkId: `demo-${observed}-${randomUUID()}`,
      observedAtUtc: new Date(observed).toISOString(), ok: false, status: 'unknown', compiled: false,
      mode: 'offline_captured_world', commit: false, liveGameVerified: false, modelCalls: 0, gameRequests: 0,
      gameWrites: 0, nativeFilesWritten: 0, revisionStoreWrites: 0, selectionChanged: false, promotionPerformed: false };
    let stage = 'capture';
    try {
      const selected = await selectCapture(captureDirectory), captured = selected.captured;
      const { snapshot, metadata } = captureMetadata(captured.value, selected, captured, observed);
      receipt.capture = metadata;
      stage = 'compiler';
      const { buildGraph, compileArchitectStructuralRequest, identity } = await compiler();
      receipt.compiler = { entry: 'companion/lib/architect-structural.mjs',
        function: 'compileArchitectStructuralRequest', ...identity };
      const result = compileArchitectStructuralRequest(buildGraph(snapshot), { blueprint_name: 'AI Architect offline captured-world shell',
        width_cells: 2, depth_cells: 1, wall_courses: 2, open_ends: 'both', commit: false });
      if (!result.compiled) {
        receipt.reason = result.reason || 'captured_world_cannot_support_this_shell';
        if (Array.isArray(result.missing)) receipt.missing = result.missing.filter(value => ['foundation', 'wall'].includes(value));
      } else {
        if (result.layout?.action?.commit !== false || result.layout?.part_count !== 8 || result.manifest?.part_count !== 8) throw new UnknownCapture('compiler_did_not_return_the_fixed_uncommitted_eight_part_shell');
        receipt.ok = true; receipt.status = 'compiled_offline'; receipt.compiled = true;
        receipt.manifest = result.manifest;
        receipt.layout = { dimensions: result.layout.dimensions, part_count: result.layout.part_count, buildables: result.layout.buildables, commit: false };
        receipt.geometryAudit = auditStructuralGeometry(result.manifest);
        if (receipt.geometryAudit.status !== 'no_measured_box_penetration') {
          receipt.ok = false; receipt.status = 'geometry_needs_attention'; receipt.reason = receipt.geometryAudit.status;
        }
        receipt.limitations = [...result.manifest.limitations, 'saved_capture_only_not_a_live_world_verification',
          ...(metadata.freshness.status === 'stale' ? ['capture_is_stale'] : [])];
      }
    } catch (error) { receipt.reason = error instanceof UnknownCapture ? error.reason : stage === 'compiler' ? 'structural_compiler_unavailable_or_failed' : 'capture_unreadable'; }
    return persist(receipt, evidenceDirectory);
  };
}

export async function runArchitectDemo() {
  const captureDirectory = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'FactoryGame/Saved/AIFactoryCopilot/Snapshots') : null;
  return createArchitectDemoRunner({ captureDirectory })();
}
