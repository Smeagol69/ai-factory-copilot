import assert from "node:assert/strict";
import test from "node:test";

import { validateAction } from "../lib/actions.mjs";
import { compileArchitectPromotion } from "../lib/architect-promotion.mjs";
import { buildGraph } from "../lib/graph.mjs";
import {
  captureUnlockConstraints,
  gridPointToWorld,
  validateMegabaseManifest,
} from "../lib/megabase.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const REVISION = `sha256:${"b".repeat(64)}`;
const FAMILY = `sha256:${"a".repeat(64)}`;
const FOUNDATION_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Foundations/Recipe_Foundation_8x2_01.Recipe_Foundation_8x2_01_C";
const FOUNDATION_ITEM = "/Game/FactoryGame/Buildable/Building/Foundation/Desc_Foundation_8x2_01.Desc_Foundation_8x2_01_C";
const CONSTRUCTOR_BUILD_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_ConstructorMk1.Recipe_ConstructorMk1_C";
const CONSTRUCTOR_ITEM = "/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Desc_ConstructorMk1.Desc_ConstructorMk1_C";
const CONSTRUCTOR_CLASS = "/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C";
const WALL_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Walls/Recipe_Wall_8x2_01.Recipe_Wall_8x2_01_C";
const WALL_ITEM = "/Game/FactoryGame/Buildable/Building/Wall/Desc_Wall_8x2_01.Desc_Wall_8x2_01_C";
const WINDOW_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Walls/Recipe_Wall_8x2_Window_01.Recipe_Wall_8x2_Window_01_C";
const WINDOW_ITEM = "/Game/FactoryGame/Buildable/Building/Wall/Desc_Wall_8x2_Window_01.Desc_Wall_8x2_Window_01_C";
const ROOF_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Roofs/Recipe_Roof_8x2_01.Recipe_Roof_8x2_01_C";
const ROOF_ITEM = "/Game/FactoryGame/Buildable/Building/Roof/Desc_Roof_8x2_01.Desc_Roof_8x2_01_C";
const SUPPORT_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Pillars/Recipe_Pillar_4x4_01.Recipe_Pillar_4x4_01_C";
const SUPPORT_ITEM = "/Game/FactoryGame/Buildable/Building/Pillar/Desc_Pillar_4x4_01.Desc_Pillar_4x4_01_C";
const WALKWAY_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Walkways/Recipe_Walkway_8x1_01.Recipe_Walkway_8x1_01_C";
const WALKWAY_ITEM = "/Game/FactoryGame/Buildable/Building/Walkway/Desc_Walkway_8x1_01.Desc_Walkway_8x1_01_C";
const RAIL_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Railings/Recipe_Railing_8x1_01.Recipe_Railing_8x1_01_C";
const RAIL_ITEM = "/Game/FactoryGame/Buildable/Building/Railing/Desc_Railing_8x1_01.Desc_Railing_8x1_01_C";
const FINAL_RECIPE = "/Game/Test/Recipe_FinalPart.Recipe_FinalPart_C";
const FINAL_ITEM = "/Game/Test/Desc_FinalPart.Desc_FinalPart_C";
const BELT_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C";
const BELT_ITEM = "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1/Desc_ConveyorBeltMk1.Desc_ConveyorBeltMk1_C";
const BELT_CLASS = "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C";
const POWER_WIRE_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_PowerLine.Recipe_PowerLine_C";
const POWER_WIRE_ITEM = "/Game/FactoryGame/Buildable/Factory/PowerLine/Desc_PowerLine.Desc_PowerLine_C";
const POWER_CIRCUIT = "/Script/FactoryGame.FGPowerCircuit";
const POWER_POLE_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_PowerPoleMk1.Recipe_PowerPoleMk1_C";
const POWER_POLE_ITEM = "/Game/FactoryGame/Buildable/Factory/PowerPoleMk1/Desc_PowerPoleMk1.Desc_PowerPoleMk1_C";

function promotionGraph() {
  const snapshot = buildFactorySnapshot();
  snapshot.content.items.push({
    class_path: FOUNDATION_ITEM,
    name: "Foundation 8m x 2m",
    form: "RF_SOLID",
    available: true,
    building: {
      class_path: "/Game/FactoryGame/Buildable/Building/Foundation/Build_Foundation_8x2_01.Build_Foundation_8x2_01_C",
    },
  });
  snapshot.content.recipes.push({
    class_path: FOUNDATION_RECIPE,
    name: "Foundation 8m x 2m",
    available: true,
    ingredients: [],
    products: [{ item_class: FOUNDATION_ITEM, item_name: "Foundation 8m x 2m", amount: 1 }],
    produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
  });
  for (const [recipeClass, itemClass, name, buildableClass] of [
    [WALL_RECIPE, WALL_ITEM, "Wall 8m x 2m", "/Game/Build_Wall_8x2_01.Build_Wall_8x2_01_C"],
    [WINDOW_RECIPE, WINDOW_ITEM, "Glass Window Wall 8m x 2m", "/Game/Build_Wall_8x2_Window_01.Build_Wall_8x2_Window_01_C"],
    [ROOF_RECIPE, ROOF_ITEM, "Roof 8m x 2m", "/Game/Build_Roof_8x2_01.Build_Roof_8x2_01_C"],
    [SUPPORT_RECIPE, SUPPORT_ITEM, "Structural Pillar 4m x 4m", "/Game/Build_Pillar_4x4_01.Build_Pillar_4x4_01_C"],
    [WALKWAY_RECIPE, WALKWAY_ITEM, "Walkway 8m x 1m", "/Game/Build_Walkway_8x1_01.Build_Walkway_8x1_01_C"],
    [RAIL_RECIPE, RAIL_ITEM, "Railing 8m x 1m", "/Game/Build_Railing_8x1_01.Build_Railing_8x1_01_C"],
  ]) {
    snapshot.content.items.push({
      class_path: itemClass,
      name,
      form: "RF_SOLID",
      available: true,
      building: { class_path: buildableClass },
    });
    snapshot.content.recipes.push({
      class_path: recipeClass,
      name,
      available: true,
      ingredients: [],
      products: [{ item_class: itemClass, item_name: name, amount: 1 }],
      produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
    });
  }
  snapshot.content.items.push({
    class_path: CONSTRUCTOR_ITEM,
    name: "Constructor",
    form: "RF_SOLID",
    available: true,
    building: {
      class_path: CONSTRUCTOR_CLASS,
      native_factory_connections: [
        {
          component_name: "InputConnection0",
          direction: "FCD_INPUT",
          native_default_location_cm: { x: 0, y: -400, z: 100 },
          native_default_normal: { x: 0, y: -1, z: 0 },
        },
        {
          component_name: "OutputConnection0",
          direction: "FCD_OUTPUT",
          native_default_location_cm: { x: 0, y: 400, z: 100 },
          native_default_normal: { x: 0, y: 1, z: 0 },
        },
      ],
      native_circuit_connections: [
        {
          component_name: "PowerConnection",
          component_class_path: "/Script/FactoryGame.FGPowerConnectionComponent",
          hidden: false,
          max_links: 2,
          circuit_type_class_path: POWER_CIRCUIT,
          native_default_location_cm: { x: 0, y: 0, z: 300 },
        },
      ],
    },
  });
  snapshot.content.recipes.push({
    class_path: CONSTRUCTOR_BUILD_RECIPE,
    name: "Constructor",
    available: true,
    ingredients: [],
    products: [{ item_class: CONSTRUCTOR_ITEM, item_name: "Constructor", amount: 1 }],
    produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
  });
  snapshot.content.items.push(
    { class_path: FINAL_ITEM, name: "Final Part", form: "RF_SOLID", available: true },
    {
      class_path: BELT_ITEM,
      name: "Conveyor Belt Mk.1",
      form: "RF_SOLID",
      available: true,
      building: { class_path: BELT_CLASS, native_topology_kind: "conveyor" },
    },
    {
      class_path: POWER_WIRE_ITEM,
      name: "Power Line",
      form: "RF_SOLID",
      available: true,
      building: {
        class_path: "/Game/FactoryGame/Buildable/Factory/PowerLine/Build_PowerLine.Build_PowerLine_C",
        native_topology_kind: "power_wire",
        wire_max_length_cm: 10_000,
      },
    },
    {
      class_path: POWER_POLE_ITEM,
      name: "Power Pole Mk.1",
      form: "RF_SOLID",
      owner_mod: "FactoryGame",
      available: true,
      building: {
        class_path: "/Game/FactoryGame/Buildable/Factory/PowerPoleMk1/Build_PowerPoleMk1.Build_PowerPoleMk1_C",
        native_topology_kind: "power_pole",
        power_pole_type: "PPT_POLE",
        native_circuit_connections: [
          {
            component_name: "PowerConnection",
            component_class_path: "/Script/FactoryGame.FGPowerConnectionComponent",
            hidden: false,
            max_links: 4,
            circuit_type_class_path: POWER_CIRCUIT,
            native_default_location_cm: { x: 0, y: 0, z: 500 },
          },
        ],
      },
    },
  );
  snapshot.content.recipes.push(
    {
      class_path: FINAL_RECIPE,
      name: "Final Part",
      available: true,
      duration_seconds: 4,
      ingredients: [{ item_class: "Desc_IronRod", item_name: "Iron Rod", amount: 1 }],
      products: [{ item_class: FINAL_ITEM, item_name: "Final Part", amount: 1 }],
      produced_in: [CONSTRUCTOR_CLASS],
    },
    {
      class_path: BELT_RECIPE,
      name: "Conveyor Belt Mk.1",
      available: true,
      ingredients: [],
      products: [{ item_class: BELT_ITEM, item_name: "Conveyor Belt Mk.1", amount: 1 }],
      produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
    },
    {
      class_path: POWER_WIRE_RECIPE,
      name: "Power Line",
      available: true,
      ingredients: [],
      products: [{ item_class: POWER_WIRE_ITEM, item_name: "Power Line", amount: 1 }],
      produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
    },
    {
      class_path: POWER_POLE_RECIPE,
      name: "Power Pole Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      ingredients: [],
      products: [{ item_class: POWER_POLE_ITEM, item_name: "Power Pole Mk.1", amount: 1 }],
      produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
    },
  );
  snapshot.actors.push({
    actor_id: "/Game/Test.PersistentLevel.Build_ConveyorBeltMk1_C_Architect",
    name: "Build_ConveyorBeltMk1_C_Architect",
    class_path: BELT_CLASS,
    owner_mod: "FactoryGame",
    kind: "buildable",
    location: { x: 5_000, y: 5_000, z: 0 },
    built_with_recipe: BELT_RECIPE,
    connections: [],
    inventories: [],
    transport: {
      kind: "conveyor",
      reported_speed: 120,
      item_spacing_cm: 120,
      reported_length: 800,
      available_space: 4,
      items_on_segment: 0,
    },
  });
  snapshot.content.available_item_count = snapshot.content.items.filter((item) => item.available).length;
  snapshot.content.available_recipe_count = snapshot.content.recipes.filter((recipe) => recipe.available).length;
  return buildGraph(snapshot);
}

function platformAndMachinesManifest(graph) {
  const manifest = platformManifest(graph);
  const productionZone = {
    id: "production-zone-1",
    kind: "production_zone",
    local: { x: -1, y: 2, z: 1 },
    size_cells: { x: 4, y: 3, z: 2 },
    world_origin_cm: gridPointToWorld(
      { x: -1, y: 2, z: 1 },
      manifest.grid,
      manifest.anchor_cm,
    ),
    world_size_cm: { x: 3_200, y: 2_400, z: 800 },
    world_yaw_degrees: 90,
    requires_roles: [],
    program_group: "production-1",
    produces: "Iron Rod",
  };
  manifest.elements.push(productionZone);
  manifest.program.groups.push({
    id: "production-1",
    produces: "Iron Rod",
    machines: 2,
    building_class: CONSTRUCTOR_CLASS,
    build_recipe_class: CONSTRUCTOR_BUILD_RECIPE,
    production_recipe_class: "Recipe_IronRod",
    machine_footprint_cm: { width: 800, depth: 800, height: 900 },
    machine_footprint_cells: { x: 1, y: 1 },
    hall_size_cells: { x: 4, y: 3 },
    measurement_source: "captured constructor bounds",
  });
  manifest.validation = validateMegabaseManifest(manifest);
  return manifest;
}

function shellManifest(graph) {
  const manifest = platformAndMachinesManifest(graph);
  const facadeLocal = { x: -1, y: 1, z: 1 };
  const roofLocal = { x: -1, y: 2, z: 3 };
  manifest.elements.push(
    {
      id: "facade-1",
      kind: "glazed_facade",
      local: facadeLocal,
      size_cells: { x: 4, y: 1, z: 2 },
      world_origin_cm: gridPointToWorld(facadeLocal, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 3_200, y: 800, z: 800 },
      world_yaw_degrees: 90,
      requires_roles: ["window", "wall"],
    },
    {
      id: "roof-1",
      kind: "sloped_roof_intent",
      local: roofLocal,
      size_cells: { x: 4, y: 3, z: 1 },
      world_origin_cm: gridPointToWorld(roofLocal, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 3_200, y: 2_400, z: 400 },
      world_yaw_degrees: 90,
      requires_roles: ["sloped_roof"],
    },
  );
  manifest.part_resolution.resolved.push(
    { role: "wall", recipe_class: WALL_RECIPE, item_class: WALL_ITEM, source: "captured_game_catalog" },
    { role: "window", recipe_class: WINDOW_RECIPE, item_class: WINDOW_ITEM, source: "captured_game_catalog" },
    { role: "sloped_roof", recipe_class: ROOF_RECIPE, item_class: ROOF_ITEM, source: "captured_game_catalog" },
  );
  manifest.validation = validateMegabaseManifest(manifest);
  return manifest;
}

function directTopologyManifest(graph) {
  const manifest = platformManifest(graph);
  for (const [index, specification] of [
    {
      groupId: "production-1",
      local: { x: -1, y: 2, z: 1 },
      recipe: "Recipe_IronRod",
      produces: "Iron Rod",
      itemClass: "Desc_IronRod",
      inputs: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", rate_per_minute: 15 }],
      chain: [FINAL_RECIPE],
    },
    {
      groupId: "production-2",
      local: { x: -1, y: 6, z: 1 },
      recipe: FINAL_RECIPE,
      produces: "Final Part",
      itemClass: FINAL_ITEM,
      inputs: [{ item_class: "Desc_IronRod", item_name: "Iron Rod", rate_per_minute: 15 }],
      chain: [],
    },
  ].entries()) {
    const element = {
      id: `production-zone-${index + 1}`,
      kind: "production_zone",
      local: specification.local,
      size_cells: { x: 3, y: 3, z: 2 },
      world_origin_cm: gridPointToWorld(specification.local, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 2_400, y: 2_400, z: 800 },
      world_yaw_degrees: 90,
      requires_roles: [],
      program_group: specification.groupId,
      produces: specification.produces,
    };
    manifest.elements.push(element);
    manifest.program.groups.push({
      id: specification.groupId,
      production_step: index + 1,
      produces: specification.produces,
      produces_item_class: specification.itemClass,
      produces_rate_per_minute: 15,
      machines: 1,
      machines_exact: 1,
      per_machine_output_rate_per_minute: 15,
      inputs_required: specification.inputs,
      production_chain: specification.chain,
      building_class: CONSTRUCTOR_CLASS,
      build_recipe_class: CONSTRUCTOR_BUILD_RECIPE,
      production_recipe_class: specification.recipe,
      machine_footprint_cm: { width: 800, depth: 800, height: 900 },
      machine_footprint_cells: { x: 1, y: 1 },
      hall_size_cells: { x: 3, y: 3 },
      measurement_source: "captured constructor bounds",
    });
  }
  manifest.program.material_edges.push({
    id: "material-edge-1",
    from_program_group: "production-1",
    to_program_group: "production-2",
    item_class: "Desc_IronRod",
    item_name: "Iron Rod",
    required_rate_per_minute: 15,
    evidence: "exact production-chain provenance and matching item class",
  });
  manifest.program.external_inputs.push({
    consumer_group: "production-1",
    item_class: "Desc_IronIngot",
    item_name: "Iron Ingot",
    rate_per_minute: 15,
  });
  manifest.validation = validateMegabaseManifest(manifest);
  return manifest;
}

function fullMassingManifest(graph) {
  const manifest = shellManifest(graph);
  const supportLocal = { x: -2, y: 1, z: 0 };
  const bridgeLocal = { x: 4, y: 4, z: 2 };
  const towerLocal = { x: 8, y: 5, z: 0 };
  manifest.elements.push(
    {
      id: "support-1",
      kind: "support_pylon",
      local: supportLocal,
      size_cells: { x: 1, y: 1, z: 2 },
      world_origin_cm: gridPointToWorld(supportLocal, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 800, y: 800, z: 800 },
      world_yaw_degrees: 90,
      requires_roles: ["support_column"],
    },
    {
      id: "bridge-1",
      kind: "skybridge",
      local: bridgeLocal,
      size_cells: { x: 3, y: 1, z: 1 },
      world_origin_cm: gridPointToWorld(bridgeLocal, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 2_400, y: 800, z: 400 },
      world_yaw_degrees: 90,
      requires_roles: ["walkway", "rail"],
    },
    {
      id: "central-tower",
      kind: "vertical_landmark",
      local: towerLocal,
      size_cells: { x: 2, y: 2, z: 2 },
      world_origin_cm: gridPointToWorld(towerLocal, manifest.grid, manifest.anchor_cm),
      world_size_cm: { x: 1_600, y: 1_600, z: 800 },
      world_yaw_degrees: 90,
      requires_roles: ["foundation", "wall", "window"],
      optional_roles: ["lighting"],
    },
  );
  manifest.part_resolution.resolved.push(
    { role: "support_column", recipe_class: SUPPORT_RECIPE, item_class: SUPPORT_ITEM, source: "captured_game_catalog" },
    { role: "walkway", recipe_class: WALKWAY_RECIPE, item_class: WALKWAY_ITEM, source: "captured_game_catalog" },
    { role: "rail", recipe_class: RAIL_RECIPE, item_class: RAIL_ITEM, source: "captured_game_catalog" },
  );
  manifest.validation = validateMegabaseManifest(manifest);
  return manifest;
}

function platformManifest(graph, kind = "structural_platform") {
  const grid = { unit_cm: 800, floor_height_cm: 400, yaw_degrees: 90 };
  const anchor = { x: 10_000, y: 20_000, z: 1_000 };
  const element = {
    id: "platform-1",
    kind,
    local: { x: -1, y: 2, z: 0 },
    size_cells: { x: 2, y: 2, z: 1 },
    world_origin_cm: gridPointToWorld({ x: -1, y: 2, z: 0 }, grid, anchor),
    world_size_cm: { x: 1_600, y: 1_600, z: 400 },
    world_yaw_degrees: 90,
    requires_roles: ["foundation"],
  };
  const manifest = {
    schema: "megabase.design/v1",
    compiled: true,
    status: "concept_only",
    style: "elevated_industrial_campus",
    anchor_cm: anchor,
    grid,
    creative_parameters: {},
    design_family: { family_id: "test-family", fingerprint: FAMILY },
    commissioning: { planned: true, exact_total_preserved: true },
    unlock_constraints: captureUnlockConstraints(graph),
    program: { source: "test", groups: [], material_edges: [], external_inputs: [] },
    elements: [element],
    connections: [],
    part_resolution: {
      resolved: [{
        role: "foundation",
        recipe_class: FOUNDATION_RECIPE,
        item_class: FOUNDATION_ITEM,
        source: "captured_game_catalog",
      }],
      unresolved: [],
    },
    actions: [],
    construction_ready: false,
    construction_blockers: ["game_holograms_have_not_validated_the_elements"],
  };
  manifest.validation = validateMegabaseManifest(manifest);
  return manifest;
}

test("an exact selected platform revision compiles into the existing native Blueprint action", () => {
  const graph = promotionGraph();
  const promoted = compileArchitectPromotion(graph, platformManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Platform A",
    commit: true,
  });

  assert.equal(promoted.compiled, true, JSON.stringify(promoted.blockers));
  assert.equal(promoted.ready_for_native_generation, true);
  assert.deepEqual(promoted.blockers, []);
  assert.equal(promoted.native_blueprint.schema, "aifactory.generated-blueprint/v1");
  assert.equal(promoted.native_blueprint.counts.buildables, 4);
  assert.equal(promoted.action.action, "generate_native_blueprint");
  assert.equal(promoted.action.commit, true);
  assert.equal(promoted.action.buildables.length, 4);
  assert.deepEqual(promoted.action.buildables[0].relative_location, { x: -1_600, y: -800, z: 200 });
  assert.ok(promoted.action.buildables.every((part) => part.recipe_class === FOUNDATION_RECIPE));
  assert.ok(promoted.action.buildables.every((part) => part.yaw === 90));
  assert.equal(promoted.operational_readiness.ready, false);
});

test("promotion requires the exact selected immutable revision", () => {
  const graph = promotionGraph();
  const refused = compileArchitectPromotion(graph, platformManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: `sha256:${"c".repeat(64)}`,
    blueprint_name: "Not Selected",
    commit: true,
  });
  assert.equal(refused.compiled, false);
  assert.ok(refused.blockers.includes("architect_revision_is_not_the_selected_revision"));
  assert.equal(refused.action, undefined);
  assert.match(refused.effect, /No native Blueprint action/);
});

test("a production zone adds exact measured machines with their captured selected recipe", () => {
  const graph = promotionGraph();
  const promoted = compileArchitectPromotion(graph, platformAndMachinesManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Production Deck",
  });
  assert.equal(promoted.compiled, true, JSON.stringify(promoted.blockers));
  assert.equal(promoted.action.buildables.length, 6);
  const machines = promoted.action.buildables.filter((part) => part.role === "machine");
  assert.equal(machines.length, 2);
  assert.ok(machines.every((part) => part.recipe_class === CONSTRUCTOR_BUILD_RECIPE));
  assert.ok(machines.every((part) => part.production_recipe_class === "Recipe_IronRod"));
  assert.deepEqual(
    machines.map((part) => part.relative_location),
    [{ x: -2_800, y: 400, z: 400 }, { x: -2_800, y: 1_200, z: 400 }],
  );
  assert.equal(promoted.exact_machine_evidence["production-1"].buildable_class, CONSTRUCTOR_CLASS);
});

test("unknown semantic compilers and unlock drift stay explicit blockers", () => {
  const graph = promotionGraph();
  const manifest = platformManifest(graph, "uncompiled_spaceport");
  graph.snapshot.content.recipes.find((recipe) => recipe.class_path === FOUNDATION_RECIPE).available = false;
  const refused = compileArchitectPromotion(graph, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Blocked Tower",
    commit: true,
  });
  assert.equal(refused.compiled, false);
  assert.ok(refused.blockers.includes("architect_promotion_unlock_fingerprint_is_stale"));
  assert.ok(refused.blockers.includes("architect_role_recipe_is_not_currently_unlocked:foundation"));
  assert.ok(refused.blockers.includes("architect_element_kind_has_no_native_compiler:uncompiled_spaceport"));
  assert.equal(refused.action, undefined);
});

test("glazed facade frames and roofs compile only from dimension-matched selected parts", () => {
  const graph = promotionGraph();
  const promoted = compileArchitectPromotion(graph, shellManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Shell",
  });
  assert.equal(promoted.compiled, true, JSON.stringify(promoted.blockers));
  assert.equal(promoted.action.buildables.length, 34);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === WALL_RECIPE).length, 8);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === WINDOW_RECIPE).length, 8);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === ROOF_RECIPE).length, 12);
  assert.equal(promoted.exact_role_evidence.window.dimensions.height_cm, 200);
  assert.equal(promoted.exact_role_evidence.sloped_roof.dimensions.width_cm, 800);
});

test("a same-grid but unmeasured Foundation name is not treated as proven geometry", () => {
  const graph = promotionGraph();
  const manifest = platformManifest(graph);
  const item = graph.snapshot.content.items.find((entry) => entry.class_path === FOUNDATION_ITEM);
  item.class_path = "/Example/Desc_Foundation_Custom.Desc_Foundation_Custom_C";
  const recipe = graph.snapshot.content.recipes.find((entry) => entry.class_path === FOUNDATION_RECIPE);
  recipe.products[0].item_class = item.class_path;
  const rebuilt = buildGraph(graph.snapshot);
  const refused = compileArchitectPromotion(rebuilt, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Unknown Geometry",
  });
  assert.equal(refused.compiled, false);
  assert.ok(refused.blockers.includes("architect_foundation_descriptor_dimensions_are_not_proven"));
});

test("dimension-proven pylons, guarded skybridges, and landmark floors/facades complete massing", () => {
  const graph = promotionGraph();
  const promoted = compileArchitectPromotion(graph, fullMassingManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Full Massing",
  });
  assert.equal(promoted.compiled, true, JSON.stringify(promoted.blockers));
  assert.equal(promoted.action.buildables.length, 61);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === SUPPORT_RECIPE).length, 2);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === WALKWAY_RECIPE).length, 3);
  assert.equal(promoted.action.buildables.filter((part) => part.recipe_class === RAIL_RECIPE).length, 6);
  assert.equal(promoted.exact_role_evidence.support_column.native_role, "pillar");
  assert.equal(promoted.exact_role_evidence.walkway.native_role, "floor");
  assert.equal(promoted.exact_role_evidence.rail.native_role, "wall");
  assert.equal(promoted.exact_role_evidence.lighting, undefined);
  const independentlyValidated = validateAction(graph, promoted.action);
  assert.equal(independentlyValidated.valid, true, JSON.stringify(independentlyValidated));
  assert.equal(independentlyValidated.action.buildables.length, 61);
  assert.equal(
    independentlyValidated.checks.native_internal_collision_readback,
    "game_side_required",
  );
});

test("one-to-one rate-matched internal dependencies compile through native v2 conveyors", () => {
  const graph = promotionGraph();
  const promoted = compileArchitectPromotion(graph, directTopologyManifest(graph), {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Direct Conveyor",
    commit: true,
  });
  assert.equal(promoted.compiled, true, JSON.stringify(promoted));
  assert.equal(promoted.native_blueprint.schema, "aifactory.generated-blueprint/v2");
  assert.equal(promoted.native_blueprint.counts.buildables, 6);
  assert.equal(promoted.native_blueprint.counts.conveyors, 1);
  assert.equal(promoted.internal_conveyors.compiled, true);
  assert.equal(promoted.internal_conveyors.evidence[0].lane_rate_per_minute, 15);
  assert.equal(promoted.internal_conveyors.evidence[0].belt_capacity_per_minute, 20);
  assert.equal(promoted.internal_power.planned, true);
  assert.equal(promoted.internal_power.mode, "native_machine_daisy_chain");
  assert.equal(promoted.internal_power.wires, 1);
  assert.equal(promoted.native_blueprint.counts.power_wires, 1);
  assert.equal(promoted.action.conveyors[0].from_connector_name, "OutputConnection0");
  assert.equal(promoted.action.conveyors[0].to_connector_name, "InputConnection0");

  const independentlyValidated = validateAction(graph, promoted.action);
  assert.equal(independentlyValidated.valid, true, JSON.stringify(independentlyValidated));
  assert.equal(independentlyValidated.checks.captured_factory_connector_checked_endpoints, 2);
  assert.equal(
    independentlyValidated.checks.native_topology_readback,
    "isolated_blueprint_world_exact_reciprocal_endpoints_required",
  );
  assert.equal(independentlyValidated.checks.captured_power_capacity_checked_endpoints, 2);
});

test("an unequal material fan-out remains a named topology blocker", () => {
  const graph = promotionGraph();
  const manifest = directTopologyManifest(graph);
  const consumer = manifest.program.groups.find((group) => group.id === "production-2");
  consumer.machines = 2;
  consumer.machines_exact = 2;
  consumer.hall_size_cells.x = 4;
  const zone = manifest.elements.find((element) => element.program_group === "production-2");
  zone.size_cells.x = 4;
  zone.world_size_cm.x = 3_200;
  manifest.validation = validateMegabaseManifest(manifest);
  const refused = compileArchitectPromotion(graph, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Needs Splitter",
  });
  assert.equal(refused.compiled, false);
  assert.deepEqual(refused.blockers, [
    "architect_internal_conveyor_compiler_refused:architect_material_edge_requires_splitter_or_merger_topology",
  ]);
  assert.equal(refused.internal_conveyors.edge_id, "material-edge-1");
  assert.equal(refused.action, undefined);
});

test("a diagonal machine pair is not mislabeled as a native straight conveyor", () => {
  const graph = promotionGraph();
  const manifest = directTopologyManifest(graph);
  const consumerZone = manifest.elements.find(
    (element) => element.program_group === "production-2",
  );
  consumerZone.local.x += 1;
  consumerZone.world_origin_cm = gridPointToWorld(
    consumerZone.local,
    manifest.grid,
    manifest.anchor_cm,
  );
  manifest.validation = validateMegabaseManifest(manifest);
  const refused = compileArchitectPromotion(graph, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Needs Multi Leg Belt",
  });
  assert.equal(refused.compiled, false);
  assert.deepEqual(refused.blockers, [
    "architect_internal_conveyor_compiler_refused:architect_material_edge_requires_explicit_multi_leg_route",
  ]);
  assert.ok(refused.internal_conveyors.direct_route_diagnostic.from_alignment < 0.995);
  assert.equal(refused.action, undefined);
});

test("powered Architect machines without a proven wire block native promotion", () => {
  const graph = promotionGraph();
  graph.recipesByClass.delete(POWER_WIRE_RECIPE);
  graph.itemsByClass.delete(POWER_WIRE_ITEM);
  const manifest = directTopologyManifest(graph);
  const refused = compileArchitectPromotion(graph, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Missing Power Evidence",
  });
  assert.equal(refused.compiled, false);
  assert.deepEqual(refused.blockers, [
    "architect_internal_power_compiler_refused:no_unlocked_native_power_wire_with_captured_length",
  ]);
  assert.equal(refused.internal_power.planned, false);
  assert.equal(refused.operational_readiness.internal_power_topology, "blocked");
  assert.equal(refused.action, undefined);
});

test("single-link Architect machines receive a capacity-safe pole with an external link reserved", () => {
  const graph = promotionGraph();
  const constructor = graph.itemsByClass.get(CONSTRUCTOR_ITEM);
  constructor.building.native_circuit_connections[0].max_links = 1;
  const manifest = directTopologyManifest(graph);
  const promoted = compileArchitectPromotion(graph, manifest, {
    revision_id: REVISION,
    selected_revision_id: REVISION,
    blueprint_name: "Architect Pole Distribution",
  });
  assert.equal(promoted.compiled, true, JSON.stringify(promoted));
  assert.equal(promoted.internal_power.mode, "captured_capacity_power_pole_trunk");
  assert.equal(promoted.internal_power.poles, 1);
  assert.equal(promoted.internal_power.wires, 2);
  assert.equal(promoted.internal_power.external_connection.reserved_links, 1);
  assert.equal(promoted.native_blueprint.counts.buildables, 7);
  assert.equal(promoted.native_blueprint.counts.power_wires, 2);
  const independentlyValidated = validateAction(graph, promoted.action);
  assert.equal(independentlyValidated.valid, true, JSON.stringify(independentlyValidated));
  assert.equal(independentlyValidated.checks.captured_power_capacity_checked_endpoints, 3);
});
