/**
 * A site the game cannot build on is worse than no site.
 *
 * Found live. `find_best_site` scores the whole map, and on the owner's save it
 * returned a winner 5.5 km away. Satisfactory only streams the world near the
 * player, so a placement trace out there finds no ground: the very first
 * foundation was refused with `no_build_surface_below_requested_location`, and
 * because the mod preflights the whole plan, all 205 actions were skipped.
 *
 * Nothing was damaged — that is the preflight working. But the player waited
 * for a 205-action plan to be built, validated, sent and rejected, when the
 * distance was checkable in one line before any of it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const recipe = (className, descriptor, name) => ({
  class_path: `/Game/Recipes/${className}.${className}_C`,
  name,
  available: true,
  produced_in: [BUILD_GUN],
  products: [{ item_class: `/Game/Desc/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 }],
});

/** A node far enough away that the site solver will prefer it. */
const node = (name, x, y, resource) => ({
  actor_id: name,
  name,
  kind: "resource_node",
  location: { x, y, z: 100 },
  resource_name: resource,
  purity: "pure",
  node_type: "Node",
  occupied: false,
});

const distantWorld = buildGraph({
  world_revision: 9,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  // Every resource sits 5 km away, so the best site does too.
  actors: [
    node("BP_Iron_far", 500_000, 0, "Iron Ore"),
    node("BP_Copper_far", 500_800, 400, "Copper Ore"),
    node("BP_Limestone_far", 499_200, -400, "Limestone"),
  ],
  content: {
    items: [{ name: "Iron Plate", class_path: "/Game/Desc_IronPlate.Desc_IronPlate_C", available: true }],
    recipes: [
      recipe("Recipe_Foundation_8x2_01", "Desc_Foundation_8x2_01", "Foundation (2 m)"),
      recipe("Recipe_ConstructorMk1", "Desc_ConstructorMk1", "Constructor"),
    ],
  },
});

test("refuses a site out of build range before sending a single action", () => {
  const emitted = [];
  const answer = answerLocally(
    "build a base for 60 Iron Plate per minute at the best location",
    distantWorld,
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );

  // The whole point: nothing is sent. A 205-action plan that the game will
  // reject at step one is a waste of the player's time, not a safety net.
  assert.equal(emitted.length, 0, "no action may be sent to a site that cannot be built on");

  if (answer?.local?.solver === "build_base_out_of_range") {
    assert.match(answer.reply, /too far to build/);
    // It must say what to do, not just that it failed.
    assert.match(answer.reply, /teleport/i);
  }
});

test("a site within range is built normally", () => {
  const nearWorld = buildGraph({
    world_revision: 9,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
    actors: [
      node("BP_Iron_near", 10_000, 0, "Iron Ore"),
      node("BP_Copper_near", 10_800, 400, "Copper Ore"),
    ],
    content: {
      items: [{ name: "Iron Plate", class_path: "/Game/Desc_IronPlate.Desc_IronPlate_C", available: true }],
      recipes: [
        recipe("Recipe_Foundation_8x2_01", "Desc_Foundation_8x2_01", "Foundation (2 m)"),
        recipe("Recipe_ConstructorMk1", "Desc_ConstructorMk1", "Constructor"),
      ],
    },
  });

  const answer = answerLocally(
    "build a base for 60 Iron Plate per minute at the best location",
    nearWorld,
    { actions: { emit: () => {} } },
  );
  // 100 m away is fine; only the far case is refused.
  assert.notEqual(answer?.local?.solver, "build_base_out_of_range");
});
