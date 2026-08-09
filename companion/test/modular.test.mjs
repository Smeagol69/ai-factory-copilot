/**
 * Tiling a base from the owner's own modular blueprint set.
 *
 * Their description of it: C for corners, M for the middles between them, IN
 * for the inner parts, power wired at the base and again on inner roofs.
 *
 * The tests that matter are the ones about what it refuses to invent — a module
 * pitch it cannot derive, a role with no blueprint — and the one about roles
 * landing in the right cells, because a corner in the middle of an edge is a
 * hole in the wall.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { findModularSet, planModularShell, modularShellActions } from "../lib/modular.mjs";

const module5 = (name) => ({ name, designer_dimensions: { x: 5, y: 5, z: 5 } });

const LIBRARY = [
  module5("C01_5x5_MODULAR_1.0"),
  module5("C02_5x5_MODULAR_1.0"),
  module5("M01_5x5_MODULAR_1.0"),
  module5("M02_5x5_MODULAR_1.0"),
  module5("M03_5x5_MODULAR_1.0"),
  module5("IC01_5X5_MODULAR_1.0"),
  // Neither of these belongs to the set and must not be tiled with.
  module5("Concrete Factory"),
  { name: "Coal power plant 2700MW v1.1", designer_dimensions: { x: 12, y: 12, z: 6 } },
];

const plan = (options = {}) =>
  planModularShell({}, {
    width_modules: 4,
    depth_modules: 3,
    origin_cm: { x: 0, y: 0, z: 1_000 },
    blueprints: LIBRARY,
    cell_size_cm: 800,
    ...options,
  });

test("the set is sorted by the prefix it already uses", () => {
  const set = findModularSet(LIBRARY);
  assert.deepEqual(set.corner.map((b) => b.name), [
    "C01_5x5_MODULAR_1.0",
    "C02_5x5_MODULAR_1.0",
  ]);
  assert.equal(set.middle.length, 3);
  // The owner calls them "IN"; the files are named IC01. Both are accepted
  // rather than making anyone rename a blueprint.
  assert.deepEqual(set.inner.map((b) => b.name), ["IC01_5X5_MODULAR_1.0"]);
});

test("a blueprint that is not part of the set is never tiled with", () => {
  const set = findModularSet(LIBRARY);
  const all = [...set.corner, ...set.middle, ...set.inner].map((b) => b.name);
  assert.ok(!all.includes("Concrete Factory"));
  assert.ok(!all.includes("Coal power plant 2700MW v1.1"));
});

test("roles land where they belong", () => {
  const result = plan();
  assert.equal(result.planned, true);
  assert.deepEqual(result.counts, { corner: 4, middle: 6, inner: 2 });

  const at = (x, y) => result.placements.find((p) => p.module_x === x && p.module_y === y);
  // A corner in the middle of an edge is a hole in the wall.
  for (const [x, y] of [[0, 0], [3, 0], [0, 2], [3, 2]]) {
    assert.equal(at(x, y).role, "corner", `${x},${y} should be a corner`);
  }
  assert.equal(at(1, 0).role, "middle");
  assert.equal(at(1, 1).role, "inner");
  assert.equal(at(2, 1).role, "inner");
});

test("every corner faces a different way", () => {
  const corners = plan().placements.filter((p) => p.role === "corner");
  assert.equal(new Set(corners.map((p) => p.yaw)).size, 4);
});

test("modules sit on the grid pitch the save actually reported", () => {
  const result = plan({ cell_size_cm: 800 });
  assert.equal(result.module_pitch_cm, 4_000);
  const at = (x, y) => result.placements.find((p) => p.module_x === x && p.module_y === y);
  assert.equal(at(1, 0).location.x - at(0, 0).location.x, 4_000);
  assert.equal(at(0, 1).location.y - at(0, 0).location.y, 4_000);

  // A different grid moves everything, which is why it is never assumed.
  assert.equal(plan({ cell_size_cm: 400 }).module_pitch_cm, 2_000);
});

test("an underivable grid is refused rather than assumed to be 8 m", () => {
  const result = plan({ cell_size_cm: null });
  assert.equal(result.planned, false);
  assert.match(result.reason, /pitch is unknown/i);
});

test("variety is used, so an edge does not read as one stamped unit", () => {
  const middles = plan({ width_modules: 5, depth_modules: 4 }).placements
    .filter((p) => p.role === "middle")
    .map((p) => p.blueprint_name);
  assert.ok(new Set(middles).size > 1, "three middle blueprints should not collapse to one");

  const same = plan({ width_modules: 5, depth_modules: 4, variety: false }).placements
    .filter((p) => p.role === "middle")
    .map((p) => p.blueprint_name);
  assert.equal(new Set(same).size, 1);
});

test("a footprint with no interior does not demand an inner module", () => {
  // 2x2 is four corners and nothing else, so a library without IC still tiles.
  const cornersOnly = LIBRARY.filter((b) => !b.name.startsWith("IC"));
  const result = planModularShell({}, {
    width_modules: 2,
    depth_modules: 2,
    origin_cm: { x: 0, y: 0, z: 0 },
    blueprints: cornersOnly,
    cell_size_cm: 800,
  });
  assert.equal(result.planned, true);
  assert.deepEqual(result.counts, { corner: 4 });
});

test("a missing role is named rather than substituted", () => {
  const noCorners = LIBRARY.filter((b) => !b.name.startsWith("C0"));
  const result = planModularShell({}, {
    width_modules: 4,
    depth_modules: 3,
    origin_cm: { x: 0, y: 0, z: 0 },
    blueprints: noCorners,
    cell_size_cm: 800,
  });
  assert.equal(result.planned, false);
  assert.match(result.reason, /corner/i);
});

test("too small and too large are both refused", () => {
  assert.match(plan({ width_modules: 1 }).reason, /at least 2 x 2/i);
  assert.match(plan({ width_modules: 9, depth_modules: 9 }).reason, /64 is the most/i);
});

test("power is stated as the player's job, not silently skipped", () => {
  // The owner said it: wired at the base, and again on the roof for inners.
  assert.match(plan().power, /base/i);
  assert.match(plan().power, /roof/i);
});

test("actions go corners, then edges, then the interior", () => {
  const actions = modularShellActions(plan(), { commit: true });
  assert.equal(actions.length, 12);
  assert.ok(actions.every((action) => action.action === "place_blueprint"));
  assert.ok(actions.every((action) => action.commit === true));
  const roles = actions.map((action) =>
    action.blueprint_name.startsWith("C") ? 0 : action.blueprint_name.startsWith("M") ? 1 : 2,
  );
  assert.deepEqual(roles, [...roles].sort(), "placement order should not jump around");
});

test("a preview commits nothing", () => {
  assert.ok(modularShellActions(plan()).every((action) => action.commit === false));
});
