import assert from "node:assert/strict";
import test from "node:test";
import { compileArchitectAccess } from "../lib/architect-access.mjs";
import { elementOriginToWorld } from "../lib/megabase.mjs";

function fixture(yaw = 0) {
  const manifest = {
    schema: "megabase.design/v1", compiled: true, actions: [],
    grid: { unit_cm: 800, floor_height_cm: 400, yaw_degrees: yaw },
    anchor_cm: { x: 10000, y: 20000, z: 1000 },
    design_family: { family_id: "access", fingerprint: `sha256:${"a".repeat(64)}` },
    commissioning: { planned: true, exact_total_preserved: true },
    program: { groups: [], material_edges: [], external_inputs: [], external_outputs: [] },
    elements: [{ id: "face", kind: "glazed_facade", local: { x: 0, y: 0, z: 0 },
      size_cells: { x: 4, y: 1, z: 3 }, world_yaw_degrees: yaw,
      openings: [{ start_cell: 1, width_cells: 2, base_floor: 0, height_floors: 1 }] }],
  };
  manifest.elements[0].world_origin_cm = { ...manifest.anchor_cm };
  return manifest;
}

test("portal edges use half-module boundaries and the native facade plane", () => {
  const manifest = fixture();
  const before = structuredClone(manifest);
  const result = compileArchitectAccess(manifest);
  assert.equal(result.compiled, true, JSON.stringify(result.issues));
  assert.equal(result.portals.length, 1);
  assert.deepEqual(result.portals[0], {
    id: "face:opening:1", element_id: "face", opening_index: 0,
    width_cm: 1600, height_cm: 400,
    lower_edge_center_cm: { x: 11200, y: 20400, z: 1000 },
    corners_cm: [
      { x: 10400, y: 20400, z: 1000 }, { x: 12000, y: 20400, z: 1000 },
      { x: 12000, y: 20400, z: 1400 }, { x: 10400, y: 20400, z: 1400 },
    ],
    outward_normal: { x: 0, y: -1, z: 0 }, world_yaw_degrees: 0,
  });
  assert.equal(result.circulation.reachable, null);
  assert.equal(result.circulation.status, "not_routed");
  assert.deepEqual(manifest, before);
});

test("elevated apertures rotate with the facade and preserve declared dimensions", () => {
  const manifest = fixture(90);
  manifest.elements[0].openings[0].base_floor = 1;
  manifest.elements[0].openings[0].height_floors = 2;
  const result = compileArchitectAccess(manifest);
  const portal = result.portals[0];
  assert.equal(result.compiled, true, JSON.stringify(result.issues));
  assert.deepEqual(portal.lower_edge_center_cm, { x: 9600, y: 21200, z: 1400 });
  assert.deepEqual(portal.corners_cm[2], { x: 9600, y: 22000, z: 2200 });
  assert.deepEqual(portal.outward_normal, { x: 1, y: 0, z: 0 });
  assert.equal(portal.height_cm, 800);
});

test("fractional hall frames compose with face orientation without moving the frame origin", () => {
  const manifest = fixture(17.25);
  const face = manifest.elements[0];
  face.local = { x: 2, y: 3, z: 1 };
  face.placement_frame = { local_pivot_cells: { x: 1.5, y: 2.5 }, campus_pivot_cells: { x: 10, y: -5 } };
  face.yaw_offset_degrees = 30;
  face.orientation_offset_degrees = 180;
  face.world_yaw_degrees = 227.25;
  face.world_origin_cm = elementOriginToWorld(face, manifest.grid, manifest.anchor_cm);
  const result = compileArchitectAccess(manifest);
  assert.equal(result.compiled, true, JSON.stringify(result.issues));
  const portal = result.portals[0];
  const radians = 227.25 * Math.PI / 180;
  const delta = { x: portal.lower_edge_center_cm.x - face.world_origin_cm.x,
    y: portal.lower_edge_center_cm.y - face.world_origin_cm.y };
  // Undo only the facade rotation: the aperture centre must be (1200, 400).
  assert.ok(Math.abs(delta.x * Math.cos(radians) + delta.y * Math.sin(radians) - 1200) < 0.001);
  assert.ok(Math.abs(-delta.x * Math.sin(radians) + delta.y * Math.cos(radians) - 400) < 0.001);
  assert.ok(Math.abs(Math.hypot(portal.outward_normal.x, portal.outward_normal.y) - 1) < 1e-12);
  assert.equal(portal.lower_edge_center_cm.z, 1400);
});

test("absent legacy openings report an empty catalog without implying access", () => {
  const manifest = fixture();
  delete manifest.elements[0].openings;
  const result = compileArchitectAccess(manifest);
  assert.equal(result.compiled, true);
  assert.deepEqual(result.portals, []);
  assert.equal(result.circulation.reachable, null);
});

test("invalid or tampered geometry never produces a partial catalog", () => {
  const mutations = [
    (m) => { m.elements[0].world_origin_cm.x += 1; },
    (m) => { m.elements[0].world_yaw_degrees = 42; },
    (m) => { m.elements[0].openings.push({ start_cell: 3, width_cells: 2, base_floor: 0, height_floors: 1 }); },
    (m) => { m.elements[0].openings = [null]; },
    (m) => { m.grid.unit_cm = null; },
    (m) => { m.grid.floor_height_cm = -400; },
    (m) => { m.elements[0].world_yaw_degrees = null; },
  ];
  for (const mutate of mutations) {
    const manifest = fixture();
    mutate(manifest);
    const result = compileArchitectAccess(manifest);
    assert.equal(result.compiled, false, JSON.stringify(manifest));
    assert.deepEqual(result.portals, []);
    assert.ok(result.issues.length > 0);
  }
  for (const input of [null, {}, { elements: {} }]) {
    assert.equal(compileArchitectAccess(input).compiled, false);
  }
});
