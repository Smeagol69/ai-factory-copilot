import assert from "node:assert/strict";
import test from "node:test";

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
const FOUNDATION_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Foundations/Recipe_Foundation_8x1_01.Recipe_Foundation_8x1_01_C";
const FOUNDATION_ITEM = "/Game/FactoryGame/Buildable/Building/Foundation/Desc_Foundation_8x1_01.Desc_Foundation_8x1_01_C";

function promotionGraph() {
  const snapshot = buildFactorySnapshot();
  snapshot.content.items.push({
    class_path: FOUNDATION_ITEM,
    name: "Foundation 8m x 1m",
    form: "RF_SOLID",
    available: true,
    building: {
      class_path: "/Game/FactoryGame/Buildable/Building/Foundation/Build_Foundation_8x1_01.Build_Foundation_8x1_01_C",
    },
  });
  snapshot.content.recipes.push({
    class_path: FOUNDATION_RECIPE,
    name: "Foundation 8m x 1m",
    available: true,
    ingredients: [],
    products: [{ item_class: FOUNDATION_ITEM, item_name: "Foundation 8m x 1m", amount: 1 }],
    produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
  });
  snapshot.content.available_item_count = snapshot.content.items.filter((item) => item.available).length;
  snapshot.content.available_recipe_count = snapshot.content.recipes.filter((recipe) => recipe.available).length;
  return buildGraph(snapshot);
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
    program: { source: "test", groups: [] },
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
  assert.deepEqual(promoted.action.buildables[0].relative_location, { x: -1_600, y: -800, z: 0 });
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

test("unknown semantic compilers and unlock drift stay explicit blockers", () => {
  const graph = promotionGraph();
  const manifest = platformManifest(graph, "vertical_landmark");
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
  assert.ok(refused.blockers.includes("architect_element_kind_has_no_native_compiler:vertical_landmark"));
  assert.equal(refused.action, undefined);
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

