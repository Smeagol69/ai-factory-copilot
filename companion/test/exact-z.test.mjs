/**
 * Who means their heights, and who does not.
 *
 * `PositionAndValidateActionHologram` traces down for a build surface and, by
 * default, places on whatever it hits. That is right for a single building
 * dropped on open ground and wrong for everything that computed its Z on
 * purpose — measured live as a Smelter asked for z 8054 landing at 9028, nearly
 * ten metres up, because each building settled onto its own patch of terrain.
 *
 * `exact_z` is the opt-in. The split is the whole point, so it is pinned here in
 * one place rather than left to four planners to remember separately:
 *
 *   asks for it — a saved design, a clone of a real building, and anything
 *   placed at a computed deck or storey height. Foundations are flat; a floor
 *   grid that follows terrain is a lumpy floor.
 *
 *   does not — a fresh layout on open ground, where the trace is doing the
 *   useful work of finding the ground in the first place.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file) => fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");

test("planners that compute their heights ask for them", () => {
  for (const file of ["designs.mjs", "clone.mjs", "composition.mjs", "architecture.mjs", "base-build.mjs"]) {
    assert.ok(read(file).includes("exact_z: true"), `${file} should ask for its own heights`);
  }

  // Both of composition's converters, not just the one that is easy to find:
  // stageComposition builds the same actions for a plan too big to send whole,
  // and a staged build that drifts is the same bug arriving later.
  assert.equal(read("composition.mjs").match(/exact_z: true/g).length, 2);
});

test("planners laying out on open ground still let the trace find it", () => {
  // These site a factory on terrain nobody has flattened yet, and their Z is
  // the anchor's -- the resource node's own height -- reused for a row that
  // marches tens of metres away from it. The terrain under the far end is not
  // something the planner measured, so forcing the anchor's height there would
  // float or bury a generator. The trace is doing real work.
  for (const file of ["power.mjs", "resource-factory.mjs"]) {
    assert.ok(!read(file).includes("exact_z"), `${file} should leave the ground trace alone`);
  }
});

test("the flag survives validation on its way to the game", async () => {
  const { validatePlan } = await import("../lib/actions.mjs");
  const graph = { world_revision: 1, nodes: new Map(), snapshot: { content: { recipes: [] } } };
  const proposal = {
    action: "place_building",
    recipe_class: "/G/Recipe_Foundation_C",
    location: { x: 0, y: 0, z: 900 },
    yaw: 0,
    commit: true,
  };

  assert.equal(validatePlan(graph, [{ ...proposal, exact_z: true }]).actions[0].exact_z, true);
  // Absent rather than false when unasked, so the mod's default stands.
  assert.equal("exact_z" in validatePlan(graph, [proposal]).actions[0], false);
});
