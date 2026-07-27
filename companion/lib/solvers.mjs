/**
 * Deterministic factory solvers.
 *
 * The language model calls these instead of performing factory arithmetic
 * itself. Every result carries its source and certainty, and every value the
 * snapshot does not support is reported as an explicit unknown with the reason
 * and the field that was missing.
 */

import {
  buildGraph,
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
      availability_evidence:
        (usageCount.get(recipe.class_path) ?? 0) > 0
          ? "in_use_in_world_so_available_to_this_save"
          : "registered_in_content_registry",
      unlock_status: "not_determinable_from_snapshot",
      unlock_reason:
        "The snapshot lists purchased schematics but not the schematic-to-recipe mapping, so recipe unlock state cannot be derived.",
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
    source: "authoritative_content_registry_with_deterministic_rate_arithmetic",
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
    unlock_status: "not_determinable_from_snapshot",
    unlock_reason:
      "Purchased schematics are captured but not their recipe unlocks, so build availability cannot be confirmed from the snapshot.",
    source: "authoritative_content_registry_and_captured_inventories",
    certainty: "calculated",
  };
}

export function solveUnlockStatus(graph) {
  const progression = graph.snapshot?.progression ?? {};
  const purchased = progression.purchased_schematics ?? [];
  return {
    solver: "unlock_status",
    world_revision: graph.world_revision,
    highest_available_tech_tier: finiteNumber(progression.highest_available_tech_tier),
    purchased_schematic_count: purchased.length,
    purchased_schematics: purchased,
    recipe_unlock_mapping: "not_present_in_snapshot",
    recipe_unlock_note:
      "The snapshot lists purchased schematics but not which recipes each unlocks. Recipe availability is therefore unknown unless a machine in the world already uses the recipe.",
    source: "authoritative_schematic_manager",
    certainty: "authoritative_for_listed_schematics",
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
    });
  }

  const usableNodes = allNodes.filter(
    (node) => !node.occupied && node.has_resources && (include_deposits || node.minable),
  );

  const candidates = [];
  const seen = new Set();
  const addCandidate = (location, origin, actorId = null) => {
    if (!location || ![location.x, location.y, location.z].every((value) => Number.isFinite(value))) return;
    const key = `${Math.round(location.x / 5000)}:${Math.round(location.y / 5000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ location, origin, actor_id: actorId });
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
    for (const node of usableNodes) addCandidate(node.location, "resource_node", node.actor_id);
    if (playerLocation) addCandidate(playerLocation, "current_player_position");
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

    const diversityScore = scoreWeights.resource_diversity * resources.length;
    const purityScore = scoreWeights.purity_weighted_nodes * purityWeightTotal;
    const coverageScore = scoreWeights.required_coverage * coverageFraction;
    const distancePenalty = scoreWeights.distance_penalty_per_100m * (meanNearestMeters / 100);
    const score = diversityScore + purityScore + coverageScore - distancePenalty;

    sites.push({
      center_cm: candidate.location,
      candidate_origin: candidate.origin,
      anchor_actor_id: candidate.actor_id,
      score: round(score, 3),
      score_breakdown: {
        resource_diversity: round(diversityScore, 3),
        purity_weighted_nodes: round(purityScore, 3),
        required_coverage: round(coverageScore, 3),
        distance_penalty: round(-distancePenalty, 3),
        formula: "diversity + purity_weighted_nodes + required_coverage - distance_penalty",
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
    sites: ranked,
    scoring_basis: {
      purity_extraction_weights: PURITY_EXTRACTION_WEIGHT,
      purity_weight_source: "documented_extraction_multipliers_not_snapshot_facts",
      note: "Ranking depends on these weights. Different weights give a different winner; the score breakdown shows exactly how each site earned its total.",
    },
    not_captured: {
      terrain_flatness: "Ground slope and buildable area are not in the snapshot.",
      obstructions: "Cliffs, water, and foliage blocking a footprint are not captured.",
      water_availability: "Water extractors sit on water surfaces, not nodes, so water access is unknown.",
      hostile_creatures: "Creature locations are not captured.",
      consequence:
        "This ranks resource access only. Confirm the winning spot is actually flat and buildable before committing.",
    },
    completeness_warning: partialWorld
      ? `The snapshot was captured with a ${scanRadius} m scan radius, so this ranks only what was inside that bubble and cannot answer a world-scale siting question. Recapture with the whole-world snapshot before trusting it.`
      : null,
    source: "deterministic_geometry_over_authoritative_resource_nodes",
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
