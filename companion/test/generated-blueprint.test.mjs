import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateAction, validatePlan, WRITE_ACTION_KINDS } from "../lib/actions.mjs";
import {
  compileGeneratedBlueprint,
  generatedBlueprintAction,
} from "../lib/generated-blueprints.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { answerLocally, parseBaseDesignRequest } from "../lib/router.mjs";
import { SOLVER_TOOLS } from "../lib/tools.mjs";
import { solveProductionPlan } from "../lib/solvers.mjs";
import { planEnclosedFactory } from "../lib/base-build.mjs";
import { planStructure, planTower } from "../lib/architecture.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

function compiledFactory() {
  return compileGeneratedBlueprint({
    blueprint_name: "AI Iron Ingot Test",
    actions: [
      {
        action: "place_building",
        recipe_class: "Recipe_SmelterMk1",
        production_recipe_class: "Recipe_IngotIron",
        location: { x: 12_000, y: -4_000, z: 800 },
        yaw: 90,
        generated_role: "machine",
      },
      {
        action: "place_building",
        recipe_class: "Recipe_SmelterMk1",
        production_recipe_class: "Recipe_IngotIron",
        location: { x: 14_000, y: -4_000, z: 800 },
        yaw: 90,
        generated_role: "machine",
      },
    ],
  });
}

test("a deterministic placement plan compiles to exact Blueprint-relative geometry", () => {
  const compiled = compiledFactory();
  assert.equal(compiled.compiled, true, compiled.reason);
  assert.equal(compiled.schema, "aifactory.generated-blueprint/v2");
  assert.deepEqual(compiled.origin_cm, { x: 12_000, y: -4_000, z: 800 });
  assert.deepEqual(compiled.buildables.map((part) => part.relative_location), [
    { x: 0, y: 0, z: 0 },
    { x: 2_000, y: 0, z: 0 },
  ]);
  assert.equal(compiled.buildables[0].recipe_class, "Recipe_SmelterMk1");
  assert.equal(compiled.buildables[0].production_recipe_class, "Recipe_IngotIron");
  assert.equal(compiled.buildables[0].role, "machine");
});

test("v1 keeps refusing topology instead of silently dropping it", () => {
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "No Silent Belt Loss",
    schema: "aifactory.generated-blueprint/v1",
    actions: [
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 0, y: 0, z: 0 } },
      { action: "place_belt", recipe_class: "Recipe_ConveyorBeltMk1", from_step: 1, to_step: 2 },
    ],
  });
  assert.equal(compiled.compiled, false);
  assert.equal(compiled.reason, "generated_blueprint_v1_accepts_only_standalone_buildings");
  assert.deepEqual(compiled.unsupported, [{ step: 2, action: "place_belt" }]);
});

test("v2 compiles directed belts and physical power wires to generated part ids", () => {
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "Native Topology",
    actions: [
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 0, y: 0, z: 0 } },
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 2_000, y: 0, z: 0 } },
      { action: "place_belt", recipe_class: "Recipe_ConveyorBeltMk1", from_step: 1, to_step: 2 },
    ],
    power_connections: [
      { recipe_class: "Recipe_PowerLine", from_step: 1, to_step: 2 },
    ],
  });
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  assert.equal(compiled.schema, "aifactory.generated-blueprint/v2");
  assert.deepEqual(compiled.conveyors, [{
    link_id: "conveyor-0001",
    recipe_class: "Recipe_ConveyorBeltMk1",
    from_part_id: "part-0001",
    to_part_id: "part-0002",
  }]);
  assert.deepEqual(compiled.power_wires, [{
    link_id: "power_wire-0001",
    recipe_class: "Recipe_PowerLine",
    from_part_id: "part-0001",
    to_part_id: "part-0002",
  }]);
});

test("v3 compiles an explicit straight native pipeline without weakening v2", () => {
  const args = {
    blueprint_name: "Native Fluid Topology",
    actions: [
      { action: "place_building", recipe_class: "Recipe_WaterExtractor", location: { x: 0, y: 0, z: 0 } },
      { action: "place_building", recipe_class: "Recipe_CoalGenerator", location: { x: 2_000, y: 0, z: 0 } },
    ],
    pipeline_connections: [{
      recipe_class: "Recipe_PipelineMk1",
      from_step: 1,
      to_step: 2,
      from_connector_name: "PipeOutput",
      to_connector_name: "PipeInput",
    }],
  };
  const refusedV2 = compileGeneratedBlueprint(args);
  assert.equal(refusedV2.compiled, false);
  assert.equal(refusedV2.reason, "generated_blueprint_v2_cannot_carry_pipelines");

  const compiled = compileGeneratedBlueprint({
    ...args,
    schema: "aifactory.generated-blueprint/v3",
  });
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  assert.deepEqual(compiled.pipelines, [{
    link_id: "pipeline-0001",
    recipe_class: "Recipe_PipelineMk1",
    from_part_id: "part-0001",
    to_part_id: "part-0002",
    from_connector_name: "PipeOutput",
    to_connector_name: "PipeInput",
  }]);
  assert.equal(compiled.counts.pipelines, 1);
  assert.equal(compiled.topology.pipes, "1_explicit_straight_native_links");
  assert.deepEqual(generatedBlueprintAction(compiled).pipelines, compiled.pipelines);
});

function generatedResourceAnchorFixture() {
  const snapshot = buildFactorySnapshot();
  const buildGun = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
  snapshot.content.items.push(
    {
      class_path: "Desc_AIFactoryBlueprintResourceAnchor",
      name: "Blueprint Resource Anchor",
      owner_mod: "AIFactoryCopilot",
      available: true,
      form: "RF_SOLID",
      stack_size: 1,
      building: {
        class_path: "/AIFactoryCopilot/Buildables/Build_AIFactoryBlueprintResourceAnchor.Build_AIFactoryBlueprintResourceAnchor_C",
        native_topology_kind: "blueprint_resource_anchor",
        supports_generated_solid_resource_configuration: true,
      },
    },
    {
      class_path: "Desc_MinerMk1",
      name: "Miner Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      form: "RF_SOLID",
      stack_size: 1,
      building: {
        class_path: "/Game/FactoryGame/Buildable/Factory/MinerMk1.Build_MinerMk1_C",
        native_topology_kind: "resource_extractor",
        supports_generated_blueprint_resource_anchor: true,
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
      products: [{
        item_class: "Desc_AIFactoryBlueprintResourceAnchor",
        item_name: "Blueprint Resource Anchor",
        amount: 1,
      }],
      produced_in: [buildGun],
    },
    {
      class_path: "Recipe_MinerMk1",
      name: "Miner Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: "Desc_MinerMk1", item_name: "Miner Mk.1", amount: 1 }],
      produced_in: [buildGun],
    },
  );
  snapshot.content.available_item_count = (snapshot.content.available_item_count ?? 0) + 2;
  snapshot.content.available_recipe_count += 2;
  return snapshot;
}

function compiledResourceAnchorBlueprint() {
  return compileGeneratedBlueprint({
    blueprint_name: "AI Anchored Iron Miner",
    schema: "aifactory.generated-blueprint/v4",
    actions: [
      {
        action: "place_building",
        recipe_class: "Recipe_AIFactoryBlueprintResourceAnchor",
        location: { x: 40_000, y: -12_000, z: 1_000 },
        yaw: 0,
        generated_role: "resource_anchor",
        resource_class: "Desc_OreIron",
        resource_purity: "RP_Normal",
      },
      {
        action: "place_building",
        recipe_class: "Recipe_MinerMk1",
        location: { x: 40_000, y: -12_000, z: 1_000 },
        yaw: 0,
        generated_role: "miner",
        target_step: 1,
      },
    ],
  });
}

test("v4 compiles and validates one exact solid-resource Anchor to vanilla Miner binding", () => {
  const compiled = compiledResourceAnchorBlueprint();
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  assert.equal(compiled.counts.resource_anchors, 1);
  assert.equal(compiled.counts.miners, 1);
  assert.equal(compiled.buildables[0].resource_class, "Desc_OreIron");
  assert.equal(compiled.buildables[0].resource_purity, "RP_Normal");
  assert.equal(compiled.buildables[1].resource_anchor_part_id, "part-0001");
  assert.equal(compiled.topology.miners_and_resource_anchors, "1_explicit_one_to_one_native_bindings");

  const result = validateAction(
    buildGraph(generatedResourceAnchorFixture()),
    generatedBlueprintAction(compiled, { commit: true }),
  );
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.action.layout_schema, "aifactory.generated-blueprint/v4");
  assert.equal(result.action.buildables[0].resource_class, "Desc_OreIron");
  assert.equal(result.action.buildables[1].resource_anchor_part_id, "part-0001");
  assert.equal(result.checks.resource_anchors, 1);
  assert.equal(result.checks.miners, 1);
  assert.equal(result.checks.exact_anchor_miner_bindings, 1);
});

test("v4 refuses orphan, duplicate, fluid, and uncaptured extractor relationships", () => {
  const orphan = compileGeneratedBlueprint({
    blueprint_name: "Orphan Anchor",
    schema: "aifactory.generated-blueprint/v4",
    actions: [{
      action: "place_building",
      recipe_class: "Recipe_AIFactoryBlueprintResourceAnchor",
      location: { x: 0, y: 0, z: 0 },
      generated_role: "resource_anchor",
      resource_class: "Desc_OreIron",
      resource_purity: "RP_Pure",
    }],
  });
  assert.equal(orphan.compiled, false);
  assert.equal(orphan.reason, "generated_resource_anchors_require_one_to_one_miner_bindings");

  const duplicate = compileGeneratedBlueprint({
    blueprint_name: "Duplicate Miner Binding",
    schema: "aifactory.generated-blueprint/v4",
    actions: [
      {
        action: "place_building",
        recipe_class: "Recipe_AIFactoryBlueprintResourceAnchor",
        location: { x: 0, y: 0, z: 0 },
        generated_role: "resource_anchor",
        resource_class: "Desc_OreIron",
        resource_purity: "RP_Normal",
      },
      { action: "place_building", recipe_class: "Recipe_MinerMk1", location: { x: 0, y: 0, z: 0 }, generated_role: "miner", target_step: 1 },
      { action: "place_building", recipe_class: "Recipe_MinerMk1", location: { x: 0, y: 0, z: 0 }, generated_role: "miner", target_step: 1 },
    ],
  });
  assert.equal(duplicate.compiled, false);
  assert.equal(duplicate.reason, "generated_resource_anchor_can_bind_only_one_miner");

  const proposal = generatedBlueprintAction(compiledResourceAnchorBlueprint(), { commit: true });
  const fluid = structuredClone(proposal);
  fluid.buildables[0].resource_class = "Desc_LiquidOil";
  const fluidResult = validateAction(buildGraph(generatedResourceAnchorFixture()), fluid);
  assert.equal(fluidResult.valid, false);
  assert.equal(fluidResult.reason, "generated_resource_anchor_resource_must_be_solid");

  const uncaptured = generatedResourceAnchorFixture();
  uncaptured.content.items.find((item) => item.class_path === "Desc_MinerMk1")
    .building.supports_generated_blueprint_resource_anchor = false;
  const uncapturedResult = validateAction(buildGraph(uncaptured), proposal);
  assert.equal(uncapturedResult.valid, false);
  assert.equal(uncapturedResult.reason, "generated_miner_recipe_lacks_captured_native_capability");
});

test("generated native Blueprint validation requires captured unlock truth for every recipe", () => {
  const graph = buildGraph(buildFactorySnapshot());
  const proposal = generatedBlueprintAction(compiledFactory(), { commit: true });
  const result = validateAction(graph, proposal);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.action.action, "generate_native_blueprint");
  assert.equal(result.action.expect_world_revision, "41");
  assert.equal(result.action.buildables.length, 2);
  assert.equal(result.checks.authoritative_unlock_capture, true);
  assert.equal(result.checks.native_internal_collision_readback, "game_side_required");
  assert.ok(WRITE_ACTION_KINDS.includes("generate_native_blueprint"));

  const missingUnlockTruth = buildFactorySnapshot();
  missingUnlockTruth.content.availability_known = false;
  const refused = validateAction(buildGraph(missingUnlockTruth), proposal);
  assert.equal(refused.valid, false);
  assert.equal(refused.reason, "generated_blueprint_requires_authoritative_recipe_unlock_capture");
});

test("v2 topology recipes and endpoint references are revalidated from captured unlock truth", () => {
  const snapshot = buildFactorySnapshot();
  const buildGun = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
  snapshot.content.recipes.push(
    {
      class_path: "Recipe_ConveyorBeltMk1",
      name: "Conveyor Belt Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      products: [{ item_class: "Desc_ConveyorBeltMk1", item_name: "Conveyor Belt Mk.1", amount: 1 }],
      ingredients: [],
      produced_in: [buildGun],
    },
    {
      class_path: "Recipe_PowerLine",
      name: "Power Line",
      owner_mod: "FactoryGame",
      available: true,
      products: [{ item_class: "Desc_PowerLine", item_name: "Power Line", amount: 1 }],
      ingredients: [],
      produced_in: [buildGun],
    },
  );
  snapshot.content.available_recipe_count += 2;
  const graph = buildGraph(snapshot);
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "Topology Validation",
    actions: [
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 0, y: 0, z: 0 } },
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 2_000, y: 0, z: 0 } },
      { action: "place_belt", recipe_class: "Recipe_ConveyorBeltMk1", from_step: 1, to_step: 2 },
    ],
    power_connections: [{ recipe_class: "Recipe_PowerLine", from_step: 1, to_step: 2 }],
  });
  const result = validateAction(graph, generatedBlueprintAction(compiled, { commit: true }));
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.action.conveyors.length, 1);
  assert.equal(result.action.power_wires.length, 1);
  assert.equal(
    result.checks.native_topology_readback,
    "isolated_blueprint_world_exact_reciprocal_endpoints_required",
  );

  const wrongType = structuredClone(generatedBlueprintAction(compiled, { commit: true }));
  wrongType.conveyors[0].recipe_class = "Recipe_PowerLine";
  const refused = validateAction(graph, wrongType);
  assert.equal(refused.valid, false);
  assert.equal(refused.reason, "generated_topology_recipe_has_wrong_product_type");
});

test("v3 resolves captured native producer and consumer pipe ports exactly", () => {
  const snapshot = buildFactorySnapshot();
  const buildGun = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
  const descriptor = (classPath, name, connection, type, extra = {}) => ({
    class_path: classPath,
    name,
    owner_mod: "FactoryGame",
    available: true,
    form: "RF_SOLID",
    stack_size: 50,
    building: {
      class_path: `Build_${name.replace(/\s+/g, "")}`,
      native_circuit_connections: [],
      native_pipe_connections: [{
        component_name: connection,
        component_class_path: "/Script/FactoryGame.FGPipeConnectionComponent",
        pipe_connection_type: type,
        connector_clearance_cm: 100,
        native_default_location_cm: {
          x: type === "PCT_PRODUCER" ? 100 : -100,
          y: 0,
          z: 100,
        },
        native_default_normal: { x: type === "PCT_PRODUCER" ? 1 : -1, y: 0, z: 0 },
      }],
      ...extra,
    },
  });
  snapshot.content.items.push(
    descriptor("Desc_WaterExtractor", "Water Extractor", "PipeOutput", "PCT_PRODUCER"),
    descriptor("Desc_CoalGenerator", "Coal Generator", "PipeInput", "PCT_CONSUMER"),
    descriptor("Desc_PipelineMk1", "Pipeline Mk.1", "", "PCT_ANY", {
      native_topology_kind: "pipeline",
      pipeline_min_length_cm: 200,
      pipeline_max_length_cm: 5600.1,
      pipeline_flow_limit_m3_s: 5,
    }),
  );
  snapshot.content.recipes.push(
    ...[
      ["Recipe_WaterExtractor", "Desc_WaterExtractor", "Water Extractor"],
      ["Recipe_CoalGenerator", "Desc_CoalGenerator", "Coal Generator"],
      ["Recipe_PipelineMk1", "Desc_PipelineMk1", "Pipeline Mk.1"],
    ].map(([classPath, itemClass, name]) => ({
      class_path: classPath,
      name,
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: itemClass, item_name: name, amount: 1 }],
      produced_in: [buildGun],
    })),
  );
  snapshot.content.available_item_count += 3;
  snapshot.content.available_recipe_count += 3;
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "Validated Native Fluid Topology",
    schema: "aifactory.generated-blueprint/v3",
    actions: [
      { action: "place_building", recipe_class: "Recipe_WaterExtractor", location: { x: 0, y: 0, z: 0 } },
      { action: "place_building", recipe_class: "Recipe_CoalGenerator", location: { x: 2_000, y: 0, z: 0 } },
    ],
    pipeline_connections: [{ recipe_class: "Recipe_PipelineMk1", from_step: 1, to_step: 2 }],
  });
  const result = validateAction(
    buildGraph(snapshot),
    generatedBlueprintAction(compiled, { commit: true }),
  );
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.action.pipelines.length, 1);
  assert.equal(result.action.pipelines[0].from_connector_name, "PipeOutput");
  assert.equal(result.action.pipelines[0].to_connector_name, "PipeInput");
  assert.equal(result.checks.captured_pipe_connector_checked_endpoints, 2);
  assert.equal(result.checks.captured_pipe_length_checked_links, 1);

  const reused = structuredClone(generatedBlueprintAction(compiled, { commit: true }));
  reused.pipelines.push({ ...reused.pipelines[0], link_id: "pipeline-0002" });
  const refused = validateAction(buildGraph(snapshot), reused);
  assert.equal(refused.valid, false);
  assert.equal(refused.reason, "generated_topology_edge_is_duplicated");

  const overlengthCompiled = compileGeneratedBlueprint({
    blueprint_name: "Overlength Native Fluid Topology",
    schema: "aifactory.generated-blueprint/v3",
    actions: [
      { action: "place_building", recipe_class: "Recipe_WaterExtractor", location: { x: 0, y: 0, z: 0 } },
      { action: "place_building", recipe_class: "Recipe_CoalGenerator", location: { x: 10_000, y: 0, z: 0 } },
    ],
    pipeline_connections: [{ recipe_class: "Recipe_PipelineMk1", from_step: 1, to_step: 2 }],
  });
  const overlength = validateAction(
    buildGraph(snapshot),
    generatedBlueprintAction(overlengthCompiled, { commit: true }),
  );
  assert.equal(overlength.valid, false);
  assert.equal(overlength.reason, "generated_pipeline_exceeds_captured_native_length_limits");
});

test("generated Blueprint files are standalone committed writes", () => {
  const graph = buildGraph(buildFactorySnapshot());
  const proposal = generatedBlueprintAction(compiledFactory(), { commit: true });
  const mixed = validatePlan(graph, [
    proposal,
    { action: "waypoint", name: "also mutate", location: { x: 0, y: 0, z: 0 }, commit: true },
  ]);
  assert.equal(mixed.valid, false);
  assert.equal(mixed.reason, "native_blueprint_export_must_be_a_standalone_commit");
});

test("natural factory-Blueprint wording reaches the generated path", () => {
  const parsed = parseBaseDesignRequest(
    "create a blueprint that makes 60 iron ingot per minute",
  );
  assert.equal(parsed?.item, "iron ingot");
  assert.equal(parsed?.per_minute, 60);
  assert.equal(parsed?.commit, true);
  assert.equal(parsed?.as_blueprint, true);
});

test("the local production route emits one native Blueprint file action, not world placements", () => {
  const snapshot = buildFactorySnapshot();
  const buildGun = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
  const structural = [
    ["Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)"],
    ["Recipe_Wall_8x4_01", "Desc_Wall_8x4_01", "Basic Wall (4 m)"],
    ["Recipe_Roof_8x1_01", "Desc_Roof_8x1_01", "Flat Roof (1 m)"],
  ].map(([recipe, descriptor, name]) => ({
    class_path: `/Game/Test/${recipe}.${recipe}_C`,
    name,
    owner_mod: "FactoryGame",
    available: true,
    ingredients: [],
    products: [{ item_class: `/Game/Test/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 }],
    produced_in: [buildGun],
  }));
  snapshot.content.recipes.push(...structural);
  snapshot.content.recipes.push({
    class_path: "Recipe_ConvertIronOre",
    name: "Iron Ore (Limestone)",
    owner_mod: "FactoryGame",
    available: true,
    duration_seconds: 6,
    ingredients: [{ item_class: "Desc_Stone", item_name: "Limestone", amount: 24 }],
    products: [{ item_class: "Desc_OreIron", item_name: "Iron Ore", amount: 12 }],
    produced_in: ["Build_Converter_C"],
  });
  snapshot.content.available_recipe_count += structural.length + 1;
  snapshot.content.recipes.find((recipe) => recipe.class_path === "Recipe_IngotIron").produced_in = [
    "/Game/FactoryGame/Buildable/Factory/Build_SmelterMk1.Build_SmelterMk1_C",
  ];

  const graph = buildGraph(snapshot);
  const production = solveProductionPlan(graph, {
    item_class: "Desc_IronIngot",
    target_rate_per_minute: 30,
  });
  assert.equal(production.planned, true, JSON.stringify(production));
  const enclosed = planEnclosedFactory(graph, {
    production_plan: production,
    plan_structure: planStructure,
    plan_tower: planTower,
  });
  assert.equal(enclosed.planned, true, JSON.stringify({ enclosed, step: production.steps?.[0] }));
  const emitted = [];
  const answer = answerLocally(
    "create a blueprint that makes 30 iron ingot per minute",
    graph,
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );

  assert.equal(answer?.local?.solver, "generate_native_blueprint", JSON.stringify(answer));
  assert.equal(emitted.length, 1, JSON.stringify(emitted));
  assert.equal(emitted[0].action, "generate_native_blueprint");
  assert.equal(emitted[0].commit, true);
  assert.ok(emitted[0].buildables.length > 1);
  assert.ok(emitted[0].buildables.some((part) => part.role === "floor"));
  assert.ok(emitted[0].buildables.some((part) => part.role === "machine"));
  const machines = emitted[0].buildables.filter((part) => part.role === "machine");
  assert.equal(machines.length, 1, JSON.stringify(machines));
  assert.equal(machines[0].production_recipe_class, "Recipe_IngotIron");
  assert.equal(
    emitted[0].buildables.some((part) => part.production_recipe_class === "Recipe_ConvertIronOre"),
    false,
  );
  assert.equal(emitted.some((action) => action.action === "place_building"), false);
  assert.match(answer.reply, /vanilla Build Gun/i);
  assert.match(answer.reply, /Straight planned belts are included/i);
});

test("the model action schema exposes generated relative buildables", () => {
  const tool = SOLVER_TOOLS.find((entry) => entry.name === "perform_actions");
  const item = tool.parameters.properties.actions.items;
  assert.ok(item.properties.action.enum.includes("generate_native_blueprint"));
  assert.deepEqual(item.properties.layout_schema.enum, [
    "aifactory.generated-blueprint/v1",
    "aifactory.generated-blueprint/v2",
    "aifactory.generated-blueprint/v3",
    "aifactory.generated-blueprint/v4",
  ]);
  assert.ok(item.properties.buildables.items.properties.role.enum.includes("resource_anchor"));
  assert.ok(item.properties.buildables.items.properties.role.enum.includes("miner"));
  assert.deepEqual(item.properties.buildables.items.properties.resource_purity.enum, [
    "RP_Inpure", "RP_Normal", "RP_Pure",
  ]);
  assert.deepEqual(
    item.properties.buildables.items.required,
    ["part_id", "recipe_class", "relative_location", "yaw"],
  );
  assert.deepEqual(item.properties.conveyors.items.required, [
    "link_id", "recipe_class", "from_part_id", "to_part_id",
  ]);
  assert.deepEqual(item.properties.power_wires.items.required, [
    "link_id", "recipe_class", "from_part_id", "to_part_id",
  ]);
  assert.deepEqual(item.properties.pipelines.items.required, [
    "link_id", "recipe_class", "from_part_id", "to_part_id",
  ]);
});

test("the game-side generator keeps staging transient, construction-time, bounded, and native", () => {
  const source = readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp", import.meta.url),
    "utf8",
  );
  const actions = readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp", import.meta.url),
    "utf8",
  );
  const snapshot = readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp", import.meta.url),
    "utf8",
  );
  const staging = source.indexOf("class FScopedGeneratedBuildables");
  const setDesigner = source.indexOf("SetInsideBlueprintDesigner(StagingDesigner)", staging);
  const finishSpawning = source.indexOf("FinishSpawning(WorldTransform)", staging);
  const destroy = source.indexOf("Buildable->Destroy()", staging);
  const save = source.indexOf("Designer->SaveBlueprint(Record, Controller)", staging);
  const readback = source.indexOf("ReadBlueprintFromDisc(BlueprintName)", save);

  assert.ok(staging >= 0);
  assert.ok(source.indexOf("Params.ObjectFlags |= RF_Transient", staging) > staging);
  assert.ok(setDesigner > staging && finishSpawning > setDesigner);
  assert.ok(destroy > finishSpawning);
  assert.ok(source.includes("ValidateGeneratedInternalBounds"));
  assert.ok(source.includes("Execute_GetClearanceData(Buildable, ClearanceData)"));
  assert.ok(source.includes("Clearance.GetTransformedClearanceBox()"));
  assert.ok(source.includes("GetComponentsBoundingBox(false, true)"));
  assert.ok(source.includes("GetComponentsBoundingBox(true, true)"));
  assert.ok(source.includes("native_clearance_data"));
  assert.ok(source.includes("generated_buildable_needs_an_unimplemented_native_topology"));
  assert.ok(source.includes("StageConveyor"));
  assert.ok(source.includes("StagePowerWire"));
  assert.ok(source.includes("StagePipeline"));
  assert.ok(source.includes("AFGPipelineHologram::MINIMUM_HOLOGRAM_LENGTH"));
  assert.ok(source.includes("mMaxSplineLength"));
  assert.ok(source.includes("native_blueprint_pipeline_topology_readback_mismatch"));
  assert.ok(source.includes("BindGeneratedMiner"));
  assert.ok(source.includes("HasRecordedBoundExtractor"));
  assert.ok(source.includes("native_blueprint_resource_anchor_topology_readback_mismatch"));
  assert.ok(source.includes("native_loaded_exact_anchor_configurations"));
  assert.ok(snapshot.includes("native_pipe_connections"));
  assert.ok(snapshot.includes("supports_generated_blueprint_resource_anchor"));
  assert.ok(snapshot.includes("supports_generated_solid_resource_configuration"));
  assert.ok(snapshot.includes("GetPipeConnectionType()"));
  assert.ok(snapshot.includes("pipeline_flow_limit_m3_s"));
  assert.ok(snapshot.includes("native_pipeline_hologram_cdo_property"));
  assert.ok(source.includes("ValidateGeneratedNativeTopologyReadback"));
  assert.ok(source.includes("LoadStoredBlueprint"));
  assert.ok(source.includes("exact_native_topology_readback"));
  assert.ok(save > staging && readback > save);
  assert.ok(actions.includes('Kind == TEXT("generate_native_blueprint")'));
  assert.ok(actions.includes("native_blueprint_file_write_must_be_a_standalone_commit"));
});
