/**
 * Coal power, from a node to a row of burning generators.
 *
 * The request behind this — "im switching to coal power i want something step 1
 * to end compact from this node" — matched no local route, escalated to a paid
 * model, and failed on billing sixty-two seconds later. Before that the local
 * model had offered to process coal into Iron Ingot, Limestone or Copper Ore,
 * none of which are coal products.
 *
 * The tests that matter here are the ones about what the planner refuses to
 * invent, and the one about port counts: a miner has a single output, and a
 * plan that belts it to four generators is refused three times by the game.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { planCoalPower, sizeGeneratorsForNode } from "../lib/power.mjs";
import { solveBuildRecipeLookup } from "../lib/solvers.mjs";
import { findBestAvailableBelt } from "../lib/base-build.mjs";
import { parseCoalPowerRequest } from "../lib/router.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const recipe = (className, descriptor, name) => ({
  class_path: `/Game/Recipes/${className}.${className}_C`,
  name,
  available: true,
  produced_in: [BUILD_GUN],
  products: [{ item_class: `/Game/Desc/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 }],
});

const FULL_KIT = [
  recipe("Recipe_MinerMk1", "Desc_MinerMk1", "Miner Mk1"),
  recipe("Recipe_MinerMk2", "Desc_MinerMk2", "Miner Mk2"),
  recipe("Recipe_GeneratorCoal", "Desc_GeneratorCoal", "Coal Generator"),
  recipe("Recipe_ConveyorBeltMk2", "Desc_ConveyorBeltMk2", "Conveyor Belt Mk.2"),
  recipe("Recipe_ConveyorAttachmentSplitter", "Desc_ConveyorAttachmentSplitter", "Conveyor Splitter"),
];

const NODE = {
  actor_id: "BP_ResourceNode618",
  kind: "resource_node",
  name: "BP_ResourceNode618",
  node_type: "Node",
  occupied: false,
  location: { x: 367_000, y: -139_000, z: 5_500 },
};

const graphWith = (recipes) =>
  buildGraph({
    world_revision: 1_669,
    world: { scan_center: NODE.location },
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 367_168, y: -139_192, z: 5_564 } },
    },
    actors: [NODE],
    content: { items: [], recipes },
  });

const target = { resolved: true, ...NODE, on: NODE.name };

const plan = (options = {}) => {
  const graph = graphWith(options.recipes ?? FULL_KIT);
  return planCoalPower(graph, {
    node: options.node ?? target,
    generator_count: "count" in options ? options.count : 4,
    build_recipe_lookup: solveBuildRecipeLookup,
    belt: findBestAvailableBelt(graph),
    cell_size_cm: 800,
  });
};

test("a miner's single output is split, not belted four ways", () => {
  const result = plan({ count: 4 });
  assert.equal(result.planned, true);

  const belts = result.actions.filter((action) => action.action === "place_belt");
  const fromMiner = belts.filter((action) => action.from_step === 1);
  // The whole point. A miner has one output port; the game refuses the rest.
  assert.equal(fromMiner.length, 1, "exactly one belt may leave the miner");

  // Every splitter takes one belt in and sends two out.
  assert.equal(result.splitter_count, 3);
  const outgoing = new Map();
  for (const belt of belts) outgoing.set(belt.from_step, (outgoing.get(belt.from_step) ?? 0) + 1);
  for (const [step, count] of outgoing) {
    if (step === 1) continue;
    assert.ok(count <= 2, `step ${step} sends ${count} belts; a splitter has two spare ports`);
  }

  // Every generator is fed exactly once.
  const fed = belts.map((belt) => belt.to_step).filter((step) => step >= 2 && step <= 5);
  assert.deepEqual([...new Set(fed)].sort(), [2, 3, 4, 5]);
});

test("a single generator needs no splitter", () => {
  const result = plan({ count: 1 });
  assert.equal(result.planned, true);
  assert.equal(result.splitter_count, 0);
  const belts = result.actions.filter((action) => action.action === "place_belt");
  assert.equal(belts.length, 1);
  assert.deepEqual([belts[0].from_step, belts[0].to_step], [1, 2]);
});

test("step references only ever point backwards", () => {
  // The mod resolves a belt against actors earlier in the same transaction. A
  // forward reference names something that does not exist yet.
  const result = plan({ count: 5 });
  const actions = result.actions;
  for (const [index, action] of actions.entries()) {
    if (action.action !== "place_belt") continue;
    assert.ok(action.from_step <= index, "from_step must precede the belt");
    assert.ok(action.to_step <= index, "to_step must precede the belt");
    assert.ok(action.from_step >= 1 && action.to_step >= 1, "steps are 1-based");
  }
});

test("the plant is not sized by guessing a burn rate", () => {
  // A snapshot without building_stats cannot say what a generator burns.
  // Inventing 15/min would be the exact habit this project exists to break, so
  // it asks instead. FULL_KIT deliberately carries no stats.
  const result = plan({ count: null });
  assert.equal(result.planned, false);
  assert.equal(result.reason, "how many generators?");
  assert.match(result.why_unknown, /not in this snapshot/i);
});

test("water is reported missing rather than quietly skipped", () => {
  // A plant that looks finished and never spins up is worse than one that says
  // what it did not do.
  const result = plan({ count: 2 });
  assert.equal(result.planned, true);
  assert.match(result.missing.water, /water/i);
  assert.match(result.missing.water, /pipe/i);
});

test("what the save has not unlocked is refused by name", () => {
  const noGenerator = FULL_KIT.filter((entry) => !entry.name.includes("Coal Generator"));
  assert.match(plan({ count: 2, recipes: noGenerator }).reason, /coal generator/i);

  const noSplitter = FULL_KIT.filter((entry) => !entry.name.includes("Splitter"));
  assert.match(plan({ count: 3, recipes: noSplitter }).reason, /splitter/i);

  const noBelt = FULL_KIT.filter((entry) => !entry.name.includes("Conveyor Belt"));
  assert.match(plan({ count: 2, recipes: noBelt }).reason, /belt/i);
});

test("a deposit or an occupied node is refused before anything is placed", () => {
  const deposit = plan({ count: 2, node: { ...target, node_type: "Deposit" } });
  assert.equal(deposit.planned, false);
  assert.match(deposit.reason, /deposit/i);

  const taken = plan({ count: 2, node: { ...target, occupied: true } });
  assert.equal(taken.planned, false);
  assert.match(taken.reason, /already has something/i);
});

test("the request routes on how it was actually typed", () => {
  const asked = parseCoalPowerRequest(
    "im switching to coal power i want  something step 1 to end compact from this node",
  );
  assert.ok(asked);
  assert.equal(asked.generator_count, null);

  assert.equal(parseCoalPowerRequest("coal power here with 4 generators").generator_count, 4);
  assert.equal(parseCoalPowerRequest("set up 6 coal generators from this node").generator_count, 6);

  // Questions about coal power are not requests to build one.
  for (const question of [
    "how much power does a coal generator make",
    "what is a coal generator",
    "does a coal generator need water",
  ]) {
    assert.equal(parseCoalPowerRequest(question), null, `should not build: ${question}`);
  }
});

test("the miner names the node it sits on, not just a coordinate", () => {
  // A miner placed on BP_ResourceNode213 was refused with
  // hologram_disqualified:FGCDInitializing. The mod traces downward for a build
  // surface and the trace struck StaticMeshActor_8276 -- the terrain mesh
  // beside the node. The hologram was positioned correctly and bound to a rock,
  // so it never finished initialising. A trace finds a surface, not a target.
  const result = plan({ count: 2 });
  const miner = result.actions.find((action) =>
    String(action.recipe_class).includes("Miner"),
  );
  assert.ok(miner);
  assert.equal(miner.target_actor_id, NODE.actor_id);
});

test("a node with no actor id places without one rather than sending an empty string", () => {
  // Absent stays absent: the mod treats an empty target as "use the trace",
  // and an empty string would instead be a lookup that fails.
  const { actor_id: _dropped, ...anonymous } = NODE;
  const result = plan({ count: 1, node: { resolved: true, ...anonymous, on: NODE.name } });
  const miner = result.actions.find((action) =>
    String(action.recipe_class).includes("Miner"),
  );
  assert.ok(miner);
  assert.equal("target_actor_id" in miner, false);
});

/* ---------------- sizing the plant from the save ---------------- */

// The owner's objection: it knows the node purity and the tech tier, so it
// should not have to ask how many generators. Once the mod reports
// building_stats it does not. These are real Satisfactory numbers, but none of
// them is written down in the source -- they are derived from the class data
// the snapshot now carries, which is what keeps them right for modded
// generators too.
const COAL_CLASS = "/Game/Desc/Desc_Coal.Desc_Coal_C";
const MINER_MK1 = "/Game/Recipes/Recipe_MinerMk1.Recipe_MinerMk1_C";
const COAL_GENERATOR = "/Game/Recipes/Recipe_GeneratorCoal.Recipe_GeneratorCoal_C";

const withStats = (className, descriptor, name, buildingStats) => ({
  ...recipe(className, descriptor, name),
  building_stats: buildingStats,
});

const STATTED_KIT = [
  withStats("Recipe_MinerMk1", "Desc_MinerMk1", "Miner Mk.1", {
    extracted_items_per_cycle: 1,
    extract_cycle_seconds: 1,
    items_per_minute_at_normal_purity: 60,
  }),
  withStats("Recipe_GeneratorCoal", "Desc_GeneratorCoal", "Coal-Powered Generator", {
    power_production_mw: 75,
    requires_supplemental_resource: true,
    supplemental_resource_class: "/Game/Desc/Desc_Water.Desc_Water_C",
    fuels: [
      {
        item_class: COAL_CLASS,
        item_name: "Coal",
        energy_mj_per_item: 300,
        items_per_minute_at_full_load: 15,
      },
    ],
  }),
  recipe("Recipe_ConveyorBeltMk2", "Desc_ConveyorBeltMk2", "Conveyor Belt Mk.2"),
  recipe("Recipe_ConveyorAttachmentSplitter", "Desc_ConveyorAttachmentSplitter", "Conveyor Splitter"),
];

const sizedGraph = () =>
  buildGraph({
    world_revision: 1,
    world: { scan_center: NODE.location },
    interaction_context: {
      player: { pawn_available: true, pawn_location: NODE.location },
    },
    actors: [NODE],
    content: { items: [], recipes: STATTED_KIT },
  });

test("purity decides the plant size, and the save supplies the rates", () => {
  const graph = sizedGraph();
  const sizeFor = (purity) =>
    sizeGeneratorsForNode(graph, {
      miner: { recipe_class: MINER_MK1 },
      generator: { recipe_class: COAL_GENERATOR },
      purity,
      fuel_item_class: COAL_CLASS,
    });

  // 60/min mined, 15/min burned. Doubling and halving with purity.
  assert.equal(sizeFor("Impure").count, 2);
  assert.equal(sizeFor("Normal").count, 4);
  assert.equal(sizeFor("Pure").count, 8);
  assert.equal(sizeFor("Normal").power_mw, 300);
  // Nothing left stranded on the belt at normal purity.
  assert.equal(sizeFor("Normal").leftover_per_minute, 0);
});

test("a sized node no longer asks how many generators", () => {
  const graph = sizedGraph();
  const result = planCoalPower(graph, {
    node: { resolved: true, ...NODE, purity: "Normal", resource_class: COAL_CLASS, on: NODE.name },
    generator_count: null,
    build_recipe_lookup: solveBuildRecipeLookup,
    belt: findBestAvailableBelt(graph),
    cell_size_cm: 800,
  });
  assert.equal(result.planned, true);
  assert.equal(result.generator_count, 4);
  assert.equal(result.splitter_count, 3);
  assert.equal(result.sizing.purity_multiplier, 1);
});

test("an explicit count still wins over the derived one", () => {
  // The player asked for two. Working out that four fit is not permission to
  // build four.
  const graph = sizedGraph();
  const result = planCoalPower(graph, {
    node: { resolved: true, ...NODE, purity: "Normal", resource_class: COAL_CLASS, on: NODE.name },
    generator_count: 2,
    build_recipe_lookup: solveBuildRecipeLookup,
    belt: findBestAvailableBelt(graph),
    cell_size_cm: 800,
  });
  assert.equal(result.generator_count, 2);
  assert.equal(result.sizing, null);
});

test("without building_stats it goes back to asking rather than guessing", () => {
  assert.equal(plan({ count: null }).planned, false);
  assert.equal(
    sizeGeneratorsForNode(graphWith(FULL_KIT), {
      miner: { recipe_class: MINER_MK1 },
      generator: { recipe_class: COAL_GENERATOR },
      purity: "Normal",
      fuel_item_class: COAL_CLASS,
    }),
    null,
  );
});
