import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { validateAction } from "../lib/actions.mjs";
import { planEnclosedFactory } from "../lib/base-build.mjs";
import { planStructure, planTower } from "../lib/architecture.mjs";
import { measureBuilding } from "../lib/designer.mjs";
import {
  attachAimedGeneratedBlueprintSource,
  resolveAimedGeneratedBlueprintSource,
} from "../lib/generated-resource-source.mjs";
import { compileGeneratedBlueprint } from "../lib/generated-blueprints.mjs";
import { answerLocally, parseBaseDesignRequest } from "../lib/router.mjs";
import { measureConnectors } from "../lib/routing.mjs";
import { solveProductionPlan } from "../lib/solvers.mjs";
import {
  BELT_ORE,
  MINER,
  ORE_NODE,
  buildFactorySnapshot,
} from "./fixtures/factory.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const MINER_CLASS = "/Game/FactoryGame/Buildable/Factory/MinerMk1.Build_MinerMk1_C";
const SMELTER_CLASS = "/Game/FactoryGame/Buildable/Factory/SmelterMk1.Build_SmelterMk1_C";
const BELT_CLASS = "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1.Build_ConveyorBeltMk1_C";
const SPLITTER_CLASS =
  "/Game/FactoryGame/Buildable/Factory/Splitter/Build_ConveyorAttachmentSplitter.Build_ConveyorAttachmentSplitter_C";
const POWER_CIRCUIT = "/Script/FactoryGame.FGPowerCircuit";

function powerConnector(maxLinks) {
  return {
    component_name: "PowerConnection",
    component_class_path: "/Script/FactoryGame.FGPowerConnectionComponent",
    hidden: false,
    max_links: maxLinks,
    circuit_type_class_path: POWER_CIRCUIT,
    native_default_location_cm: { x: 0, y: 0, z: 200 },
  };
}

function nativeFactoryPort(name, direction, location, normal) {
  return {
    component_name: name,
    component_class_path: "/Script/FactoryGame.FGFactoryConnectionComponent",
    direction,
    connector_clearance_cm: 0,
    native_default_location_cm: location,
    native_default_normal: normal,
  };
}

function sourceGraph() {
  const snapshot = buildFactorySnapshot();
  snapshot.actors.find((actor) => actor.actor_id === MINER).bounds = {
    origin: { x: 0, y: 0, z: 200 },
    extent: { x: 500, y: 500, z: 200 },
  };
  snapshot.actors.find((actor) => actor.class_path === SMELTER_CLASS).bounds = {
    origin: { x: 800, y: 0, z: 200 },
    extent: { x: 500, y: 500, z: 200 },
  };
  snapshot.content.items.push(
    {
      class_path: "Desc_AIFactoryBlueprintResourceAnchor",
      name: "Blueprint Resource Anchor",
      owner_mod: "AIFactoryCopilot",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: "/AIFactoryCopilot/Build_AIFactoryBlueprintResourceAnchor_C",
        native_topology_kind: "blueprint_resource_anchor",
        supports_generated_solid_resource_configuration: true,
        native_factory_connections: [],
      },
    },
    {
      class_path: "Desc_MinerMk1",
      name: "Miner Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: MINER_CLASS,
        native_topology_kind: "resource_extractor",
        supports_generated_blueprint_resource_anchor: true,
        native_circuit_connections: [powerConnector(1)],
        native_factory_connections: [
          nativeFactoryPort(
            "OutputConnection0",
            "FCD_OUTPUT",
            { x: 600, y: 0, z: 100 },
            { x: 1, y: 0, z: 0 },
          ),
        ],
      },
    },
    {
      class_path: "Desc_SmelterMk1",
      name: "Smelter",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: SMELTER_CLASS,
        native_circuit_connections: [powerConnector(1)],
        native_factory_connections: [
          nativeFactoryPort(
            "InputConnection0",
            "FCD_INPUT",
            { x: -500, y: 0, z: 100 },
            { x: -1, y: 0, z: 0 },
          ),
          nativeFactoryPort(
            "OutputConnection0",
            "FCD_OUTPUT",
            { x: 500, y: 0, z: 100 },
            { x: 1, y: 0, z: 0 },
          ),
        ],
      },
    },
    {
      class_path: "Desc_ConveyorBeltMk1",
      name: "Conveyor Belt Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: { class_path: BELT_CLASS },
    },
    {
      class_path: "Desc_ConveyorAttachmentSplitter",
      name: "Conveyor Splitter",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: SPLITTER_CLASS,
        native_factory_connections: [
          nativeFactoryPort(
            "Input0",
            "FCD_INPUT",
            { x: -100, y: 0, z: 100 },
            { x: -1, y: 0, z: 0 },
          ),
          nativeFactoryPort(
            "Output0",
            "FCD_OUTPUT",
            { x: 100, y: -100, z: 100 },
            { x: 1, y: 0, z: 0 },
          ),
          nativeFactoryPort(
            "Output1",
            "FCD_OUTPUT",
            { x: 100, y: 0, z: 100 },
            { x: 1, y: 0, z: 0 },
          ),
          nativeFactoryPort(
            "Output2",
            "FCD_OUTPUT",
            { x: 100, y: 100, z: 100 },
            { x: 1, y: 0, z: 0 },
          ),
        ],
      },
    },
    {
      class_path: "Desc_PowerLine",
      name: "Power Line",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: "Build_PowerLine_C",
        native_topology_kind: "power_wire",
        wire_max_length_cm: 10_000,
        native_circuit_connections: [],
      },
    },
    {
      class_path: "Desc_PowerPoleMk1",
      name: "Power Pole Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: {
        class_path: "Build_PowerPoleMk1_C",
        native_topology_kind: "power_pole",
        power_pole_type: "PPT_POLE",
        native_circuit_connections: [powerConnector(4)],
      },
    },
  );
  snapshot.content.recipes.push(
    {
      class_path: "Recipe_AIFactoryBlueprintResourceAnchor",
      name: "Blueprint Resource Anchor",
      owner_mod: "AIFactoryCopilot",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_AIFactoryBlueprintResourceAnchor", amount: 1 }],
      produced_in: [BUILD_GUN],
    },
    {
      class_path: "Recipe_MinerMk1",
      name: "Miner Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_MinerMk1", amount: 1 }],
      produced_in: [BUILD_GUN],
      building_stats: { items_per_minute_at_normal_purity: 60 },
    },
    {
      class_path: "Recipe_ConveyorBeltMk1",
      name: "Conveyor Belt Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_ConveyorBeltMk1", amount: 1 }],
      produced_in: [BUILD_GUN],
    },
    {
      class_path: "Recipe_ConveyorAttachmentSplitter",
      name: "Conveyor Splitter",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_ConveyorAttachmentSplitter", amount: 1 }],
      produced_in: [BUILD_GUN],
    },
    {
      class_path: "Recipe_PowerLine",
      name: "Power Line",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_PowerLine", amount: 1 }],
      produced_in: [BUILD_GUN],
    },
    {
      class_path: "Recipe_PowerPoleMk1",
      name: "Power Pole Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_PowerPoleMk1", amount: 1 }],
      produced_in: [BUILD_GUN],
    },
  );
  const smelterBuild = snapshot.content.recipes.find(
    (recipe) => recipe.class_path === "Recipe_SmelterMk1",
  );
  smelterBuild.products = [{ item_class: "Desc_SmelterMk1", amount: 1 }];
  smelterBuild.produced_in = [BUILD_GUN];
  snapshot.content.recipes.find(
    (recipe) => recipe.class_path === "Recipe_IngotIron",
  ).produced_in = [
    "/Game/FactoryGame/Buildable/Factory/Build_SmelterMk1.Build_SmelterMk1_C",
  ];
  for (const [recipeClass, itemClass, name, buildClass] of [
    ["Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)", "Build_Foundation_8x1_01_C"],
    ["Recipe_Wall_8x4_01", "Desc_Wall_8x4_01", "Basic Wall (4 m)", "Build_Wall_8x4_01_C"],
    ["Recipe_Roof_8x1_01", "Desc_Roof_8x1_01", "Flat Roof (1 m)", "Build_Roof_8x1_01_C"],
  ]) {
    snapshot.content.items.push({
      class_path: itemClass,
      name,
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      building: { class_path: buildClass },
    });
    snapshot.content.recipes.push({
      class_path: recipeClass,
      name,
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: itemClass, amount: 1 }],
      produced_in: [BUILD_GUN],
    });
  }
  for (const beltActor of snapshot.actors.filter(
    (actor) => actor.transport?.kind === "conveyor" && /ConveyorBeltMk1/i.test(actor.class_path),
  )) {
    beltActor.class_path = BELT_CLASS;
    beltActor.transport.reported_speed = 120;
  }
  snapshot.actors.push({
    actor_id: "Build_ConveyorAttachmentSplitter_C_1",
    name: "Build_ConveyorAttachmentSplitter_C_1",
    class_path: SPLITTER_CLASS,
    owner_mod: "FactoryGame",
    kind: "buildable",
    location: { x: 10_000, y: 10_000, z: 0 },
    rotation: { pitch: 0, yaw: 0, roll: 0 },
    bounds: {
      origin: { x: 10_000, y: 10_000, z: 100 },
      extent: { x: 150, y: 150, z: 100 },
    },
    connections: [],
    inventories: [],
  });
  return buildGraph(snapshot);
}

const target = {
  resolved: true,
  actor_id: "BP_ResourceNode213",
  on: "BP_ResourceNode213",
  node_type: "Node",
  resource_class: "Desc_OreIron",
  resource_name: "Iron Ore",
  purity: "RP_Pure",
};

function oneMachineActions() {
  return [
    {
      action: "place_building",
      recipe_class: "Recipe_Foundation",
      location: { x: 0, y: 0, z: 0 },
      yaw: 0,
      generated_role: "floor",
      commit: true,
    },
    {
      action: "place_building",
      recipe_class: "Recipe_Wall",
      location: { x: 800, y: -400, z: 100 },
      yaw: 0,
      generated_role: "wall",
      commit: true,
    },
    {
      action: "place_building",
      recipe_class: "Recipe_SmelterMk1",
      production_recipe_class: "Recipe_IngotIron",
      location: { x: 800, y: 800, z: 100 },
      yaw: 0,
      generated_role: "machine",
      commit: true,
    },
  ];
}

const production = {
  planned: true,
  raw_inputs_required: [{
    item_class: "Desc_OreIron",
    item_name: "Iron Ore",
    display_units_per_minute: 30,
  }],
  steps: [{
    recipe_class: "Recipe_IngotIron",
    machines_required: 1,
    machines_exact: 1,
  }],
};

const shell = {
  grid: { cell_size_cm: 800 },
  footprint: {
    origin_cm: { x: 0, y: 0, z: 0 },
    width_cm: 2_400,
    depth_cm: 2_400,
  },
};

test("resolves exact aimed solid resource, native purity, unlocked Anchor and lowest supported Miner", () => {
  const source = resolveAimedGeneratedBlueprintSource(sourceGraph(), { target });
  assert.equal(source.resolved, true, JSON.stringify(source));
  assert.equal(source.resource_class, "Desc_OreIron");
  assert.equal(source.native_purity, "RP_Pure");
  assert.equal(source.anchor_recipe_class, "Recipe_AIFactoryBlueprintResourceAnchor");
  assert.equal(source.miner_recipe_class, "Recipe_MinerMk1");
  assert.equal(source.miner_tier, 1);
  assert.equal(source.available_rate_per_minute, 120);
  assert.equal(source.miner_output.name, "OutputConnection0");
});

test("adds one collision-clear Anchor/Miner pair and one exact straight input belt", () => {
  const graph = sourceGraph();
  const source = resolveAimedGeneratedBlueprintSource(graph, { target });
  const attached = attachAimedGeneratedBlueprintSource(
    graph,
    oneMachineActions(),
    source,
    {
      production_plan: production,
      shell,
      belt_recipe_class: "Recipe_ConveyorBeltMk1",
    },
  );
  assert.equal(attached.attached, true, JSON.stringify(attached));
  assert.equal(attached.removed_front_wall, true);
  assert.equal(attached.actions.filter((action) => action.generated_role === "resource_anchor").length, 1);
  assert.equal(attached.actions.filter((action) => action.generated_role === "miner").length, 1);
  assert.equal(attached.actions.filter((action) => action.action === "place_belt").length, 1);
  const miner = attached.actions.find((action) => action.generated_role === "miner");
  const anchor = attached.actions.find((action) => action.generated_role === "resource_anchor");
  const belt = attached.actions.find((action) => action.action === "place_belt");
  assert.deepEqual(miner.location, anchor.location);
  assert.ok(miner.location.y + source.miner_collision_radius_cm < -400);
  assert.equal(belt.from_step, attached.miner_step);
  assert.equal(belt.to_step, attached.consumer_steps[0]);
  assert.equal(belt.from_connector_name, "OutputConnection0");
  assert.equal(belt.to_connector_name, "InputConnection0");
  assert.deepEqual(attached.connector_evidence, {
    miner_output: "OutputConnection0",
    source_destination_input: "InputConnection0",
    consumer_inputs: [],
    splitter_outputs: [],
    from_alignment: 1,
    to_alignment: -1,
  });

  const compiled = compileGeneratedBlueprint({
    blueprint_name: "AI Pure Iron Ingot 30pm",
    schema: "aifactory.generated-blueprint/v4",
    actions: attached.actions,
  });
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  assert.equal(compiled.counts.resource_anchors, 1);
  assert.equal(compiled.counts.miners, 1);
  assert.equal(compiled.counts.conveyors, 1);
});

test("uses one measured regular splitter and unique native outputs for identical consumers", () => {
  const graph = sourceGraph();
  const source = resolveAimedGeneratedBlueprintSource(graph, { target });
  const twoMachines = [
    ...oneMachineActions(),
    {
      ...oneMachineActions().at(-1),
      location: { x: 1_600, y: 800, z: 100 },
    },
  ];
  const production60 = {
    planned: true,
    raw_inputs_required: [{
      item_class: "Desc_OreIron",
      item_name: "Iron Ore",
      display_units_per_minute: 60,
    }],
    steps: [{
      recipe_class: "Recipe_IngotIron",
      machines_required: 2,
      machines_exact: 2,
    }],
  };
  const fanOut = attachAimedGeneratedBlueprintSource(graph, twoMachines, source, {
    production_plan: production60,
    shell,
    belt_recipe_class: "Recipe_ConveyorBeltMk1",
  });
  assert.equal(fanOut.attached, true, JSON.stringify(fanOut));
  assert.equal(fanOut.fan_out.consumers, 2);
  assert.equal(fanOut.fan_out.outputs_available, 3);
  assert.equal(fanOut.actions.filter((action) => action.recipe_class ===
    "Recipe_ConveyorAttachmentSplitter").length, 1);
  const belts = fanOut.actions.filter((action) => action.action === "place_belt");
  assert.equal(belts.length, 3);
  assert.equal(belts[0].from_step, fanOut.miner_step);
  assert.equal(belts[0].to_step, fanOut.splitter_step);
  assert.equal(belts[0].to_connector_name, "Input0");
  assert.equal(new Set(belts.slice(1).map((belt) => belt.from_connector_name)).size, 2);
  assert.deepEqual(
    new Set(belts.slice(1).map((belt) => belt.to_step)),
    new Set(fanOut.consumer_steps),
  );

  const compiled = compileGeneratedBlueprint({
    blueprint_name: "AI Pure Iron Ingot 60pm",
    schema: "aifactory.generated-blueprint/v4",
    actions: fanOut.actions,
  });
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  assert.equal(compiled.counts.conveyors, 3);
});

test("refuses source-rate and partial-machine fan-out overclaims", () => {
  const graph = sourceGraph();
  const source = resolveAimedGeneratedBlueprintSource(graph, { target });
  const tooFast = attachAimedGeneratedBlueprintSource(graph, oneMachineActions(), source, {
    production_plan: {
      planned: true,
      raw_inputs_required: [{ item_class: "Desc_OreIron", display_units_per_minute: 121 }],
      steps: [{ recipe_class: "Recipe_IngotIron", machines_required: 1, machines_exact: 1 }],
    },
    shell,
    belt_recipe_class: "Recipe_ConveyorBeltMk1",
  });
  assert.equal(tooFast.attached, false);
  assert.match(tooFast.reason, /cannot supply/);

  const twoMachines = [
    ...oneMachineActions(),
    { ...oneMachineActions().at(-1), location: { x: 1_600, y: 800, z: 100 } },
  ];
  const partial = attachAimedGeneratedBlueprintSource(graph, twoMachines, source, {
    production_plan: {
      planned: true,
      raw_inputs_required: [{ item_class: "Desc_OreIron", display_units_per_minute: 45 }],
      steps: [{ recipe_class: "Recipe_IngotIron", machines_required: 2, machines_exact: 1.5 }],
    },
    shell,
    belt_recipe_class: "Recipe_ConveyorBeltMk1",
  });
  assert.equal(partial.attached, false);
  assert.match(partial.reason, /fully utilized identical machines/);
});

test("node-sourced Blueprint wording is explicit in the parsed request", () => {
  const parsed = parseBaseDesignRequest(
    "create a blueprint that makes 30 iron ingot per minute from this node using Miner Mk.1",
  );
  assert.equal(parsed?.as_blueprint, true);
  assert.equal(parsed?.from_aimed_node, true);
  assert.equal(parsed?.miner_tier, 1);
  assert.equal(parsed?.per_minute, 30);
});

test("the local route emits one complete v4 file proposal with no live node actor id", () => {
  const graph = sourceGraph();
  const aimed = graph.nodes.get(ORE_NODE).raw;
  graph.snapshot.interaction_context.preferred_target = {
    available: true,
    selected_from: "aim_trace",
    actor_id: ORE_NODE,
    actor_name: aimed.name,
    actor_snapshot: aimed,
  };
  const planned = solveProductionPlan(graph, {
    item_class: "Desc_IronIngot",
    target_rate_per_minute: 30,
    use_existing_surplus: false,
    prefer_standard_recipes: true,
    stop_at_item_classes: ["Desc_OreIron"],
  });
  assert.equal(planned.planned, true, JSON.stringify(planned));
  const enclosed = planEnclosedFactory(graph, {
    production_plan: planned,
    measure_building: measureBuilding,
    measure_connectors: measureConnectors,
    plan_structure: planStructure,
    plan_tower: planTower,
  });
  assert.equal(enclosed.planned, true, JSON.stringify(enclosed));
  const emitted = [];
  const answer = answerLocally(
    "create a blueprint that makes 30 iron ingot per minute from this node using Miner Mk.1",
    graph,
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );
  assert.equal(answer?.local?.solver, "generate_native_blueprint", JSON.stringify(answer));
  assert.equal(emitted.length, 1, JSON.stringify(emitted));
  const action = emitted[0];
  assert.equal(action.action, "generate_native_blueprint");
  assert.equal(action.layout_schema, "aifactory.generated-blueprint/v4");
  assert.equal(action.buildables.filter((part) => part.role === "resource_anchor").length, 1);
  assert.equal(action.buildables.filter((part) => part.role === "miner").length, 1);
  assert.equal(action.conveyors.length, 1);
  assert.ok(action.power_wires.length >= 1);
  assert.equal(JSON.stringify(action).includes(ORE_NODE), false);
  assert.match(answer.reply, /Resource Anchor/);
  assert.match(answer.reply, /destination alignment remains the vanilla Build Gun's decision/i);
});

test("the local route emits a native regular-splitter fan-out for 60 Iron Ingots per minute", () => {
  const graph = sourceGraph();
  const aimed = graph.nodes.get(ORE_NODE).raw;
  graph.snapshot.interaction_context.preferred_target = {
    available: true,
    selected_from: "aim_trace",
    actor_id: ORE_NODE,
    actor_name: aimed.name,
    actor_snapshot: aimed,
  };
  const emitted = [];
  const answer = answerLocally(
    "create a blueprint that makes 60 iron ingot per minute from this node using Miner Mk.1",
    graph,
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );
  assert.equal(answer?.local?.solver, "generate_native_blueprint", JSON.stringify(answer));
  assert.equal(emitted.length, 1, JSON.stringify(emitted));
  const action = emitted[0];
  assert.equal(action.layout_schema, "aifactory.generated-blueprint/v4");
  assert.equal(action.buildables.filter((part) => part.role === "resource_anchor").length, 1);
  assert.equal(action.buildables.filter((part) => part.role === "miner").length, 1);
  assert.equal(action.buildables.filter((part) => part.recipe_class ===
    "Recipe_ConveyorAttachmentSplitter").length, 1);
  assert.equal(action.buildables.filter((part) => part.production_recipe_class ===
    "Recipe_IngotIron").length, 2);
  assert.equal(action.conveyors.length, 3);
  assert.equal(new Set(action.conveyors.slice(1).map((belt) => belt.from_connector_name)).size, 2);
  assert.equal(JSON.stringify(action).includes(ORE_NODE), false);
  assert.match(answer.reply, /3 planned belt leg/i);

  const revalidated = validateAction(graph, action);
  assert.equal(revalidated.valid, true, JSON.stringify(revalidated));
  assert.equal(revalidated.checks.captured_factory_connector_checked_endpoints, 6);

  const duplicateOutput = structuredClone(action);
  duplicateOutput.conveyors[2].from_connector_name =
    duplicateOutput.conveyors[1].from_connector_name;
  const duplicateResult = validateAction(graph, duplicateOutput);
  assert.equal(duplicateResult.valid, false);
  assert.equal(duplicateResult.reason, "generated_conveyor_connector_is_used_more_than_once");

  const wrongDirection = structuredClone(action);
  wrongDirection.conveyors[0].to_connector_name = "Output0";
  const directionResult = validateAction(graph, wrongDirection);
  assert.equal(directionResult.valid, false);
  assert.equal(
    directionResult.reason,
    "generated_conveyor_endpoint_needs_one_exact_captured_connector",
  );
});

test("the scanner captures native factory connector defaults from exact class CDOs", () => {
  const sourcePath = path.resolve(
    "..",
    "Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp",
  );
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  assert.match(sourceText, /native_factory_connections/);
  assert.match(sourceText, /native_factory_connection_count/);
  assert.match(sourceText, /Connection->GetDirection\(\)/);
  assert.match(sourceText, /Connection->GetConnectorNormal\(\)/);
});
