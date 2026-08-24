import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  beltFor,
  crossCheckTransport,
  efficiencyData,
  machinesFor,
  measureFootprints,
  overclockPower,
  recipeRates,
} from "../lib/efficiency.mjs";

/** The real Iron Ingot recipe, in the exact shape a snapshot carries. */
const ironIngot = {
  class_path: "/Game/FactoryGame/Recipes/Smelter/Recipe_IngotIron.Recipe_IngotIron_C",
  name: "Iron Ingot",
  duration_seconds: 2,
  ingredients: [
    { item_class: ".../Desc_OreIron_C", item_name: "Iron Ore", amount: 1 },
  ],
  products: [
    { item_class: ".../Desc_IronIngot_C", item_name: "Iron Ingot", amount: 1 },
  ],
  produced_in: [".../Build_SmelterMk1_C"],
};

test("a recipe's rate comes from its cycle time, not a lookup table", () => {
  const rates = recipeRates(ironIngot);
  assert.equal(rates.cycles_per_minute, 30);
  assert.equal(rates.outputs[0].per_minute, 30);
  assert.equal(rates.inputs[0].per_minute, 30);
});

test("a recipe with no duration is refused rather than divided by zero", () => {
  assert.equal(recipeRates({ ...ironIngot, duration_seconds: 0 }), null);
  assert.equal(recipeRates({}), null);
});

test("a fractional machine count underclocks the remainder instead of rounding up", () => {
  // 72/min from a 30/min machine is 2.4 machines.
  const plan = machinesFor(ironIngot, 72);
  assert.equal(plan.full_machines, 2);
  assert.equal(plan.partial_machine_clock_percent, 40);
  assert.equal(plan.unmet_per_minute, 0);
});

test("an exact multiple needs no partial machine", () => {
  const plan = machinesFor(ironIngot, 90);
  assert.equal(plan.full_machines, 3);
  assert.equal(plan.partial_machine_clock_percent, 0);
});

test("input demand scales with the fractional machine count, not the rounded one", () => {
  const plan = machinesFor(ironIngot, 72);
  // 2.4 smelters consume 72 ore/min, not 90.
  assert.equal(plan.inputs_per_minute[0].per_minute, 72);
});

test("a remainder too small to clock is reported as shortfall, never hidden", () => {
  // 30.15/min leaves 0.5% of a machine, below the 1% minimum clock.
  const plan = machinesFor(ironIngot, 30.15);
  assert.equal(plan.full_machines, 1);
  assert.equal(plan.partial_machine_clock_percent, 0);
  assert.ok(plan.unmet_per_minute > 0, "the gap must surface, not vanish");
});

test("overclock power follows the superlinear curve", () => {
  assert.equal(overclockPower(4, 100).power_mw, 4);
  // 250% draws 2.5^1.321928 ~= 3.4x, well above the 2.5x output gain.
  const high = overclockPower(4, 250);
  assert.ok(high.power_mw > 4 * 2.5, "overclocking must cost more than it yields");
});

test("two machines underclocked beat one at full rate on power", () => {
  // The whole reason machinesFor underclocks rather than rounding up.
  const one = overclockPower(4, 100).power_mw;
  const two = overclockPower(4, 50).power_mw * 2;
  assert.ok(two < one, "underclocking two halves must undercut one full machine");
});

test("a clock outside the legal range is clamped and says so", () => {
  const over = overclockPower(4, 400);
  assert.equal(over.clock_percent, 250);
  assert.equal(over.clamped, true);
});

test("belt selection picks the smallest tier that carries the rate", () => {
  assert.equal(beltFor(60).tier, 1);
  assert.equal(beltFor(61).tier, 2);
  assert.equal(beltFor(270).tier, 3);
});

test("a rate beyond the top tier reports parallel belts rather than pretending to fit", () => {
  const huge = beltFor(3000);
  assert.equal(huge.saturated, true);
  assert.equal(huge.belts_needed, 3);
});

test("belt selection honours what the player has actually unlocked", () => {
  const limited = beltFor(200, { available: ["Conveyor Belt Mk.1", "Conveyor Belt Mk.2"] });
  assert.equal(limited.saturated, true);
  assert.equal(limited.belts_needed, 2);
});

test("footprints are measured from bounds, and a median resists one bad sample", () => {
  const snapshot = {
    actors: [
      { kind: "buildable", class_path: "a.Build_SmelterMk1_C", bounds: { extent: { x: 300, y: 450, z: 250 } } },
      { kind: "buildable", class_path: "a.Build_SmelterMk1_C", bounds: { extent: { x: 300, y: 450, z: 250 } } },
      // A clipped outlier that a mean would let distort the answer.
      { kind: "buildable", class_path: "a.Build_SmelterMk1_C", bounds: { extent: { x: 5, y: 5, z: 5 } } },
    ],
  };
  const measured = measureFootprints(snapshot);
  assert.equal(measured.Build_SmelterMk1_C.width_m, 6);
  assert.equal(measured.Build_SmelterMk1_C.depth_m, 9);
  assert.equal(measured.Build_SmelterMk1_C.sample_count, 3);
});

test("the hardcoded transport table is cross-checked against the game's own text", () => {
  const snapshot = {
    content: {
      items: [
        { name: "Conveyor Belt Mk.1", description: "Transports up to 60 resources per minute." },
        { name: "Conveyor Belt Mk.3", description: "Transports up to 270 resources per minute." },
      ],
    },
  };
  const result = crossCheckTransport(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.checked_count, 2);
});

test("a table that has drifted from the game fails loudly", () => {
  const snapshot = {
    content: {
      items: [
        { name: "Conveyor Belt Mk.1", description: "Transports up to 75 resources per minute." },
      ],
    },
  };
  const result = crossCheckTransport(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /table says 60\/min, game says 75\/min/);
});

test("nothing unverified is presented as verified", () => {
  // pipes were never confirmed against a real install; the data must admit it
  // rather than look as trustworthy as the belts that were checked.
  const { transport } = efficiencyData();
  assert.ok(transport.belts.every((tier) => tier.verified === true));
  assert.ok(transport.pipes.every((tier) => tier.verified === false));
});

test("footprints ship empty rather than guessed", () => {
  const data = efficiencyData();
  const keys = Object.keys(data.footprints_m).filter((k) => !k.startsWith("$"));
  assert.equal(keys.length, 0, "recalled footprints must not be smuggled in as facts");
});

test("the real install agrees with the table, when a snapshot is present", (t) => {
  const path = "C:/Users/roesl/AppData/Local/FactoryGame/Saved/AIFactoryCopilot/Snapshots/latest.json";
  if (!fs.existsSync(path)) {
    t.skip("no local snapshot to check against");
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(path, "utf8"));
  const result = crossCheckTransport(snapshot);
  assert.equal(result.problems.length, 0, result.problems.join("; "));
  assert.ok(result.checked_count >= 10, `only ${result.checked_count} tiers matched`);
});
