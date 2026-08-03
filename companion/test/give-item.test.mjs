/**
 * Putting items in the player's inventory.
 *
 * The player asked "insert biomass into my inventory" and the copilot refused —
 * correctly, because no such action existed and it declined to invent one. This
 * is that action.
 *
 * It is a write, not a convenience: gated behind the write switch, stamped with
 * the world revision, honours a dry run, and reversible. Undo takes back only
 * what actually landed, so a partial add into a full inventory cannot leave
 * undo confiscating items the player already had.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WRITE_ACTION_KINDS, validatePlan } from "../lib/actions.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { answerLocally, parseGiveRequest } from "../lib/router.mjs";

const graph = buildGraph({
  world_revision: 77,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [],
  content: {
    items: [
      { class_path: "/Game/FactoryGame/Resource/Parts/GenericBiomass/Desc_GenericBiomass.Desc_GenericBiomass_C", name: "Biomass" },
      { class_path: "/Game/FactoryGame/Resource/Parts/IronPlate/Desc_IronPlate.Desc_IronPlate_C", name: "Iron Plate" },
      { class_path: "/Game/FactoryGame/Resource/RawResources/Coal/Desc_Coal.Desc_Coal_C", name: "Coal" },
    ],
  },
});

test("give_item is a write, so it is gated and stamped like every other write", () => {
  assert.ok(WRITE_ACTION_KINDS.includes("give_item"));

  const plan = validatePlan(graph, [
    { action: "give_item", item_name: "Biomass", count: 50, commit: true },
  ]);
  assert.equal(plan.valid, true, JSON.stringify(plan.rejected ?? plan));

  const [action] = plan.actions;
  assert.equal(action.action, "give_item");
  assert.equal(action.count, 50);
  assert.match(action.item_class, /Desc_GenericBiomass_C$/);
  // Without this the mod refuses with committed_write_missing_expect_world_revision.
  assert.equal(action.expect_world_revision, "77");
});

test("resolves an item by display name, class name, or full class path", () => {
  const byPath = validatePlan(graph, [
    { action: "give_item", item_class: "/Game/FactoryGame/Resource/RawResources/Coal/Desc_Coal.Desc_Coal_C", count: 1, commit: true },
  ]);
  assert.equal(byPath.valid, true);

  const byShortName = validatePlan(graph, [
    { action: "give_item", item_class: "Desc_Coal_C", count: 1, commit: true },
  ]);
  assert.equal(byShortName.valid, true);
  assert.match(byShortName.actions[0].item_class, /Desc_Coal_C$/);
});

test("an item the game does not have is refused, with real suggestions", () => {
  const plan = validatePlan(graph, [
    { action: "give_item", item_name: "Unobtanium", count: 5, commit: true },
  ]);
  assert.equal(plan.valid, false);
  assert.equal(plan.rejected[0].reason, "no_such_item");
  // The earlier suggestion logic matched "Tan" inside "unobtanium". Anything
  // returned here must be a real item name, never a fragment.
  for (const suggestion of plan.rejected[0].closest ?? []) {
    assert.ok(suggestion.length > 0);
    assert.ok(["Biomass", "Iron Plate", "Coal"].includes(suggestion), `bogus suggestion: ${suggestion}`);
  }
});

test("a slipped decimal or a nonsense count is refused rather than granted", () => {
  for (const count of [0, -3, 1.5, 999_999]) {
    const plan = validatePlan(graph, [
      { action: "give_item", item_name: "Coal", count, commit: true },
    ]);
    assert.equal(plan.valid, false, `expected count ${count} to be refused`);
  }
});

test("an uncommitted give stays a dry run", () => {
  const plan = validatePlan(graph, [
    { action: "give_item", item_name: "Coal", count: 10, commit: false },
  ]);
  assert.equal(plan.valid, true);
  assert.equal(plan.actions[0].commit, false);
});

test("the phrasing the player actually used is answered locally, so it costs nothing", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("insert biomass into my inventory", graph, services);

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "give_item");
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].item_class, /Desc_GenericBiomass_C$/);
  assert.equal(emitted[0].count, 1);
  assert.equal(emitted[0].expect_world_revision, "77");
});

test("reads the count out of the phrasings people use", () => {
  assert.deepEqual(parseGiveRequest("give me 50 iron plate"), { item: "iron plate", count: 50 });
  assert.deepEqual(parseGiveRequest("put 5 x cable in my inventory"), { item: "cable", count: 5 });
  assert.deepEqual(parseGiveRequest("spawn 20 coal"), { item: "coal", count: 20 });

  // A second clause means something else was asked too.
  assert.equal(parseGiveRequest("give me iron plate and build a smelter"), null);
});

test("an unknown item falls through to the model rather than being denied locally", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("give me 5 unobtanium", graph, services);
  assert.notEqual(answer?.local?.solver, "give_item");
  assert.equal(emitted.length, 0);
});
