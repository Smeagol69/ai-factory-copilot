import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { planAimedMk1WireFactory } from "../lib/resource-factory.mjs";
import { answerLocally } from "../lib/router.mjs";
import { solveBuildRecipeLookup } from "../lib/solvers.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const COPPER = "Desc_OreCopper_C";
const INGOT = "Desc_CopperIngot_C";
const IRON = "Desc_OreIron_C";
const IRON_INGOT = "Desc_IronIngot_C";
const WIRE = "Desc_Wire_C";

const buildRecipe = (key, descriptor, name, extra = {}) => ({
  class_path: key,
  name,
  owner_mod: "FactoryGame",
  available: true,
  produced_in: [BUILD_GUN],
  products: [{ item_class: descriptor, item_name: name, amount: 1 }],
  ...extra,
});

function graphOf(mutator = null) {
  const recipes = [
    {
      class_path: "Recipe_IngotCopper_C",
      name: "Copper Ingot",
      owner_mod: "FactoryGame",
      available: true,
      duration_seconds: 2,
      ingredients: [{ item_class: COPPER, item_name: "Copper Ore", amount: 1 }],
      products: [{ item_class: INGOT, item_name: "Copper Ingot", amount: 1 }],
      produced_in: ["/Game/Build_SmelterMk1.Build_SmelterMk1_C"],
    },
    {
      class_path: "Recipe_Wire_C",
      name: "Wire",
      owner_mod: "FactoryGame",
      available: true,
      duration_seconds: 4,
      ingredients: [{ item_class: INGOT, item_name: "Copper Ingot", amount: 1 }],
      products: [{ item_class: WIRE, item_name: "Wire", amount: 2 }],
      produced_in: ["/Game/Build_ConstructorMk1.Build_ConstructorMk1_C"],
    },
    {
      class_path: "Recipe_IngotIron_C",
      name: "Iron Ingot",
      owner_mod: "FactoryGame",
      available: true,
      duration_seconds: 2,
      ingredients: [{ item_class: IRON, item_name: "Iron Ore", amount: 1 }],
      products: [{ item_class: IRON_INGOT, item_name: "Iron Ingot", amount: 1 }],
      produced_in: ["/Game/Build_SmelterMk1.Build_SmelterMk1_C"],
    },
    {
      class_path: "Recipe_IronWire_C",
      name: "Alternate: Iron Wire",
      owner_mod: "FactoryGame",
      available: true,
      duration_seconds: 24,
      ingredients: [{ item_class: IRON_INGOT, item_name: "Iron Ingot", amount: 5 }],
      products: [{ item_class: WIRE, item_name: "Wire", amount: 9 }],
      produced_in: ["/Game/Build_ConstructorMk1.Build_ConstructorMk1_C"],
    },
    // Faster unlocked alternates are traps: "all Mk.1" must stay on the
    // standard Copper chain.
    {
      class_path: "Recipe_Alternate_Wire_C",
      name: "Alternate: Caterium Wire",
      owner_mod: "FactoryGame",
      available: true,
      duration_seconds: 1,
      ingredients: [{ item_class: "Desc_CateriumIngot_C", item_name: "Caterium Ingot", amount: 1 }],
      products: [{ item_class: WIRE, item_name: "Wire", amount: 9 }],
      produced_in: ["/Game/Build_ConstructorMk1.Build_ConstructorMk1_C"],
    },
    buildRecipe("Recipe_MinerMk1_C", "Desc_MinerMk1_C", "Miner Mk.1", {
      building_stats: {
        extractor_type_name: "Miner",
        items_per_minute_at_normal_purity: 60,
      },
    }),
    buildRecipe("Recipe_SmelterBasicMk1_C", "Desc_SmelterMk1_C", "Smelter"),
    buildRecipe("Recipe_ConstructorMk1_C", "Desc_ConstructorMk1_C", "Constructor"),
    buildRecipe("Recipe_ConveyorBeltMk1_C", "Desc_ConveyorBeltMk1_C", "Conveyor Belt Mk.1"),
    buildRecipe("Recipe_ConveyorBeltMk2_C", "Desc_ConveyorBeltMk2_C", "Conveyor Belt Mk.2"),
    buildRecipe("Recipe_ConveyorSplitter_C", "Desc_ConveyorSplitter_C", "Conveyor Splitter"),
    buildRecipe("Recipe_ConveyorMerger_C", "Desc_ConveyorMerger_C", "Conveyor Merger"),
    buildRecipe("Recipe_StorageContainerMk1_C", "Desc_StorageContainerMk1_C", "Storage Container"),
    buildRecipe(
      "/Game/FactoryGame/Buildable/Building/Foundation/Recipe_Foundation_8x1_01.Recipe_Foundation_8x1_01_C",
      "Desc_Foundation_8x1_01_C",
      "Foundation (1 m)",
    ),
  ];
  const snapshot = {
    world_revision: 727,
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 355_996.7, y: -148_976.6, z: 4_563.9 } },
    },
    actors: [
      {
        actor_id: "Belt_Mk1_Evidence",
        name: "Build_ConveyorBeltMk1_C_1",
        class_path: "/Game/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        transport: { kind: "conveyor", reported_speed: 120, item_spacing_cm: 120 },
        connections: [],
        inventories: [],
      },
    ],
    content: {
      availability_known: true,
      items: [
        { class_path: COPPER, name: "Copper Ore", form: "RF_SOLID" },
        { class_path: INGOT, name: "Copper Ingot", form: "RF_SOLID" },
        { class_path: IRON, name: "Iron Ore", form: "RF_SOLID" },
        { class_path: IRON_INGOT, name: "Iron Ingot", form: "RF_SOLID" },
        { class_path: WIRE, name: "Wire", form: "RF_SOLID" },
        { class_path: "Desc_CateriumIngot_C", name: "Caterium Ingot", form: "RF_SOLID" },
      ],
      recipes,
    },
  };
  if (typeof mutator === "function") mutator(snapshot);
  return buildGraph(snapshot);
}

const target = {
  resolved: true,
  actor_id: "BP_ResourceNode213",
  on: "BP_ResourceNode213",
  location: { x: 355_461.7, y: -149_808.1, z: 4_214.5 },
  node_type: "Node",
  occupied: false,
  purity: "RP_Pure",
  resource_class: COPPER,
  resource_name: "Copper Ore",
};
const item = { class_path: WIRE, name: "Wire" };

test("Pure Copper is capped by observed Mk.1 transport and uses standard recipes", () => {
  const plan = planAimedMk1WireFactory(graphOf(), {
    target,
    item,
    build_recipe_lookup: solveBuildRecipeLookup,
  });
  assert.equal(plan.planned, true, plan.reason);
  assert.equal(plan.extracted_per_minute, 120);
  assert.equal(plan.belt_capacity_per_minute, 60);
  assert.equal(plan.line_input_per_minute, 60);
  assert.equal(plan.output_per_minute, 120);
  assert.equal(plan.node_utilisation_percent, 50);
  assert.equal(plan.smelters, 2);
  assert.equal(plan.constructors, 4);
  assert.equal(plan.foundations, 14);
  assert.equal(plan.production.covered_by_existing_surplus.length, 0);

  const belts = plan.actions.filter((action) => action.action === "place_belt");
  assert.equal(belts.length, 17);
  assert.ok(belts.every((action) => action.recipe_class === "Recipe_ConveyorBeltMk1_C"));
  const configured = plan.actions.filter((action) => action.production_recipe_class);
  assert.equal(configured.filter((action) => action.production_recipe_class === "Recipe_IngotCopper_C").length, 2);
  assert.equal(configured.filter((action) => action.production_recipe_class === "Recipe_Wire_C").length, 4);
  assert.equal(plan.actions[0].target_actor_id, target.actor_id);
  const foundationSteps = new Set(plan.actions
    .map((action, index) => ({ action, step: index + 1 }))
    .filter(({ action }) => /Recipe_Foundation_8x1_01/i.test(action.recipe_class ?? ""))
    .map(({ step }) => step));
  const supportedPlacements = plan.actions.filter((action) => action.target_step !== undefined);
  assert.equal(supportedPlacements.length, 14);
  assert.ok(supportedPlacements.every((action) => foundationSteps.has(action.target_step)));
  assert.ok(supportedPlacements.every((action) => action.target_step < plan.actions.indexOf(action) + 1));
  assert.ok(plan.actions.every((action) => action.commit === true));
  assert.match(plan.notes.join(" "), /Power is not wired/);
});

test("the supported factory grows away from the captured player", () => {
  const graph = graphOf();
  const plan = planAimedMk1WireFactory(graph, {
    target,
    item,
    build_recipe_lookup: solveBuildRecipeLookup,
  });
  assert.equal(plan.planned, true, plan.reason);

  const player = graph.snapshot.interaction_context.player.pawn_location;
  const distanceToPlayer = (location) => Math.hypot(
    Number(location.x) - Number(player.x),
    Number(location.y) - Number(player.y),
  );
  const nodeDistance = distanceToPlayer(target.location);
  const foundations = plan.actions.filter((action) =>
    /Recipe_Foundation_8x1_01/i.test(action.recipe_class ?? ""),
  );
  assert.equal(foundations.length, 14);
  assert.ok(
    foundations.every((action) => distanceToPlayer(action.location) > nodeDistance),
    "no support may be placed between the captured player and the aimed node",
  );
});

test("the complete fan-out never asks one machine port for two belts", () => {
  const plan = planAimedMk1WireFactory(graphOf(), {
    target,
    item,
    build_recipe_lookup: solveBuildRecipeLookup,
  });
  const belts = plan.actions.filter((action) => action.action === "place_belt");
  const fromCounts = new Map();
  for (const belt of belts) {
    fromCounts.set(belt.from_step, (fromCounts.get(belt.from_step) ?? 0) + 1);
  }
  const splitterSteps = new Set(plan.actions
    .map((action, index) => ({ action, step: index + 1 }))
    .filter(({ action }) => action.action === "place_building" && /Splitter/i.test(action.recipe_class))
    .map(({ step }) => step));
  // Only splitters legitimately have several output connections.
  for (const [step, count] of fromCounts) {
    if (count > 1) assert.ok(splitterSteps.has(step), `step ${step} reuses one-output machinery`);
  }
  const singleInputConsumers = plan.actions
    .map((action, index) => ({ action, step: index + 1 }))
    .filter(({ action }) =>
      action.action === "place_building" &&
      /(Smelter|Constructor|Storage)/i.test(action.recipe_class))
    .map(({ step }) => step);
  for (const consumer of singleInputConsumers) {
    assert.equal(belts.filter((belt) => belt.to_step === consumer).length, 1);
  }
});

test("an Iron node selects the unlocked Iron Wire chain and sizes its partial last constructor", () => {
  const plan = planAimedMk1WireFactory(graphOf(), {
    target: {
      ...target,
      actor_id: "BP_ResourceNodeIron",
      on: "BP_ResourceNodeIron",
      resource_class: IRON,
      resource_name: "Iron Ore",
    },
    item,
    build_recipe_lookup: solveBuildRecipeLookup,
  });
  assert.equal(plan.planned, true, plan.reason);
  assert.equal(plan.recipe, "Alternate: Iron Wire");
  assert.equal(plan.output_per_minute, 108);
  assert.equal(plan.smelters, 2);
  assert.equal(plan.constructors, 5);
  assert.equal(plan.last_constructor_utilisation_percent, 96);
  assert.equal(plan.storage_lanes, 3);
  assert.equal(plan.foundations, 17);
  assert.equal(plan.actions.length, 55);
  assert.equal(plan.actions.filter((action) => action.action === "place_belt").length, 20);
  assert.equal(
    plan.actions.filter((action) => action.production_recipe_class === "Recipe_IronWire_C").length,
    5,
  );
});

test("missing authoritative evidence refuses instead of guessing", () => {
  const cases = [
    { name: "target", graph: graphOf(), target: null, pattern: /aimed target/ },
    {
      name: "purity",
      graph: graphOf(),
      target: { ...target, purity: null },
      pattern: /normal rate or this node's purity/,
    },
    {
      name: "belt evidence",
      graph: graphOf((snapshot) => { snapshot.actors = []; }),
      target,
      pattern: /captured Mk\.1 belt/,
    },
    {
      name: "occupied",
      graph: graphOf(),
      target: { ...target, occupied: true },
      pattern: /already occupied/,
    },
  ];
  for (const entry of cases) {
    const plan = planAimedMk1WireFactory(entry.graph, {
      target: entry.target,
      item,
      build_recipe_lookup: solveBuildRecipeLookup,
    });
    assert.equal(plan.planned, false, entry.name);
    assert.match(plan.reason, entry.pattern, entry.name);
    assert.equal(plan.actions, undefined, entry.name);
  }
});

test("a locked standard recipe does not silently switch to an alternate", () => {
  const graph = graphOf((snapshot) => {
    snapshot.content.recipes.find((recipe) => recipe.class_path === "Recipe_Wire_C").available = false;
  });
  const plan = planAimedMk1WireFactory(graph, {
    target,
    item,
    build_recipe_lookup: solveBuildRecipeLookup,
  });
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /complete dependency chain rooted only in the aimed node/);
});

test("the owner's exact command stays local and revision-stamps the whole write", () => {
  const graph = graphOf((snapshot) => {
    snapshot.interaction_context.preferred_target = {
      available: true,
      selected_from: "aim_trace",
      actor_id: target.actor_id,
      actor_name: target.on,
      actor_snapshot: {
        actor_id: target.actor_id,
        name: target.on,
        kind: "resource_node",
        location: target.location,
        node_type: target.node_type,
        occupied: target.occupied,
        purity: target.purity,
        resource_class: target.resource_class,
        resource_name: target.resource_name,
      },
    };
  });
  let emitted = [];
  const answer = answerLocally(
    "build a wire factory using all mk1 parts on this node",
    graph,
    { actions: { emit: (actions) => { emitted = actions; } } },
  );
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "aimed_mk1_wire_factory");
  assert.match(answer.reply, /120 Wire\/min/);
  assert.match(answer.reply, /Power is not wired/);
  assert.equal(emitted.length, 46);
  assert.ok(emitted.every((action) => action.expect_world_revision === "727"));
});
