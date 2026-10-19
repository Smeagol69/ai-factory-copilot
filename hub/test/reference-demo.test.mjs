import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = resolve('state/architect');
const SOURCE_FILES = ['companion/server.mjs', 'companion/lib/blueprints.mjs', 'companion/lib/solvers.mjs', 'companion/lib/blueprint-reference-traits.mjs'];
const FP_LEFT = `sha256:${'a'.repeat(64)}`, FP_RIGHT = `sha256:${'b'.repeat(64)}`;
const OBSERVED = '2026-10-17T12:00:00.000Z';

async function run(options) {
  let module;
  try { module = await import('../lib/reference-demo.mjs'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('The bounded local reference demo is not implemented'); throw error; }
  return module.runReferenceDemo(options);
}

function comparison(status = 'matched') {
  return {
    available: true, source: 'compared_from_two_saved_native_blueprint_inspections', certainty: 'authoritative_for_compared_serialized_records',
    reference_traits: {
      schema: 'aifactory.blueprint-reference-comparison/v1',
      left: { source_fingerprint: FP_LEFT, entity_total: 2, eligible_entity_count: 2, appearance: { swatches: [{ descriptor_class: '/Game/Swatch/Concrete', count: 2 }], color_slots: [{ slot: 0, count: 2 }], missing_swatch_count: 0 } },
      right: { source_fingerprint: FP_RIGHT, entity_total: 3, eligible_entity_count: 3, appearance: { swatches: [{ descriptor_class: '/Game/Swatch/Metal', count: 3 }], color_slots: [{ slot: 1, count: 3 }], missing_swatch_count: 0 } },
      translated_motif: { status, source_entity_count: 2, target_entity_count: 3, matched_entity_count: 2,
        translation_cm: { x: 100, y: 200, z: 0 }, tolerance_cm: 0.1, rotation_policy: 'complete_saved_quaternion', scale_policy: 'saved_scale',
        appearance_equal_count: 0, appearance_different_count: 2, appearance_unknown_count: 0,
        candidates_evaluated: 2, search_complete: true, input_coverage_complete: true,
        matches: [0, 1].map(i => ({ source_entity_index: i, target_entity_index: i + 1, class_path: '/Mod/Ficus.Prop_C',
          source_location_cm: { x: i * 10, y: 0, z: 0 }, target_location_cm: { x: 100 + i * 10, y: 200, z: 0 },
          source_appearance: { swatch_descriptor: '/Game/Swatch/Concrete', color_slot: 0 }, target_appearance: { swatch_descriptor: '/Game/Swatch/Metal', color_slot: 1 } })), matches_truncated: 0 },
      claims_not_made: ['site_fit', 'mesh_collision_navigation', 'rendered_appearance', 'buildability', 'live_functionality'],
      caveat: 'A witnessed translated subset does not establish maximum assignment or aesthetic quality.',
    },
  };
}

async function fixture(output = comparison()) {
  await mkdir(BASE, { recursive: true });
  const directory = await mkdtemp(join(BASE, 'test-reference-'));
  const sourceDirectory = join(directory, 'source');
  const leftLibrary = join(directory, 'left-library'), rightLibrary = join(directory, 'right-library');
  await Promise.all([leftLibrary, rightLibrary, join(directory, 'state/architect')].map(p => mkdir(p, { recursive: true })));
  for (const file of SOURCE_FILES) { await mkdir(join(sourceDirectory, file, '..'), { recursive: true }); await writeFile(join(sourceDirectory, file), `// isolated code identity ${file}\n`); }
  const selection = { schema: 'copilot.reference-selection/v1',
    left: { label: 'Entrance fixture', blueprint_reference: 'entrance/Entrance.sbp', library_directory: leftLibrary },
    right: { label: 'Underground fixture', blueprint_reference: 'underground/Underground.sbp', library_directory: rightLibrary } };
  const selectionFile = join(directory, 'state/architect/reference-selection.json');
  await writeFile(selectionFile, JSON.stringify(selection));
  const inspected = [];
  const services = {
    makeBlueprintReader(env) {
      const side = env.AIFACTORY_BLUEPRINT_DIR === leftLibrary ? 'left' : env.AIFACTORY_BLUEPRINT_DIR === rightLibrary ? 'right' : null;
      if (!side) return null;
      const reader = () => [{ blueprint_reference: selection[side].blueprint_reference }];
      reader.inspect = (name, options) => {
        assert.equal(name, selection[side].blueprint_reference);
        assert.equal(options.includeReferenceTraits, true);
        inspected.push(side);
        return { available: true, blueprint_reference: name, source_fingerprint: side === 'left' ? FP_LEFT : FP_RIGHT,
          reference_traits: output.reference_traits?.[side] };
      };
      return reader;
    },
    solveBlueprintComparison(graph, args, service) {
      assert.deepEqual(graph, { world_revision: null });
      assert.equal(args.include_reference_traits, true);
      assert.equal(args.left_blueprint_name, selection.left.blueprint_reference);
      assert.equal(args.right_blueprint_name, selection.right.blueprint_reference);
      service.inspectBlueprint(args.left_blueprint_name, { includeReferenceTraits: true });
      service.inspectBlueprint(args.right_blueprint_name, { includeReferenceTraits: true });
      return output;
    },
  };
  return { directory, sourceDirectory, selection, selectionFile, inspected, services,
    options: { directory, sourceDirectory, services, clock: () => Date.parse(OBSERVED) },
    async cleanup() { assert(resolve(directory).startsWith(BASE + '\\') || resolve(directory).startsWith(BASE + '/')); await rm(directory, { recursive: true, force: true }); } };
}

test('missing local selection or pinned game source stays unknown with zero inference or game writes', async () => {
  const f = await fixture();
  try {
    await rm(f.selectionFile);
    const missing = await run(f.options);
    assert.equal(missing.ok, false); assert.equal(missing.reason, 'reference_selection_not_found');
    assert.equal(missing.status, 'unknown'); assert.equal(missing.modelCalls, 0); assert.equal(missing.gameWrites, 0);
    await writeFile(f.selectionFile, JSON.stringify(f.selection));
    const absentSource = await run({ ...f.options, sourceDirectory: join(f.directory, 'absent-source') });
    assert.equal(absentSource.ok, false); assert.equal(absentSource.reason, 'reference_source_unavailable');
    assert.deepEqual(f.inspected, []);
  } finally { await f.cleanup(); }
});

test('a witnessed motif keeps exact source identities, palette differences and local evidence', async () => {
  const f = await fixture();
  try {
    const result = await run(f.options);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.status, 'matched');
    assert.equal(result.observedAt, OBSERVED);
    assert.deepEqual(f.inspected, ['left', 'right']);
    assert.equal(result.left.label, 'Entrance fixture'); assert.equal(result.left.source_fingerprint, FP_LEFT);
    assert.equal(result.right.source_fingerprint, FP_RIGHT); assert.equal(result.left.entity_total, 2); assert.equal(result.right.eligible_entity_count, 3);
    assert.equal(result.reference_traits.translated_motif.matched_entity_count, 2);
    assert.equal(result.reference_traits.translated_motif.appearance_different_count, 2);
    assert.equal(result.modelCalls, 0); assert.equal(result.gameWrites, 0);
    assert.match(result.evidenceFile, /^state\/architect\/reference-comparisons\/[a-f0-9-]+\.json$/);
    const evidence = JSON.parse(await readFile(join(f.directory, result.evidenceFile), 'utf8'));
    assert.equal(evidence.checkId, result.checkId); assert.equal(evidence.comparison.reference_traits.translated_motif.matched_entity_count, 2);
    const latest = JSON.parse(await readFile(join(f.directory, 'state/architect/reference-comparisons/latest.json'), 'utf8'));
    assert.equal(latest.evidenceFile, result.evidenceFile);
    const serialized = JSON.stringify(result);
    assert(!serialized.includes(f.directory)); assert(!serialized.includes('library_directory'));
    assert.equal(result.source.code.files.length, 4); assert(result.source.code.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally { await f.cleanup(); }
});

test('malformed, oversized or path-bearing selection config is refused before any Blueprint inspection', async () => {
  const f = await fixture();
  try {
    for (const input of ['{', ' '.repeat(16385), JSON.stringify({ ...f.selection, command: 'ignored?' }),
      JSON.stringify({ ...f.selection, left: { ...f.selection.left, library_directory: 'relative/folder' } }),
      JSON.stringify({ ...f.selection, left: { ...f.selection.left, label: '' } }),
      JSON.stringify({ ...f.selection, left: { ...f.selection.left, blueprint_reference: '../outside.sbp' } }),
      JSON.stringify({ ...f.selection, right: { ...f.selection.right, library_directory: '\\\\host\\share' } })]) {
      await writeFile(f.selectionFile, input);
      const result = await run(f.options);
      assert.equal(result.ok, false); assert.equal(result.status, 'unknown'); assert.match(result.reason, /^reference_selection_/);
    }
    assert.deepEqual(f.inspected, []);
  } finally { await f.cleanup(); }
});

test('a symbolic-link selection file is refused', async t => {
  const f = await fixture();
  try {
    const target = join(f.directory, 'private-selection.json');
    await writeFile(target, JSON.stringify(f.selection)); await rm(f.selectionFile);
    try { await symlink(target, f.selectionFile, 'file'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Windows account cannot create file symlinks'); return; } throw error; }
    const result = await run(f.options);
    assert.equal(result.ok, false); assert.equal(result.reason, 'reference_selection_must_be_regular_file'); assert.deepEqual(f.inspected, []);
  } finally { await f.cleanup(); }
});

test('same exact reference in different libraries is ambiguous and undiscovered aliases cannot resolve', async () => {
  const f = await fixture();
  try {
    f.selection.right.blueprint_reference = f.selection.left.blueprint_reference;
    await writeFile(f.selectionFile, JSON.stringify(f.selection));
    const ambiguous = await run(f.options);
    assert.equal(ambiguous.ok, false); assert.equal(ambiguous.reason, 'reference_selection_ambiguous_across_libraries');
    f.selection.right.blueprint_reference = 'underground/Underground.sbp';
    const original = f.services.makeBlueprintReader;
    f.services.makeBlueprintReader = env => { const reader = original(env); const list = () => [{ blueprint_reference: 'some-other-reference.sbp' }]; list.inspect = reader.inspect; return list; };
    await writeFile(f.selectionFile, JSON.stringify(f.selection));
    const missing = await run(f.options);
    assert.equal(missing.ok, false); assert.equal(missing.reason, 'selected_blueprint_reference_not_discovered'); assert.deepEqual(f.inspected, []);
  } finally { await f.cleanup(); }
});

test('cached runtime modules cannot acquire a new provenance hash after source bytes change', async () => {
  const f = await fixture();
  try {
    assert.equal((await run(f.options)).ok, true);
    await writeFile(join(f.sourceDirectory, 'companion/lib/blueprints.mjs'), '// different reader bytes\n');
    const changed = await run(f.options);
    assert.equal(changed.ok, false); assert.equal(changed.reason, 'reference_source_changed_restart_required');
    assert.equal(changed.status, 'unknown'); assert.deepEqual(f.inspected, ['left', 'right']);
  } finally { await f.cleanup(); }
});

test('unknown, unavailable and bounded comparison evidence retain their distinct status', async () => {
  for (const output of [comparison('unknown'), { available: false, reason: 'one_or_both_blueprint_inspections_unavailable' },
    { available: true, reason: 'reference_traits_pending' }, comparison('bounded')]) {
    const f = await fixture(output);
    try {
      const result = await run(f.options);
      assert.equal(result.status, output.reference_traits?.translated_motif.status ?? 'unknown');
      assert.equal(result.ok, result.status === 'bounded');
      assert.equal(result.gameWrites, 0); assert.equal(result.modelCalls, 0);
      if (result.status === 'unknown') assert(result.reason);
    } finally { await f.cleanup(); }
  }
});

test('large displayed samples shrink while full counts, caveats and actual evidence remain intact', async () => {
  const output = comparison('bounded');
  const motif = output.reference_traits.translated_motif;
  motif.matched_entity_count = 500; motif.appearance_different_count = 500;
  motif.search_complete = false; motif.input_coverage_complete = false; motif.matches_truncated = 436;
  motif.matches = Array.from({ length: 64 }, (_, i) => ({ ...motif.matches[0], source_entity_index: i, target_entity_index: i, class_path: `/Mod/${'VeryLongSavedClass'.repeat(18)}_${i}.Prop_C` }));
  for (const side of ['left', 'right']) output.reference_traits[side].appearance.swatches = Array.from({ length: 32 }, (_, i) => ({ descriptor_class: `/Game/${'SavedSwatch'.repeat(24)}_${i}`, count: i + 1 }));
  const f = await fixture(output);
  try {
    const result = await run(f.options);
    assert.equal(result.ok, true); assert.equal(result.status, 'bounded');
    assert(Buffer.byteLength(JSON.stringify(result)) <= 24576);
    assert.equal(result.reference_traits.translated_motif.matched_entity_count, 500);
    assert.equal(result.reference_traits.translated_motif.matches_truncated, 436);
    assert.equal(result.reference_traits.translated_motif.search_complete, false);
    assert.deepEqual(result.reference_traits.claims_not_made, output.reference_traits.claims_not_made);
    assert.equal(result.reference_traits.caveat, output.reference_traits.caveat);
    assert.equal(result.display.truncated, true);
    assert(result.display.omittedMatchRows > 0); assert(result.display.omittedHistogramRows > 0);
    const bytes = await readFile(join(f.directory, result.evidenceFile));
    assert(bytes.length <= 1024 * 1024);
    const full = JSON.parse(bytes);
    assert.equal(full.reference_traits.translated_motif.matches.length, 64);
    assert.equal(full.reference_traits.left.appearance.swatches.length, 32);
    assert.equal(full.evidenceFile, result.evidenceFile);
  } finally { await f.cleanup(); }
});

test('real existing discovery and native inspection preserve unknown for undecodable files without inference', async () => {
  const f = await fixture();
  try {
    // Load the real reader and comparison solver without starting the bridge.
    // Invalid public fixture bytes cannot become fabricated native evidence.
    for (const side of ['left', 'right']) {
      const file = join(f.selection[side].library_directory, f.selection[side].blueprint_reference);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'not a native Satisfactory Blueprint');
    }
    const server = pathToFileURL(resolve('../companion/server.mjs')).href;
    const solvers = pathToFileURL(resolve('../companion/lib/solvers.mjs')).href;
    await writeFile(join(f.sourceDirectory, 'companion/server.mjs'), `export { makeBlueprintReader } from ${JSON.stringify(server)};\n`);
    await writeFile(join(f.sourceDirectory, 'companion/lib/solvers.mjs'), `export { solveBlueprintComparison } from ${JSON.stringify(solvers)};\n`);
    const result = await run({ ...f.options, services: undefined });
    assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'one_or_both_blueprint_inspections_unavailable');
    assert.equal(result.source.execution, 'local_reader_and_solver');
    assert.equal(result.modelCalls, 0); assert.equal(result.gameWrites, 0);
    const evidence = JSON.parse(await readFile(join(f.directory, result.evidenceFile), 'utf8'));
    assert.equal(evidence.comparison.available, false);
    assert(!JSON.stringify(evidence).includes(f.directory));
    assert.deepEqual(f.inspected, []);
  } finally { await f.cleanup(); }
});

test('a match without both exact source fingerprints is unknown rather than accepted evidence', async () => {
  const output = comparison();
  delete output.reference_traits.right.source_fingerprint;
  const f = await fixture(output);
  try {
    const result = await run(f.options);
    assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'reference_source_fingerprint_unavailable');
  } finally { await f.cleanup(); }
});

test('an evidence directory link cannot redirect saved receipts', async t => {
  const f = await fixture();
  try {
    const target = join(f.directory, 'unexpected-evidence');
    await mkdir(target);
    try { await symlink(target, join(f.directory, 'state/architect/reference-comparisons'), 'junction'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Windows account cannot create directory links'); return; } throw error; }
    const result = await run(f.options);
    assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'reference_evidence_directory_must_be_regular_directory');
    assert.deepEqual(await readdir(target), []);
  } finally { await f.cleanup(); }
});
