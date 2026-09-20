import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { censusExtractedSupply, planSupplyDrivenProduction } from "../lib/supply-production.mjs";

const ORE = "/Game/Desc_OreIron.Desc_OreIron_C";
const INGOT = "/Game/Desc_IronIngot.Desc_IronIngot_C";

function minerNode(id, perMinute) {
  return {
    actor_id: id,
    kind: "buildable",
    role: "factory",
    class_path: "/Game/Build_MinerMk3.Build_MinerMk3_C",
    inventory_by_item: new Map(),
    raw: { extractor: { extractable_resource_actor_id: `${id}_node`, extraction_per_minute: perMinute } },
  };
}
function oreNode(id) {
  return { actor_id: `${id}_node`, kind: "resource_node", raw: { resource_class: ORE } };
}
function beltNode(id, perMinute) {
  return {
    actor_id: id,
    kind: "buildable",
    role: "conveyor",
    class_path: "/Game/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
    conveyor: { items_per_minute: perMinute },
    raw: {},
  };
}

function makeGraph({ miners = [600, 600], beltRate = 60 } = {}) {
  const nodes = new Map();
  miners.forEach((rate, index) => {
    nodes.set(`miner_${index}`, minerNode(`miner_${index}`, rate));
    nodes.set(`miner_${index}_node`, oreNode(`miner_${index}`));
  });
  if (beltRate) nodes.set("belt", beltNode("belt", beltRate));
  return {
    nodes,
    // solveProductionPlan reaches into the power solver, which iterates
    // graph.circuits. A stub without it made the probe throw - which the
    // module now turns into a refusal rather than an exception, but the
    // fixture should still exercise the real path.
    circuits: new Map(),
    itemsByClass: new Map([
      [ORE, { name: "Iron Ore", class_path: ORE }],
      [INGOT, { name: "Iron Ingot", class_path: INGOT }],
    ]),
    recipesByClass: new Map(),
    snapshot: {
      content: {
        availability_known: true,
        recipes: [
          {
            class_path: "/Game/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C",
            recipe_class: "/Game/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C",
            name: "Conveyor Belt Mk.1",
            available: true,
            produced_in: ["/Game/BP_BuildGun.BP_BuildGun_C"],
            products: [{ item_class: "/Game/Desc_ConveyorBeltMk1.Desc_ConveyorBeltMk1_C" }],
          },
        ],
        items: [{ class_path: ORE, name: "Iron Ore" }, { class_path: INGOT, name: "Iron Ingot" }],
      },
    },
  };
}

test("the census reports what is mined and what can actually leave the miner", () => {
  // A Mk.3 miner on a pure node out-produces a Mk.1 belt. Planning against the
  // mining rate rather than the deliverable rate overstates the factory, so
  // both numbers are reported and the clamp is flagged.
  const census = censusExtractedSupply(makeGraph({ miners: [600, 600], beltRate: 60 }));
  assert.equal(census.supply.length, 1);
  const iron = census.supply[0];
  assert.equal(iron.item_class, ORE);
  assert.equal(iron.extractors, 2);
  assert.equal(iron.mined_per_minute, 1200, "unclamped mining rate is preserved");
  assert.equal(iron.deliverable_per_minute, 120, "two miners clamped to one Mk.1 belt each");
  assert.equal(iron.clamped_by_belt, true);
  assert.equal(census.belt_clamp_applied, true);
});

test("no captured belt means no clamp, and that is stated rather than assumed", () => {
  // Filling in a vanilla 60/min here would be a guess about a modded world.
  const census = censusExtractedSupply(makeGraph({ miners: [600], beltRate: null }));
  assert.equal(census.belt_clamp_applied, false);
  assert.equal(census.supply[0].deliverable_per_minute, 600);
  assert.equal(census.supply[0].clamped_by_belt, false);
});

test("an extractor whose rate cannot be resolved is named, not dropped", () => {
  const graph = makeGraph({ miners: [600] });
  graph.nodes.set("broken", {
    actor_id: "broken",
    kind: "buildable",
    role: "factory",
    inventory_by_item: new Map(),
    raw: { extractor: { extractable_resource_actor_id: "broken_node" } },
  });
  graph.nodes.set("broken_node", { actor_id: "broken_node", kind: "resource_node", raw: { resource_class: ORE } });
  const census = censusExtractedSupply(graph);
  assert.ok(
    census.unresolved.some((entry) => entry.actor_id === "broken"),
    "the unresolved extractor is reported",
  );
  // And it does not silently inflate the supply figure.
  assert.equal(census.supply[0].extractors, 1);
});

test("an empty world refuses rather than sizing a factory from nothing", () => {
  const plan = planSupplyDrivenProduction({ nodes: new Map(), itemsByClass: new Map(), snapshot: { content: {} } }, {
    item_name: "Iron Ingot",
  });
  assert.equal(plan.planned, false);
  assert.deepEqual(plan.missing, ["captured_extractors"]);
});

test("naming no product refuses and says what supply is available", () => {
  const plan = planSupplyDrivenProduction(makeGraph(), {});
  assert.equal(plan.planned, false);
  assert.deepEqual(plan.missing, ["item_name"]);
  assert.deepEqual(plan.available_supply, ["Iron Ore"]);
});

test("an ore that is not being mined refuses by name", () => {
  const plan = planSupplyDrivenProduction(makeGraph(), {
    item_name: "Iron Ingot",
    ore_class: "/Game/Desc_OreGold.Desc_OreGold_C",
  });
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /not being extracted/);
});

test("a product with no resolvable chain refuses and shows what it tried", () => {
  // The stub graph has no smelter recipe, so the chain cannot reduce to ore.
  // Refusing with the attempts listed beats inventing a machine count.
  const plan = planSupplyDrivenProduction(makeGraph(), { item_name: "Iron Ingot" });
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /no extracted ore feeds that product/);
  assert.ok(Array.isArray(plan.attempts) && plan.attempts.length > 0, "it says what it tried");
  assert.equal(plan.attempts[0].ore, ORE);
});

test("the module never invents a fractional machine", () => {
  // Rounding down is the rule: supply that buys 3.7 machines buys three, and
  // the spare ore is reported. A fourth machine would starve.
  const source = new URL("../lib/supply-production.mjs", import.meta.url);
  const text = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n");
  assert.match(text, /const machines = Math\.floor\(supported\);/);
  assert.match(text, /ore_left_over_per_minute/);
  assert.match(text, /supply_supports_less_than_one_machine/);
});
