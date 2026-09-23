import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECT_PREVIEW_SCHEMA,
  MAX_ARCHITECT_PREVIEW_ELEMENTS,
  compileArchitectPreview,
} from "../lib/architect-preview.mjs";
import { OVERLAY_ACTION_KINDS, validateAction, validatePlan } from "../lib/actions.mjs";

function manifest() {
  return {
    schema: "megabase.design/v1",
    compiled: true,
    validation: { valid: true, issues: [] },
    style: "elevated_industrial_campus",
    grid: { unit_cm: 800, floor_height_cm: 1600, yaw_degrees: 45 },
    design_family: { fingerprint: `sha256:${"a".repeat(64)}` },
    unlock_constraints: {
      availability_fingerprint: `sha256:${"b".repeat(64)}`,
      captured_world_revision: 71,
    },
    elements: [
      {
        id: "production-zone-1",
        kind: "production_zone",
        world_origin_cm: { x: 1000, y: 2000, z: 3000 },
        world_size_cm: { x: 8000, y: 6400, z: 3200 },
        world_yaw_degrees: 45,
      },
      {
        id: "central-tower",
        kind: "vertical_landmark",
        world_origin_cm: { x: -2000, y: 9000, z: 3000 },
        world_size_cm: { x: 6400, y: 6400, z: 11200 },
        world_yaw_degrees: 45,
      },
    ],
  };
}

test("compiles exact megabase transforms into a private draw-only Architect action", () => {
  const preview = compileArchitectPreview(manifest());
  assert.equal(preview.compiled, true, preview.reason);
  assert.equal(preview.schema, ARCHITECT_PREVIEW_SCHEMA);
  assert.match(preview.manifest_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.action.action, "architect_preview");
  assert.equal(preview.action.grid_unit_cm, 800);
  assert.equal(preview.action.floor_height_cm, 1600);
  assert.deepEqual(preview.action.elements[0].origin_cm, { x: 1000, y: 2000, z: 3000 });
  assert.deepEqual(preview.action.elements[0].size_cm, { x: 8000, y: 6400, z: 3200 });
  assert.ok(OVERLAY_ACTION_KINDS.includes("architect_preview"));

  const validated = validateAction({ world_revision: 71 }, preview.action);
  assert.equal(validated.valid, true, validated.reason);
  assert.equal(validated.action.commit, true);
  assert.equal(validated.checks.draws_only, true);
  assert.match(validated.warnings[0], /not a native Blueprint hologram/i);

  const plan = validatePlan({ world_revision: 71 }, [preview.action]);
  assert.equal(plan.valid, true, plan.reason);
  assert.equal(plan.commits, 0);
  assert.equal(plan.overlays, 1);
});

test("preview compilation refuses invalid, unsupported, and oversized manifests whole", () => {
  const invalid = manifest();
  invalid.validation.valid = false;
  assert.equal(compileArchitectPreview(invalid).compiled, false);

  const unsupported = manifest();
  unsupported.elements[0].kind = "model_invented_building";
  assert.equal(compileArchitectPreview(unsupported).compiled, false);

  const oversized = manifest();
  oversized.elements = Array.from(
    { length: MAX_ARCHITECT_PREVIEW_ELEMENTS + 1 },
    (_unused, index) => ({ ...oversized.elements[0], id: `zone-${index}` }),
  );
  const result = compileArchitectPreview(oversized);
  assert.equal(result.compiled, false);
  assert.equal(result.reason, "manifest_exceeds_architect_preview_element_limit");
});

test("bridge validation refuses invented provenance, duplicate ids, and malformed geometry", () => {
  const preview = compileArchitectPreview(manifest());

  assert.equal(validateAction({}, {
    ...preview.action,
    manifest_fingerprint: "trust me",
  }).valid, false);

  assert.equal(validateAction({}, {
    ...preview.action,
    elements: [preview.action.elements[0], preview.action.elements[0]],
  }).valid, false);

  assert.equal(validateAction({}, {
    ...preview.action,
    elements: [{ ...preview.action.elements[0], size_cm: { x: 0, y: 1, z: 1 } }],
  }).valid, false);
});

function facadeManifest(yaw = 0) {
  const concept = manifest();
  concept.grid = { unit_cm: 800, floor_height_cm: 400, yaw_degrees: yaw };
  concept.elements = [{
    id: "hall-front", kind: "glazed_facade",
    world_origin_cm: { x: 10000, y: 20000, z: 1000 },
    world_size_cm: { x: 3200, y: 800, z: 800 },
    world_yaw_degrees: yaw, size_cells: { x: 4, y: 1, z: 2 },
    openings: [{ start_cell: 1, width_cells: 2, base_floor: 0, height_floors: 1 }],
  }];
  return concept;
}

test("facade previews show a centred ground opening and retain the upper storey", () => {
  const concept = facadeManifest();
  const before = structuredClone(concept);
  const result = compileArchitectPreview(concept);
  assert.equal(result.compiled, true, result.reason);
  assert.equal(result.element_count, 3);
  assert.deepEqual(result.action.elements.map(({ origin_cm, size_cm }) => ({ origin_cm, size_cm })), [
    { origin_cm: { x: 9600, y: 20000, z: 1000 }, size_cm: { x: 800, y: 800, z: 400 } },
    { origin_cm: { x: 12000, y: 20000, z: 1000 }, size_cm: { x: 800, y: 800, z: 400 } },
    { origin_cm: { x: 9600, y: 20000, z: 1400 }, size_cm: { x: 3200, y: 800, z: 400 } },
  ]);
  const checked = validatePlan({ world_revision: 71 }, [result.action]);
  assert.equal(checked.valid, true, checked.reason);
  assert.equal(checked.overlays, 1);
  assert.equal(checked.commits, 0);
  assert.deepEqual(concept, before);
});

test("opening edges preserve the facade pivot at quarter and fractional rotations", () => {
  for (const yaw of [90, 227.25]) {
    const result = compileArchitectPreview(facadeManifest(yaw));
    assert.equal(result.compiled, true, result.reason);
    const radians = yaw * Math.PI / 180;
    for (const [index, section] of result.action.elements.entries()) {
      const dx = section.origin_cm.x - 10000;
      const dy = section.origin_cm.y - 20000;
      const expectedX = index === 1 ? 2000 : -400;
      assert.ok(Math.abs(dx * Math.cos(radians) + dy * Math.sin(radians) - expectedX) < 0.001);
      assert.ok(Math.abs(-dx * Math.sin(radians) + dy * Math.cos(radians)) < 0.001);
      assert.equal(section.yaw_degrees, yaw);
    }
  }
});

test("overlapping and elevated openings preserve exactly the union of omitted cells", () => {
  const concept = facadeManifest();
  const face = concept.elements[0];
  face.size_cells = { x: 8, y: 1, z: 4 };
  face.world_size_cm = { x: 6400, y: 800, z: 1600 };
  face.openings = [
    { start_cell: 1, width_cells: 3, base_floor: 0, height_floors: 2 },
    { start_cell: 2, width_cells: 3, base_floor: 1, height_floors: 2 },
    { start_cell: 6, width_cells: 2, base_floor: 2, height_floors: 2 },
  ];
  const result = compileArchitectPreview(concept);
  assert.equal(result.compiled, true, result.reason);
  // Independent raster oracle: each solid cell is covered once; every opening
  // cell remains empty, even where several declared rectangles overlap.
  const expectedRows = ["10001111", "10000111", "11000100", "11111100"];
  for (let z = 0; z < 4; z += 1) {
    for (let x = 0; x < 8; x += 1) {
      const centre = { x: 10000 + x * 800, z: 1000 + (z + 0.5) * 400 };
      const covering = result.action.elements.filter((section) =>
        centre.x > section.origin_cm.x && centre.x < section.origin_cm.x + section.size_cm.x &&
        centre.z > section.origin_cm.z && centre.z < section.origin_cm.z + section.size_cm.z);
      assert.equal(covering.length, Number(expectedRows[z][x]), `cell ${x},${z}`);
    }
  }
  const reversed = structuredClone(concept);
  reversed.elements[0].openings.reverse();
  assert.deepEqual(compileArchitectPreview(reversed), result);
});

test("wall runs merge vertically and a fully open facade emits no false wall", () => {
  const concept = facadeManifest();
  concept.elements[0].openings[0].height_floors = 2;
  const result = compileArchitectPreview(concept);
  assert.equal(result.element_count, 2);
  assert.ok(result.action.elements.every((section) => section.size_cm.z === 800));
  concept.elements[0].openings[0] = { start_cell: 0, width_cells: 4, base_floor: 0, height_floors: 2 };
  assert.equal(compileArchitectPreview(concept).reason, "manifest_has_no_retained_preview_geometry");
  concept.elements.push(manifest().elements[1]);
  assert.equal(compileArchitectPreview(concept).element_count, 1);
});

test("opening changes alter the draw fingerprint while empty openings preserve legacy output", () => {
  const concept = facadeManifest();
  const original = compileArchitectPreview(concept);
  concept.elements[0].openings[0].width_cells = 1;
  assert.notEqual(compileArchitectPreview(concept).manifest_fingerprint, original.manifest_fingerprint);
  concept.elements[0].openings = [];
  const empty = compileArchitectPreview(concept);
  delete concept.elements[0].openings;
  assert.deepEqual(compileArchitectPreview(concept), empty);
});

test("malformed openings refuse the entire preview despite a stale validation flag", () => {
  for (const openings of [null, {}, [null],
    [{ start_cell: 3, width_cells: 2, base_floor: 0, height_floors: 1 }],
    [{ start_cell: 1, width_cells: 1, base_floor: 1, height_floors: 2 }],
    [{ start_cell: 1.5, width_cells: 1, base_floor: 0, height_floors: 1 }]]) {
    const concept = facadeManifest();
    concept.elements[0].openings = openings;
    const result = compileArchitectPreview(concept);
    assert.equal(result.compiled, false);
    assert.equal(result.action, undefined);
  }
  const mismatch = facadeManifest();
  mismatch.elements[0].world_size_cm.x += 1;
  assert.equal(compileArchitectPreview(mismatch).compiled, false);
  const wrongKind = facadeManifest();
  wrongKind.elements[0].kind = "production_zone";
  assert.equal(compileArchitectPreview(wrongKind).compiled, false);
});

test("expanded facade sections respect the total renderer budget without partial draws", () => {
  const concept = facadeManifest();
  const face = concept.elements[0];
  concept.elements = Array.from({ length: 86 }, (_, index) => ({ ...face, id: `face-${index}` }));
  assert.equal(compileArchitectPreview(concept).reason, "facade_sections_exceed_architect_preview_element_limit");
  concept.elements = [face];
  face.size_cells.x = 513;
  face.world_size_cm.x = 513 * 800;
  face.openings = Array.from({ length: 256 }, (_, index) => ({
    start_cell: index * 2 + 1, width_cells: 1, base_floor: 0, height_floors: 2,
  }));
  assert.equal(compileArchitectPreview(concept).reason, "facade_sections_exceed_architect_preview_element_limit");
});

test("preview transforms reject null scalars and derived ids remain bounded for long facade names", () => {
  for (const field of ["world_origin_cm", "world_size_cm", "world_yaw_degrees"]) {
    const concept = facadeManifest();
    if (field === "world_yaw_degrees") concept.elements[0][field] = null;
    else concept.elements[0][field].x = null;
    assert.equal(compileArchitectPreview(concept).compiled, false);
  }
  const concept = facadeManifest();
  concept.elements[0].id = "f".repeat(96);
  const result = compileArchitectPreview(concept);
  assert.equal(result.compiled, true, result.reason);
  assert.equal(validateAction({}, result.action).valid, true);
  assert.equal(new Set(result.action.elements.map((section) => section.id)).size, 3);
});
