import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { solveProductionPlan } from "../lib/solvers.mjs";
import { CONSTRUCTOR, SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const graphOf = (overrides) => buildGraph(buildFactorySnapshot(overrides));

/** The fixture already produces spare Iron Rod, Iron Ingot, and Iron Ore. */
function graphWithoutSurplus() {
  const snapshot = buildFactorySnapshot();
  // Stop every machine producing so nothing offsets the plan.
  for (const actor of snapshot.actors) {
    if (actor.factory) actor.factory.production_cycle_seconds = 0;
    delete actor.extractor;
    delete actor.reflected_properties;
  }
  return buildGraph(snapshot);
}

test("requires both a target item and a rate", () => {
  const noItem = solveProductionPlan(graphOf(), { target_rate_per_minute: 60 });
  assert.equal(noItem.planned, false);
  assert.equal(noItem.reason, "no_target_item_given");

  const noRate = solveProductionPlan(graphOf(), { item_name: "Iron Rod" });
  assert.equal(noRate.planned, false);
  assert.equal(noRate.reason, "no_target_rate_given");
});

test("resolves an item by name from the full catalog", () => {
  const plan = solveProductionPlan(graphOf(), { item_name: "Iron Rod", target_rate_per_minute: 15 });
  assert.equal(plan.target.item_class, "Desc_IronRod");
  assert.equal(plan.target.item_name, "Iron Rod");
});

test("reports an unknown item instead of planning something else", () => {
  const plan = solveProductionPlan(graphOf(), {
    item_name: "Ficsonium Fuel Rod",
    target_rate_per_minute: 1,
  });
  assert.equal(plan.planned, false);
  assert.equal(plan.reason, "item_not_found_in_catalog");
});

test("computes machine counts by expanding the recipe tree", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
  });

  // Iron Rod: 15/min per constructor -> 4 machines. Each needs 15 ingot/min,
  // so 60 ingot/min -> smelter at 30/min -> 2 smelters.
  const rod = plan.steps.find((step) => step.produces.item_name === "Iron Rod");
  const ingot = plan.steps.find((step) => step.produces.item_name === "Iron Ingot");
  assert.equal(rod.machines_required, 4);
  assert.equal(rod.per_machine_display_units_per_minute, 15);
  assert.equal(ingot.produces.display_units_per_minute, 60);
  assert.equal(ingot.machines_required, 2);
});

test("subtracts what the base already over-produces", () => {
  const withSurplus = solveProductionPlan(graphOf(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
  });
  const without = solveProductionPlan(graphOf(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
  });

  // The fixture has 15/min spare Iron Rod, so only 45/min needs building.
  const covered = withSurplus.covered_by_existing_surplus.find(
    (entry) => entry.item_name === "Iron Rod",
  );
  assert.equal(covered.display_units_per_minute, 15);
  assert.equal(withSurplus.steps[0].produces.display_units_per_minute, 45);
  assert.ok(withSurplus.totals.machines < without.totals.machines);
  assert.equal(withSurplus.planned_against_this_base, true);
});

test("prefers a recipe already used in this world over a higher-yield one", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  const rod = plan.steps[0];
  // Recipe_Alternate_IronRod yields more, but Recipe_IronRod is the one in use.
  assert.equal(rod.recipe_class, "Recipe_IronRod");
  assert.equal(rod.recipe_already_used_here, true);
  assert.equal(rod.alternate_recipes_available, 1);
});

test("an explicitly requested recipe overrides the in-use preference", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 48,
    recipe_class: "Recipe_Alternate_IronRod",
    use_existing_surplus: false,
  });
  assert.equal(plan.steps[0].recipe_class, "Recipe_Alternate_IronRod");
  assert.equal(plan.steps[0].machines_required, 1);
});

test("rejects an explicitly requested recipe locked in the loaded save", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.content.recipes.find(
    (recipe) => recipe.class_path === "Recipe_Alternate_IronRod",
  ).available = false;

  const plan = solveProductionPlan(buildGraph(snapshot), {
    item_name: "Iron Rod",
    target_rate_per_minute: 48,
    recipe_class: "Recipe_Alternate_IronRod",
    use_existing_surplus: false,
  });
  assert.equal(plan.planned, false);
  assert.equal(plan.unresolved[0].reason, "requested_recipe_is_unavailable_in_this_save");
  assert.equal(plan.unresolved[0].recipe_class, "Recipe_Alternate_IronRod");
});

test("reads power off the player's own machines, not a table", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  const rod = plan.steps[0];
  // The fixture constructor draws 4 MW while producing.
  assert.equal(rod.power_each_mw, 4);
  assert.equal(rod.power_total_mw, 4);
  assert.match(rod.power_source, /observed_on_your_own_machine/);
});

test("reports partial power rather than inventing a figure", () => {
  const snapshot = buildFactorySnapshot();
  // Remove every machine that could supply an observed draw.
  for (const actor of snapshot.actors) delete actor.factory;
  const plan = solveProductionPlan(buildGraph(snapshot), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  assert.equal(plan.steps[0].power_each_mw, null);
  assert.equal(plan.totals.power_is_partial, true);
  assert.match(plan.steps[0].power_source, /unknown/);
});

test("stops at raw inputs and names them", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  const ore = plan.raw_inputs_required.find((entry) => entry.item_name === "Iron Ore");
  assert.ok(ore, "iron ore is not produced by any recipe, so it is a raw input");
  assert.match(ore.supplied_by, /extraction/);
});

test("bounds recursion and reports what it did not expand", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    max_depth: 1,
    use_existing_surplus: false,
  });
  assert.equal(plan.steps.length, 1);
  const stopped = plan.unresolved.find((entry) => entry.item_name === "Iron Ingot");
  assert.equal(stopped.reason, "max_depth_reached");
});

test("reports the last machine's utilisation so overbuild is visible", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 20,
    use_existing_surplus: false,
  });
  // 20/min over 15/min machines is 1.33 machines, rounded up to 2.
  assert.equal(plan.steps[0].machines_required, 2);
  assert.equal(plan.steps[0].machines_exact, 1.333);
  assert.equal(plan.steps[0].utilisation_of_last_machine_percent, 66.7);
});

test("prices the machines against captured inventories", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Ingot",
    target_rate_per_minute: 30,
    use_existing_surplus: false,
  });
  // Smelters cost 5 Iron Rod + 5 Iron Plate each in the fixture.
  const rod = plan.machine_build_cost.find((entry) => entry.item_name === "Iron Rod");
  assert.equal(rod.required, 5);
  assert.equal(rod.held_in_player_inventories, 5);
  assert.equal(rod.shortfall, 0);
});

test("states what it is not: a physical layout", () => {
  const plan = solveProductionPlan(graphOf(), { item_name: "Iron Rod", target_rate_per_minute: 15 });
  assert.match(plan.caveats.layout, /not a physical layout/);
  assert.match(plan.caveats.unlocks, /authoritative AFGRecipeManager/);
  assert.match(plan.caveats.power, /unknown rather than estimating/);
});

test("the fixture machines are the ones the plan reasons about", () => {
  // Guards the fixture assumptions the numbers above depend on.
  const graph = graphOf();
  assert.equal(graph.nodes.get(CONSTRUCTOR).recipe_class, "Recipe_IronRod");
  assert.equal(graph.nodes.get(SMELTER).recipe_class, "Recipe_IngotIron");
});

/* ---------------- power headroom ---------------- */

test("checks the plan's draw against the best circuit headroom", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 300,
    use_existing_surplus: false,
  });

  // 20 constructors + 10 smelters at 4 MW each = 120 MW; the healthy circuit
  // has 50 MW headroom.
  assert.equal(plan.power_check.checked, true);
  assert.equal(plan.power_check.plan_draw_mw, 120);
  assert.equal(plan.power_check.best_circuit_headroom_mw, 50);
  assert.equal(plan.power_check.fits_on_existing_power, false);
  assert.equal(plan.power_check.additional_mw_needed, 70);
  assert.equal(plan.power_check.circuit_id, 2);
});

test("a small plan is reported as fitting on existing power", () => {
  const plan = solveProductionPlan(graphWithoutSurplus(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  assert.equal(plan.power_check.fits_on_existing_power, true);
  assert.equal(plan.power_check.additional_mw_needed, 0);
});

test("an unknown per-machine draw makes the power check a lower bound", () => {
  const snapshot = buildFactorySnapshot();
  for (const actor of snapshot.actors) {
    if (actor.factory) delete actor.factory.producing_power_consumption_mw;
  }
  const plan = solveProductionPlan(buildGraph(snapshot), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  assert.equal(plan.power_check.partial, true);
  assert.match(plan.power_check.note, /at least this much/);
});

test("no captured circuit means the power question is unknown, not answered", () => {
  const snapshot = buildFactorySnapshot();
  for (const actor of snapshot.actors) {
    actor.connections = (actor.connections ?? []).filter((entry) => entry.kind !== "power");
  }
  const plan = solveProductionPlan(buildGraph(snapshot), {
    item_name: "Iron Rod",
    target_rate_per_minute: 15,
    use_existing_surplus: false,
  });
  assert.equal(plan.power_check.checked, false);
  assert.equal(plan.power_check.reason, "no_power_circuit_captured");
});
