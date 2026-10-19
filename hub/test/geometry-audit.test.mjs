import test from 'node:test';
import assert from 'node:assert/strict';

const piece = { measurement: { local_size_cm: { x: 800, y: 800, z: 100 }, local_min_z_cm: -50 } };
const floor = (id, x, y, z = 50, yaw = 0) => ({ part_id: id, role: 'floor', relative_location: { x, y, z }, yaw });
const manifest = elements => ({ schema: 'architect.structure/v1', pieces: { floor: structuredClone(piece), wall: structuredClone(piece) }, elements });

test('measured rectangular geometry distinguishes contact from penetration in centimetres', async () => {
  const { auditStructuralGeometry } = await import('../lib/geometry-audit.mjs');
  const touching = auditStructuralGeometry(manifest([floor('a', 400, 400), floor('b', 1200, 400)]));
  assert.equal(touching.status, 'no_measured_box_penetration');
  assert.equal(touching.testedPairs, 1);
  assert.equal(touching.gamePlacementVerified, false);
  const clipped = auditStructuralGeometry(manifest([floor('a', 400, 400), floor('b', 1190, 400)]));
  assert.equal(clipped.status, 'measured_box_penetration');
  assert.equal(clipped.overlaps.length, 1);
  assert.equal(clipped.overlaps[0].minimumPenetrationCm, 10);
  assert.deepEqual(clipped.overlaps[0].parts, ['a', 'b']);
  assert.equal(auditStructuralGeometry(manifest([floor('a', 400, 400), floor('b', 400, 400, 150)])).overlaps.length, 0);
});

test('rotated measured boxes use separating axes rather than world AABB intersection', async () => {
  const { auditStructuralGeometry } = await import('../lib/geometry-audit.mjs');
  const m = manifest([floor('a', 0, 0, 50, 45), floor('b', 0, 100, 50, 45)]);
  m.pieces.floor.measurement.local_size_cm = { x: 800, y: 20, z: 100 };
  // Parallel 8m beams have overlapping world AABBs, but 70.71cm perpendicular separation.
  assert.equal(auditStructuralGeometry(m).status, 'no_measured_box_penetration');
  m.elements[1].relative_location.y = 10;
  const clipped = auditStructuralGeometry(m);
  assert.equal(clipped.status, 'measured_box_penetration');
  assert(Math.abs(clipped.overlaps[0].minimumPenetrationCm - (20 - 10 / Math.sqrt(2))) < 0.0001);
});

test('missing measurements, duplicate IDs and invalid numeric transforms stay unknown', async () => {
  const { auditStructuralGeometry } = await import('../lib/geometry-audit.mjs');
  for (const alter of [m => { delete m.pieces.floor.measurement; }, m => { m.elements[0].yaw = Infinity; },
    m => { m.elements.push(structuredClone(m.elements[0])); }, m => { m.elements[0].role = 'decoration'; }]) {
    const m = manifest([floor('a', 0, 0)]); alter(m);
    assert.equal(auditStructuralGeometry(m).status, 'unknown');
  }
});
