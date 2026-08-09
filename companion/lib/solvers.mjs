/**
 * Deterministic factory solvers.
 *
 * The language model calls these instead of performing factory arithmetic
 * itself. Every result carries its source and certainty, and every value the
 * snapshot does not support is reported as an explicit unknown with the reason
 * and the field that was missing.
 */

import { costAgainstInventory } from "./blueprints.mjs";
import {
  buildGraph,
  distanceMeters,
  finiteNumber,
  finitePositive,
  normalizeProductionStatus,
  reflectedNumber,
  traceDownstream,
  traceUpstream,
} from "./graph.mjs";

const LIQUID_OR_GAS_REGISTRY_UNITS_PER_CUBIC_METER = 1000;
const MEGAWATT_HOURS_TO_SECONDS = 3600;
const MAXIMUM_ROOT_CAUSE_DEPTH = 12;

function round(value, decimals = 6) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function recipeAvailability(recipe, inUseInWorld = false) {
  if (typeof recipe?.available === "boolean") {
    return {
      unlock_status: recipe.available ? "available" : "unavailable",
      availability_evidence: "AFGRecipeManager runtime state",
      unlock_reason: recipe.available
        ? "The live recipe manager marks this recipe available in the loaded save."
        : "The live recipe manager marks this recipe unavailable in the loaded save.",
      certainty: "authoritative",
    };
  }
  if (inUseInWorld) {
    return {
      unlock_status: "available",
      availability_evidence: "in_use_in_world_so_available_to_this_save",
      unlock_reason: "A captured live machine is already using this recipe.",
      certainty: "authoritative",
    };
  }
  return {
    unlock_status: "unknown",
    availability_evidence: "registered_in_content_registry",
    unlock_reason:
      "This snapshot predates recipe-manager availability fields, so registration alone does not prove the save unlocked it.",
    certainty: "unknown",
  };
}

/**
 * Liquid and gas amounts are stored in the registry as thousandths of a cubic
 * metre. Comparing a recipe amount with a pipeline flow limit is only valid
 * after this conversion, so both the raw and converted values are reported.
 */
function itemUnitScale(graph, itemClass) {
  const form = String(graph.itemsByClass.get(itemClass)?.form ?? "").toUpperCase();
  if (form.includes("LIQUID") || form.includes("GAS")) {
    return {
      form,
      display_unit: "cubic_meters",
      registry_units_per_display_unit: LIQUID_OR_GAS_REGISTRY_UNITS_PER_CUBIC_METER,
    };
  }
  if (!form || form.includes("INVALID")) {
    return { form: form || null, display_unit: "registry_units_form_unknown", registry_units_per_display_unit: 1 };
  }
  return { form, display_unit: "items", registry_units_per_display_unit: 1 };
}

function rateEntry(graph, entry, unitsPerMinuteMultiplier) {
  const amount = finiteNumber(entry?.amount);
  if (amount === null) return null;
  const scale = itemUnitScale(graph, entry.item_class);
  const registryUnitsPerMinute = amount * unitsPerMinuteMultiplier;
  return {
    item_class: entry.item_class ?? null,
    item_name: entry.item_name ?? graph.itemsByClass.get(entry.item_class)?.name ?? null,
    amount_per_cycle: amount,
    registry_units_per_minute: round(registryUnitsPerMinute),
    display_units_per_minute: round(registryUnitsPerMinute / scale.registry_units_per_display_unit),
    display_unit: scale.display_unit,
    form: scale.form,
  };
}

function rateEntries(graph, entries, unitsPerMinuteMultiplier) {
  const result = [];
  for (const entry of entries ?? []) {
    const converted = rateEntry(graph, entry, unitsPerMinuteMultiplier);
    if (converted) result.push(converted);
  }
  return result;
}

function playerInventories(graph) {
  const totals = new Map();
  const playerIds = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== "player") continue;
    playerIds.push(node.actor_id);
    for (const stack of node.raw?.player_inventory ?? []) {
      const itemClass = stack?.item_class;
      const amount = finiteNumber(stack?.amount);
      if (!itemClass || amount === null) continue;
      totals.set(itemClass, (totals.get(itemClass) ?? 0) + amount);
    }
  }
  return { totals, playerIds };
}

/* ------------------------------------------------------------------ *
 * 1. Exact per-minute transformation solver
 * ------------------------------------------------------------------ */

/**
 * Per-machine rates from the live cycle time, which already accounts for
 * overclocking. Production boost is applied to products only.
 */
export function solveMachineRates(graph, { actor_ids = null } = {}) {
  const requested = actor_ids ? new Set(actor_ids) : null;
  const machines = [];
  const unresolved = [];

  for (const node of graph.nodes.values()) {
    if (requested && !requested.has(node.actor_id)) continue;
    if (node.role !== "manufacturer" && node.role !== "factory") continue;

    const factory = node.raw?.factory ?? {};
    const cycleSeconds = finitePositive(factory.production_cycle_seconds);
    const productivity = finiteNumber(factory.productivity);
    const productionBoost = finitePositive(factory.current_production_boost) ?? 1;

    const common = {
      actor_id: node.actor_id,
      name: node.name,
      class_path: node.class_path,
      owner_mod: node.owner_mod,
      role: node.role,
      production_status: node.production_status,
      is_producing: node.is_producing,
      productivity,
      current_potential: finiteNumber(factory.current_potential),
      max_potential: finiteNumber(factory.max_potential),
      reported_production_boost: productionBoost,
      cycle_seconds: cycleSeconds,
      default_cycle_seconds: finiteNumber(factory.default_production_cycle_seconds),
      power_circuit_id: node.power_circuit_id,
    };

    if (node.role === "manufacturer") {
      const recipe = graph.recipesByClass.get(node.recipe_class);
      if (!node.recipe_class) {
        unresolved.push({ ...common, reason: "manufacturer_has_no_selected_recipe" });
        continue;
      }
      if (!recipe) {
        unresolved.push({ ...common, recipe_class: node.recipe_class, reason: "recipe_not_present_in_snapshot_catalog" });
        continue;
      }
      if (cycleSeconds === null) {
        unresolved.push({ ...common, recipe_class: node.recipe_class, reason: "live_production_cycle_seconds_unavailable" });
        continue;
      }

      const cyclesPerMinute = 60 / cycleSeconds;
      machines.push({
        ...common,
        recipe_class: node.recipe_class,
        recipe_name: node.recipe_name ?? recipe.name ?? null,
        recipe_owner_mod: recipe.owner_mod ?? null,
        cycles_per_minute: round(cyclesPerMinute),
        theoretical_inputs: rateEntries(graph, recipe.ingredients, cyclesPerMinute),
        theoretical_outputs: rateEntries(graph, recipe.products, cyclesPerMinute),
        outputs_after_production_boost: rateEntries(graph, recipe.products, cyclesPerMinute * productionBoost),
        observed_outputs:
          productivity === null
            ? null
            : rateEntries(graph, recipe.products, cyclesPerMinute * productionBoost * productivity),
        rate_basis: "live_production_cycle_seconds_includes_overclock",
        source: "deterministic_arithmetic_from_live_cycle_and_registered_recipe",
        certainty: "calculated",
        caveat:
          "A mod can override recipe consumption or output semantics; an explicit adapter must confirm nonstandard behavior.",
      });
      continue;
    }

    // Extractors have no recipe. Prefer the extractor's own per-minute
    // accessor, fall back to per-cycle yield, then to reflection.
    const extractor = node.raw?.extractor ?? null;
    const reportedPerMinute = finitePositive(extractor?.extraction_per_minute);
    const itemsPerCycle =
      finitePositive(extractor?.items_per_cycle) ?? reflectedNumber(node.raw, "mItemsPerCycle");

    if (reportedPerMinute === null && (itemsPerCycle === null || cycleSeconds === null)) {
      unresolved.push({
        ...common,
        reason:
          itemsPerCycle === null
            ? "extractor_yield_absent_from_extractor_fields_and_reflected_properties"
            : "live_production_cycle_seconds_unavailable",
      });
      continue;
    }

    const cyclesPerMinute = cycleSeconds === null ? null : 60 / cycleSeconds;
    // The extractable resource node carries the authoritative resource class.
    const resourceNode = graph.nodes.get(extractor?.extractable_resource_actor_id);
    const resourceClass = resourceNode?.raw?.resource_class || null;
    const extractedItems = resourceClass ? [resourceClass] : [...node.inventory_by_item.keys()];
    const usesReportedRate = reportedPerMinute !== null;
    machines.push({
      ...common,
      extracted_item_classes: extractedItems,
      extracted_item_source: resourceClass
        ? "authoritative_resource_class_of_the_extracted_node"
        : extractedItems.length > 0
          ? "observed_in_live_output_inventory"
          : "unknown_output_inventory_empty_at_capture",
      cycles_per_minute: round(cyclesPerMinute),
      items_per_cycle: itemsPerCycle,
      reported_extraction_per_minute: reportedPerMinute,
      theoretical_inputs: [],
      theoretical_outputs: extractedItems.map((itemClass) => {
        const scale = itemUnitScale(graph, itemClass);
        // GetExtractionPerMinute is already form-converted for display, so it is
        // a display-unit rate; the per-cycle path yields registry units.
        const displayPerMinute = usesReportedRate
          ? reportedPerMinute
          : (itemsPerCycle * cyclesPerMinute) / scale.registry_units_per_display_unit;
        return {
          item_class: itemClass,
          item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
          amount_per_cycle: itemsPerCycle,
          registry_units_per_minute: round(displayPerMinute * scale.registry_units_per_display_unit),
          display_units_per_minute: round(displayPerMinute),
          display_unit: scale.display_unit,
          form: scale.form,
        };
      }),
      outputs_after_production_boost: null,
      observed_outputs: null,
      rate_basis: usesReportedRate
        ? "authoritative_extractor_extraction_per_minute"
        : "extractor_items_per_cycle_and_live_cycle_seconds",
      source: usesReportedRate
        ? "authoritative_extractor_accessor"
        : "deterministic_arithmetic_from_extractor_yield_and_live_cycle",
      certainty: usesReportedRate ? "authoritative" : "calculated",
    });
  }

  return {
    solver: "machine_rates",
    world_revision: graph.world_revision,
    machine_count: machines.length,
    machines,
    unresolved_machines: unresolved,
    unknown_policy:
      "Machines listed under unresolved_machines have no derivable rate; their throughput must be treated as unknown.",
  };
}

/* ------------------------------------------------------------------ *
 * 2. Cached production graph / item balance
 * ------------------------------------------------------------------ */

export function solveItemBalance(graph, { item_class = null } = {}) {
  const rates = solveMachineRates(graph);
  const balances = new Map();

  const accumulate = (entry, field, actorId) => {
    if (!entry?.item_class) return;
    if (!balances.has(entry.item_class)) {
      balances.set(entry.item_class, {
        item_class: entry.item_class,
        item_name: entry.item_name,
        display_unit: entry.display_unit,
        form: entry.form,
        produced_display_units_per_minute: 0,
        consumed_display_units_per_minute: 0,
        producer_actor_ids: [],
        consumer_actor_ids: [],
      });
    }
    const balance = balances.get(entry.item_class);
    balance[field] += entry.display_units_per_minute ?? 0;
    const list = field === "produced_display_units_per_minute" ? balance.producer_actor_ids : balance.consumer_actor_ids;
    if (!list.includes(actorId)) list.push(actorId);
  };

  for (const machine of rates.machines) {
    for (const output of machine.outputs_after_production_boost ?? machine.theoretical_outputs ?? []) {
      accumulate(output, "produced_display_units_per_minute", machine.actor_id);
    }
    for (const input of machine.theoretical_inputs ?? []) {
      accumulate(input, "consumed_display_units_per_minute", machine.actor_id);
    }
  }

  let items = [...balances.values()].map((balance) => ({
    ...balance,
    produced_display_units_per_minute: round(balance.produced_display_units_per_minute),
    consumed_display_units_per_minute: round(balance.consumed_display_units_per_minute),
    net_display_units_per_minute: round(
      balance.produced_display_units_per_minute - balance.consumed_display_units_per_minute,
    ),
    status:
      balance.produced_display_units_per_minute + 1e-9 < balance.consumed_display_units_per_minute
        ? "deficit"
        : balance.produced_display_units_per_minute > balance.consumed_display_units_per_minute + 1e-9
          ? "surplus"
          : "balanced",
  }));

  if (item_class) items = items.filter((entry) => entry.item_class === item_class);
  items.sort((a, b) => (a.net_display_units_per_minute ?? 0) - (b.net_display_units_per_minute ?? 0));

  return {
    solver: "item_balance",
    world_revision: graph.world_revision,
    basis: "theoretical_rates_at_full_uptime_with_reported_production_boost",
    items,
    coverage: {
      resolved_machines: rates.machine_count,
      unresolved_machines: rates.unresolved_machines.length,
      unresolved_reasons: [...new Set(rates.unresolved_machines.map((entry) => entry.reason))],
      warning:
        rates.unresolved_machines.length > 0
          ? "Balances exclude the unresolved machines; treat these totals as lower bounds."
          : null,
    },
    source: "deterministic_aggregation_of_machine_rates",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 3. Recipe-selection constraints
 * ------------------------------------------------------------------ */

export function solveRecipeOptions(graph, { item_class = null, name_contains = null } = {}) {
  const usageCount = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.recipe_class) continue;
    usageCount.set(node.recipe_class, (usageCount.get(node.recipe_class) ?? 0) + 1);
  }

  const matches = (recipe) => {
    if (item_class) {
      const inProducts = (recipe.products ?? []).some((entry) => entry.item_class === item_class);
      const inIngredients = (recipe.ingredients ?? []).some((entry) => entry.item_class === item_class);
      if (!inProducts && !inIngredients) return false;
    }
    if (name_contains) {
      const needle = String(name_contains).toLowerCase();
      const haystack = `${recipe.name ?? ""} ${recipe.class_path ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  };

  const producing = [];
  const consuming = [];

  for (const recipe of graph.recipesByClass.values()) {
    if (!matches(recipe)) continue;
    const duration = finitePositive(recipe.duration_seconds);
    const cyclesPerMinute = duration === null ? null : 60 / duration;
    const inUseInWorld = (usageCount.get(recipe.class_path) ?? 0) > 0;
    const availability = recipeAvailability(recipe, inUseInWorld);
    const entry = {
      recipe_class: recipe.class_path,
      recipe_name: recipe.name ?? null,
      owner_mod: recipe.owner_mod ?? null,
      duration_seconds: duration,
      cycles_per_minute_at_base_time: round(cyclesPerMinute),
      produced_in: recipe.produced_in ?? [],
      inputs: cyclesPerMinute === null ? [] : rateEntries(graph, recipe.ingredients, cyclesPerMinute),
      outputs: cyclesPerMinute === null ? [] : rateEntries(graph, recipe.products, cyclesPerMinute),
      machines_currently_using_it: usageCount.get(recipe.class_path) ?? 0,
      ...availability,
    };
    if (!item_class || (recipe.products ?? []).some((product) => product.item_class === item_class)) {
      producing.push(entry);
    }
    if (item_class && (recipe.ingredients ?? []).some((ingredient) => ingredient.item_class === item_class)) {
      consuming.push(entry);
    }
  }

  const orderByOutput = (a, b) => {
    if (!item_class) return String(a.recipe_name).localeCompare(String(b.recipe_name));
    const rate = (entry) =>
      entry.outputs.find((output) => output.item_class === item_class)?.display_units_per_minute ?? 0;
    return rate(b) - rate(a);
  };
  producing.sort(orderByOutput);

  return {
    solver: "recipe_options",
    world_revision: graph.world_revision,
    query: { item_class, name_contains },
    recipes_producing_item: producing,
    recipes_consuming_item: consuming,
    catalog_recipe_count: graph.recipesByClass.size,
    catalog_note:
      "The bridge may have compacted the content catalog for context size; absent recipes are unknown, not nonexistent.",
    source: "authoritative_content_and_recipe_registries_with_deterministic_rate_arithmetic",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 4. Conveyor and pipeline capacity graph
 * ------------------------------------------------------------------ */

function endpointRate(graph, ratesByActor, endpointActorId, direction, transportKey) {
  const machine = ratesByActor.get(endpointActorId);
  if (!machine) return null;
  const entries = direction === "supply" ? machine.outputs_after_production_boost ?? machine.theoretical_outputs : machine.theoretical_inputs;
  let total = 0;
  let counted = 0;
  for (const entry of entries ?? []) {
    const isFluid = entry.display_unit === "cubic_meters";
    if (transportKey === "item" && isFluid) continue;
    if (transportKey === "fluid" && !isFluid) continue;
    total += entry.display_units_per_minute ?? 0;
    counted += 1;
  }
  return counted === 0 ? null : total;
}

export function solveTransportCapacity(graph, { actor_ids = null, only_problems = false } = {}) {
  const rates = solveMachineRates(graph);
  const ratesByActor = new Map(rates.machines.map((machine) => [machine.actor_id, machine]));
  const requested = actor_ids ? new Set(actor_ids) : null;

  const conveyors = [];
  const pipelines = [];

  for (const node of graph.nodes.values()) {
    if (requested && !requested.has(node.actor_id)) continue;
    const isConveyor = node.role === "conveyor";
    const isPipeline = node.role === "pipeline";
    if (!isConveyor && !isPipeline) continue;

    const transportKey = isConveyor ? "item" : "fluid";
    const capacity = isConveyor
      ? node.conveyor?.items_per_minute ?? null
      : node.pipeline?.cubic_meters_per_minute ?? null;

    const upstream = traceUpstream(graph, node.actor_id, transportKey);
    const downstream = traceDownstream(graph, node.actor_id, transportKey);

    let supply = null;
    for (const hop of upstream) {
      const rate = endpointRate(graph, ratesByActor, hop.endpoint_actor_id, "supply", transportKey);
      if (rate !== null) supply = (supply ?? 0) + rate;
    }
    let demand = null;
    for (const hop of downstream) {
      const rate = endpointRate(graph, ratesByActor, hop.endpoint_actor_id, "demand", transportKey);
      if (rate !== null) demand = (demand ?? 0) + rate;
    }

    const overCapacity = capacity !== null && supply !== null && supply > capacity + 1e-9;
    const underSupplied = supply !== null && demand !== null && supply + 1e-9 < demand;

    const entry = {
      actor_id: node.actor_id,
      name: node.name,
      class_path: node.class_path,
      owner_mod: node.owner_mod,
      role: node.role,
      capacity_display_units_per_minute: round(capacity),
      capacity_basis: isConveyor ? node.conveyor : node.pipeline,
      upstream_supply_display_units_per_minute: round(supply),
      downstream_demand_display_units_per_minute: round(demand),
      utilization_percent_of_capacity:
        capacity !== null && capacity > 0 && supply !== null ? round((supply / capacity) * 100, 3) : null,
      upstream_endpoints: upstream,
      downstream_endpoints: downstream,
      over_capacity: overCapacity,
      under_supplied: underSupplied,
      findings: [
        ...(overCapacity
          ? [
              {
                finding: "supply_exceeds_segment_capacity",
                excess_display_units_per_minute: round(supply - capacity),
                severity: "invalid_throughput",
              },
            ]
          : []),
        ...(underSupplied
          ? [
              {
                finding: "downstream_demand_exceeds_supply",
                shortfall_display_units_per_minute: round(demand - supply),
                severity: "inefficient",
              },
            ]
          : []),
      ],
      source: "deterministic_graph_traversal_and_arithmetic",
      certainty: "calculated",
    };

    if (isConveyor) {
      entry.observed_items_on_segment = finiteNumber(node.raw?.transport?.items_on_segment);
      entry.observed_available_space = finiteNumber(node.raw?.transport?.available_space);
      entry.backed_up_evidence =
        entry.observed_available_space !== null && entry.observed_available_space <= 0
          ? "segment_reports_no_available_space_at_capture"
          : null;
      conveyors.push(entry);
    } else {
      entry.observed_content = finiteNumber(node.raw?.transport?.reported_content);
      entry.observed_max_content = finiteNumber(node.raw?.transport?.reported_max_content);
      entry.observed_flow_cubic_meters_per_second = finiteNumber(node.raw?.transport?.reported_flow);
      entry.fluid_class = node.raw?.transport?.fluid_class || null;
      entry.headlift_status = "not_present_in_snapshot";
      entry.headlift_note =
        "Pipeline head lift and pressure are not captured, so elevation-related fluid problems cannot be confirmed or ruled out.";
      pipelines.push(entry);
    }
  }

  const filter = (list) => (only_problems ? list.filter((entry) => entry.findings.length > 0 || entry.backed_up_evidence) : list);

  return {
    solver: "transport_capacity",
    world_revision: graph.world_revision,
    conveyor_speed_divisor: graph.conveyor_speed_divisor,
    conveyors: filter(conveyors),
    pipelines: filter(pipelines),
    unresolved_connections: graph.unresolvedConnections,
    source: "deterministic_graph_traversal_and_arithmetic",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 5. Power-circuit graph
 * ------------------------------------------------------------------ */

export function solvePowerCircuits(graph, { circuit_id = null } = {}) {
  const circuits = [];

  for (const circuit of graph.circuits.values()) {
    if (circuit_id !== null && circuit.circuit_id !== circuit_id) continue;

    const capacity = circuit.production_capacity_mw;
    const consumption = circuit.maximum_consumption_mw;
    const headroom = capacity !== null && consumption !== null ? capacity - consumption : null;
    const deficit = headroom !== null && headroom < 0 ? -headroom : 0;

    const members = [];
    for (const actorId of circuit.member_actor_ids) {
      const node = graph.nodes.get(actorId);
      if (!node) continue;
      members.push({
        actor_id: actorId,
        name: node.name,
        class_path: node.class_path,
        owner_mod: node.owner_mod,
        role: node.role,
        production_status: node.production_status,
        producing_power_consumption_mw: finiteNumber(node.raw?.factory?.producing_power_consumption_mw),
        idle_power_consumption_mw: finiteNumber(node.raw?.factory?.idle_power_consumption_mw),
      });
    }
    members.sort(
      (a, b) => (b.producing_power_consumption_mw ?? 0) - (a.producing_power_consumption_mw ?? 0),
    );

    let batteryRuntimeSeconds = null;
    if (deficit > 0 && (circuit.battery_store_mwh ?? 0) > 0) {
      batteryRuntimeSeconds = round((circuit.battery_store_mwh / deficit) * MEGAWATT_HOURS_TO_SECONDS, 2);
    }
    let batteryFullInSeconds = null;
    if (
      headroom !== null &&
      headroom > 0 &&
      circuit.battery_capacity_mwh !== null &&
      circuit.battery_store_mwh !== null &&
      circuit.battery_capacity_mwh > circuit.battery_store_mwh
    ) {
      batteryFullInSeconds = round(
        ((circuit.battery_capacity_mwh - circuit.battery_store_mwh) / headroom) * MEGAWATT_HOURS_TO_SECONDS,
        2,
      );
    }

    const findings = [];
    if (circuit.fuse_triggered) {
      findings.push({
        finding: "fuse_triggered",
        severity: "invalid",
        consequence: "Every machine on this circuit is unpowered until the fuse is reset and capacity exceeds demand.",
      });
    }
    if (deficit > 0) {
      findings.push({
        finding: "consumption_exceeds_production_capacity",
        deficit_mw: round(deficit),
        severity: "invalid",
        battery_runtime_seconds: batteryRuntimeSeconds,
      });
    }

    circuits.push({
      circuit_id: circuit.circuit_id,
      fuse_triggered: circuit.fuse_triggered,
      production_capacity_mw: round(capacity),
      maximum_consumption_mw: round(consumption),
      headroom_mw: round(headroom),
      utilization_percent:
        capacity !== null && capacity > 0 && consumption !== null ? round((consumption / capacity) * 100, 3) : null,
      battery_store_mwh: circuit.battery_store_mwh,
      battery_capacity_mwh: circuit.battery_capacity_mwh,
      battery_input_mw: circuit.battery_input_mw,
      battery_output_mw: circuit.battery_output_mw,
      battery_runtime_seconds_at_current_deficit: batteryRuntimeSeconds,
      battery_full_in_seconds_at_current_surplus: batteryFullInSeconds,
      member_count: members.length,
      members,
      findings,
      source: "authoritative_power_circuit_state_with_deterministic_arithmetic",
      certainty: "calculated",
    });
  }

  circuits.sort((a, b) => (a.headroom_mw ?? 0) - (b.headroom_mw ?? 0));

  return {
    solver: "power_circuits",
    world_revision: graph.world_revision,
    circuit_count: circuits.length,
    circuits,
    coverage_note:
      "Only circuits reachable through captured power connections appear here. Machines outside the scan radius are not counted in consumption.",
    source: "authoritative_power_circuit_state",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 6. Starvation and blockage root-cause analysis
 * ------------------------------------------------------------------ */

function localCauses(graph, node, powerByCircuit, ratesByActor) {
  const causes = [];
  const factory = node.raw?.factory ?? {};
  const status = node.production_status;
  const productivity = finiteNumber(factory.productivity);

  if (node.role === "manufacturer" && !node.recipe_class) {
    causes.push({
      cause: "no_recipe_selected",
      severity: "invalid",
      evidence: "manufacturer.recipe_class is empty",
      propagates_upstream: false,
    });
  }

  const circuit = node.power_circuit_id === null ? null : powerByCircuit.get(node.power_circuit_id);
  if (circuit?.fuse_triggered) {
    causes.push({
      cause: "power_fuse_triggered",
      severity: "invalid",
      evidence: `power circuit ${circuit.circuit_id} reports fuse_triggered=true`,
      circuit_id: circuit.circuit_id,
      propagates_upstream: false,
    });
  } else if (circuit && (circuit.headroom_mw ?? 0) < 0) {
    causes.push({
      cause: "power_capacity_deficit",
      severity: "invalid",
      evidence: `power circuit ${circuit.circuit_id} consumption exceeds capacity by ${Math.abs(circuit.headroom_mw)} MW`,
      circuit_id: circuit.circuit_id,
      propagates_upstream: false,
    });
  }

  if (node.unconnected_item_inputs > 0) {
    causes.push({
      cause: "input_port_not_connected",
      severity: "invalid",
      evidence: `${node.unconnected_item_inputs} item input connection(s) report connected=false`,
      propagates_upstream: false,
    });
  }
  if (node.unconnected_item_outputs > 0) {
    causes.push({
      cause: "output_port_not_connected",
      severity: "invalid",
      evidence: `${node.unconnected_item_outputs} item output connection(s) report connected=false`,
      propagates_upstream: false,
    });
  }

  const machine = ratesByActor.get(node.actor_id);
  if (machine) {
    const missing = [];
    for (const input of machine.theoretical_inputs ?? []) {
      if ((node.inventory_by_item.get(input.item_class) ?? 0) <= 0) {
        missing.push({ item_class: input.item_class, item_name: input.item_name });
      }
    }
    if (missing.length > 0 && status !== "producing") {
      causes.push({
        cause: "input_starved",
        severity: "inefficient",
        evidence: `input inventory holds none of: ${missing.map((entry) => entry.item_name ?? entry.item_class).join(", ")}`,
        missing_items: missing,
        propagates_upstream: true,
      });
    }
  }

  if (status === "error") {
    causes.push({
      cause: "machine_reports_error_status",
      severity: "invalid",
      evidence: `factory.production_status is ${node.raw?.factory?.production_status}`,
      propagates_upstream: false,
    });
  }

  if (causes.length === 0 && status === "standby") {
    causes.push({
      cause: "standby_without_captured_reason",
      severity: "unknown",
      evidence:
        "The machine reports standby but no starved input, power fault, disconnected port, or error status was captured.",
      propagates_upstream: true,
    });
  }

  if (productivity !== null && productivity < 1 && status === "producing" && causes.length === 0) {
    causes.push({
      cause: "producing_below_full_productivity",
      severity: "inefficient",
      evidence: `factory.productivity is ${productivity}`,
      propagates_upstream: true,
    });
  }

  return causes;
}

export function solveBottlenecks(graph, { actor_ids = null, include_healthy = false } = {}) {
  const power = solvePowerCircuits(graph);
  const powerByCircuit = new Map(power.circuits.map((circuit) => [circuit.circuit_id, circuit]));
  const rates = solveMachineRates(graph);
  const ratesByActor = new Map(rates.machines.map((machine) => [machine.actor_id, machine]));
  const requested = actor_ids ? new Set(actor_ids) : null;

  const causeCache = new Map();
  const causesFor = (node) => {
    if (!causeCache.has(node.actor_id)) {
      causeCache.set(node.actor_id, localCauses(graph, node, powerByCircuit, ratesByActor));
    }
    return causeCache.get(node.actor_id);
  };

  const reports = [];

  for (const node of graph.nodes.values()) {
    if (requested && !requested.has(node.actor_id)) continue;
    if (node.role !== "manufacturer" && node.role !== "factory") continue;

    const causes = causesFor(node);
    if (causes.length === 0 && !include_healthy) continue;

    // Walk upstream while the local cause is one that propagates, so the report
    // names the machine that actually has to change.
    let rootActorId = node.actor_id;
    let rootCauses = causes;
    const chain = [node.actor_id];
    const seen = new Set(chain);

    for (let depth = 0; depth < MAXIMUM_ROOT_CAUSE_DEPTH; depth += 1) {
      if (rootCauses.length === 0 || !rootCauses.every((entry) => entry.propagates_upstream)) break;
      const upstream = traceUpstream(graph, rootActorId, "item").filter(
        (hop) => hop.endpoint_actor_id && !seen.has(hop.endpoint_actor_id),
      );
      if (upstream.length !== 1) break;

      const nextNode = graph.nodes.get(upstream[0].endpoint_actor_id);
      if (!nextNode || (nextNode.role !== "manufacturer" && nextNode.role !== "factory")) break;
      const nextCauses = causesFor(nextNode);
      if (nextCauses.length === 0) break;

      rootActorId = nextNode.actor_id;
      rootCauses = nextCauses;
      chain.push(rootActorId);
      seen.add(rootActorId);
    }

    reports.push({
      actor_id: node.actor_id,
      name: node.name,
      class_path: node.class_path,
      owner_mod: node.owner_mod,
      role: node.role,
      recipe_class: node.recipe_class,
      recipe_name: node.recipe_name,
      production_status: node.production_status,
      is_producing: node.is_producing,
      productivity: finiteNumber(node.raw?.factory?.productivity),
      power_circuit_id: node.power_circuit_id,
      local_causes: causes,
      root_cause_actor_id: rootActorId,
      root_causes: rootCauses,
      causal_chain_actor_ids: chain,
      healthy: causes.length === 0,
      source: "deterministic_classification_of_captured_state_and_graph_traversal",
      certainty: "calculated",
    });
  }

  const severityRank = { invalid: 0, inefficient: 1, unknown: 2 };
  const worst = (report) =>
    Math.min(...(report.local_causes.length ? report.local_causes.map((entry) => severityRank[entry.severity] ?? 3) : [9]));
  reports.sort((a, b) => worst(a) - worst(b));

  const causeCounts = Object.create(null);
  for (const report of reports) {
    for (const cause of report.local_causes) {
      causeCounts[cause.cause] = (causeCounts[cause.cause] ?? 0) + 1;
    }
  }

  return {
    solver: "bottlenecks",
    world_revision: graph.world_revision,
    reported_machine_count: reports.length,
    cause_counts: causeCounts,
    reports,
    classification_rules: {
      invalid: "The factory cannot work as built until this is changed.",
      inefficient: "The factory works but throughput is below what the build could achieve.",
      unknown: "The snapshot did not contain enough evidence to classify the stall.",
    },
    source: "deterministic_classification",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 7. Unlock and construction-cost checks
 * ------------------------------------------------------------------ */

export function solveBuildCost(graph, { recipe_class = null, class_path = null, count = 1 } = {}) {
  const multiplier = finitePositive(count) ?? 1;
  let recipe = recipe_class ? graph.recipesByClass.get(recipe_class) : null;
  let resolvedFrom = recipe ? "recipe_class" : null;

  if (!recipe && class_path) {
    for (const node of graph.nodes.values()) {
      if (node.class_path === class_path && node.built_with_recipe) {
        recipe = graph.recipesByClass.get(node.built_with_recipe);
        if (recipe) {
          resolvedFrom = "built_with_recipe_of_existing_actor_of_that_class";
          break;
        }
      }
    }
  }

  if (!recipe) {
    return {
      solver: "build_cost",
      world_revision: graph.world_revision,
      query: { recipe_class, class_path, count: multiplier },
      resolved: false,
      reason: recipe_class
        ? "recipe_class_not_present_in_snapshot_catalog"
        : "no_existing_actor_of_that_class_in_snapshot_and_no_recipe_class_given",
      note: "Construction cost cannot be derived without the build recipe; treat it as unknown.",
      source: "authoritative_content_registry",
      certainty: "unknown",
    };
  }

  const { totals, playerIds } = playerInventories(graph);
  const ingredients = [];
  let affordable = true;

  for (const ingredient of recipe.ingredients ?? []) {
    const amount = finiteNumber(ingredient.amount);
    if (amount === null) continue;
    const scale = itemUnitScale(graph, ingredient.item_class);
    const required = amount * multiplier;
    const held = totals.get(ingredient.item_class) ?? 0;
    const shortfall = Math.max(0, required - held);
    if (shortfall > 0) affordable = false;
    ingredients.push({
      item_class: ingredient.item_class,
      item_name: ingredient.item_name ?? graph.itemsByClass.get(ingredient.item_class)?.name ?? null,
      required_registry_units: required,
      required_display_units: round(required / scale.registry_units_per_display_unit),
      held_in_player_inventories_registry_units: held,
      shortfall_registry_units: shortfall,
      display_unit: scale.display_unit,
    });
  }

  const availability = recipeAvailability(
    recipe,
    resolvedFrom === "built_with_recipe_of_existing_actor_of_that_class",
  );
  return {
    solver: "build_cost",
    world_revision: graph.world_revision,
    query: { recipe_class, class_path, count: multiplier },
    resolved: true,
    resolved_from: resolvedFrom,
    recipe_class: recipe.class_path,
    recipe_name: recipe.name ?? null,
    owner_mod: recipe.owner_mod ?? null,
    count: multiplier,
    ingredients,
    affordable_from_captured_player_inventories: ingredients.length > 0 ? affordable : null,
    inventory_scope: {
      player_actor_ids: playerIds,
      note:
        playerIds.length === 0
          ? "No player actor was captured, so held amounts are unknown rather than zero."
          : "Held amounts cover captured player inventories only; storage containers and dimensional depot are not included.",
      certainty: playerIds.length === 0 ? "unknown" : "authoritative_for_captured_players",
    },
    unlock_status: availability.unlock_status,
    unlock_reason: availability.unlock_reason,
    availability_evidence: availability.availability_evidence,
    unlock_certainty: availability.certainty,
    source: "authoritative_content_registry_and_captured_inventories",
    certainty: "calculated",
  };
}

export function solveUnlockStatus(graph) {
  const progression = graph.snapshot?.progression ?? {};
  const content = graph.snapshot?.content ?? {};
  const purchased = progression.purchased_schematics ?? [];
  const recipes = [...graph.recipesByClass.values()];
  const availabilityKnown =
    content.availability_known === true ||
    recipes.some((recipe) => typeof recipe?.available === "boolean");
  const availableRecipeCount =
    finiteNumber(content.available_recipe_count) ??
    recipes.filter((recipe) => recipe?.available === true).length;
  const unavailableRecipeCount =
    finiteNumber(content.unavailable_recipe_count) ??
    recipes.filter((recipe) => recipe?.available === false).length;
  return {
    solver: "unlock_status",
    world_revision: graph.world_revision,
    highest_available_tech_tier: finiteNumber(progression.highest_available_tech_tier),
    purchased_schematic_count: purchased.length,
    purchased_schematics: purchased,
    active_schematic: progression.active_schematic ?? null,
    last_active_schematic: progression.last_active_schematic ?? null,
    onboarding: progression.onboarding ?? null,
    game_phase: progression.game_phase ?? null,
    todo_lists: progression.todo_lists ?? null,
    visible_ui: graph.snapshot?.visible_ui ?? null,
    recipe_availability_known: availabilityKnown,
    available_recipe_count: availableRecipeCount,
    unavailable_recipe_count: unavailableRecipeCount,
    recipe_unlock_mapping: availabilityKnown
      ? "authoritative_AFGRecipeManager_runtime_state"
      : "not_present_in_snapshot",
    recipe_unlock_note:
      availabilityKnown
        ? "Every catalog recipe carries the loaded save's exact available/unavailable state. Use find_recipes for a specific recipe."
        : "This older snapshot lists purchased schematics but not live recipe availability; only recipes already in use can be proven available.",
    source: availabilityKnown
      ? "authoritative_schematic_recipe_tutorial_game_phase_and_rendered_UMG_state"
      : "authoritative_schematic_manager",
    certainty: availabilityKnown
      ? "authoritative"
      : "authoritative_for_listed_schematics",
  };
}

/**
 * Exact census of the actors present in this capture.
 *
 * This deliberately says "captured" everywhere. A radius-limited scan is not
 * the whole map, and an actor-limit hit is not proof that the omitted actors do
 * not exist. The rows retain class paths and owner mods so modded buildings are
 * counted from their live data instead of folded into vanilla assumptions.
 */
export function solveFactorySummary(graph) {
  const snapshot = graph?.snapshot ?? {};
  const snapshotActorCount = Array.isArray(snapshot.actors)
    ? snapshot.actors.length
    : (graph?.nodes?.size ?? 0);
  const indexedActorCount = graph?.nodes?.size ?? 0;
  const increment = (map, key, amount = 1) => {
    const normalized = String(key ?? "unknown").trim() || "unknown";
    map.set(normalized, (map.get(normalized) ?? 0) + amount);
  };
  const ranked = (map, valueKey = "name") =>
    [...map.entries()]
      .map(([name, count]) => ({ [valueKey]: name, count }))
      .sort((a, b) => b.count - a.count || String(a[valueKey]).localeCompare(String(b[valueKey])));

  const actorKinds = new Map();
  const roles = new Map();
  const ownerMods = new Map();
  const buildableTypes = new Map();
  const buildableMetadata = new Map();
  const productionStatuses = new Map();
  const transports = new Map();
  const resources = new Map();
  let productionMachineCount = 0;
  let productionMachinesWithRecipe = 0;

  for (const node of graph?.nodes?.values?.() ?? []) {
    const raw = node.raw ?? {};
    increment(actorKinds, raw.kind ?? node.kind);
    increment(roles, node.role);
    increment(ownerMods, raw.owner_mod ?? node.owner_mod);

    if (raw.kind === "buildable") {
      const classPath = String(node.class_path ?? raw.class_path ?? "unknown");
      increment(buildableTypes, classPath);
      if (!buildableMetadata.has(classPath)) {
        buildableMetadata.set(classPath, {
          class_path: classPath,
          class_name: classPath.split(".").pop() || classPath,
          owner_mod: raw.owner_mod ?? node.owner_mod ?? "unknown",
        });
      }
    }

    if (raw.factory) {
      productionMachineCount += 1;
      if (raw.manufacturer?.recipe_class) productionMachinesWithRecipe += 1;
      increment(productionStatuses, normalizeProductionStatus(raw.factory.production_status));
    }

    if (raw.transport?.kind) increment(transports, raw.transport.kind);

    if (raw.kind === "resource_node") {
      const resourceName = String(raw.resource_name ?? raw.resource_class ?? "unknown");
      if (!resources.has(resourceName)) {
        resources.set(resourceName, {
          resource_name: resourceName,
          count: 0,
          occupied_count: 0,
          open_for_miner_count: 0,
          deposits_count: 0,
          purity_counts: new Map(),
        });
      }
      const resource = resources.get(resourceName);
      resource.count += 1;
      if (raw.occupied === true) resource.occupied_count += 1;
      const nodeType = String(raw.node_type ?? "");
      if (nodeType === "Deposit") resource.deposits_count += 1;
      if ((nodeType === "Node" || nodeType === "FrackingCore") && raw.occupied !== true) {
        resource.open_for_miner_count += 1;
      }
      increment(resource.purity_counts, normalizeResourcePurity(raw.purity));
    }
  }

  const buildables = ranked(buildableTypes, "class_path").map((entry) => ({
    ...buildableMetadata.get(entry.class_path),
    count: entry.count,
  }));
  const resourceRows = [...resources.values()]
    .map((entry) => ({
      resource_name: entry.resource_name,
      count: entry.count,
      occupied_count: entry.occupied_count,
      open_for_miner_count: entry.open_for_miner_count,
      deposits_count: entry.deposits_count,
      purity_counts: Object.fromEntries(ranked(entry.purity_counts).map(({ name, count }) => [name, count])),
    }))
    .sort((a, b) => b.count - a.count || a.resource_name.localeCompare(b.resource_name));

  const scanRadius = finiteNumber(snapshot?.world?.scan_radius_meters);
  const actorLimitReached = snapshot?.completeness?.actor_limit_reached === true;
  const scopeNotes = [];
  if (scanRadius !== null && scanRadius >= 0) {
    scopeNotes.push(`The scanner captured actors within ${scanRadius} metres of its scan centre.`);
  }
  if (actorLimitReached) {
    scopeNotes.push("The capture hit its actor limit, so additional actors exist outside this census.");
  }
  if (snapshotActorCount > indexedActorCount) {
    scopeNotes.push(
      `${snapshotActorCount - indexedActorCount} captured actor(s) lacked actor_id and are excluded from category details.`,
    );
  }
  if (scopeNotes.length === 0) {
    scopeNotes.push("No radius or actor-limit truncation was reported by this snapshot.");
  }

  return {
    solver: "factory_summary",
    world_revision: graph?.world_revision ?? null,
    generated_at_utc: snapshot?.generated_at_utc ?? null,
    captured_actor_count: snapshotActorCount,
    indexed_actor_count: indexedActorCount,
    actor_kinds: ranked(actorKinds, "kind"),
    roles: ranked(roles, "role"),
    owner_mods: ranked(ownerMods, "owner_mod"),
    buildable_count: actorKinds.get("buildable") ?? 0,
    buildable_type_count: buildables.length,
    buildable_types: buildables,
    production: {
      machine_count: productionMachineCount,
      with_recipe_count: productionMachinesWithRecipe,
      without_recipe_count: productionMachineCount - productionMachinesWithRecipe,
      status_counts: Object.fromEntries(
        ranked(productionStatuses).map(({ name, count }) => [name, count]),
      ),
    },
    transports: ranked(transports, "kind"),
    resource_node_count: actorKinds.get("resource_node") ?? 0,
    resources: resourceRows,
    capture_scope: {
      scan_radius_meters: scanRadius,
      actor_limit: finiteNumber(snapshot?.completeness?.actor_limit),
      actor_limit_reached: actorLimitReached,
      notes: scopeNotes,
    },
    source: "counts_over_authoritative_captured_actors",
    certainty: "authoritative_for_capture_scope",
  };
}

/* ------------------------------------------------------------------ *
 * 8. Site selection
 * ------------------------------------------------------------------ */

/**
 * Miner output scales with node purity. These are the documented extraction
 * multipliers, not snapshot facts, so they are configurable and echoed back.
 */
const PURITY_EXTRACTION_WEIGHT = { impure: 0.5, normal: 1, pure: 2 };

const DEFAULT_SITE_WEIGHTS = {
  resource_diversity: 25,
  purity_weighted_nodes: 4,
  required_coverage: 120,
  distance_penalty_per_100m: 6,
  terrain: 60,
};

/**
 * How buildable each measured ground verdict is, 0..1. Sites the scanner probed
 * are scored on this; sites it did not reach score neutral and say so.
 */
const TERRAIN_BUILDABILITY = {
  flat_and_clear: 1,
  usable_with_foundations: 0.6,
  steep: 0.15,
  obstructed: 0.1,
  over_water: 0,
  no_ground_found: 0,
};

/** `RP_Inpure` is the engine's spelling; `RP_Impure` is not a thing. */
export function normalizeResourcePurity(purity) {
  const text = String(purity ?? "").toUpperCase();
  if (text.includes("INPURE") || text.includes("IMPURE")) return "impure";
  if (text.includes("PURE")) return "pure";
  if (text.includes("NORMAL")) return "normal";
  return "unknown";
}

function matchesResourceQuery(node, query) {
  const needle = String(query).toLowerCase();
  return (
    String(node.resource_name ?? "").toLowerCase().includes(needle) ||
    String(node.resource_class ?? "").toLowerCase().includes(needle)
  );
}

/**
 * Why the winning site won.
 *
 * The scorer already knows this — it is the difference between the winner's
 * factor breakdown and the runner-up's — but a score of 130.5 against 125.2
 * tells the player nothing on its own. This turns the arithmetic into the
 * reason: which factor decided it, what the winner gave up to get there, and
 * which resources actually drove the resource terms.
 *
 * Everything here is derived from numbers the scorer computed. It explains the
 * *scoring decision*, which is a thing the data proves. It says nothing about
 * why the map has resources where it does, which the data does not.
 */
const COST_PHRASING = {
  resource_diversity: "having fewer distinct resources in range",
  purity_weighted_nodes: "having poorer or fewer nodes",
  required_coverage: "coverage of the resources you asked for",
  terrain: "worse ground to build on",
  distance_penalty: "being further from you",
};

function explainSiteChoice(ranked) {
  const winner = ranked[0];
  if (!winner) return null;

  const drivers = (winner.resources_in_radius ?? [])
    .slice()
    .sort((a, b) => (a.nearest_distance_meters ?? 1e9) - (b.nearest_distance_meters ?? 1e9))
    .slice(0, 4)
    .map((entry) => ({
      resource: entry.resource_name,
      nodes: entry.node_count,
      nearest_meters: entry.nearest_distance_meters,
      purity_weight: entry.purity_weight_total,
    }));

  const base = {
    chosen_because: [],
    traded_away: [],
    resource_drivers: drivers,
    basis:
      "Derived from the scored factors. This explains why this point outscored the others, not why the map has resources where it does — the snapshot cannot show that.",
  };

  const runnerUp = ranked[1];
  if (!runnerUp) {
    return {
      ...base,
      margin: null,
      chosen_because: ["It was the only candidate scored, so there was nothing to beat."],
    };
  }

  const margin = round(winner.score - runnerUp.score, 2);
  const labels = {
    resource_diversity: "more distinct resources in range",
    purity_weighted_nodes: "richer or purer nodes",
    required_coverage: "covers the resources you asked for",
    terrain: "better ground to build on",
    distance_penalty: "closer to you",
  };

  // A factor helps the winner when it is higher, except the distance penalty,
  // which is stored negative and helps when it is *less* negative.
  for (const [factor, label] of Object.entries(labels)) {
    const mine = finiteNumber(winner.score_breakdown?.[factor]) ?? 0;
    const theirs = finiteNumber(runnerUp.score_breakdown?.[factor]) ?? 0;
    const delta = round(mine - theirs, 2);
    if (Math.abs(delta) < 0.01) continue;
    const entry = { factor, label, points: Math.abs(delta) };
    if (delta > 0) base.chosen_because.push(entry);
    else base.traded_away.push(entry);
  }

  base.chosen_because.sort((a, b) => b.points - a.points);
  base.traded_away.sort((a, b) => b.points - a.points);

  const decider = base.chosen_because[0];
  const cost = base.traded_away[0];
  let headline;
  if (!decider) {
    headline = `Every scored factor tied; it won by ${margin} points on rounding.`;
  } else {
    headline = `It won by ${margin} points, mostly on ${decider.label} (+${decider.points}).`;
    if (cost) headline += ` It gave up ${cost.points} points on ${COST_PHRASING[cost.factor] ?? cost.label}.`;
  }

  return { ...base, margin, beat_runner_up_by: margin, headline };
}

export function solveSiteSelection(
  graph,
  {
    radius_meters = 300,
    top = 5,
    required_resources = null,
    include_deposits = false,
    weights = null,
    center = null,
  } = {},
) {
  const radiusMeters = finitePositive(radius_meters) ?? 300;
  const radiusCm = radiusMeters * 100;
  const scoreWeights = { ...DEFAULT_SITE_WEIGHTS, ...(weights ?? {}) };
  const required = Array.isArray(required_resources) ? required_resources : null;

  const allNodes = [];
  for (const node of graph.nodes.values()) {
    if (node.role !== "resource_node") continue;
    const raw = node.raw ?? {};
    const location = raw.location;
    if (!location || ![location.x, location.y, location.z].every((value) => Number.isFinite(value))) {
      continue;
    }
    const nodeType = String(raw.node_type ?? "");
    allNodes.push({
      actor_id: node.actor_id,
      name: node.name,
      location,
      resource_class: raw.resource_class ?? null,
      resource_name: raw.resource_name ?? null,
      purity: normalizeResourcePurity(raw.purity),
      node_type: nodeType,
      occupied: Boolean(raw.occupied),
      has_resources: raw.has_resources !== false,
      // Deposits are hand-mined and cannot host a miner.
      minable: nodeType === "Node" || nodeType === "FrackingCore",
      terrain: raw.terrain ?? null,
    });
  }

  const usableNodes = allNodes.filter(
    (node) => !node.occupied && node.has_resources && (include_deposits || node.minable),
  );

  const candidates = [];
  const seen = new Set();
  const addCandidate = (location, origin, actorId = null, terrain = null) => {
    if (!location || ![location.x, location.y, location.z].every((value) => Number.isFinite(value))) return;
    const key = `${Math.round(location.x / 5000)}:${Math.round(location.y / 5000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ location, origin, actor_id: actorId, terrain });
  };

  // Existing buildings are an obstruction the terrain probe deliberately does
  // not measure, because their bounds are already in the snapshot.
  const buildableBoxes = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== "buildable") continue;
    const bounds = node.raw?.bounds;
    const origin = bounds?.origin;
    const extent = bounds?.extent;
    if (!origin || !extent) continue;
    if (![origin.x, origin.y, extent.x, extent.y].every(Number.isFinite)) continue;
    buildableBoxes.push({
      actor_id: node.actor_id,
      name: node.name,
      minX: origin.x - Math.abs(extent.x),
      maxX: origin.x + Math.abs(extent.x),
      minY: origin.y - Math.abs(extent.y),
      maxY: origin.y + Math.abs(extent.y),
    });
  }

  const overlappingBuildables = (center) => {
    const half = radiusCm > 0 ? Math.min(radiusCm, 4000) : 1200;
    const minX = center.x - half;
    const maxX = center.x + half;
    const minY = center.y - half;
    const maxY = center.y + half;
    const hits = [];
    for (const box of buildableBoxes) {
      if (box.maxX < minX || box.minX > maxX || box.maxY < minY || box.minY > maxY) continue;
      hits.push({ actor_id: box.actor_id, name: box.name });
      if (hits.length >= 12) break;
    }
    return { footprint_half_extent_cm: half, count: hits.length, examples: hits.slice(0, 6) };
  };

  // Older snapshots carry no interaction_context, so fall back to the captured
  // player actor before giving up on a player position.
  let playerLocation = graph.snapshot?.interaction_context?.player?.pawn_location ?? null;
  if (!playerLocation) {
    for (const node of graph.nodes.values()) {
      if (node.kind === "player" && node.raw?.location) {
        playerLocation = node.raw.location;
        break;
      }
    }
  }

  if (center) {
    addCandidate(center, "caller_supplied_center");
  } else {
    for (const node of usableNodes) {
      addCandidate(node.location, "resource_node", node.actor_id, node.terrain);
    }
    if (playerLocation) {
      addCandidate(
        playerLocation,
        "current_player_position",
        null,
        graph.snapshot?.terrain?.at_scan_center ?? null,
      );
    }
  }
  const sites = [];

  for (const candidate of candidates) {
    const byResource = new Map();
    let purityWeightTotal = 0;

    for (const node of usableNodes) {
      const distanceCm = Math.hypot(
        node.location.x - candidate.location.x,
        node.location.y - candidate.location.y,
        node.location.z - candidate.location.z,
      );
      if (distanceCm > radiusCm) continue;

      const key = node.resource_class ?? node.resource_name ?? "unknown";
      if (!byResource.has(key)) {
        byResource.set(key, {
          resource_class: node.resource_class,
          resource_name: node.resource_name,
          node_count: 0,
          by_purity: { pure: 0, normal: 0, impure: 0, unknown: 0 },
          purity_weight_total: 0,
          nearest_distance_meters: Infinity,
          nearest_actor_id: null,
          // The coordinate matters as much as the distance: without it a build
          // request on "the nearest iron node" has nowhere to go, and the model
          // is left trying to triangulate a position from distances alone.
          nearest_location_cm: null,
          nearest_purity: null,
        });
      }
      const entry = byResource.get(key);
      const weight = PURITY_EXTRACTION_WEIGHT[node.purity] ?? 1;
      entry.node_count += 1;
      entry.by_purity[node.purity] = (entry.by_purity[node.purity] ?? 0) + 1;
      entry.purity_weight_total += weight;
      purityWeightTotal += weight;
      if (distanceCm / 100 < entry.nearest_distance_meters) {
        entry.nearest_distance_meters = distanceCm / 100;
        entry.nearest_actor_id = node.actor_id;
        entry.nearest_location_cm = node.location ?? null;
        entry.nearest_purity = node.purity ?? null;
      }
    }

    if (byResource.size === 0) continue;

    const resources = [...byResource.values()].map((entry) => ({
      ...entry,
      nearest_distance_meters: round(entry.nearest_distance_meters, 2),
      purity_weight_total: round(entry.purity_weight_total, 3),
    }));
    resources.sort((a, b) => b.purity_weight_total - a.purity_weight_total);

    const missingRequired = [];
    if (required) {
      for (const query of required) {
        const found = resources.some((entry) =>
          matchesResourceQuery({ resource_name: entry.resource_name, resource_class: entry.resource_class }, query),
        );
        if (!found) missingRequired.push(query);
      }
    }
    const coverageFraction = required ? (required.length - missingRequired.length) / required.length : 1;

    const meanNearestMeters =
      resources.reduce((total, entry) => total + entry.nearest_distance_meters, 0) / resources.length;

    // Measured ground. An unprobed site scores neutral rather than being
    // assumed flat, and says which it is.
    const terrain = candidate.terrain ?? null;
    const terrainVerdict = terrain?.sampled ? terrain.verdict : terrain?.verdict ?? "not_sampled";
    const buildability = terrain?.sampled ? (TERRAIN_BUILDABILITY[terrainVerdict] ?? 0.5) : null;
    const terrainScore = buildability === null ? 0 : scoreWeights.terrain * (buildability - 0.5) * 2;

    const diversityScore = scoreWeights.resource_diversity * resources.length;
    const purityScore = scoreWeights.purity_weighted_nodes * purityWeightTotal;
    const coverageScore = scoreWeights.required_coverage * coverageFraction;
    const distancePenalty = scoreWeights.distance_penalty_per_100m * (meanNearestMeters / 100);
    const score = diversityScore + purityScore + coverageScore + terrainScore - distancePenalty;

    sites.push({
      center_cm: candidate.location,
      candidate_origin: candidate.origin,
      anchor_actor_id: candidate.actor_id,
      score: round(score, 3),
      score_breakdown: {
        resource_diversity: round(diversityScore, 3),
        purity_weighted_nodes: round(purityScore, 3),
        required_coverage: round(coverageScore, 3),
        terrain: round(terrainScore, 3),
        distance_penalty: round(-distancePenalty, 3),
        formula:
          "diversity + purity_weighted_nodes + required_coverage + terrain - distance_penalty",
      },
      existing_buildings_in_footprint: overlappingBuildables(candidate.location),
      terrain: terrain
        ? {
            measured: Boolean(terrain.sampled),
            verdict: terrainVerdict,
            buildability_0_to_1: buildability,
            mean_slope_degrees: terrain.mean_slope_degrees ?? null,
            max_slope_degrees: terrain.max_slope_degrees ?? null,
            elevation_range_cm: terrain.elevation_range_cm ?? null,
            water_samples: terrain.water_samples ?? null,
            blocked_samples: terrain.blocked_samples ?? null,
            samples_with_ground: terrain.samples_with_ground ?? null,
            footprint_meters: terrain.footprint_meters ?? null,
            source: terrain.source ?? null,
          }
        : {
            measured: false,
            verdict: "not_sampled",
            buildability_0_to_1: null,
            note:
              "Outside the scanner's terrain probe radius. Unmeasured ground is not flat ground; walk closer and recapture to measure it.",
          },
      distinct_resources: resources.length,
      total_purity_weight: round(purityWeightTotal, 3),
      mean_nearest_distance_meters: round(meanNearestMeters, 2),
      distance_to_player_meters: playerLocation
        ? round(
            Math.hypot(
              candidate.location.x - playerLocation.x,
              candidate.location.y - playerLocation.y,
              candidate.location.z - playerLocation.z,
            ) / 100,
            2,
          )
        : null,
      resources_in_radius: resources,
      missing_required_resources: missingRequired,
      meets_all_required: missingRequired.length === 0,
    });
  }

  sites.sort((a, b) => b.score - a.score);
  const ranked = sites.slice(0, Math.max(1, Math.trunc(top) || 5)).map((site, index) => ({
    rank: index + 1,
    ...site,
  }));

  const scanRadius = finiteNumber(graph.snapshot?.world?.scan_radius_meters);
  const partialWorld = scanRadius !== null && scanRadius > 0;

  return {
    solver: "site_selection",
    world_revision: graph.world_revision,
    query: {
      radius_meters: radiusMeters,
      top,
      required_resources: required,
      include_deposits,
      weights: scoreWeights,
      center: center ?? null,
    },
    resource_node_totals: {
      captured: allNodes.length,
      usable: usableNodes.length,
      occupied: allNodes.filter((node) => node.occupied).length,
      deposits_excluded: include_deposits ? 0 : allNodes.filter((node) => !node.minable).length,
    },
    candidates_evaluated: candidates.length,
    // Why the top site won, derived from the factor deltas rather than asserted.
    why_this_site: explainSiteChoice(ranked),
    sites: ranked,
    scoring_basis: {
      purity_extraction_weights: PURITY_EXTRACTION_WEIGHT,
      purity_weight_source: "documented_extraction_multipliers_not_snapshot_facts",
      note: "Ranking depends on these weights. Different weights give a different winner; the score breakdown shows exactly how each site earned its total.",
    },
    terrain_coverage: {
      measured_sites: ranked.filter((site) => site.terrain?.measured).length,
      unmeasured_sites: ranked.filter((site) => !site.terrain?.measured).length,
      how: "Downward line traces on a grid across each footprint, plus water-volume containment at each ground point.",
      measured: [
        "ground height and elevation range across the footprint",
        "surface slope from the impact normal, mean and maximum",
        "water, from the game's own water volumes",
        "rock, cliff, and foliage blocking the footprint above ground level",
        "existing buildings overlapping the footprint, from their captured bounds",
      ],
      probe_settings: graph.snapshot?.terrain
        ? {
            footprint_meters: graph.snapshot.terrain.probe_footprint_meters,
            resolution: graph.snapshot.terrain.probe_resolution,
            radius_meters: graph.snapshot.terrain.probe_radius_meters,
            budget: graph.snapshot.terrain.probe_budget,
          }
        : null,
    },
    not_captured: {
      hostile_creatures: "Creature locations are not captured.",
      exact_placement_validity:
        "Only the game's own hologram check can confirm a specific building fits at a specific transform; this is measured ground, not a placement guarantee.",
    },
    completeness_warning: partialWorld
      ? `The snapshot was captured with a ${scanRadius} m scan radius, so this ranks only what was inside that bubble and cannot answer a world-scale siting question. Recapture with the whole-world snapshot before trusting it.`
      : null,
    source: "deterministic_geometry_over_authoritative_resource_nodes",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * 9. Blueprint library
 * ------------------------------------------------------------------ */

/**
 * Reads the player's saved blueprints from disk and prices them against what
 * they are carrying. Files are read through an injected reader so the caller
 * decides which directory is ever touched.
 */
export function solveBlueprintLibrary(
  graph,
  { name_contains = null, limit = 25 } = {},
  { listBlueprints = null } = {},
) {
  if (typeof listBlueprints !== "function") {
    return {
      solver: "blueprint_library",
      world_revision: graph.world_revision,
      available: false,
      reason: "blueprint_directory_not_configured",
      note: "Set AIFACTORY_BLUEPRINT_DIR so the bridge can read the saved blueprint folder.",
      blueprints: [],
      source: "none",
      certainty: "unknown",
    };
  }

  const { totals } = playerInventories(graph);
  const gameChangelist = finiteNumber(graph.snapshot?.world?.game_changelist);
  const entries = listBlueprints();
  const needle = name_contains ? String(name_contains).toLowerCase() : null;

  const blueprints = [];
  const failures = [];
  for (const entry of entries) {
    if (entry.error) {
      failures.push({ name: entry.name, error: entry.error });
      continue;
    }
    if (needle && !String(entry.name).toLowerCase().includes(needle)) continue;

    const pricing = costAgainstInventory(entry, totals);

    // A blueprint references the build recipes of what it contains, so the
    // recipe list resolves to the actual buildings via the catalog.
    const contains = [];
    for (const reference of entry.contents?.recipes ?? []) {
      const tail = String(reference.class_path).split(".").pop();
      const recipe =
        graph.recipesByClass.get(reference.class_path) ??
        [...graph.recipesByClass.values()].find(
          (candidate) => String(candidate.class_path).split(".").pop() === tail,
        );
      contains.push({
        building: recipe?.products?.[0]?.item_name ?? reference.name,
        recipe_class: reference.class_path,
        resolved_from_catalog: Boolean(recipe),
        occurrences: reference.occurrences,
      });
    }

    blueprints.push({
      contains,
      contains_resolved_from_catalog: contains.filter((c) => c.resolved_from_catalog).length,
      contents_caveat: entry.contents?.counts_caveat ?? null,
      transforms: entry.contents?.transforms ?? "not_decoded",
      name: entry.name,
      designer_dimensions: entry.designer_dimensions,
      authored_on_game_changelist: entry.game_changelist,
      authored_on_a_different_build:
        gameChangelist !== null && entry.game_changelist !== gameChangelist,
      description: entry.description,
      build_cost: entry.build_cost,
      ...pricing,
      cost_list_truncated: entry.cost_list_truncated,
      object_graph_decoded: entry.object_graph_decoded,
      object_graph_note: entry.object_graph_note,
    });
    if (blueprints.length >= Math.max(1, Math.trunc(limit) || 25)) break;
  }

  return {
    solver: "blueprint_library",
    world_revision: graph.world_revision,
    available: true,
    query: { name_contains, limit },
    blueprint_count: blueprints.length,
    total_files_seen: entries.length,
    blueprints,
    unreadable_files: failures,
    what_is_known:
      "Designer dimensions, exact build cost, the buildings it contains, the game build each blueprint was authored on, and its description.",
    what_is_not_known:
      "Positions, rotations, and wiring inside a blueprint are not decoded. The buildings it contains are known from the build recipes it references; where they sit is not.",
    source: "parsed_from_saved_blueprint_files",
    certainty: "authoritative_for_header_and_cost",
  };
}

/* ------------------------------------------------------------------ *
 * 10. Production planning
 * ------------------------------------------------------------------ */

const DEFAULT_PLAN_DEPTH = 6;
const MAXIMUM_PLAN_STEPS = 120;

/** Per-machine output rate for one product of a recipe, in display units. */
function recipeOutputRate(graph, recipe, itemClass) {
  const duration = finitePositive(recipe?.duration_seconds);
  if (duration === null) return null;
  const product = (recipe.products ?? []).find((entry) => entry.item_class === itemClass);
  const amount = finiteNumber(product?.amount);
  if (amount === null || amount <= 0) return null;
  const scale = itemUnitScale(graph, itemClass);
  return (amount * (60 / duration)) / scale.registry_units_per_display_unit;
}

/**
 * Power draw for a building class, taken from the player's own machines of that
 * class rather than a table. If they have none, it is unknown rather than
 * guessed.
 */
function observedPowerForBuilding(graph, producedIn) {
  const wanted = (producedIn ?? []).map((entry) => String(entry).split(".").pop());
  if (wanted.length === 0) return null;

  for (const node of graph.nodes.values()) {
    const className = String(node.class_path ?? "").split(".").pop();
    if (!className || !wanted.some((entry) => className.includes(entry) || entry.includes(className))) {
      continue;
    }
    const producing = finitePositive(node.raw?.factory?.producing_power_consumption_mw);
    if (producing !== null) {
      return { megawatts_each: producing, from_actor_id: node.actor_id, source: "observed_on_your_own_machine" };
    }
  }
  return null;
}

/**
 * Plans a production line for a target item and rate.
 *
 * It plans against *this* base: existing surplus from the item balance offsets
 * what has to be built, so the plan covers what is actually missing rather than
 * an empty-world ideal. Every branch stops at something already produced, a raw
 * resource, or a stated unknown.
 */
export function solveProductionPlan(
  graph,
  {
    item_class = null,
    item_name = null,
    target_rate_per_minute = null,
    recipe_class = null,
    max_depth = DEFAULT_PLAN_DEPTH,
    use_existing_surplus = true,
    prefer_standard_recipes = false,
    stop_at_item_classes = [],
  } = {},
) {
  const targetRate = finitePositive(target_rate_per_minute);
  if (!item_class && !item_name) {
    return {
      solver: "production_plan",
      world_revision: graph.world_revision,
      planned: false,
      reason: "no_target_item_given",
      note: "Give item_class or item_name, plus target_rate_per_minute.",
      certainty: "unknown",
    };
  }
  if (targetRate === null) {
    return {
      solver: "production_plan",
      world_revision: graph.world_revision,
      planned: false,
      reason: "no_target_rate_given",
      note: "Give target_rate_per_minute so machine counts can be computed.",
      certainty: "unknown",
    };
  }

  // Resolve the item from the full catalog the bridge holds.
  let targetClass = item_class;
  if (!targetClass && item_name) {
    const needle = String(item_name).toLowerCase();
    for (const item of graph.itemsByClass.values()) {
      if (String(item.name ?? "").toLowerCase() === needle) {
        targetClass = item.class_path;
        break;
      }
    }
    if (!targetClass) {
      for (const item of graph.itemsByClass.values()) {
        if (String(item.name ?? "").toLowerCase().includes(needle)) {
          targetClass = item.class_path;
          break;
        }
      }
    }
  }
  if (!targetClass) {
    return {
      solver: "production_plan",
      world_revision: graph.world_revision,
      planned: false,
      reason: "item_not_found_in_catalog",
      query: { item_class, item_name },
      certainty: "unknown",
    };
  }

  // Callers that own an authoritative source (for example, an aimed resource
  // node) can declare it as a terminal input. This prevents late-game
  // Converter recipes from expanding Iron Ore into SAM/Limestone merely
  // because the catalog says Iron Ore can also be manufactured.
  const terminalInputs = new Set(
    Array.isArray(stop_at_item_classes)
      ? stop_at_item_classes.map((value) => String(value)).filter(Boolean)
      : [],
  );

  const surplusByItem = new Map();
  if (use_existing_surplus) {
    for (const entry of solveItemBalance(graph).items) {
      if ((entry.net_display_units_per_minute ?? 0) > 0) {
        surplusByItem.set(entry.item_class, entry.net_display_units_per_minute);
      }
    }
  }

  const availabilityKnown = graph.snapshot?.content?.availability_known === true;
  const recipesProducing = (itemClass) => {
    const all = [];
    for (const recipe of graph.recipesByClass.values()) {
      if ((recipe.products ?? []).some((product) => product.item_class === itemClass)) {
        all.push(recipe);
      }
    }
    return {
      all,
      // A current snapshot carries an exact AFGRecipeManager decision for every
      // registered recipe. In that case only an explicit true is selectable;
      // missing availability is unknown, not an unlocked recipe. The looser
      // legacy rule remains only for snapshots predating that field.
      usable: all.filter((recipe) =>
        availabilityKnown ? recipe?.available === true : recipe?.available !== false,
      ),
      locked: all.filter((recipe) => recipe?.available === false),
      unknown: all.filter((recipe) => typeof recipe?.available !== "boolean"),
    };
  };

  const inUseRecipeClasses = new Set(
    [...graph.nodes.values()].map((node) => node.recipe_class).filter(Boolean),
  );

  const steps = [];
  const rawInputs = new Map();
  const coveredBySurplus = [];
  const unresolved = [];
  const totals = { machines: 0, megawatts: 0, power_unknown_steps: 0 };
  const buildCost = new Map();
  let stepBudgetHit = false;

  const plan = (itemClass, rate, depth, chain) => {
    if (steps.length >= MAXIMUM_PLAN_STEPS) {
      stepBudgetHit = true;
      return;
    }

    // Anything the base already over-produces is covered, not rebuilt.
    const surplus = surplusByItem.get(itemClass) ?? 0;
    const fromSurplus = Math.min(surplus, rate);
    if (fromSurplus > 0) {
      surplusByItem.set(itemClass, surplus - fromSurplus);
      coveredBySurplus.push({
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round(fromSurplus),
        note: "Your factory already produces this much spare; the plan does not rebuild it.",
      });
    }
    const remaining = rate - fromSurplus;
    if (remaining <= 1e-9) return;

    if (terminalInputs.has(itemClass)) {
      const scale = itemUnitScale(graph, itemClass);
      rawInputs.set(itemClass, {
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round((rawInputs.get(itemClass)?.raw ?? 0) + remaining),
        raw: (rawInputs.get(itemClass)?.raw ?? 0) + remaining,
        display_unit: scale.display_unit,
        supplied_by: "the caller's authoritative source; recipe expansion stops here",
      });
      return;
    }

    const recipeOptions = recipesProducing(itemClass);
    if (recipeOptions.all.length === 0) {
      // Nothing makes it, so it is a raw input for this plan.
      const scale = itemUnitScale(graph, itemClass);
      rawInputs.set(itemClass, {
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round((rawInputs.get(itemClass)?.raw ?? 0) + remaining),
        raw: (rawInputs.get(itemClass)?.raw ?? 0) + remaining,
        display_unit: scale.display_unit,
        supplied_by: "extraction or an existing line; not planned here",
      });
      return;
    }
    if (recipeOptions.usable.length === 0) {
      unresolved.push({
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round(remaining),
        reason: availabilityKnown && recipeOptions.unknown.length > 0
          ? "no_recipe_is_proven_available_in_the_current_capture"
          : "all_catalog_recipes_are_unavailable_in_this_save",
        locked_recipe_classes: recipeOptions.locked.map((recipe) => recipe.class_path),
        unknown_recipe_classes: recipeOptions.unknown.map((recipe) => recipe.class_path),
        chain,
      });
      return;
    }
    if (depth <= 0) {
      unresolved.push({
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round(remaining),
        reason: "max_depth_reached",
        chain,
      });
      return;
    }

    const options = recipeOptions.usable;
    const requestedRecipe =
      depth === max_depth && recipe_class
        ? recipeOptions.all.find((recipe) => recipe.class_path === recipe_class)
        : null;
    if (
      requestedRecipe &&
      (requestedRecipe.available === false ||
        (availabilityKnown && requestedRecipe.available !== true))
    ) {
      unresolved.push({
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round(remaining),
        reason: requestedRecipe.available === false
          ? "requested_recipe_is_unavailable_in_this_save"
          : "requested_recipe_is_not_proven_available_in_the_current_capture",
        recipe_class: requestedRecipe.class_path,
        chain,
      });
      return;
    }

    // "All Mk.1 parts" means the ordinary early-game chain, not an alternate
    // recipe that happens to have higher yield or is already running elsewhere
    // in a heavily modded save. The standard recipe's display name is exactly
    // the product's item name. This preference applies recursively so Wire does
    // not quietly become Caterium Wire or Pure Copper Ingot downstream.
    const itemDisplayName = String(graph.itemsByClass.get(itemClass)?.name ?? "").trim();
    const isStandardRecipe = (candidate) =>
      itemDisplayName &&
      String(candidate?.name ?? "").trim().toLowerCase() ===
        itemDisplayName.toLowerCase();
    const registeredStandardRecipe = prefer_standard_recipes
      ? recipeOptions.all.find(isStandardRecipe)
      : null;
    if (
      registeredStandardRecipe &&
      (registeredStandardRecipe.available === false ||
        (availabilityKnown && registeredStandardRecipe.available !== true))
    ) {
      unresolved.push({
        item_class: itemClass,
        item_name: itemDisplayName || null,
        display_units_per_minute: round(remaining),
        reason: registeredStandardRecipe.available === false
          ? "standard_recipe_is_unavailable_in_this_save"
          : "standard_recipe_is_not_proven_available_in_the_current_capture",
        recipe_class: registeredStandardRecipe.class_path,
        chain,
      });
      return;
    }
    const standardRecipe = prefer_standard_recipes
      ? options.find(isStandardRecipe)
      : null;

    // Prefer an explicitly requested recipe, then the standard recipe when
    // requested, then one already used in this world, then highest yield.
    const chosen =
      requestedRecipe ||
      standardRecipe ||
      options.find((r) => inUseRecipeClasses.has(r.class_path)) ||
      options.slice().sort((a, b) => (recipeOutputRate(graph, b, itemClass) ?? 0) - (recipeOutputRate(graph, a, itemClass) ?? 0))[0];

    const perMachine = recipeOutputRate(graph, chosen, itemClass);
    if (perMachine === null || perMachine <= 0) {
      unresolved.push({
        item_class: itemClass,
        display_units_per_minute: round(remaining),
        reason: "recipe_rate_not_derivable",
        recipe_class: chosen?.class_path ?? null,
        chain,
      });
      return;
    }

    const machinesExact = remaining / perMachine;
    const machines = Math.ceil(machinesExact - 1e-9);
    const power = observedPowerForBuilding(graph, chosen.produced_in);

    totals.machines += machines;
    if (power) totals.megawatts += power.megawatts_each * machines;
    else totals.power_unknown_steps += 1;

    const cyclesPerMinute = 60 / finitePositive(chosen.duration_seconds);
    const inputs = rateEntries(graph, chosen.ingredients, cyclesPerMinute * machinesExact);

    steps.push({
      step: steps.length + 1,
      depth: max_depth - depth,
      produces: {
        item_class: itemClass,
        item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
        display_units_per_minute: round(remaining),
      },
      recipe_class: chosen.class_path,
      recipe_name: chosen.name ?? null,
      recipe_already_used_here: inUseRecipeClasses.has(chosen.class_path),
      recipe_available_in_save:
        typeof chosen.available === "boolean" ? chosen.available : null,
      alternate_recipes_available: options.length - 1,
      alternate_recipes_locked: recipeOptions.locked.length,
      produced_in: chosen.produced_in ?? [],
      machines_required: machines,
      machines_exact: round(machinesExact, 3),
      per_machine_display_units_per_minute: round(perMachine),
      utilisation_of_last_machine_percent:
        machines > 0 ? round((machinesExact / machines) * 100, 1) : null,
      power_each_mw: power?.megawatts_each ?? null,
      power_total_mw: power ? round(power.megawatts_each * machines) : null,
      power_source: power?.source ?? "unknown_no_machine_of_this_type_in_your_world",
      inputs_required: inputs,
      chain,
    });

    // Build cost for the machines themselves, from an existing actor's recipe.
    for (const node of graph.nodes.values()) {
      const className = String(node.class_path ?? "").split(".").pop();
      if (!className || !(chosen.produced_in ?? []).some((entry) => String(entry).includes(className))) {
        continue;
      }
      const buildRecipe = graph.recipesByClass.get(node.built_with_recipe);
      if (!buildRecipe) break;
      for (const ingredient of buildRecipe.ingredients ?? []) {
        const amount = (finiteNumber(ingredient.amount) ?? 0) * machines;
        buildCost.set(ingredient.item_class, (buildCost.get(ingredient.item_class) ?? 0) + amount);
      }
      break;
    }

    for (const input of inputs) {
      plan(input.item_class, input.display_units_per_minute, depth - 1, [...chain, chosen.class_path]);
    }
  };

  plan(targetClass, targetRate, Math.max(1, Math.trunc(max_depth) || DEFAULT_PLAN_DEPTH), []);

  const { totals: held } = playerInventories(graph);
  const machineCost = [...buildCost.entries()].map(([itemClass, amount]) => ({
    item_class: itemClass,
    item_name: graph.itemsByClass.get(itemClass)?.name ?? null,
    required: round(amount),
    held_in_player_inventories: held.get(itemClass) ?? 0,
    shortfall: round(Math.max(0, amount - (held.get(itemClass) ?? 0))),
  }));

  // A plan that needs more power than the grid has is not buildable as stated,
  // so the headroom check happens here rather than being left to the reader.
  const circuits = solvePowerCircuits(graph).circuits;
  const bestHeadroom = circuits.reduce(
    (best, circuit) => Math.max(best, circuit.headroom_mw ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );
  const headroom = Number.isFinite(bestHeadroom) ? bestHeadroom : null;
  const powerCheck =
    headroom === null
      ? {
          checked: false,
          reason: "no_power_circuit_captured",
          note: "No circuit was captured, so whether the grid can carry this plan is unknown.",
        }
      : {
          checked: true,
          plan_draw_mw: round(totals.megawatts),
          best_circuit_headroom_mw: round(headroom),
          circuit_id: circuits.find((circuit) => circuit.headroom_mw === bestHeadroom)?.circuit_id ?? null,
          fits_on_existing_power: totals.megawatts <= headroom,
          additional_mw_needed: round(Math.max(0, totals.megawatts - headroom)),
          partial: totals.power_unknown_steps > 0,
          note:
            totals.power_unknown_steps > 0
              ? "Some steps had no machine of that type to read draw from, so the plan's real draw is at least this much."
              : null,
        };

  return {
    solver: "production_plan",
    world_revision: graph.world_revision,
    planned: steps.length > 0 || coveredBySurplus.length > 0,
    power_check: powerCheck,
    target: {
      item_class: targetClass,
      item_name: graph.itemsByClass.get(targetClass)?.name ?? null,
      display_units_per_minute: targetRate,
    },
    planned_against_this_base: use_existing_surplus,
    steps,
    step_count: steps.length,
    covered_by_existing_surplus: coveredBySurplus,
    raw_inputs_required: [...rawInputs.values()].map(({ raw, ...rest }) => rest),
    unresolved,
    totals: {
      machines: totals.machines,
      power_mw: round(totals.megawatts),
      power_is_partial: totals.power_unknown_steps > 0,
      power_unknown_steps: totals.power_unknown_steps,
    },
    machine_build_cost: machineCost,
    affordable_from_captured_player_inventories:
      machineCost.length > 0 ? machineCost.every((entry) => entry.shortfall === 0) : null,
    step_budget_hit: stepBudgetHit,
    caveats: {
      recipe_choice:
        prefer_standard_recipes
          ? "Unavailable recipes are excluded. The recipe whose name exactly matches each product is preferred recursively; existing-use and yield only break a missing standard match."
          : "Unavailable recipes are excluded. Among usable recipes, ones already used in this world are preferred, then the highest-yield option. Pass recipe_class to force one.",
      unlocks:
        graph.snapshot?.content?.availability_known === true
          ? "Recipe choices use the loaded save's authoritative AFGRecipeManager availability state."
          : "This older snapshot lacks recipe-manager availability; recipes already in use are known available and other registered recipes remain uncertain.",
      power:
        "Per-machine draw is read off your own machines of that type. Steps with no such machine report power as unknown rather than estimating it.",
      layout:
        "This is a bill of materials and machine count, not a physical layout. Placement still needs find_best_site for ground and the game's own hologram check.",
      terminal_inputs:
        terminalInputs.size > 0
          ? [...terminalInputs]
          : "none supplied; catalog recipes may expand resources that can also be manufactured",
    },
    source: "deterministic_recipe_expansion_over_the_authoritative_catalog",
    certainty: "calculated",
  };
}

/* ------------------------------------------------------------------ *
 * Full report
 * ------------------------------------------------------------------ */

/** Runs every solver once. Used by `/v1/analyze` and the compact digest. */
export function analyzeSnapshot(snapshot, options = {}) {
  const graph = buildGraph(snapshot, options);
  return {
    schema: "aifactory.analysis",
    schema_version: 1,
    world_revision: graph.world_revision,
    factory_summary: solveFactorySummary(graph),
    machine_rates: solveMachineRates(graph),
    item_balance: solveItemBalance(graph),
    transport_capacity: solveTransportCapacity(graph, { only_problems: true }),
    power_circuits: solvePowerCircuits(graph),
    bottlenecks: solveBottlenecks(graph),
    unlock_status: solveUnlockStatus(graph),
    graph_completeness: {
      node_count: graph.nodes.size,
      unresolved_connection_count: graph.unresolvedConnections.length,
      unresolved_connections: graph.unresolvedConnections.slice(0, 50),
    },
    source: "deterministic_solvers_over_authoritative_snapshot",
    certainty: "calculated",
  };
}

export { buildGraph, normalizeProductionStatus };

/**
 * Finds a specific thing in the world and says exactly where it is.
 *
 * The gap this closes: the model could be told a node's name by another solver,
 * then had no way to ask where it was. It said so honestly rather than
 * inventing a coordinate, but a build request naming a node could never
 * succeed. The solvers read the complete snapshot, so the answer was always
 * available — there was simply no tool that returned it.
 *
 * Matches on actor id, name, class, or resource, in that order of specificity.
 */
export function solveActorLookup(graph, args = {}) {
  const { actor_id, name_contains, resource_name, kind, limit = 10 } = args;
  const wanted = String(actor_id ?? "").trim();
  const nameNeedle = String(name_contains ?? "").trim().toLowerCase();
  const resourceNeedle = String(resource_name ?? "").trim().toLowerCase();
  const kindNeedle = String(kind ?? "").trim().toLowerCase();

  if (!wanted && !nameNeedle && !resourceNeedle && !kindNeedle) {
    return {
      solver: "actor_lookup",
      found: false,
      reason: "give an actor_id, name_contains, resource_name, or kind to look for",
    };
  }

  const playerLocation = findPlayerLocation(graph);
  const matches = [];

  for (const node of graph.nodes.values()) {
    const raw = node.raw ?? {};
    const id = String(node.actor_id ?? "");
    const name = String(raw.name ?? "");
    const resource = String(raw.resource_name ?? "");

    if (wanted && id !== wanted && !id.endsWith(wanted) && name !== wanted) continue;
    if (nameNeedle && !name.toLowerCase().includes(nameNeedle) && !id.toLowerCase().includes(nameNeedle)) continue;
    if (resourceNeedle && !resource.toLowerCase().includes(resourceNeedle)) continue;
    if (kindNeedle && String(raw.kind ?? "").toLowerCase() !== kindNeedle) continue;

    const location = raw.location ?? null;
    const entry = {
      actor_id: id,
      name: name || null,
      kind: raw.kind ?? null,
      class_path: node.class_path ?? null,
      location_cm: location,
      distance_meters: location && playerLocation ? round(distanceMeters(playerLocation, location), 1) : null,
    };

    // Resource nodes carry the details that decide whether you can build here.
    if (raw.kind === "resource_node") {
      const nodeType = String(raw.node_type ?? "");
      entry.resource_name = resource || null;
      entry.purity = normalizeResourcePurity(raw.purity);
      entry.node_type = nodeType || null;
      entry.occupied = Boolean(raw.occupied);
      entry.can_host_a_miner = (nodeType === "Node" || nodeType === "FrackingCore") && !raw.occupied;
      if (!entry.can_host_a_miner) {
        entry.why_not = raw.occupied
          ? "something is already built on this node"
          : "this is a hand-mined deposit, which cannot host a miner";
      }
    }
    matches.push(entry);
  }

  matches.sort((a, b) => (a.distance_meters ?? 1e9) - (b.distance_meters ?? 1e9));
  const capped = matches.slice(0, Math.max(1, limit));

  return {
    solver: "actor_lookup",
    found: capped.length > 0,
    query: { actor_id: wanted || null, name_contains: name_contains ?? null, resource_name: resource_name ?? null, kind: kind ?? null },
    match_count: matches.length,
    returned: capped.length,
    matches: capped,
    source: "read_from_the_complete_snapshot",
    certainty: "authoritative",
    note:
      matches.length === 0
        ? "Nothing in this snapshot matches. The capture is radius-limited, so it may exist outside what was scanned."
        : "Coordinates are in centimetres and can be used directly in a placement.",
  };
}

function findPlayerLocation(graph) {
  const fromContext = graph?.snapshot?.interaction_context?.player?.pawn_location;
  if (fromContext) return fromContext;
  for (const node of graph?.nodes?.values() ?? []) {
    if (node.raw?.kind === "player" && node.raw?.location) return node.raw.location;
  }
  return null;
}

/* ---------------- placing a building without a model ---------------- */

/**
 * A build recipe is one the build gun produces. That is the game's own
 * distinction, not a name convention, so it holds for modded buildings too.
 */
const BUILD_GUN_CLASS = "BP_BuildGun";

/** Tokens that add nothing to a building name: "a mk1 miner" == "Miner Mk.1". */
const PLACEMENT_NOISE = new Set(["a", "an", "the", "new", "another", "mk", "mark"]);

function placementTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/mk\s*\.?\s*(\d)/g, "mk$1")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token && !PLACEMENT_NOISE.has(token));
}

/**
 * Finds the build recipe the player named.
 *
 * Exact token-set equality first, then containment. Anything ambiguous is
 * refused with the candidates listed rather than resolved by preference — the
 * player asked for one specific building, and picking for them is the kind of
 * silent guess that puts the wrong machine on a node.
 */
export function solveBuildRecipeLookup(graph, args = {}) {
  const wanted = placementTokens(args.building);
  if (wanted.length === 0) {
    return { solver: "build_recipe_lookup", resolved: false, reason: "no building was named" };
  }

  const recipes = graph?.snapshot?.content?.recipes ?? [];
  const buildRecipes = recipes.filter((recipe) =>
    (recipe.produced_in ?? []).some((producer) => String(producer).includes(BUILD_GUN_CLASS)),
  );

  const wantedKey = [...wanted].sort().join(" ");
  const exact = [];
  const partial = [];
  for (const recipe of buildRecipes) {
    const tokens = placementTokens(recipe.name);
    if (tokens.length === 0) continue;
    if ([...tokens].sort().join(" ") === wantedKey) exact.push(recipe);
    else if (wanted.every((token) => tokens.includes(token))) partial.push(recipe);
  }

  // An unavailable recipe is a real answer: the building exists but is not
  // unlocked, which is different from not existing.
  const pick = (list) => {
    const available = list.filter((recipe) => recipe.available);
    return available.length > 0 ? available : list;
  };

  const candidates = exact.length > 0 ? pick(exact) : pick(partial);
  if (candidates.length === 0) {
    return {
      solver: "build_recipe_lookup",
      resolved: false,
      reason: `nothing buildable is named "${args.building}"`,
    };
  }
  if (candidates.length > 1) {
    return {
      solver: "build_recipe_lookup",
      resolved: false,
      reason: `"${args.building}" matches more than one building`,
      candidates: candidates.slice(0, 6).map((recipe) => recipe.name),
    };
  }

  const [recipe] = candidates;
  if (!recipe.available) {
    return {
      solver: "build_recipe_lookup",
      resolved: false,
      reason: `${recipe.name} is not unlocked yet`,
      recipe_class: recipe.class_path,
    };
  }
  return {
    solver: "build_recipe_lookup",
    resolved: true,
    recipe_class: recipe.class_path,
    name: recipe.name,
    owner_mod: recipe.owner_mod ?? null,
    product_class: recipe.products?.[0]?.item_class ?? null,
    building_stats: recipe.building_stats ?? null,
  };
}

/**
 * Where "this", "here", or a named thing actually is.
 *
 * "this" is whatever the player is aiming at, which the mod captures every
 * tick — the snapshot's own grounding rules say to prefer it over anything in
 * the conversation, because the player has usually moved since.
 */
export function solvePlacementTarget(graph, args = {}) {
  const context = graph?.snapshot?.interaction_context ?? {};
  const kind = args.kind;

  if (kind === "aim") {
    const target = context.preferred_target;
    if (!target?.available) {
      return { resolved: false, reason: "you are not aiming at anything the capture could identify" };
    }
    const snapshotOfActor = target.actor_snapshot ?? {};
    // A resource node is placed *on*, so its own centre is the target. Ground
    // is placed *at*, so the exact point under the crosshair is.
    if (snapshotOfActor.kind === "resource_node" && snapshotOfActor.location) {
      return {
        resolved: true,
        location: snapshotOfActor.location,
        on: snapshotOfActor.name ?? target.actor_name,
        node_type: snapshotOfActor.node_type ?? null,
        occupied: Boolean(snapshotOfActor.occupied),
        purity: snapshotOfActor.purity ?? null,
        resource_class: snapshotOfActor.resource_class ?? null,
        resource_name: snapshotOfActor.resource_name ?? null,
        // The node itself, not the ground under it. A miner has to be told what
        // it sits on: the mod's downward trace hits the terrain mesh beside the
        // node, which positions the hologram correctly and binds it to nothing.
        actor_id: snapshotOfActor.actor_id ?? target.actor_id ?? null,
      };
    }

    // A placed extractor physically covers the node it mines, so the camera
    // normally hits the machine rather than the node underneath it. Current
    // snapshots carry the game's GetExtractableResource() relation. Follow
    // that exact actor id back to the complete graph instead of inferring a
    // resource from an inventory stack or nearest-neighbour geometry.
    const extractor = snapshotOfActor.extractor;
    if (extractor) {
      const resourceActorId = String(extractor.extractable_resource_actor_id ?? "").trim();
      const capturedResource = resourceActorId
        ? graph?.nodes?.get?.(resourceActorId)?.raw ?? null
        : null;
      const resourceClass = capturedResource?.resource_class ?? extractor.resource_class ?? null;
      const resourceName = capturedResource?.resource_name ?? extractor.resource_name ?? null;
      if (resourceActorId && (resourceClass || resourceName)) {
        return {
          resolved: true,
          location: capturedResource?.location ?? snapshotOfActor.location ?? target.hit_location,
          on: capturedResource?.name ?? resourceActorId,
          node_type: capturedResource?.node_type ?? null,
          occupied: true,
          purity: capturedResource?.purity ?? null,
          resource_class: resourceClass,
          resource_name: resourceName,
          actor_id: resourceActorId,
          existing_extractor_actor_id: snapshotOfActor.actor_id ?? target.actor_id ?? null,
          existing_extractor_name: snapshotOfActor.name ?? target.actor_name ?? "existing extractor",
          extraction_per_minute: Number.isFinite(Number(extractor.extraction_per_minute))
            ? Number(extractor.extraction_per_minute)
            : null,
          resource_relation_source: "authoritative_extractor_interface",
        };
      }
    }
    if (target.hit_location) {
      return { resolved: true, location: target.hit_location, on: target.actor_name ?? "the ground" };
    }
    return { resolved: false, reason: "the thing you are aiming at has no usable position" };
  }

  if (kind === "here") {
    const here = context.preferred_target?.hit_location ?? context.player?.pawn_location;
    return here
      ? { resolved: true, location: here, on: "where you are standing" }
      : { resolved: false, reason: "your position is not in this capture" };
  }

  const found = solveActorLookup(graph, { ...args.lookup, limit: 1 });
  const [match] = found?.matches ?? [];
  if (!match?.location_cm) {
    return { resolved: false, reason: `nothing in the snapshot matches "${args.lookup?.target}"` };
  }
  return {
    resolved: true,
    location: match.location_cm,
    on: match.name ?? match.actor_id,
    node_type: match.node_type ?? null,
    occupied: match.occupied ?? false,
  };
}
