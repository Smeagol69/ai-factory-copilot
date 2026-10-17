import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createArchitectDemoRunner } from '../lib/architect-demo.mjs';

const BASE = resolve('state/architect');
function snapshot() {
  const directories = ['/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/', '/Game/FactoryGame/Buildable/Building/Wall/ConcreteWallSet/'];
  const names = ['Foundation_Concrete_8x1', 'Wall_Concrete_8x4'];
  const asset = (i, prefix) => `${directories[i]}${prefix}_${names[i]}.${prefix}_${names[i]}_C`;
  return { schema: 'aifactory.snapshot', schema_version: 1, world_revision: 77,
    generated_at_utc: '2026-10-11T05:00:00.000Z', world: { map: 'Test_Map', session_name: 'Owned fixture', scan_radius_meters: -1 },
    completeness: { actor_limit_reached: false }, private_marker: 'PRIVATE_WORLD_PAYLOAD_DO_NOT_PERSIST',
    actors: names.map((name, i) => ({ actor_id: `piece-${i}`, kind: 'buildable', class_path: asset(i, 'Build'),
      location: { x: 1000, y: 2000, z: 3000 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 },
      bounds: { origin: { x: 1000, y: 2000, z: i ? 3200 : 3000 }, extent: i ? { x: 25, y: 400, z: 200 } : { x: 400, y: 400, z: 50 } } })),
    content: { availability_known: true,
      items: names.map((name, i) => ({ class_path: asset(i, 'Desc'), name, building: { class_path: asset(i, 'Build') } })),
      recipes: names.map((name, i) => ({ class_path: asset(i, 'Recipe'), name, available: true, products: [{ item_class: asset(i, 'Desc'), amount: 1 }], ingredients: [], produced_in: ['/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C'] })) } };
}
async function fixture(alter) {
  await mkdir(BASE, { recursive: true }); const root = await mkdtemp(join(BASE, 'test-'));
  const captureDirectory = join(root, 'captures'), evidenceDirectory = join(root, 'evidence'); await mkdir(captureDirectory);
  const s = snapshot(); alter?.(s);
  const envelope = { schema: 'aifactory.snapshot-cache/v1', whole_world: true, stored_at_utc: '2026-10-11T05:00:01.000Z',
    world_revision: s.world_revision, generated_at_utc: s.generated_at_utc, actor_count: s.actors.length,
    save: { map: s.world.map, save_session_name: s.world.session_name }, snapshot: s };
  await writeFile(join(captureDirectory, `${'a'.repeat(64)}-world.json.gz`), gzipSync(JSON.stringify(envelope)));
  return { root, run: createArchitectDemoRunner({ captureDirectory, evidenceDirectory, now: () => Date.parse('2026-10-16T05:00:00.000Z') }), evidenceDirectory };
}
async function cleanup(root) { assert(resolve(root).startsWith(BASE + '\\') || resolve(root).startsWith(BASE + '/')); await rm(root, { recursive: true, force: true }); }

test('offline captured-world demo compiles the exact measured 2x1x2 shell and labels stale provenance', async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.manifest.part_count, 8);
    assert.deepEqual(result.layout.buildables.filter(p => p.role === 'floor').map(p => p.relative_location), [{ x: 400, y: 400, z: 50 }, { x: 1200, y: 400, z: 50 }]);
    assert.deepEqual(result.layout.buildables.filter(p => p.role === 'roof').map(p => p.relative_location.z), [950, 950]);
    assert.deepEqual(result.layout.buildables.filter(p => p.role === 'wall').map(p => p.relative_location.z), [100, 100, 500, 500]);
    assert.equal(result.capture.worldRevision, 77);
    assert.equal(result.capture.session, 'Owned fixture');
    assert.equal(result.capture.schema, 'aifactory.snapshot');
    assert.equal(result.capture.freshness.status, 'stale');
    assert.equal(result.capture.freshness.ageMs, 5 * 24 * 60 * 60 * 1000);
    assert.match(result.capture.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.commit, false);
    assert.equal(result.liveGameVerified, false);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.nativeFilesWritten, 0);
    assert.equal(result.geometryAudit.status, 'no_measured_box_penetration');
    assert.equal(result.geometryAudit.testedPairs, 28);
    assert.equal(result.geometryAudit.gamePlacementVerified, false);
    assert.equal(result.layout.action, undefined);
    const saved = await readFile(join(f.evidenceDirectory, 'latest-demo.json'), 'utf8');
    assert(!saved.includes('PRIVATE_WORLD_PAYLOAD_DO_NOT_PERSIST'));
    assert(!saved.includes('"actors"'));
    assert.equal(JSON.parse(saved).checkId, result.checkId);
    assert(Buffer.byteLength(saved) <= 32768);
  } finally { await cleanup(f.root); }
});

test('unknown geometry or recipe capture refuses rather than inventing a structural piece', async () => {
  for (const alter of [s => { s.actors = []; }, s => { s.content.availability_known = false; }, s => { s.content.recipes[1].available = false; }]) {
    const f = await fixture(alter);
    try {
      const result = await f.run();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unknown');
      assert.equal(result.manifest, undefined);
      assert.equal(result.layout, undefined);
      assert.equal(result.commit, false);
      assert(result.reason);
    } finally { await cleanup(f.root); }
  }
});

test('a missing capture and a nearby-only capture cannot become whole-world design evidence', async () => {
  const f = await fixture(s => { s.world.scan_radius_meters = 250; });
  try {
    assert.equal((await f.run()).reason, 'capture_is_not_whole_world');
    const run = createArchitectDemoRunner({ captureDirectory: join(f.root, 'absent'), evidenceDirectory: f.evidenceDirectory });
    const missing = await run();
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'whole_world_capture_not_found');
  } finally { await cleanup(f.root); }
});

test('raw captures with missing whole-world scope and mismatched cache metadata stay unknown', async () => {
  const f = await fixture();
  const directory = join(f.root, 'captures');
  const path = join(directory, `${'a'.repeat(64)}-world.json.gz`);
  try {
    const s = snapshot(); delete s.world.scan_radius_meters;
    await rm(path); await writeFile(join(directory, 'latest.json'), JSON.stringify(s));
    assert.equal((await f.run()).reason, 'capture_whole_world_scope_unknown');
    await rm(join(directory, 'latest.json'));
    await writeFile(path, gzipSync(JSON.stringify({ schema: 'aifactory.snapshot-cache/v1', whole_world: true,
      world_revision: s.world_revision + 1, actor_count: s.actors.length,
      save: { map: s.world.map, save_session_name: s.world.session_name }, snapshot: s })));
    assert.equal((await f.run()).reason, 'capture_envelope_metadata_mismatch');
  } finally { await cleanup(f.root); }
});

test('an invalid completion timestamp uses the valid generated timestamp without displaying an invalid date', async () => {
  const f = await fixture(s => { s.capture_completed_at_utc = 'invalid completion'; });
  try {
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.capture.completedAtUtc, null);
    assert.equal(result.capture.freshness.basis, 'generated_at_utc');
    assert.equal(result.capture.freshness.ageMs, 5 * 24 * 60 * 60 * 1000);
  } finally { await cleanup(f.root); }
});
