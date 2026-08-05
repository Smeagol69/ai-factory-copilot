import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import {
  MEGABASE_SCHEMA,
  MEGABASE_STYLES,
  compileMegabaseConcept,
  deriveMegabaseFloorHeight,
  gridPointToWorld,
  validateMegabaseManifest,
} from "../lib/megabase.mjs";
import { runSolverTool } from "../lib/tools.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const layout = {
  designed: true,
  origin: { x: 100_000, y: -20_000, z: 5_000 },
  base_grid: { detected: true, yaw_degrees: 0 },
  layout: {
    rows: [
      {
        row: 1,
        produces: "Iron Ingot",
        building_class: "/Game/Buildable/Build_Smelter.Build_Smelter_C",
        build_recipe_class: "/Game/Recipes/Recipe_Smelter.Recipe_Smelter_C",
        machines: 2,
        machine_footprint_cm: { width: 600, depth: 900, height: 800 },
        footprint_measured_from: "2 of your own machines",
      },
      {
        row: 2,
        produces: "Iron Plate",
        building_class: "/Game/Buildable/Build_Constructor.Build_Constructor_C",
        build_recipe_class: "/Game/Recipes/Recipe_Constructor.Recipe_Constructor_C",
        machines: 4,
        machine_footprint_cm: { width: 800, depth: 600, height: 800 },
        footprint_measured_from: "6 of your own machines",
      },
      {
        row: 3,
        produces: "Reinforced Iron Plate",
        building_class: "/Game/Buildable/Build_Assembler.Build_Assembler_C",
        build_recipe_class: "/Game/Recipes/Recipe_Assembler.Recipe_Assembler_C",
        machines: 2,
        machine_footprint_cm: { width: 1000, depth: 1500, height: 1200 },
        footprint_measured_from: "1 of your own machines",
      },
    ],
  },
};

const graph = {
  snapshot: {
    content: {
      recipes: [
        {
          class_path: "/Game/FactoryGame/Recipes/Buildings/Recipe_Foundation.Recipe_Foundation_C",
          name: "Foundation",
          available: true,
          products: [{ item_class: "/Game/FactoryGame/Buildable/Factory/Foundation/Desc_Foundation.Desc_Foundation_C" }],
        },
        {
          class_path: "/ExampleMod/Recipe_GlassWall.Recipe_GlassWall_C",
          name: "Modded Glass Wall",
          available: true,
          mod_reference: "ExampleMod",
          products: [{ item_class: "/ExampleMod/Desc_GlassWall.Desc_GlassWall_C" }],
        },
        {
          class_path: "/Game/FactoryGame/Recipes/Buildings/Recipe_Wall.Recipe_Wall_C",
          name: "Wall",
          available: false,
          products: [{ item_class: "/Game/FactoryGame/Buildable/Factory/Wall/Desc_Wall.Desc_Wall_C" }],
        },
      ],
    },
  },
};

const partSelections = {
  foundation: "/Game/FactoryGame/Recipes/Buildings/Recipe_Foundation.Recipe_Foundation_C",
  window: "/ExampleMod/Recipe_GlassWall.Recipe_GlassWall_C",
  wall: "/Game/FactoryGame/Recipes/Buildings/Recipe_Wall.Recipe_Wall_C",
  rail: "/Untrusted/Recipe_Rail.Recipe_Rail_C",
};

const formerlyTrustedCallerData = {
  foundation: {
    recipe_class: "/Game/FactoryGame/Recipes/Buildings/Recipe_Foundation.Recipe_Foundation_C",
    available: true,
    source: "captured_game_catalog",
  },
  window: {
    recipe_class: "/ExampleMod/Recipe_GlassWall.Recipe_GlassWall_C",
    available: true,
    source: "captured_game_catalog",
    mod_reference: "ExampleMod",
  },
  wall: {
    recipe_class: "/Game/FactoryGame/Recipes/Buildings/Recipe_Wall.Recipe_Wall_C",
    available: false,
    source: "captured_game_catalog",
  },
  rail: {
    recipe_class: "/Untrusted/Recipe_Rail.Recipe_Rail_C",
    available: true,
    source: "model_suggestion",
  },
};

function compile(style, extra = {}) {
  return compileMegabaseConcept(graph, layout, {
    style,
    floor_height_cm: 400,
    part_selections: partSelections,
    ...extra,
  });
}

test("converts integer grid cells to exact rotated world coordinates", () => {
  const point = gridPointToWorld(
    { x: 2, y: 3, z: 4 },
    { unit_cm: 800, floor_height_cm: 400, yaw_degrees: 90 },
    { x: 10_000, y: 20_000, z: 1_000 },
  );
  assert.deepEqual(point, { x: 7_600, y: 21_600, z: 2_600 });
});

test("refuses to guess the vertical module or authoritative anchor", () => {
  const noFloorHeight = compileMegabaseConcept(graph, layout, {
    style: "elevated_industrial_campus",
  });
  assert.equal(noFloorHeight.compiled, false);
  assert.match(noFloorHeight.reason, /floor_height/);
  assert.deepEqual(noFloorHeight.actions, []);

  const noAnchor = compileMegabaseConcept(graph, { ...layout, origin: null }, {
    style: "elevated_industrial_campus",
    floor_height_cm: 400,
  });
  assert.equal(noAnchor.compiled, false);
  assert.match(noAnchor.reason, /authoritative_x_y_and_z/);
});

test("derives floor height from the tallest measured machine plus service clearance", () => {
  assert.deepEqual(deriveMegabaseFloorHeight(layout), {
    derived: true,
    floor_height_cm: 2_400,
    tallest_machine_cm: 1_200,
    service_clearance_cm: 800,
    source: "tallest_measured_machine_plus_one_grid_unit_rounded_up_to_the_grid",
  });

  const missing = structuredClone(layout);
  missing.layout.rows[1].machine_footprint_cm.height = null;
  const unknown = deriveMegabaseFloorHeight(missing);
  assert.equal(unknown.derived, false);
  assert.match(unknown.reason, /measured_height/);
});

test("all reference style grammars compile as valid preview-only manifests", () => {
  for (const style of MEGABASE_STYLES) {
    const concept = compile(style);
    assert.equal(concept.schema, MEGABASE_SCHEMA);
    assert.equal(concept.compiled, true, concept.reason);
    assert.equal(concept.status, "concept_only");
    assert.equal(concept.validation.valid, true, concept.validation.issues.join(", "));
    assert.equal(concept.construction_ready, false);
    assert.deepEqual(concept.actions, []);
    assert.equal(concept.program.groups.length, 3);
    assert.equal(concept.elements.filter((entry) => entry.kind === "production_zone").length, 3);
    assert.ok(concept.elements.some((entry) => entry.kind === "vertical_landmark"));
    assert.ok(concept.elements.some((entry) => entry.kind === "skybridge"));
  }
});

test("machine halls retain measured recipes and grow from measured footprints", () => {
  const concept = compile("elevated_industrial_campus");
  const group = concept.program.groups[1];
  assert.equal(group.produces, "Iron Plate");
  assert.equal(group.build_recipe_class, layout.layout.rows[1].build_recipe_class);
  assert.deepEqual(group.machine_footprint_cm, { width: 800, depth: 600, height: 800 });
  assert.equal(group.hall_size_cells.x, 8);
  assert.match(group.measurement_source, /your own machines/);
});

test("a missing measured footprint stays missing instead of becoming vanilla geometry", () => {
  const unmeasured = structuredClone(layout);
  unmeasured.layout.rows[0].footprint_measured_from = "";
  const concept = compileMegabaseConcept(graph, unmeasured, {
    style: "terraced_megafactory",
    floor_height_cm: 400,
  });
  assert.equal(concept.compiled, false);
  assert.equal(concept.reason, "every_machine_group_needs_a_measured_positive_footprint");
  assert.deepEqual(concept.actions, []);
});

test("only available captured catalog entries resolve semantic parts", () => {
  const concept = compile("curvilinear_future_campus");
  const resolved = new Map(concept.part_resolution.resolved.map((entry) => [entry.role, entry]));
  const unresolved = new Map(concept.part_resolution.unresolved.map((entry) => [entry.role, entry]));

  assert.match(resolved.get("foundation").recipe_class, /Recipe_Foundation/);
  assert.equal(resolved.get("window").mod_reference, "ExampleMod");
  assert.match(unresolved.get("wall").reason, /not_available/);
  assert.match(unresolved.get("rail").reason, /not_in_the_captured_game_catalog/);
  assert.match(unresolved.get("support_column").reason, /no_part_selected/);
});

test("a caller cannot self-certify an invented recipe as captured", () => {
  const concept = compile("elevated_industrial_campus", {
    part_catalog: formerlyTrustedCallerData,
    part_selections: { foundation: "/Invented/Recipe_Foundation.Recipe_Foundation_C" },
  });
  assert.equal(concept.part_resolution.resolved.length, 0);
  const foundation = concept.part_resolution.unresolved.find((entry) => entry.role === "foundation");
  assert.match(foundation.reason, /not_in_the_captured_game_catalog/);
});

test("curvilinear grammar creates a stepped campus spine without fuzzy coordinates", () => {
  const concept = compile("curvilinear_future_campus");
  const zones = concept.elements.filter((entry) => entry.kind === "production_zone");
  assert.notEqual(zones[0].local.x, zones[1].local.x);
  for (const zone of zones) {
    assert.equal(Number.isInteger(zone.local.x), true);
    assert.equal(Number.isInteger(zone.local.y), true);
    assert.equal(Number.isInteger(zone.local.z), true);
    assert.ok(Object.values(zone.world_origin_cm).every(Number.isFinite));
  }
});

test("creative parameters are explicit, bounded integers", () => {
  const concept = compile("elevated_industrial_campus", {
    creative_parameters: { tower_floors: 11, deck_floor: 6 },
  });
  assert.equal(concept.creative_parameters.tower_floors, 11);
  assert.equal(concept.creative_parameters.deck_floor, 6);

  const bad = compile("elevated_industrial_campus", {
    creative_parameters: { tower_floors: 2.5 },
  });
  assert.equal(bad.compiled, false);
  assert.match(bad.reason, /tower_floors/);
});

test("the compiler is deterministic for the same authoritative inputs", () => {
  const first = compile("terraced_megafactory");
  const second = compile("terraced_megafactory");
  assert.deepEqual(first, second);
});

test("manifest validation catches actions, transform drift and missing endpoints", () => {
  const concept = compile("elevated_industrial_campus");
  const corrupted = structuredClone(concept);
  corrupted.actions.push({ action: "place_building" });
  corrupted.elements[0].world_origin_cm.x += 1;
  corrupted.connections[0].to = "does-not-exist";
  const result = validateMegabaseManifest(corrupted);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("a_preview_manifest_must_not_contain_actions"));
  assert.ok(result.issues.some((issue) => issue.startsWith("world_transform_mismatch:")));
  assert.ok(result.issues.some((issue) => issue.startsWith("connection_endpoint_missing:")));
});

test("the model-facing solver builds its inputs from the graph and cannot emit actions", () => {
  const snapshot = buildFactorySnapshot();
  for (const actor of snapshot.actors) {
    if (actor.kind !== "buildable") continue;
    const isSmelter = actor.actor_id === SMELTER;
    actor.bounds = {
      origin: { ...actor.location },
      extent: isSmelter ? { x: 300, y: 450, z: 400 } : { x: 400, y: 300, z: 400 },
    };
    actor.rotation = { pitch: 0, yaw: 45, roll: 0 };
    if (actor.factory) actor.factory.production_cycle_seconds = 0;
  }
  const toolGraph = buildGraph(snapshot);
  const result = runSolverTool(toolGraph, "design_megabase_concept", {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    origin: { x: 100_000, y: 100_000, z: 500 },
    style: "elevated_industrial_campus",
  });
  const parsed = JSON.parse(result.serialized);

  assert.equal(parsed.compiled, true, parsed.reason);
  assert.equal(parsed.validation.valid, true);
  assert.equal(parsed.grid.yaw_degrees, 45);
  assert.equal(parsed.vertical_module.source, "tallest_measured_machine_plus_one_grid_unit_rounded_up_to_the_grid");
  assert.deepEqual(parsed.actions, []);
});
