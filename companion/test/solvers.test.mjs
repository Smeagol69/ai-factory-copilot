import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  analyzeSnapshot,
  solveBottlenecks,
  solveBuildCost,
  solveItemBalance,
  solveMachineRates,
  solvePowerCircuits,
  solveRecipeOptions,
  solveSiteSelection,
  solveTransportCapacity,
  solveUnlockStatus,
} from "../lib/solvers.mjs";
import {
  BELT_INGOT,
  BELT_ORE,
  CONSTRUCTOR,
  GENERATOR,
  MINER,
  PIPELINE,
  REFINERY,
  SMELTER,
  buildFactorySnapshot,
} from "./fixtures/factory.mjs";

const graphOf = (overrides) => buildGraph(buildFactorySnapshot(overrides));

/* ---------------- per-minute transformation solver ---------------- */

test("derives manufacturer rates from the live cycle time", () => {
  const rates = solveMachineRates(graphOf());
  const smelter = rates.machines.find((machine) => machine.actor_id === SMELTER);

  assert.equal(smelter.cycles_per_minute, 30);
  assert.equal(smelter.theoretical_inputs[0].item_class, "Desc_OreIron");
  assert.equal(smelter.theoretical_inputs[0].display_units_per_minute, 30);
  assert.equal(smelter.theoretical_outputs[0].display_units_per_minute, 30);
  assert.equal(smelter.rate_basis, "live_production_cycle_seconds_includes_overclock");

  const constructor = rates.machines.find((machine) => machine.actor_id === CONSTRUCTOR);
  assert.equal(constructor.cycles_per_minute, 15);
  assert.equal(constructor.theoretical_outputs[0].display_units_per_minute, 15);
});

test("scales observed output by reported productivity", () => {
  const rates = solveMachineRates(graphOf());
  const smelter = rates.machines.find((machine) => machine.actor_id === SMELTER);
  const constructor = rates.machines.find((machine) => machine.actor_id === CONSTRUCTOR);

  assert.equal(smelter.productivity, 0);
  assert.equal(smelter.observed_outputs[0].display_units_per_minute, 0);
  assert.equal(constructor.observed_outputs[0].display_units_per_minute, 15);
});

test("applies production boost to products only", () => {
  const snapshot = buildFactorySnapshot();
  const constructor = snapshot.actors.find((actor) => actor.actor_id === CONSTRUCTOR);
  constructor.factory.current_production_boost = 2;

  const rates = solveMachineRates(buildGraph(snapshot));
  const machine = rates.machines.find((entry) => entry.actor_id === CONSTRUCTOR);
  assert.equal(machine.theoretical_inputs[0].display_units_per_minute, 15);
  assert.equal(machine.theoretical_outputs[0].display_units_per_minute, 15);
  assert.equal(machine.outputs_after_production_boost[0].display_units_per_minute, 30);
});

test("converts liquid registry amounts to cubic metres per minute", () => {
  const rates = solveMachineRates(graphOf());
  const refinery = rates.machines.find((machine) => machine.actor_id === REFINERY);
  const oil = refinery.theoretical_inputs[0];

  assert.equal(oil.item_class, "Desc_LiquidOil");
  assert.equal(oil.registry_units_per_minute, 30000);
  assert.equal(oil.display_units_per_minute, 30);
  assert.equal(oil.display_unit, "cubic_meters");
  assert.equal(refinery.theoretical_outputs[0].display_unit, "items");
  assert.equal(refinery.theoretical_outputs[0].display_units_per_minute, 20);
});

test("prefers the authoritative extractor rate over derived arithmetic", () => {
  const rates = solveMachineRates(graphOf());
  const miner = rates.machines.find((machine) => machine.actor_id === MINER);

  assert.equal(miner.reported_extraction_per_minute, 60);
  assert.equal(miner.theoretical_outputs[0].display_units_per_minute, 60);
  assert.equal(miner.rate_basis, "authoritative_extractor_extraction_per_minute");
  assert.equal(miner.certainty, "authoritative");
});

test("takes the extracted item from the resource node, not the output inventory", () => {
  const rates = solveMachineRates(graphOf());
  const miner = rates.machines.find((machine) => machine.actor_id === MINER);

  assert.deepEqual(miner.extracted_item_classes, ["Desc_OreIron"]);
  assert.equal(miner.extracted_item_source, "authoritative_resource_class_of_the_extracted_node");
});

test("falls back to per-cycle yield when no per-minute rate was captured", () => {
  const snapshot = buildFactorySnapshot();
  delete snapshot.actors.find((actor) => actor.actor_id === MINER).extractor.extraction_per_minute;

  const rates = solveMachineRates(buildGraph(snapshot));
  const miner = rates.machines.find((machine) => machine.actor_id === MINER);
  assert.equal(miner.items_per_cycle, 1);
  assert.equal(miner.cycles_per_minute, 60);
  assert.equal(miner.theoretical_outputs[0].display_units_per_minute, 60);
  assert.equal(miner.rate_basis, "extractor_items_per_cycle_and_live_cycle_seconds");
  assert.equal(miner.certainty, "calculated");
});

test("falls back to reflection when the extractor block is absent entirely", () => {
  const snapshot = buildFactorySnapshot();
  delete snapshot.actors.find((actor) => actor.actor_id === MINER).extractor;

  const rates = solveMachineRates(buildGraph(snapshot));
  const miner = rates.machines.find((machine) => machine.actor_id === MINER);
  assert.equal(miner.items_per_cycle, 1);
  assert.equal(miner.theoretical_outputs[0].display_units_per_minute, 60);
  assert.equal(miner.extracted_item_source, "observed_in_live_output_inventory");
});

test("reports a machine with no derivable rate instead of assuming one", () => {
  const rates = solveMachineRates(graphOf());
  const unresolved = rates.unresolved_machines.find((entry) => entry.actor_id === GENERATOR);

  assert.equal(rates.machine_count, 4);
  assert.equal(
    unresolved.reason,
    "extractor_yield_absent_from_extractor_fields_and_reflected_properties",
  );
  assert.ok(!rates.machines.some((machine) => machine.actor_id === GENERATOR));
});

test("reports a manufacturer with no selected recipe as unresolved", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.actors.find((actor) => actor.actor_id === SMELTER).manufacturer.recipe_class = "";

  const rates = solveMachineRates(buildGraph(snapshot));
  const unresolved = rates.unresolved_machines.find((entry) => entry.actor_id === SMELTER);
  assert.equal(unresolved.reason, "manufacturer_has_no_selected_recipe");
});

test("reports a recipe compacted out of the catalog as unresolved", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.content.recipes = snapshot.content.recipes.filter(
    (recipe) => recipe.class_path !== "Recipe_IngotIron",
  );

  const rates = solveMachineRates(buildGraph(snapshot));
  const unresolved = rates.unresolved_machines.find((entry) => entry.actor_id === SMELTER);
  assert.equal(unresolved.reason, "recipe_not_present_in_snapshot_catalog");
});

test("restricts machine rates to requested actor ids", () => {
  const rates = solveMachineRates(graphOf(), { actor_ids: [SMELTER] });
  assert.equal(rates.machines.length, 1);
  assert.equal(rates.machines[0].actor_id, SMELTER);
});

/* ---------------- item balance ---------------- */

test("nets production against consumption per item", () => {
  const balance = solveItemBalance(graphOf());
  const byItem = new Map(balance.items.map((entry) => [entry.item_class, entry]));

  assert.equal(byItem.get("Desc_OreIron").produced_display_units_per_minute, 60);
  assert.equal(byItem.get("Desc_OreIron").consumed_display_units_per_minute, 30);
  assert.equal(byItem.get("Desc_OreIron").net_display_units_per_minute, 30);
  assert.equal(byItem.get("Desc_OreIron").status, "surplus");

  assert.equal(byItem.get("Desc_IronIngot").net_display_units_per_minute, 15);
  assert.equal(byItem.get("Desc_LiquidOil").net_display_units_per_minute, -30);
  assert.equal(byItem.get("Desc_LiquidOil").status, "deficit");
  assert.equal(byItem.get("Desc_LiquidOil").display_unit, "cubic_meters");
});

test("attributes each item balance to the contributing actors", () => {
  const balance = solveItemBalance(graphOf(), { item_class: "Desc_IronIngot" });
  assert.equal(balance.items.length, 1);
  assert.deepEqual(balance.items[0].producer_actor_ids, [SMELTER]);
  assert.deepEqual(balance.items[0].consumer_actor_ids, [CONSTRUCTOR]);
});

test("warns that balances are lower bounds when machines are unresolved", () => {
  const balance = solveItemBalance(graphOf());
  assert.equal(balance.coverage.unresolved_machines, 1);
  assert.match(balance.coverage.warning, /lower bounds/);
});

/* ---------------- recipe options ---------------- */

test("ranks recipes producing an item by output rate", () => {
  const options = solveRecipeOptions(graphOf(), { item_class: "Desc_IronRod" });

  assert.equal(options.recipes_producing_item[0].recipe_class, "Recipe_Alternate_IronRod");
  assert.equal(options.recipes_producing_item[0].outputs[0].display_units_per_minute, 48);
  assert.equal(options.recipes_producing_item[1].recipe_class, "Recipe_IronRod");
  assert.equal(options.recipes_producing_item[1].outputs[0].display_units_per_minute, 15);
});

test("uses exact recipe-manager availability for used and unused recipes", () => {
  const options = solveRecipeOptions(graphOf(), { item_class: "Desc_IronRod" });
  const inUse = options.recipes_producing_item.find((entry) => entry.recipe_class === "Recipe_IronRod");
  const unused = options.recipes_producing_item.find(
    (entry) => entry.recipe_class === "Recipe_Alternate_IronRod",
  );

  assert.equal(inUse.machines_currently_using_it, 1);
  assert.equal(inUse.availability_evidence, "AFGRecipeManager runtime state");
  assert.equal(inUse.unlock_status, "available");
  assert.equal(unused.machines_currently_using_it, 0);
  assert.equal(unused.availability_evidence, "AFGRecipeManager runtime state");
  assert.equal(unused.unlock_status, "available");
});

test("falls back to live usage evidence for snapshots made before availability capture", () => {
  const snapshot = buildFactorySnapshot();
  delete snapshot.content.availability_known;
  delete snapshot.content.available_recipe_count;
  delete snapshot.content.unavailable_recipe_count;
  for (const recipe of snapshot.content.recipes) delete recipe.available;

  const options = solveRecipeOptions(buildGraph(snapshot), {
    item_class: "Desc_IronRod",
  });
  const inUse = options.recipes_producing_item.find(
    (entry) => entry.recipe_class === "Recipe_IronRod",
  );
  const unused = options.recipes_producing_item.find(
    (entry) => entry.recipe_class === "Recipe_Alternate_IronRod",
  );
  assert.equal(inUse.availability_evidence, "in_use_in_world_so_available_to_this_save");
  assert.equal(inUse.unlock_status, "available");
  assert.equal(unused.unlock_status, "unknown");
});

test("lists recipes that consume the queried item", () => {
  const options = solveRecipeOptions(graphOf(), { item_class: "Desc_IronIngot" });
  const consuming = options.recipes_consuming_item.map((entry) => entry.recipe_class).sort();
  assert.deepEqual(consuming, ["Recipe_Alternate_IronRod", "Recipe_IronRod"]);
});

test("searches recipes by name substring", () => {
  const options = solveRecipeOptions(graphOf(), { name_contains: "plastic" });
  assert.equal(options.recipes_producing_item.length, 1);
  assert.equal(options.recipes_producing_item[0].recipe_class, "Recipe_Plastic");
});

/* ---------------- transport capacity ---------------- */

test("flags a belt whose supply exceeds its capacity", () => {
  const transport = solveTransportCapacity(graphOf(), { only_problems: true });

  assert.equal(transport.conveyors.length, 1);
  const belt = transport.conveyors[0];
  assert.equal(belt.actor_id, BELT_INGOT);
  assert.equal(belt.capacity_display_units_per_minute, 20);
  assert.equal(belt.upstream_supply_display_units_per_minute, 30);
  assert.equal(belt.downstream_demand_display_units_per_minute, 15);
  assert.equal(belt.over_capacity, true);
  assert.equal(belt.findings[0].finding, "supply_exceeds_segment_capacity");
  assert.equal(belt.findings[0].excess_display_units_per_minute, 10);
  assert.equal(belt.utilization_percent_of_capacity, 150);
  assert.equal(belt.backed_up_evidence, "segment_reports_no_available_space_at_capture");
});

test("leaves a belt within capacity unflagged", () => {
  const transport = solveTransportCapacity(graphOf());
  const belt = transport.conveyors.find((entry) => entry.actor_id === BELT_ORE);

  assert.equal(belt.capacity_display_units_per_minute, 60);
  assert.equal(belt.upstream_supply_display_units_per_minute, 60);
  assert.equal(belt.over_capacity, false);
  assert.deepEqual(belt.findings, []);
  assert.equal(belt.backed_up_evidence, null);
});

test("flags a belt whose downstream demand exceeds its supply", () => {
  const snapshot = buildFactorySnapshot();
  // Halve the smelter's rate so the constructor behind the belt out-demands it.
  snapshot.actors.find((actor) => actor.actor_id === SMELTER).factory.production_cycle_seconds = 8;
  snapshot.actors.find((actor) => actor.actor_id === BELT_INGOT).transport.reported_speed = 600;

  const transport = solveTransportCapacity(buildGraph(snapshot), { only_problems: false });
  const belt = transport.conveyors.find((entry) => entry.actor_id === BELT_INGOT);

  assert.equal(belt.upstream_supply_display_units_per_minute, 7.5);
  assert.equal(belt.downstream_demand_display_units_per_minute, 15);
  assert.equal(belt.under_supplied, true);
  assert.equal(belt.findings[0].finding, "downstream_demand_exceeds_supply");
  assert.equal(belt.findings[0].shortfall_display_units_per_minute, 7.5);
});

test("reports pipeline capacity and declares head lift unknown", () => {
  const transport = solveTransportCapacity(graphOf(), { only_problems: false });
  const pipe = transport.pipelines.find((entry) => entry.actor_id === PIPELINE);

  assert.equal(pipe.capacity_display_units_per_minute, 300);
  assert.equal(pipe.downstream_demand_display_units_per_minute, 30);
  assert.equal(pipe.observed_content, 8);
  assert.equal(pipe.headlift_status, "not_present_in_snapshot");
});

/* ---------------- power ---------------- */

test("computes circuit headroom, findings, and battery runtime", () => {
  const power = solvePowerCircuits(graphOf());

  assert.equal(power.circuit_count, 2);
  const deficit = power.circuits[0];
  assert.equal(deficit.circuit_id, 1);
  assert.equal(deficit.headroom_mw, -25);
  assert.equal(deficit.utilization_percent, 133.333);
  assert.equal(deficit.findings[0].finding, "consumption_exceeds_production_capacity");
  assert.equal(deficit.findings[0].deficit_mw, 25);
  assert.equal(deficit.battery_runtime_seconds_at_current_deficit, 720);
  assert.equal(deficit.member_count, 2);

  const healthy = power.circuits[1];
  assert.equal(healthy.circuit_id, 2);
  assert.equal(healthy.headroom_mw, 50);
  assert.deepEqual(healthy.findings, []);
});

test("reports a triggered fuse as an invalid finding", () => {
  const snapshot = buildFactorySnapshot();
  for (const actor of snapshot.actors) {
    for (const connection of actor.connections ?? []) {
      if (connection.kind === "power" && connection.circuit.circuit_id === 2) {
        connection.circuit = { ...connection.circuit, fuse_triggered: true };
      }
    }
  }

  const power = solvePowerCircuits(buildGraph(snapshot), { circuit_id: 2 });
  assert.equal(power.circuits.length, 1);
  assert.equal(power.circuits[0].findings[0].finding, "fuse_triggered");
  assert.equal(power.circuits[0].findings[0].severity, "invalid");
});

test("ranks circuit members by producing draw", () => {
  const power = solvePowerCircuits(graphOf(), { circuit_id: 1 });
  assert.equal(power.circuits[0].members[0].actor_id, CONSTRUCTOR);
  assert.equal(power.circuits[0].members[0].producing_power_consumption_mw, 4);
});

/* ---------------- bottlenecks ---------------- */

test("classifies a starved machine and names the upstream root cause", () => {
  const bottlenecks = solveBottlenecks(graphOf());
  const smelter = bottlenecks.reports.find((report) => report.actor_id === SMELTER);

  assert.equal(smelter.local_causes[0].cause, "input_starved");
  assert.equal(smelter.local_causes[0].severity, "inefficient");
  assert.deepEqual(smelter.local_causes[0].missing_items, [
    { item_class: "Desc_OreIron", item_name: "Iron Ore" },
  ]);
  assert.equal(smelter.root_cause_actor_id, MINER);
  assert.deepEqual(smelter.causal_chain_actor_ids, [SMELTER, MINER]);
  assert.equal(smelter.root_causes[0].cause, "standby_without_captured_reason");
});

test("classifies power deficit and a disconnected output locally", () => {
  const bottlenecks = solveBottlenecks(graphOf());
  const constructor = bottlenecks.reports.find((report) => report.actor_id === CONSTRUCTOR);
  const causes = constructor.local_causes.map((entry) => entry.cause).sort();

  assert.deepEqual(causes, ["output_port_not_connected", "power_capacity_deficit"]);
  // Neither cause propagates, so the machine is its own root.
  assert.equal(constructor.root_cause_actor_id, CONSTRUCTOR);
});

test("treats an unexplained standby as unknown rather than inventing a reason", () => {
  const bottlenecks = solveBottlenecks(graphOf());
  const miner = bottlenecks.reports.find((report) => report.actor_id === MINER);

  assert.equal(miner.local_causes[0].cause, "standby_without_captured_reason");
  assert.equal(miner.local_causes[0].severity, "unknown");
});

test("reports a manufacturer with no recipe as invalid", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.actors.find((actor) => actor.actor_id === SMELTER).manufacturer.recipe_class = "";

  const bottlenecks = solveBottlenecks(buildGraph(snapshot));
  const smelter = bottlenecks.reports.find((report) => report.actor_id === SMELTER);
  assert.ok(smelter.local_causes.some((entry) => entry.cause === "no_recipe_selected"));
});

test("flags an error status and a fuse ahead of softer causes", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.actors.find((actor) => actor.actor_id === REFINERY).factory.production_status = "IS_ERROR";

  const bottlenecks = solveBottlenecks(buildGraph(snapshot));
  const refinery = bottlenecks.reports.find((report) => report.actor_id === REFINERY);
  assert.equal(refinery.local_causes[0].cause, "machine_reports_error_status");
  assert.equal(bottlenecks.reports[0].local_causes[0].severity, "invalid");
});

test("omits healthy machines unless asked for them", () => {
  const withoutHealthy = solveBottlenecks(graphOf());
  const withHealthy = solveBottlenecks(graphOf(), { include_healthy: true });

  assert.ok(!withoutHealthy.reports.some((report) => report.actor_id === REFINERY));
  const refinery = withHealthy.reports.find((report) => report.actor_id === REFINERY);
  assert.equal(refinery.healthy, true);
  assert.deepEqual(refinery.local_causes, []);
});

test("counts causes across the whole snapshot", () => {
  const bottlenecks = solveBottlenecks(graphOf());
  assert.equal(bottlenecks.reported_machine_count, 4);
  assert.equal(bottlenecks.cause_counts.power_capacity_deficit, 2);
  assert.equal(bottlenecks.cause_counts.input_starved, 1);
});

/* ---------------- build cost and unlocks ---------------- */

test("computes build cost against captured player inventory", () => {
  const cost = solveBuildCost(graphOf(), {
    class_path: "/Game/FactoryGame/Buildable/Factory/SmelterMk1.Build_SmelterMk1_C",
    count: 2,
  });

  assert.equal(cost.resolved, true);
  assert.equal(cost.recipe_class, "Recipe_SmelterMk1");
  const rod = cost.ingredients.find((entry) => entry.item_class === "Desc_IronRod");
  const plate = cost.ingredients.find((entry) => entry.item_class === "Desc_IronPlate");

  assert.equal(rod.required_registry_units, 10);
  assert.equal(rod.held_in_player_inventories_registry_units, 5);
  assert.equal(rod.shortfall_registry_units, 5);
  assert.equal(plate.shortfall_registry_units, 0);
  assert.equal(cost.affordable_from_captured_player_inventories, false);
});

test("resolves build cost directly from a recipe class", () => {
  const cost = solveBuildCost(graphOf(), { recipe_class: "Recipe_SmelterMk1" });
  assert.equal(cost.resolved_from, "recipe_class");
  assert.equal(cost.affordable_from_captured_player_inventories, true);
});

test("reports an unknown build cost instead of returning zero", () => {
  const cost = solveBuildCost(graphOf(), { class_path: "Build_NotInSnapshot_C" });
  assert.equal(cost.resolved, false);
  assert.equal(cost.certainty, "unknown");
  assert.match(cost.reason, /no_existing_actor_of_that_class/);
});

test("declares held amounts unknown when no player was captured", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.actors = snapshot.actors.filter((actor) => actor.kind !== "player");

  const cost = solveBuildCost(buildGraph(snapshot), { recipe_class: "Recipe_SmelterMk1" });
  assert.equal(cost.inventory_scope.certainty, "unknown");
  assert.match(cost.inventory_scope.note, /unknown rather than zero/);
});

test("reports objectives and authoritative recipe-manager availability", () => {
  const unlocks = solveUnlockStatus(graphOf());
  assert.equal(unlocks.highest_available_tech_tier, 5);
  assert.equal(unlocks.purchased_schematic_count, 1);
  assert.equal(unlocks.onboarding.current_step.title, "Build the HUB");
  assert.equal(unlocks.visible_ui.rendered_text[1].text, "Build the HUB");
  assert.equal(unlocks.recipe_unlock_mapping, "authoritative_AFGRecipeManager_runtime_state");
  assert.equal(unlocks.available_recipe_count, 5);
  assert.equal(unlocks.unavailable_recipe_count, 0);
});

test("labels a locked registered recipe unavailable instead of guessing", () => {
  const snapshot = buildFactorySnapshot();
  const locked = snapshot.content.recipes.find(
    (recipe) => recipe.class_path === "Recipe_Alternate_IronRod",
  );
  locked.available = false;
  snapshot.content.available_recipe_count = 4;
  snapshot.content.unavailable_recipe_count = 1;

  const options = solveRecipeOptions(buildGraph(snapshot), {
    item_class: "Desc_IronRod",
  });
  const result = options.recipes_producing_item.find(
    (recipe) => recipe.recipe_class === locked.class_path,
  );
  assert.equal(result.unlock_status, "unavailable");
  assert.equal(result.availability_evidence, "AFGRecipeManager runtime state");
});

/* ---------------- whole report ---------------- */

test("analyzeSnapshot runs every solver over one snapshot", () => {
  const analysis = analyzeSnapshot(buildFactorySnapshot());

  assert.equal(analysis.schema, "aifactory.analysis");
  assert.equal(analysis.world_revision, 41);
  assert.equal(analysis.machine_rates.machine_count, 4);
  assert.equal(analysis.power_circuits.circuit_count, 2);
  assert.equal(analysis.bottlenecks.reported_machine_count, 4);
  assert.equal(analysis.graph_completeness.node_count, 10);
  assert.equal(analysis.graph_completeness.unresolved_connection_count, 0);
});

test("every solver survives an empty snapshot", () => {
  const graph = buildGraph({ world_revision: 1 });
  assert.equal(solveMachineRates(graph).machine_count, 0);
  assert.deepEqual(solveItemBalance(graph).items, []);
  assert.deepEqual(solvePowerCircuits(graph).circuits, []);
  assert.deepEqual(solveBottlenecks(graph).reports, []);
  assert.deepEqual(solveTransportCapacity(graph).conveyors, []);
  assert.equal(solveRecipeOptions(graph, { item_class: "Desc_Anything" }).catalog_recipe_count, 0);
  assert.equal(solveUnlockStatus(graph).purchased_schematic_count, 0);
});

test("a resource entry reports where the nearest node is, not just how far", () => {
  // Reporting distance without a coordinate left a build request on "the nearest
  // iron node" with nowhere to go: the model tried to triangulate a position from
  // distances alone, correctly refused to trust the result, and the question cost
  // real money for no action. The fixture's own node is occupied, so this builds
  // a minimal world with a free one.
  const snapshot = buildFactorySnapshot();
  snapshot.actors = [
    ...snapshot.actors,
    {
      actor_id: "/Game/Test.Test:PersistentLevel.BP_FreeIronNode_C_1",
      name: "BP_FreeIronNode_C_1",
      class_path: "/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C",
      owner_mod: "FactoryGame",
      kind: "resource_node",
      location: { x: 5000, y: -2500, z: 120 },
      occupied: false,
      resource_class: "Desc_OreIron",
      resource_name: "Iron Ore",
      node_type: "Node",
      purity: "RP_Normal",
      amount_type: "RA_Infinite",
      has_resources: true,
    },
  ];

  const result = solveSiteSelection(buildGraph(snapshot), {});
  const entries = result.sites.flatMap((site) => site.resources_in_radius ?? []);
  assert.ok(entries.length > 0, "a free node should produce at least one scored site");

  const iron = entries.find((entry) => entry.resource_name === "Iron Ore");
  assert.ok(iron, "the free iron node should be reported");
  assert.ok(iron.nearest_actor_id, "names which node is nearest");
  assert.ok(Number.isFinite(iron.nearest_distance_meters), "says how far it is");
  assert.deepEqual(iron.nearest_location_cm, { x: 5000, y: -2500, z: 120 }, "and says where it is");
  assert.equal(iron.nearest_purity, "normal", "purity comes through normalised");
});
