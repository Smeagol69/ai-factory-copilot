/**
 * "give me 64 biofuel" — when the name matches several items.
 *
 * Found in a live save: with mods installed, "biofuel" matches five catalog
 * entries. The validator correctly refuses to guess, but the route then fell
 * through to a model, which took 33 seconds and returned nothing useful.
 *
 * The candidates were already known at the point of refusal. Listing them is
 * instant, free, and answers the question the player actually has — which is
 * "which one did you mean", not "that failed".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const item = (name, classPath, overrides = {}) => ({
  name,
  class_path: classPath,
  available: true,
  form: "RF_SOLID",
  ...overrides,
});

const graph = buildGraph({
  world_revision: 8,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [],
  content: {
    items: [
      item("Solid Biofuel Prop", "/Factory_Prop_Mod/SolidBiofuelDescrip.SolidBiofuelDescrip_C", {
        available: false,
        form: "RF_INVALID",
      }),
      item("Packaged Liquid Biofuel Prop", "/Factory_Prop_Mod/BiofuelDesc.BiofuelDesc_C", {
        available: false,
        form: "RF_INVALID",
      }),
      item("Packaged Liquid Biofuel", "/Game/Desc_PackagedBiofuel.Desc_PackagedBiofuel_C", {
        available: false,
      }),
      item("Liquid Biofuel", "/Game/Desc_LiquidBiofuel.Desc_LiquidBiofuel_C", {
        available: false,
        form: "RF_LIQUID",
      }),
      item("Solid Biofuel", "/Game/Desc_SolidBiofuel.Desc_SolidBiofuel_C"),
      item("Iron Ore", "/Game/Desc_OreIron.Desc_OreIron_C"),
    ],
    recipes: [],
  },
});

test("an ambiguous item is answered locally with the candidates, not sent to a model", () => {
  const emitted = [];
  const answer = answerLocally("give me 64 biofuel", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.provider, "solvers", "must be answered locally, for free");
  assert.equal(answer.local.solver, "give_item_ambiguous");
  assert.match(answer.reply, /Solid Biofuel/);
  assert.match(answer.reply, /Liquid Biofuel/);
  // Nothing may be added while the choice is still open.
  assert.equal(emitted.length, 0, "an ambiguous give must not put anything in the inventory");
});

test("the suggestion is a phrasing that will actually work", () => {
  const answer = answerLocally("give me 64 biofuel", graph, {});
  assert.match(answer.reply, /give me 64 Solid Biofuel"/);
});

test("the exact missing-count phrase prefers the available item over invalid decoration descriptors", () => {
  const answer = answerLocally("add me biofuel", graph, {});

  assert.equal(answer.local.solver, "give_item_ambiguous");
  assert.match(answer.reply, /give me 1 Solid Biofuel"/);
  assert.ok(answer.reply.indexOf("- Solid Biofuel\n") < answer.reply.indexOf("- Solid Biofuel Prop\n"));
});

test("an unambiguous item still just works", () => {
  const emitted = [];
  const answer = answerLocally("give me 20 Iron Ore", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.local.solver, "give_item");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "give_item");
  assert.equal(emitted[0].count, 20);
  // The stamp the mod requires on every committed write.
  assert.equal(emitted[0].expect_world_revision, "8");
});

test("an item that genuinely does not exist still reaches the model", () => {
  // No candidates means no useful local answer; the model can correct a
  // spelling or explain, which is more than a flat refusal here would.
  const answer = answerLocally("give me 5 unobtanium", graph, {});
  assert.notEqual(answer?.local?.solver, "give_item_ambiguous");
});
