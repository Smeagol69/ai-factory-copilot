import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import {
  MEGABASE_SCHEMA,
  MEGABASE_STYLES,
  assessMegabaseSite,
  captureUnlockConstraints,
  compileMegabaseConcept,
  deriveMegabaseFloorHeight,
  findMegabasePartCandidates,
  gridPointToWorld,
  megabaseFootprint,
  planCommissioningPhases,
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
    world_revision: 71,
    interaction_context: { captured_at_utc: "2026-08-09T12:00:00.000Z" },
    content: {
      availability_known: true,
      recipes: [
        {
          class_path: "/Game/FactoryGame/Recipes/Buildings/Recipe_Foundation.Recipe_Foundation_C",
          name: "Foundation",
          available: true,
          products: [{ item_class: "/Game/FactoryGame/Buildable/Factory/Foundation/Desc_Foundation.Desc_Foundation_C" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
        },
        {
          class_path: "/ExampleMod/Recipe_GlassWall.Recipe_GlassWall_C",
          name: "Modded Glass Wall",
          available: true,
          mod_reference: "ExampleMod",
          owner_mod: "ExampleMod",
          products: [{ item_class: "/ExampleMod/Desc_GlassWall.Desc_GlassWall_C" }],
          produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
        },
        {
          class_path: "/ExampleMod/Recipe_GlassWallSteel.Recipe_GlassWallSteel_C",
          name: "Modded Glass Wall",
          available: true,
          owner_mod: "ExampleMod",
          products: [{ item_class: "/ExampleMod/Desc_GlassWallSteel.Desc_GlassWallSteel_C", item_name: "Modded Glass Wall" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
        },
        {
          class_path: "/Game/FactoryGame/Recipes/Buildings/Recipe_Wall.Recipe_Wall_C",
          name: "Wall",
          available: false,
          products: [{ item_class: "/Game/FactoryGame/Buildable/Factory/Wall/Desc_Wall.Desc_Wall_C" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
        },
        {
          class_path: "/Game/Recipes/Recipe_ModularFrame.Recipe_ModularFrame_C",
          name: "Modular Frame",
          owner_mod: "FactoryGame",
          available: true,
          products: [{ item_class: "/Game/Desc_ModularFrame.Desc_ModularFrame_C", item_name: "Modular Frame" }],
          produced_in: ["/Game/FactoryGame/Buildable/Factory/AssemblerMk1/Build_AssemblerMk1.Build_AssemblerMk1_C"],
        },
        {
          class_path: "/Game/Recipes/Recipe_FlatRoof.Recipe_FlatRoof_C",
          name: "Flat Roof",
          owner_mod: "FactoryGame",
          available: true,
          products: [{ item_class: "/Game/Desc_FlatRoof.Desc_FlatRoof_C", item_name: "Flat Roof" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
        },
        {
          class_path: "/Game/Recipes/Recipe_Roof2m.Recipe_Roof2m_C",
          name: "Roof (2 m)",
          owner_mod: "FactoryGame",
          available: true,
          products: [{ item_class: "/Game/Desc_Roof2m.Desc_Roof2m_C", item_name: "Roof (2 m)" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
        },
        {
          class_path: "/FicsitWiremod/Recipe_Lightbulb.Recipe_Lightbulb_C",
          name: "Lightbulb",
          owner_mod: "FicsitWiremod",
          available: true,
          products: [{ item_class: "/FicsitWiremod/Desc_Lightbulb.Desc_Lightbulb_C", item_name: "Lightbulb" }],
          produced_in: ["/Script/FactoryGame.FGBuildGun"],
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
    floor_height_cm: 1_600,
    tallest_machine_cm: 1_200,
    service_clearance_cm: 400,
    vertical_design_module_cm: 400,
    source: "tallest_measured_machine_plus_one_half_grid_unit_rounded_up_to_the_half_grid",
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
    assert.equal(concept.commissioning.requested_phases, 1);
    assert.equal(concept.commissioning.exact_total_preserved, true);
    assert.equal(concept.design_family.family_id, style);
    assert.match(concept.design_family.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(concept.unlock_constraints.availability_known, true);
    assert.match(concept.unlock_constraints.availability_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(concept.optimization.recalculated_from_this_capture.placement_geometry, true);
    assert.equal(concept.optimization.recalculated_from_this_capture.transport_routing, false);
    assert.equal(concept.elements.filter((entry) => entry.kind === "production_zone").length, 3);
    assert.ok(concept.elements.some((entry) => entry.kind === "vertical_landmark"));
    assert.ok(concept.elements.some((entry) => entry.kind === "skybridge"));
    assert.ok(concept.footprint.size_meters.x > 0);
    assert.ok(concept.footprint.size_meters.y > 0);
    assert.equal(concept.site_assessment.game_validation_pending, true);
  }
});

test("unlock fingerprint changes only with the proven available recipe set", () => {
  const first = captureUnlockConstraints(graph);
  assert.equal(first.availability_known, true);
  assert.equal(first.captured_world_revision, 71);
  assert.match(first.replan_rule, /fresh snapshot/);

  const changed = structuredClone(graph);
  changed.snapshot.content.recipes[0].available = false;
  const second = captureUnlockConstraints(changed);
  assert.notEqual(first.availability_fingerprint, second.availability_fingerprint);
  assert.equal(second.available_recipe_count, first.available_recipe_count - 1);

  const movedWorld = structuredClone(graph);
  movedWorld.snapshot.world_revision = 99;
  const sameUnlocks = captureUnlockConstraints(movedWorld);
  assert.equal(
    first.availability_fingerprint,
    sameUnlocks.availability_fingerprint,
    "moving items may change world revision but must not fake an unlock change",
  );
});

test("splits measured production into exact independently commissionable phases", () => {
  const groups = compile("terraced_megafactory").program.groups;
  const plan = planCommissioningPhases(groups, 2);

  assert.equal(plan.planned, true);
  assert.equal(plan.requested_phases, 2);
  assert.equal(plan.balanced_identical_machine_allocations, true);
  assert.equal(plan.exact_total_preserved, true);
  assert.deepEqual(
    plan.phases.map((phase) => phase.machine_groups.map((group) => group.machines)),
    [[1, 2, 1], [1, 2, 1]],
  );
  assert.equal(plan.rate_allocation, "not_calculated_from_machine_counts");
  assert.equal(plan.spatial_layout, "not_compiled");
  assert.ok(plan.independence_requirements.some((entry) => /power/.test(entry)));
});

test("refuses to call a phase independent when it would omit a production stage", () => {
  const groups = compile("terraced_megafactory").program.groups;
  const plan = planCommissioningPhases(groups, 3);
  assert.equal(plan.planned, false);
  assert.equal(plan.reason, "commissioning_phases_exceed_the_smallest_machine_group");
  assert.match(plan.effect, /omit a production stage/);

  const concept = compile("terraced_megafactory", { commissioning_phases: 3 });
  assert.equal(concept.compiled, false);
  assert.equal(concept.status, "concept_refused");
  assert.deepEqual(concept.actions, []);
});

test("design family identity locks style parameters and exact captured role recipes", () => {
  const first = compile("terraced_megafactory", {
    design_family_id: "owner-industrial-family-v1",
    commissioning_phases: 2,
  });
  const same = compile("terraced_megafactory", {
    design_family_id: "owner-industrial-family-v1",
    commissioning_phases: 2,
  });
  const renamed = compile("terraced_megafactory", {
    design_family_id: "different-family-name",
    commissioning_phases: 2,
  });
  const changed = compile("terraced_megafactory", {
    design_family_id: "owner-industrial-family-v1",
    commissioning_phases: 2,
    part_selections: {
      ...partSelections,
      window: "/ExampleMod/Recipe_GlassWallSteel.Recipe_GlassWallSteel_C",
    },
  });

  assert.equal(first.design_family.family_id, "owner-industrial-family-v1");
  assert.equal(first.design_family.fingerprint, same.design_family.fingerprint);
  assert.notEqual(first.design_family.fingerprint, renamed.design_family.fingerprint);
  assert.notEqual(first.design_family.fingerprint, changed.design_family.fingerprint);
  assert.equal(first.design_family.signature.exact_role_recipes.foundation, partSelections.foundation);
  assert.match(first.design_family.reuse_contract, /exact signature/);
  assert.equal(first.design_family.complete, false, "unselected roles keep a theme explicitly provisional");

  const locked = compile("terraced_megafactory", {
    design_family_id: "owner-industrial-family-v1",
    commissioning_phases: 2,
    match_design_family_fingerprint: first.design_family.fingerprint,
  });
  assert.equal(locked.compiled, true);
  assert.equal(
    locked.design_family.matched_required_fingerprint,
    first.design_family.fingerprint,
  );

  const refusedDrift = compile("terraced_megafactory", {
    design_family_id: "owner-industrial-family-v1",
    commissioning_phases: 2,
    part_selections: {
      ...partSelections,
      window: "/ExampleMod/Recipe_GlassWallSteel.Recipe_GlassWallSteel_C",
    },
    match_design_family_fingerprint: first.design_family.fingerprint,
  });
  assert.equal(refusedDrift.compiled, false);
  assert.equal(
    refusedDrift.reason,
    "design_family_signature_does_not_match_the_requested_family",
  );
  assert.deepEqual(refusedDrift.actions, []);
});

test("computes exact concept bounds and refuses to stretch a small terrain probe", () => {
  const siteGraph = {
    ...graph,
    nodes: new Map(),
    snapshot: {
      ...graph.snapshot,
      world: { scan_center: { ...layout.origin } },
      terrain: {
        probe_footprint_meters: 24,
        at_scan_center: {
          sampled: true,
          verdict: "flat_and_clear",
          footprint_meters: 24,
        },
      },
    },
  };
  const concept = compileMegabaseConcept(siteGraph, layout, {
    style: "elevated_industrial_campus",
    floor_height_cm: 400,
  });
  const footprint = megabaseFootprint(concept);
  assert.deepEqual(footprint, concept.footprint);
  assert.ok(concept.site_assessment.terrain.required_footprint_meters > 24);
  assert.equal(concept.site_assessment.terrain.covers_whole_design, false);
  assert.equal(concept.site_assessment.status, "unknown_terrain_coverage");
  assert.match(concept.site_assessment.terrain.unknown_reason, /smaller_than/);

  const coveredGraph = structuredClone(siteGraph);
  coveredGraph.nodes = new Map();
  coveredGraph.snapshot.terrain.at_scan_center.footprint_meters = 1_000;
  const covered = assessMegabaseSite(coveredGraph, concept);
  assert.equal(covered.terrain.covers_whole_design, true);
  assert.match(covered.status, /no_captured_site_blocker/);
  assert.equal(covered.game_validation_pending, true);
});

test("reports captured building overlap across the complete megabase footprint", () => {
  const collisionGraph = {
    ...graph,
    nodes: new Map([
      ["existing", {
        actor_id: "Build_Existing_C_1",
        name: "Existing Building",
        class_path: "/Game/Build_Existing.Build_Existing_C",
        kind: "buildable",
        raw: {
          bounds: {
            origin: { x: layout.origin.x, y: layout.origin.y, z: layout.origin.z + 200 },
            extent: { x: 300, y: 300, z: 300 },
          },
        },
      }],
    ]),
  };
  const concept = compileMegabaseConcept(collisionGraph, layout, {
    style: "elevated_industrial_campus",
    floor_height_cm: 400,
  });
  assert.equal(concept.site_assessment.status, "blocked_by_captured_buildings");
  assert.equal(concept.site_assessment.captured_building_overlaps.count, 1);
  assert.equal(concept.site_assessment.captured_building_overlaps.examples[0].actor_id, "Build_Existing_C_1");
  assert.equal(concept.site_assessment.game_validation_pending, true);
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

test("surfaces bounded vanilla and mod candidates without asserting their behavior", () => {
  const candidates = findMegabasePartCandidates(graph, { limit_per_role: 2 });
  assert.equal(candidates.source, "captured_build_gun_recipe_catalog");
  assert.equal(candidates.limit_per_role, 2);

  const foundation = candidates.candidates_by_role.foundation[0];
  assert.match(foundation.recipe_class, /Recipe_Foundation/);
  assert.equal(foundation.available, true);
  assert.equal(foundation.behavior_verified, false);
  assert.equal(foundation.certainty, "name_match_candidate_only");
  assert.equal(foundation.match_scope, "display_name");

  const window = candidates.candidates_by_role.window[0];
  assert.equal(window.owner_mod, "ExampleMod");
  assert.match(window.recipe_class, /Recipe_GlassWall/);
  assert.equal(window.variant_count, 2);

  const everyCandidate = Object.values(candidates.candidates_by_role).flat();
  assert.equal(everyCandidate.some((entry) => /ModularFrame/.test(entry.recipe_class)), false);
  assert.equal(candidates.candidates_by_role.sloped_roof[0].product_name, "Roof (2 m)");
  assert.equal(candidates.candidates_by_role.lighting[0].owner_mod, "FicsitWiremod");
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

test("the model-facing solver is action-free by default and can emit one draw-only Architect preview", () => {
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
  const request = {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    origin: { x: 100_000, y: 100_000, z: 500 },
    style: "elevated_industrial_campus",
  };
  const result = runSolverTool(toolGraph, "design_megabase_concept", request);
  const parsed = JSON.parse(result.serialized);

  assert.equal(parsed.compiled, true, parsed.reason);
  assert.equal(parsed.validation.valid, true);
  assert.equal(parsed.grid.yaw_degrees, 45);
  assert.equal(parsed.vertical_module.source, "tallest_measured_machine_plus_one_half_grid_unit_rounded_up_to_the_half_grid");
  assert.equal(parsed.program.groups.length, 2, "existing surplus must not erase a new megabase program by default");
  assert.equal(parsed.part_candidates.source, "captured_build_gun_recipe_catalog");
  assert.deepEqual(parsed.actions, []);

  const emitted = [];
  const withPreview = runSolverTool(
    toolGraph,
    "design_megabase_concept",
    { ...request, preview_in_world: true },
    { services: { actions: { emit: (actions) => emitted.push(...actions) } } },
  );
  const previewed = JSON.parse(withPreview.serialized);
  assert.equal(previewed.architect_preview.compiled, true);
  assert.equal(previewed.architect_preview.status, "draw_action_emitted_pending_game_readback");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "architect_preview");
  assert.equal(emitted[0].commit, true);
  assert.equal(emitted[0].elements.length, parsed.elements.length);
});
