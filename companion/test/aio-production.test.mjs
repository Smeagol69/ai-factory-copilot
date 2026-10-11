import test from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../lib/graph.mjs";
import { planAioProduction } from "../lib/aio-production.mjs";
import { planBaseBuild } from "../lib/base-build.mjs";
import { runSolverTool } from "../lib/tools.mjs";

const amount = (item_class, amount) => ({ item_class, amount });
function fixture() {
  const recipe = (name, duration_seconds, ingredients, output, amountOut = 1) => ({
    name, class_path: `recipe-${name}`, available: true, duration_seconds, ingredients,
    products: [amount(output, amountOut)], produced_in: ["/Game/Build_Test.Build_Test_C"],
  });
  return buildGraph({ world_revision: 185, actors: [], content: { availability_known: true,
    items: ["Ore", "Ingot", "Rod", "Screw", "Plate", "Rotor"].map(name => ({ name, class_path: name, form: "RF_SOLID" })),
    recipes: [recipe("Ingot", 2, [amount("Ore", 1)], "Ingot"),
      recipe("Rod", 4, [amount("Ingot", 1)], "Rod"),
      recipe("Screw", 6, [amount("Rod", 1)], "Screw", 4),
      recipe("Plate", 6, [amount("Ingot", 3)], "Plate", 2),
      recipe("Rotor", 15, [amount("Rod", 5), amount("Screw", 25)], "Rotor")],
  } });
}
const row = (item_name, rate_per_minute) => ({ item_name, rate_per_minute });
const request = () => ({ inputs: [row("Ore", 90)], outputs: [row("Rod", 5), row("Plate", 10), row("Screw", 10), row("Rotor", 2)] });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("AIO reserves shared rods and screws before exposing net storage output", () => {
  const p = planAioProduction(fixture(), request());
  assert.equal(p.planned, true, JSON.stringify(p));
  close(p.output_scale, 2); // 45 ore per basket; 90 / 45 = 2.
  assert.deepEqual(p.outputs.map(o => o.rate_per_minute), [10, 20, 20, 4]);
  const rods = p.balances.find(b => b.item_class === "Rod");
  close(rods.rate_per_minute, 60);
  close(rods.internal_consumption_per_minute, 50); // 30 for screws + 20 for rotors.
  close(rods.net_output_per_minute, 10);
  assert.equal(p.totals.machines, 12);
  assert.ok(p.steps.every(s => s.required_clock_percent_each === 100));
  assert.equal(p.build_ready, false);
  assert.equal(planBaseBuild(fixture(), { production_plan: p }).reason, "aio_requires_clock_and_reserved_flow_compiler");
});

test("AIO conservation and capacity bounds hold independently across supply scales and target ordering", () => {
  for (const supply of [0.5, 30, 60, 90, 119.625, 780]) {
    const g = fixture(), a = request(); a.inputs[0].rate_per_minute = supply;
    if (supply % 2) a.outputs.reverse();
    const p = planAioProduction(g, a);
    assert.equal(p.planned, true, JSON.stringify(p));
    close(p.inputs[0].rate_per_minute, supply);
    for (const b of p.balances) {
      const consumption = p.steps.flatMap(s => s.inputs_required).filter(i => i.item_class === b.item_class)
        .reduce((sum, i) => sum + i.rate_per_minute, 0);
      const exports = p.outputs.find(o => o.item_class === b.item_class)?.rate_per_minute ?? 0;
      close(b.rate_per_minute, consumption + exports);
    }
    for (const s of p.steps) {
      close(s.machines_required * s.per_machine_display_units_per_minute * s.required_clock_percent_each / 100,
        s.produces.display_units_per_minute);
      assert.ok(s.machines_required >= s.machines_exact - 1e-9);
      assert.ok(s.machines_required - 1 < s.machines_exact);
    }
    // Any common increase violates the binding raw supply: proves the scoped optimum.
    assert.ok(p.inputs[0].rate_per_minute * 1.00001 > supply);
  }
});

test("AIO target mode refuses shortage, and measured belt counts never invent capacity", () => {
  const g = fixture(), a = request(); a.inputs[0].rate_per_minute = 30; a.maximize = false;
  assert.equal(planAioProduction(g, a).reason, "insufficient_input_for_requested_outputs");
  a.inputs[0].rate_per_minute = 90;
  const p = planAioProduction(g, a);
  close(p.inputs[0].unused_per_minute, 45);
  assert.equal(p.belt, null);
  g.nodes.set("belt", { role: "conveyor", conveyor: { items_per_minute: 50 }, class_path: "/Mod/Belt" });
  a.maximize = true; a.belt_actor_id = "belt";
  const measured = planAioProduction(g, a);
  assert.equal(measured.balances.find(b => b.item_class === "Screw").minimum_parallel_belts, 3); // 120/min.
  assert.equal(measured.transport_flows.find(f => f.item_class === "Screw" && f.to_recipe_class).minimum_parallel_belts, 2); // 100/min.
  a.belt_actor_id = "missing";
  assert.equal(planAioProduction(g, a).reason, "belt_actor_has_no_captured_capacity");
});

test("AIO does not silently substitute locked, ambiguous, cyclic or coproduct recipes", () => {
  let g = fixture(); g.recipesByClass.get("recipe-Rod").available = false;
  assert.equal(planAioProduction(g, request()).reason, "selected_recipe_not_proven_available");
  g = fixture(); g.recipesByClass.get("recipe-Rod").ingredients = [amount("Screw", 1)];
  assert.equal(planAioProduction(g, request()).reason, "cyclic_recipe_selection");
  g = fixture(); g.recipesByClass.get("recipe-Rod").products.push(amount("Ore", 1));
  assert.equal(planAioProduction(g, request()).reason, "recipe_requires_single_product_positive_duration_and_ingredients");
  g = fixture(); g.recipesByClass.set("other", { ...g.recipesByClass.get("recipe-Rod"), class_path: "other" });
  assert.equal(planAioProduction(g, request()).reason, "choose_one_exact_production_recipe");
  assert.equal(planAioProduction(g, { ...request(), recipe_choices: [{ item_name: "Rod", recipe_class: "other" }] }).planned, true);
});

test("AIO validates input contracts, units and recipe overrides", () => {
  for (const n of [0, -1, NaN, Infinity, "30", null]) {
    const a = request(); a.inputs[0].rate_per_minute = n;
    assert.equal(planAioProduction(fixture(), a).planned, false);
  }
  const g = fixture(); delete g.itemsByClass.get("Ore").form;
  assert.equal(planAioProduction(g, request()).reason, "aio_initial_solver_requires_proven_solid_item_form");
  assert.equal(planAioProduction(fixture(), { ...request(), inputs: [row("Ore", 90), row("Ore", 30)] }).reason, "duplicate_item_in_contract");
  assert.equal(planAioProduction(fixture(), { ...request(), recipe_choices: [{ item_name: "Rod", recipe_class: "bogus" }] }).planned, false);
});

test("AIO provider tool is read-only and exposes balance evidence without native actions", () => {
  const emitted = [];
  const p = JSON.parse(runSolverTool(fixture(), "plan_aio_factory", request(), { services: { actions: { emit: a => emitted.push(a) } } }).serialized);
  assert.equal(p.planned, true);
  assert.deepEqual(emitted, []);
});
