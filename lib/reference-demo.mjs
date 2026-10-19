import { open, lstat, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_FILES = ['companion/server.mjs', 'companion/lib/blueprints.mjs', 'companion/lib/solvers.mjs', 'companion/lib/blueprint-reference-traits.mjs'];
const MAX_SELECTION = 16384, MAX_EVIDENCE = 1024 * 1024, MAX_DISPLAY = 24576;
const loadedSources = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
class UnknownReference extends Error { constructor(reason) { super(reason); this.reason = reason; } }

async function readRegularFile(file, maximum, prefix) {
  let info;
  try { info = await lstat(file); }
  catch (error) { throw new UnknownReference(error.code === 'ENOENT' ? `${prefix}_not_found` : `${prefix}_unreadable`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new UnknownReference(`${prefix}_must_be_regular_file`);
  if (info.size > maximum) throw new UnknownReference(`${prefix}_exceeds_bound`);
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || before.size > maximum) throw new UnknownReference(`${prefix}_changed_while_reading`);
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new UnknownReference(`${prefix}_changed_while_reading`);
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

function validateSelection(selection) {
  if (!exactKeys(selection, ['schema', 'left', 'right']) || selection.schema !== 'copilot.reference-selection/v1') throw new UnknownReference('reference_selection_invalid_schema');
  for (const side of ['left', 'right']) {
    const row = selection[side];
    if (!exactKeys(row, ['label', 'blueprint_reference', 'library_directory'])) throw new UnknownReference('reference_selection_invalid_fields');
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120 || /[\x00-\x1f]/.test(row.label)) throw new UnknownReference('reference_selection_invalid_label');
    const ref = row.blueprint_reference;
    if (typeof ref !== 'string' || ref.length > 512 || /[\\:\x00-\x1f]/.test(ref) || !ref.endsWith('.sbp') || ref.split('/').some(part => !part || part === '.' || part === '..')) throw new UnknownReference('reference_selection_invalid_blueprint_reference');
    const library = row.library_directory;
    if (typeof library !== 'string' || library.length > 1024 || !isAbsolute(library) || /[\x00-\x1f]/.test(library) || /^(?:\\\\|\/\/)/.test(library)) throw new UnknownReference('reference_selection_invalid_library_directory');
  }
  if (selection.left.blueprint_reference === selection.right.blueprint_reference && resolve(selection.left.library_directory) !== resolve(selection.right.library_directory)) throw new UnknownReference('reference_selection_ambiguous_across_libraries');
  return selection;
}

async function sourceIdentity(directory) {
  try {
    // Include the neighbouring runtime modules in the cache guard as well as
    // the four public contract files: imported modules remain cached by Node.
    const names = new Set(SOURCE_FILES);
    for (const folder of ['companion', 'companion/lib']) {
      const entries = await readdir(join(directory, folder), { withFileTypes: true });
      if (entries.length > 1024) throw new Error('inventory bound');
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.mjs')) names.add(`${folder}/${entry.name}`);
    }
    if (names.size > 512) throw new Error('module bound');
    const files = [];
    for (const file of [...names].sort()) files.push({ file, sha256: hash(await readRegularFile(join(directory, file), 4 * 1024 * 1024, 'reference_source')) });
    return { sha256: hash(JSON.stringify(files)), files: SOURCE_FILES.map(file => files.find(row => row.file === file)), runtimeFileCount: files.length };
  } catch { throw new UnknownReference('reference_source_unavailable'); }
}

async function readerServices(directory, injected) {
  const current = await sourceIdentity(directory);
  let pending = loadedSources.get(directory);
  if (!pending) {
    pending = (async () => {
      const services = injected ?? {
        ...(await import(pathToFileURL(join(directory, 'companion/server.mjs')).href)),
        ...(await import(pathToFileURL(join(directory, 'companion/lib/solvers.mjs')).href)),
      };
      if (typeof services.makeBlueprintReader !== 'function' || typeof services.solveBlueprintComparison !== 'function') throw new UnknownReference('reference_source_unavailable');
      const after = await sourceIdentity(directory);
      if (after.sha256 !== current.sha256) throw new UnknownReference('reference_source_changed_during_load');
      return { services, identity: after };
    })();
    loadedSources.set(directory, pending);
  }
  const loaded = await pending;
  if (loaded.identity.sha256 !== current.sha256) throw new UnknownReference('reference_source_changed_restart_required');
  return loaded;
}

async function selectedReaders(selection, services) {
  const libraries = new Map();
  for (const side of ['left', 'right']) {
    const library = resolve(selection[side].library_directory);
    if (libraries.has(library)) continue;
    let info;
    try { info = await lstat(library); } catch { throw new UnknownReference('reference_selection_library_unavailable'); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UnknownReference('reference_selection_library_must_be_local_directory');
    const reader = services.makeBlueprintReader({ AIFACTORY_BLUEPRINT_DIR: library });
    if (typeof reader !== 'function' || typeof reader.inspect !== 'function') throw new UnknownReference('reference_selection_library_unavailable');
    const discovered = reader();
    if (!Array.isArray(discovered) || discovered.length > 4096) throw new UnknownReference('reference_selection_library_inventory_exceeds_bound');
    libraries.set(library, { reader, discovered });
  }
  const selected = new Map();
  for (const side of ['left', 'right']) {
    const row = selection[side], library = resolve(row.library_directory);
    const matchingLibraries = [...libraries].filter(([, value]) => value.discovered.some(entry => entry.blueprint_reference === row.blueprint_reference));
    if (matchingLibraries.length > 1) throw new UnknownReference('reference_selection_ambiguous_across_libraries');
    const own = libraries.get(library);
    if (own.discovered.filter(entry => entry.blueprint_reference === row.blueprint_reference).length !== 1) throw new UnknownReference('selected_blueprint_reference_not_discovered');
    selected.set(row.blueprint_reference, own.reader);
  }
  return selected;
}

function scrub(value, privateRoots) {
  if (typeof value === 'string') {
    for (const root of privateRoots) for (const spelling of [root, root.replaceAll('\\', '/')]) value = value.replaceAll(spelling, '[local directory]');
    return value;
  }
  if (Array.isArray(value)) return value.map(row => scrub(row, privateRoots));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'library_directory' && key !== 'diagnostic').map(([key, row]) => [key, scrub(row, privateRoots)]));
  return value;
}

function displayReceipt(evidence) {
  const receipt = structuredClone(evidence);
  delete receipt.comparison;
  receipt.display = { truncated: false, omittedMatchRows: 0, omittedHistogramRows: 0 };
  const groups = [];
  const motif = receipt.reference_traits?.translated_motif;
  if (Array.isArray(motif?.matches)) groups.push({ rows: motif.matches, kind: 'omittedMatchRows' });
  for (const side of ['left', 'right']) for (const field of ['swatches', 'color_slots']) {
    const rows = receipt.reference_traits?.[side]?.appearance?.[field];
    if (Array.isArray(rows)) groups.push({ rows, kind: 'omittedHistogramRows' });
    const summary = receipt[side]?.appearance?.[field];
    if (Array.isArray(summary)) groups.push({ rows: summary, kind: 'omittedHistogramRows' });
  }
  while (Buffer.byteLength(JSON.stringify(receipt)) > MAX_DISPLAY) {
    const group = groups.filter(group => group.rows.length).sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
    if (!group) throw new UnknownReference('reference_display_exceeds_bound');
    group.rows.pop(); receipt.display[group.kind]++; receipt.display.truncated = true;
  }
  return receipt;
}

async function persist(evidence, directory) {
  let folder = directory;
  // Check every project-relative parent before creating or writing anything.
  // mkdir({recursive:true}) alone would follow a junction out of this home.
  for (const segment of ['', 'state', 'architect', 'reference-comparisons']) {
    if (segment) folder = join(folder, segment);
    let info;
    try { info = await lstat(folder); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await lstat(folder);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UnknownReference('reference_evidence_directory_must_be_regular_directory');
  }
  evidence.evidenceFile = `state/architect/reference-comparisons/${evidence.checkId}.json`;
  const data = JSON.stringify(evidence, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_EVIDENCE) throw new UnknownReference('reference_comparison_exceeds_evidence_bound');
  const display = displayReceipt(evidence);
  await writeFile(join(directory, evidence.evidenceFile), data, { flag: 'wx' });
  const temporary = join(folder, `${evidence.checkId}.tmp`);
  await writeFile(temporary, JSON.stringify(display, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, join(folder, 'latest.json'));
  return display;
}

// The application calls this without arguments. Roots and services are injected
// only by offline tests; no HTTP/model input supplies filesystem paths or code.
export async function runReferenceDemo({ directory = ROOT, sourceDirectory = join(ROOT, 'workspaces/architect/integration'), services, clock = Date.now } = {}) {
  directory = resolve(directory); sourceDirectory = resolve(sourceDirectory);
  const receipt = { schema: 'copilot.reference-comparison/v1', checkId: randomUUID(), observedAt: new Date(clock()).toISOString(),
    ok: false, status: 'unknown', mode: 'saved_native_blueprint_comparison', modelCalls: 0, gameWrites: 0,
    liveGameVerified: false, nativeFilesWritten: 0 };
  let selection;
  try {
    const bytes = await readRegularFile(join(directory, 'state/architect/reference-selection.json'), MAX_SELECTION, 'reference_selection');
    try { selection = validateSelection(JSON.parse(bytes.toString('utf8'))); }
    catch (error) { throw error instanceof UnknownReference ? error : new UnknownReference('reference_selection_invalid_json'); }
    const loaded = await readerServices(sourceDirectory, services);
    receipt.source = { code: loaded.identity, execution: services ? 'injected_test_services' : 'local_reader_and_solver' };
    const readers = await selectedReaders(selection, loaded.services);
    const comparison = await loaded.services.solveBlueprintComparison({ world_revision: null }, {
      left_blueprint_name: selection.left.blueprint_reference, right_blueprint_name: selection.right.blueprint_reference,
      include_reference_traits: true,
    }, { inspectBlueprint(name, options = {}) {
      const reader = readers.get(name);
      if (!reader) return { available: false, reason: 'selected_blueprint_reference_not_discovered', certainty: 'unknown' };
      return reader.inspect(name, { ...options, includeReferenceTraits: true });
    } });
    receipt.comparison = comparison;
    const traits = comparison?.reference_traits;
    if (comparison?.available !== true || !object(traits) || !object(traits.translated_motif)) {
      receipt.reason = comparison?.reason ?? 'reference_traits_unavailable';
    } else {
      receipt.reference_traits = traits;
      const status = traits.translated_motif.status;
      if (['matched', 'bounded', 'absent_within_supported_search', 'unknown'].includes(status)) receipt.status = status;
      receipt.ok = receipt.status !== 'unknown';
      for (const side of ['left', 'right']) receipt[side] = { ...traits[side], label: selection[side].label, blueprint_reference: selection[side].blueprint_reference };
      if (receipt.status === 'unknown') receipt.reason = comparison.reason ?? 'reference_comparison_unknown';
      if (receipt.ok && ['left', 'right'].some(side => !/^sha256:[a-f0-9]{64}$/.test(traits[side]?.source_fingerprint ?? ''))) {
        receipt.ok = false; receipt.status = 'unknown'; receipt.reason = 'reference_source_fingerprint_unavailable';
      }
    }
  } catch (error) { receipt.ok = false; receipt.status = 'unknown'; receipt.reason = error instanceof UnknownReference ? error.reason : 'reference_comparison_failed'; }
  const roots = [directory, sourceDirectory, ...['left', 'right'].map(side => selection?.[side]?.library_directory).filter(value => typeof value === 'string' && value.length)];
  const evidence = scrub(receipt, roots);
  try { return await persist(evidence, directory); }
  catch (error) {
    return { schema: receipt.schema, checkId: receipt.checkId, observedAt: receipt.observedAt, ok: false, status: 'unknown',
      reason: error instanceof UnknownReference ? error.reason : 'reference_evidence_unwritable', modelCalls: 0, gameWrites: 0, liveGameVerified: false };
  }
}
