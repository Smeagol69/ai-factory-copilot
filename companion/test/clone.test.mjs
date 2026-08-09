/**
 * Copying what is already standing.
 *
 * The owner asked for a select-and-stamp tool, the way Micro Manage used to do
 * it. None of it needs new game code: the snapshot already carries every
 * buildable's build recipe, facing, measured bounds, and current production
 * recipe, so a clone is a read and some arithmetic.
 *
 * The tests that matter are the ones about not inventing: no measured bounds
 * means no pitch, and a copy that loses its recipe is a different machine.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { describeCloneSource, planClone } from "../lib/clone.mjs";

const SMELTER = {
  actor_id: "Build_SmelterMk1_C_1",
  name: "Build_SmelterMk1_C_1",
  class_path: "/Game/Build_SmelterMk1.Build_SmelterMk1_C",
  kind: "buildable",
  owner_mod: "FactoryGame",
  location: { x: 1_000, y: 2_000, z: 100 },
  rotation: { pitch: 0, yaw: 90, roll: 0 },
  bounds: { origin: { x: 1_000, y: 2_000, z: 100 }, extent: { x: 300, y: 450, z: 400 } },
  built_with_recipe: "/Game/Recipes/Recipe_SmelterBasicMk1.Recipe_SmelterBasicMk1_C",
  manufacturer: {
    recipe_class: "/Game/Recipes/Recipe_IngotCopper.Recipe_IngotCopper_C",
    recipe_name: "Copper Ingot",
  },
};

const graphWith = (actors) =>
  buildGraph({
    world_revision: 1,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
    actors,
    content: { items: [], recipes: [] },
  });

const clone = (options = {}) =>
  planClone(graphWith(options.actors ?? [SMELTER]), {
    actor_id: SMELTER.actor_id,
    count: 4,
    ...options,
  });

test("a copy keeps the recipe that built it and the recipe it runs", () => {
  // A Smelter cloned without its selected recipe arrives unset, which is a
  // different machine from the one the player pointed at.
  const result = clone();
  assert.equal(result.planned, true);
  for (const action of result.actions) {
    assert.equal(action.recipe_class, SMELTER.built_with_recipe);
    assert.equal(action.production_recipe_class, SMELTER.manufacturer.recipe_class);
    assert.equal(action.yaw, 90);
  }
});

test("spacing is measured from the building's own bounds", () => {
  // extent.y is a half-size, so the footprint across the row is 900, plus the
  // 200 gap. Nothing here knows or needs to know what a Smelter is.
  const result = clone();
  assert.equal(result.pitch_cm, 1_100);
  assert.equal(result.measured_from_bounds, true);

  const wider = clone({
    actors: [{ ...SMELTER, bounds: { ...SMELTER.bounds, extent: { x: 300, y: 900, z: 400 } } }],
  });
  assert.equal(wider.pitch_cm, 2_000);
});

test("copies are evenly spaced and none lands on the original", () => {
  const result = clone({ count: 3 });
  const offsets = result.actions.map((action) =>
    Math.round(Math.hypot(action.location.x - SMELTER.location.x, action.location.y - SMELTER.location.y)),
  );
  assert.deepEqual(offsets, [1_100, 2_200, 3_300]);
});

test("without measured bounds the pitch is unknown and it says so", () => {
  const { bounds: _dropped, ...noBounds } = SMELTER;
  const result = clone({ actors: [noBounds] });
  assert.equal(result.planned, false);
  assert.match(result.reason, /no measured bounds/i);
});

test("something the capture cannot describe is refused, not approximated", () => {
  // No build recipe means the copy would be some other building.
  const { built_with_recipe: _dropped, ...noRecipe } = SMELTER;
  assert.equal(clone({ actors: [noRecipe] }).planned, false);
  assert.equal(describeCloneSource(graphWith([noRecipe]), SMELTER.actor_id), null);
});

test("the count has to be sane", () => {
  assert.match(clone({ count: 0 }).reason, /1 to 20/);
  assert.match(clone({ count: 50 }).reason, /1 to 20/);
});

test("forward copies use the other axis", () => {
  // Sideways is the manifold direction; forward is for extending a line.
  const side = clone({ count: 1, direction: "side" });
  const forward = clone({ count: 1, direction: "forward" });
  assert.notDeepEqual(side.actions[0].location, forward.actions[0].location);
  // extent.x is 300, so a forward pitch is 600 + 200.
  assert.equal(forward.pitch_cm, 800);
});
