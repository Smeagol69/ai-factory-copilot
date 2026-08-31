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
