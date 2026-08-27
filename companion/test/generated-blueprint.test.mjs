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
  assert.equal(compiled.schema, "aifactory.generated-blueprint/v1");
  assert.deepEqual(compiled.origin_cm, { x: 12_000, y: -4_000, z: 800 });
  assert.deepEqual(compiled.buildables.map((part) => part.relative_location), [
    { x: 0, y: 0, z: 0 },
    { x: 2_000, y: 0, z: 0 },
  ]);
  assert.equal(compiled.buildables[0].recipe_class, "Recipe_SmelterMk1");
  assert.equal(compiled.buildables[0].production_recipe_class, "Recipe_IngotIron");
  assert.equal(compiled.buildables[0].role, "machine");
});

test("the compiler refuses topology it cannot yet serialize instead of dropping it", () => {
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "No Silent Belt Loss",
    actions: [
      { action: "place_building", recipe_class: "Recipe_SmelterMk1", location: { x: 0, y: 0, z: 0 } },
      { action: "place_belt", recipe_class: "Recipe_ConveyorBeltMk1", from_step: 1, to_step: 2 },
    ],
  });
  assert.equal(compiled.compiled, false);
  assert.equal(compiled.reason, "generated_blueprint_v1_accepts_only_standalone_buildings");
  assert.deepEqual(compiled.unsupported, [{ step: 2, action: "place_belt" }]);
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
  assert.match(answer.reply, /not generated/i);
});

test("the model action schema exposes generated relative buildables", () => {
  const tool = SOLVER_TOOLS.find((entry) => entry.name === "perform_actions");
  const item = tool.parameters.properties.actions.items;
  assert.ok(item.properties.action.enum.includes("generate_native_blueprint"));
  assert.deepEqual(item.properties.layout_schema.enum, ["aifactory.generated-blueprint/v1"]);
  assert.deepEqual(
    item.properties.buildables.items.required,
    ["part_id", "recipe_class", "relative_location", "yaw"],
  );
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
  const staging = source.indexOf("class FScopedGeneratedBuildables");
  const setDesigner = source.indexOf("SetInsideBlueprintDesigner(Designer)", staging);
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
  assert.ok(save > staging && readback > save);
  assert.ok(actions.includes('Kind == TEXT("generate_native_blueprint")'));
  assert.ok(actions.includes("native_blueprint_file_write_must_be_a_standalone_commit"));
});
