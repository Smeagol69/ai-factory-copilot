/**
 * Designing a whole base and turning it into actions.
 *
 * The test that matters most here is the Smelter one. In the real catalog:
 *
 *   Recipe_SmelterMk1_C       -> Desc_FoundryMk1_C   ("Foundry")
 *   Recipe_SmelterBasicMk1_C  -> Desc_SmelterMk1_C   ("Smelter")
 *
 * So the obvious `Build_X -> Recipe_X` rule silently builds a Foundry whenever a
 * plan asks for a Smelter, and every line of the plan still reads as correct.
 * The fixture reproduces that exactly, because it is the kind of mistake that
 * would otherwise only surface as "why is there a Foundry in my factory".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { baseBuildActions, findBuildRecipeForBuilding, planBaseBuild } from "../lib/base-build.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const buildRecipe = (className, productClass, name, available = true) => ({
  class_path: `/Game/Recipes/${className}.${className}_C`,
  name,
  available,
  produced_in: [BUILD_GUN],
  products: [{ item_class: `/Game/Desc/${productClass}.${productClass}_C`, item_name: name, amount: 1 }],
});

const SMELTER_CLASS = "/Game/Buildable/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C";
const CONSTRUCTOR_CLASS = "/Game/Buildable/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C";
const REFINERY_CLASS = "/Game/Buildable/Refinery/Build_Refinery.Build_Refinery_C";

const graph = buildGraph({
  world_revision: 8,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 1_000, y: 2_000, z: 300 } } },
  actors: [],
  content: {
    items: [],
    recipes: [
      // The trap, reproduced from the real catalog.
      buildRecipe("Recipe_SmelterMk1", "Desc_FoundryMk1", "Foundry"),
      buildRecipe("Recipe_SmelterBasicMk1", "Desc_SmelterMk1", "Smelter"),
      buildRecipe("Recipe_ConstructorMk1", "Desc_ConstructorMk1", "Constructor"),
      // Locked: present in the catalog but not usable yet.
      buildRecipe("Recipe_Refinery", "Desc_Refinery", "Refinery", false),
    ],
  },
});

const productionPlan = {
  planned: true,
  target: { item_name: "Iron Plate", display_units_per_minute: 60 },
  power_check: { plan_draw_mw: 12, fits_on_existing_power: true },
  steps: [
    {
      step: 1,
      depth: 0,
      chain: [],
      produces: { item_class: "iron-plate", item_name: "Iron Plate", display_units_per_minute: 40 },
      recipe_class: "/Game/Recipes/Recipe_IronPlate.Recipe_IronPlate_C",
      recipe_name: "Iron Plate",
      produced_in: [CONSTRUCTOR_CLASS],
      machines_required: 2,
      inputs_required: [{ item_class: "iron-ingot", item_name: "Iron Ingot" }],
    },
    {
      step: 2,
      depth: 1,
      chain: ["/Game/Recipes/Recipe_IronPlate.Recipe_IronPlate_C"],
      produces: { item_class: "iron-ingot", item_name: "Iron Ingot", display_units_per_minute: 30 },
      recipe_class: "/Game/Recipes/Recipe_IronIngot.Recipe_IronIngot_C",
      recipe_name: "Iron Ingot",
      produced_in: [SMELTER_CLASS],
      machines_required: 1,
      inputs_required: [{ item_class: "iron-ore", item_name: "Iron Ore" }],
    },
  ],
};

test("resolves a building by its product descriptor, not by recipe name", () => {
  // The whole point: the name says Recipe_SmelterMk1 builds a smelter. It does
  // not. Following the name would place a Foundry and read as correct.
  const smelter = findBuildRecipeForBuilding(graph, SMELTER_CLASS);
  assert.equal(smelter.name, "Smelter");
  assert.match(smelter.recipe_class, /Recipe_SmelterBasicMk1/);
  assert.doesNotMatch(smelter.recipe_class, /Recipe_SmelterMk1\./);
});

test("returns nothing rather than a guess when no recipe produces the building", () => {
  assert.equal(findBuildRecipeForBuilding(graph, "/Game/Buildable/Build_Imaginary.Build_Imaginary_C"), null);
  assert.equal(findBuildRecipeForBuilding(graph, "not a class path"), null);
});

test("builds deepest dependency first, so belts run forward", () => {
  const plan = planBaseBuild(graph, { production_plan: productionPlan });

  assert.equal(plan.planned, true, plan.reason);
  assert.equal(plan.rows, 2);
  // Ingots are made before plates, whatever order the production plan listed.
  assert.equal(plan.steps[0].produces, "Iron Ingot");
  assert.equal(plan.steps[1].produces, "Iron Plate");
  assert.equal(plan.steps[0].building_name, "Smelter");
  assert.equal(plan.machines_total, 3);
});

test("derives branching material edges from recipe provenance, not adjacent rows", () => {
  const targetRecipe = "/Game/Recipes/Recipe_ReinforcedPlate.Recipe_ReinforcedPlate_C";
  const plateRecipe = "/Game/Recipes/Recipe_IronPlate.Recipe_IronPlate_C";
  const screwRecipe = "/Game/Recipes/Recipe_Screw.Recipe_Screw_C";
  const branching = {
    ...productionPlan,
    steps: [
      {
        step: 1,
        depth: 0,
        chain: [],
        produces: { item_class: "reinforced", item_name: "Reinforced Iron Plate" },
        recipe_class: targetRecipe,
        recipe_name: "Reinforced Iron Plate",
        produced_in: [CONSTRUCTOR_CLASS],
        machines_required: 1,
        inputs_required: [
          { item_class: "plate", item_name: "Iron Plate" },
          { item_class: "screw", item_name: "Screws" },
        ],
      },
      {
        step: 2,
        depth: 1,
        chain: [targetRecipe],
        produces: { item_class: "plate", item_name: "Iron Plate" },
        recipe_class: plateRecipe,
        recipe_name: "Iron Plate",
        produced_in: [CONSTRUCTOR_CLASS],
        machines_required: 1,
        inputs_required: [{ item_class: "ingot-a", item_name: "Iron Ingot" }],
      },
      {
        step: 3,
        depth: 1,
        chain: [targetRecipe],
        produces: { item_class: "screw", item_name: "Screws" },
        recipe_class: screwRecipe,
        recipe_name: "Screws",
        produced_in: [CONSTRUCTOR_CLASS],
        machines_required: 1,
        inputs_required: [{ item_class: "rod", item_name: "Iron Rod" }],
      },
      {
        step: 4,
        depth: 2,
        chain: [targetRecipe, plateRecipe],
        produces: { item_class: "ingot-a", item_name: "Iron Ingot" },
        recipe_class: "/Game/Recipes/Recipe_IngotA.Recipe_IngotA_C",
        recipe_name: "Iron Ingot",
        produced_in: [SMELTER_CLASS],
        machines_required: 1,
        inputs_required: [],
      },
      {
        step: 5,
        depth: 2,
        chain: [targetRecipe, screwRecipe],
        produces: { item_class: "rod", item_name: "Iron Rod" },
        recipe_class: "/Game/Recipes/Recipe_Rod.Recipe_Rod_C",
        recipe_name: "Iron Rod",
        produced_in: [CONSTRUCTOR_CLASS],
        machines_required: 1,
        inputs_required: [],
      },
    ],
  };

  const plan = planBaseBuild(graph, { production_plan: branching });
  const edges = plan.belts.map((belt) => [belt.from_production_step, belt.to_production_step]);
  assert.deepEqual(edges, [[2, 1], [3, 1], [4, 2], [5, 3]]);
  assert.equal(edges.some(([from, to]) => from === 2 && to === 3), false);
  assert.equal(edges.some(([from, to]) => from === 3 && to === 2), false);
});

test("anchors on the player when no position is given", () => {
  const plan = planBaseBuild(graph, { production_plan: productionPlan });
  assert.deepEqual(plan.anchor_cm, { x: 1_000, y: 2_000, z: 300 });
  assert.equal(plan.steps[0].positions[0].location_cm.x, 1_000);
});

test("a locked building is reported as unbuildable, not silently placed", () => {
  const locked = {
    ...productionPlan,
    steps: [{ ...productionPlan.steps[0], produced_in: [REFINERY_CLASS] }],
  };
  const plan = planBaseBuild(graph, { production_plan: locked });
  assert.equal(plan.planned, false);
  assert.match(plan.unbuildable[0].reason, /not unlocked/);
});

test("turns the plan into ordered actions, with belts referencing earlier steps", () => {
  const plan = planBaseBuild(graph, { production_plan: productionPlan });
  const actions = baseBuildActions(plan, { commit: false });

  const placements = actions.filter((action) => action.action === "place_building");
  const belts = actions.filter((action) => action.action === "place_belt");
  assert.equal(placements.length, 3);
  assert.equal(belts.length, 1);

  // Placements must all precede the belts that join them.
  assert.equal(actions.slice(0, 3).every((a) => a.action === "place_building"), true);

  // A belt cannot name components for machines that do not exist yet, so it
  // names the step that builds each end. Steps are 1-based, as reported.
  assert.equal(belts[0].from_step, 1);
  assert.equal(belts[0].to_step, 2);
  assert.ok(belts[0].from_step >= 1, "step references are 1-based");
});

test("nothing commits unless asked", () => {
  const plan = planBaseBuild(graph, { production_plan: productionPlan });
  assert.equal(baseBuildActions(plan, { commit: false }).every((a) => a.commit === false), true);
  assert.equal(baseBuildActions(plan, { commit: true }).every((a) => a.commit === true), true);
  assert.deepEqual(baseBuildActions({ planned: false }), []);
});

test("never claims the base will stand", () => {
  const plan = planBaseBuild(graph, { production_plan: productionPlan });
  assert.match(plan.unverified, /hologram/);
  assert.ok(plan.notes.some((note) => /Power is not wired/.test(note)));
});

test("refuses without a production plan rather than inventing one", () => {
  assert.match(planBaseBuild(graph, {}).reason, /run plan_production first/);
  assert.match(planBaseBuild(graph, { production_plan: { planned: false } }).reason, /plan_production/);
});
