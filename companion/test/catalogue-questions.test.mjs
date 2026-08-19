/**
 * Three solvers that existed with no way to reach them by asking.
 *
 * `solveBuildCost`, `solveRecipeOptions` and `solveMachineRates` were all
 * written, tested, and exposed to the model as tools — and no phrasing in the
 * router reached any of them. So "how much does a smelter cost" went to a model
 * that answers from training, which is how you get a confident price for a
 * building a mod changed. The catalogue in the capture is the authority and it
 * was sitting right there.
 *
 * Two shapes were assumed wrong on the first pass and caught here rather than
 * in a save: `solveBuildCost` returns `required_display_units`, not `amount`;
 * and `solveRecipeOptions` splits into `recipes_producing_item` and
 * `recipes_consuming_item` rather than a flat `recipes`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally, parseBuildCostRequest, parseRecipeOptionsRequest } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const ORIGIN = { x: 0, y: 0, z: 0 };

const graph = buildGraph({
  world_revision: 1,
  world: { scan_center: ORIGIN },
  interaction_context: {
    player: { pawn_available: true, pawn_location: ORIGIN },
    preferred_target: {
      available: true,
      actor_id: "Build_SmelterMk1_C_9",
      actor_name: "Smelter",
      hit_location: ORIGIN,
      actor_snapshot: { kind: "buildable", name: "Smelter", location: ORIGIN, actor_id: "Build_SmelterMk1_C_9" },
    },
  },
  actors: [
    { actor_id: "P", kind: "player", location: ORIGIN, player_inventory: [{ item_class: "/G/Desc_IronRod.Desc_IronRod_C", amount: 20 }] },
    {
      actor_id: "Build_SmelterMk1_C_9",
      name: "Smelter",
      kind: "buildable",
      role: "manufacturer",
      class_path: "/G/Build_SmelterMk1.Build_SmelterMk1",
      location: ORIGIN,
      built_with_recipe: "/G/Recipe_SmelterBasicMk1.Recipe_SmelterBasicMk1_C",
      manufacturer: { recipe_class: "/G/Recipe_IngotIron.Recipe_IngotIron_C", recipe_name: "Iron Ingot" },
      factory: { production_cycle_seconds: 2, productivity: 1, current_potential: 1, production_status: "Producing" },
    },
  ],
  content: {
    items: [
      { class_path: "/G/Desc_IronIngot.Desc_IronIngot_C", name: "Iron Ingot" },
      { class_path: "/G/Desc_OreIron.Desc_OreIron_C", name: "Iron Ore" },
      { class_path: "/G/Desc_IronRod.Desc_IronRod_C", name: "Iron Rod" },
      { class_path: "/G/Desc_Wire.Desc_Wire_C", name: "Wire" },
    ],
    recipes: [
      {
        class_path: "/G/Recipe_SmelterBasicMk1.Recipe_SmelterBasicMk1_C",
        name: "Smelter",
        produced_in: ["/G/BP_BuildGun.BP_BuildGun_C"],
        ingredients: [
          { item_class: "/G/Desc_IronRod.Desc_IronRod_C", item_name: "Iron Rod", amount: 5 },
          { item_class: "/G/Desc_Wire.Desc_Wire_C", item_name: "Wire", amount: 8 },
        ],
        products: [],
      },
      {
        class_path: "/G/Recipe_IngotIron.Recipe_IngotIron_C",
        name: "Iron Ingot",
        duration_seconds: 2,
        ingredients: [{ item_class: "/G/Desc_OreIron.Desc_OreIron_C", item_name: "Iron Ore", amount: 1 }],
        products: [{ item_class: "/G/Desc_IronIngot.Desc_IronIngot_C", item_name: "Iron Ingot", amount: 1 }],
      },
      {
        class_path: "/G/Recipe_IronRod.Recipe_IronRod_C",
        name: "Iron Rod",
        duration_seconds: 4,
        ingredients: [{ item_class: "/G/Desc_IronIngot.Desc_IronIngot_C", item_name: "Iron Ingot", amount: 1 }],
        products: [{ item_class: "/G/Desc_IronRod.Desc_IronRod_C", item_name: "Iron Rod", amount: 1 }],
      },
    ],
  },
});

const ask = (question) => answerLocally(question, graph, { actions: { emit: () => {} } });

test("a build cost comes from the catalogue and scales with the count", () => {
  const one = ask("how much does a smelter cost");
  assert.equal(one.local.solver, "build_cost");
  assert.match(one.reply, /5 × Iron Rod/);
  assert.match(one.reply, /8 × Wire/);

  const three = ask("cost of 3 smelters");
  assert.match(three.reply, /15 × Iron Rod/);
  assert.match(three.reply, /24 × Wire/);
});

test("a locked building still has a price, and the lock is stated", () => {
  // Wanting the price before committing to the milestone is most of why
  // anyone asks. The lookup refuses on unlock grounds but returns the class,
  // so the question is answerable without pretending the building is available.
  const answer = ask("how much does a smelter cost");
  assert.match(answer.reply, /not unlocked yet/);
  assert.match(answer.reply, /Not all of that is in your inventory/);
});

test("naming an item finds the recipes on both sides of it", () => {
  // The player names an item; `name_contains` filters recipe *names*. "what
  // uses iron ore" found nothing until the item was resolved first.
  const uses = ask("what uses iron ore");
  assert.equal(uses.local.solver, "recipe_options");
  assert.match(uses.reply, /Uses it/);
  assert.match(uses.reply, /Iron Ingot/);
  assert.ok(!/Makes it/.test(uses.reply), "iron ore is made by no recipe here");

  const both = ask("what can i make with iron ingot");
  assert.match(both.reply, /Makes it/);
  assert.match(both.reply, /Uses it/);
  // Per minute where the catalogue gave a cycle time.
  assert.match(both.reply, /30\/min Iron Ore/);
  assert.match(both.reply, /15\/min Iron Ingot/);
});

test("the machine under the crosshair reports its own recipe", () => {
  const answer = ask("what is this making");
  assert.equal(answer.local.solver, "what_is_this_making");
  assert.match(answer.reply, /Smelter/);
  assert.match(answer.reply, /Iron Ingot/);
});

test("neighbouring questions are not swallowed", () => {
  // "cost" has to appear or "how much is my power" becomes a build cost.
  assert.equal(parseBuildCostRequest("how much power am i making"), null);
  assert.equal(parseBuildCostRequest("how much iron do i have"), null);
  assert.equal(parseRecipeOptionsRequest("what can i do"), null);
  assert.equal(parseRecipeOptionsRequest("what is this"), null);
});
