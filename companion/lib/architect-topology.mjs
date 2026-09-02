/**
 * First fail-closed AI Architect working-topology adapter.
 *
 * The semantic manifest carries exact production dependencies, but a material
 * edge is not yet a conveyor. This module accepts only the narrow direct case:
 * equal numbers of fully utilised producer/consumer machines, equal per-lane
 * rates, one captured native output and input per class, a solid item, and an
 * unlocked conveyor whose capacity was observed on a live captured instance.
 * Splitters, mergers, lifts, poles, fluids and external I/O remain explicit
 * blockers rather than being improvised here.
 */

const EPSILON = 1e-6;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortClass(value) {
  return String(value ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

function sameClass(left, right) {
  if (String(left ?? "") === String(right ?? "")) return true;
  const wanted = shortClass(left);
  return Boolean(wanted) && wanted === shortClass(right);
}

function catalogEntry(map, classPath) {
  const exact = map?.get?.(classPath);
  if (exact) return exact;
  const wanted = shortClass(classPath);
  if (!wanted) return null;
  const matches = [...(map?.values?.() ?? [])].filter(
    (entry) => shortClass(entry?.class_path) === wanted,
  );
  return matches.length === 1 ? matches[0] : null;
}

function isBuildGunProducer(value) {
  const name = shortClass(value);
  return name === "BP_BuildGun" || name === "FGBuildGun";
}

function directionMatches(value, wanted) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === wanted || normalized === wanted.replace("FCD_", "");
}

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function exactFactoryPort(building, wanted) {
  const captured = Array.isArray(building?.native_factory_connections)
    ? building.native_factory_connections
    : null;
  if (!captured) {
    return {
      resolved: false,
      reason: `architect_${wanted.toLowerCase()}_factory_ports_were_not_captured`,
    };
  }
  const matches = captured
    .filter((entry) => directionMatches(entry?.direction, wanted))
    .map((entry) => ({
      name: String(entry?.component_name ?? "").trim(),
      location: vector(entry?.native_default_location_cm),
      normal: vector(entry?.native_default_normal),
    }))
    .filter((entry) => entry.name && entry.location && entry.normal &&
      Math.hypot(entry.normal.x, entry.normal.y, entry.normal.z) > EPSILON);
  if (matches.length !== 1) {
    return {
      resolved: false,
      reason: `architect_${wanted.toLowerCase()}_needs_one_exact_native_factory_port`,
      captured_port_count: captured.length,
      matching_port_count: matches.length,
    };
  }
  return { resolved: true, ...matches[0] };
}

function buildRecipeMetadata(graph, recipeClass) {
  const recipe = catalogEntry(graph?.recipesByClass, recipeClass);
  const item = catalogEntry(graph?.itemsByClass, recipe?.products?.[0]?.item_class);
  return recipe && item?.building
    ? { recipe, item, building: item.building }
    : null;
}

function observedBeltCandidates(graph) {
  const candidates = [];
  for (const recipe of graph?.recipesByClass?.values?.() ?? []) {
    if (recipe?.available !== true ||
        !(recipe.produced_in ?? []).some(isBuildGunProducer)) continue;
    const item = catalogEntry(graph?.itemsByClass, recipe?.products?.[0]?.item_class);
    const buildableClass = String(item?.building?.class_path ?? "").trim();
    const identity = `${item?.building?.native_topology_kind ?? ""} ` +
      `${item?.class_path ?? ""} ${item?.name ?? ""} ${recipe?.name ?? ""}`;
    if (!buildableClass ||
        !(String(item?.building?.native_topology_kind ?? "") === "conveyor" ||
          /ConveyorBelt|Conveyor Belt/i.test(identity))) continue;
    const observed = [...(graph?.nodes?.values?.() ?? [])]
      .filter((node) => sameClass(node?.class_path, buildableClass))
      .map((node) => ({
        actor_id: node.actor_id,
        items_per_minute: finite(node?.conveyor?.items_per_minute),
      }))
      .filter((entry) => entry.items_per_minute !== null && entry.items_per_minute > 0)
      .sort((left, right) => left.items_per_minute - right.items_per_minute ||
        String(left.actor_id).localeCompare(String(right.actor_id)));
    if (observed.length === 0) continue;
    candidates.push({
      recipe_class: recipe.class_path,
      item_class: item.class_path,
      building_class: buildableClass,
      items_per_minute: observed[0].items_per_minute,
      observed_actor_id: observed[0].actor_id,
    });
  }
  return candidates.sort((left, right) =>
    left.items_per_minute - right.items_per_minute ||
    String(left.recipe_class).localeCompare(String(right.recipe_class)));
}

function close(left, right) {
  return Math.abs(Number(left) - Number(right)) <= EPSILON;
}

/** Compile every exact internal material dependency or refuse the set whole. */
export function compileArchitectConveyors(graph, manifest, buildingActions) {
  const edges = manifest?.program?.material_edges;
  if (!Array.isArray(edges)) {
    return {
      compiled: false,
      reason: "architect_manifest_has_no_exact_material_edge_array",
    };
  }
  if (edges.length === 0) {
    return {
      compiled: true,
      actions: [],
      topology_schema: "aifactory.generated-blueprint/v1",
      evidence: [],
      note: "No internal production dependency exists in this manifest; external I/O remains uncompiled.",
    };
  }
  if (!Array.isArray(buildingActions) ||
      buildingActions.some((action) => action?.action !== "place_building")) {
    return { compiled: false, reason: "architect_topology_requires_the_exact_building_action_sequence" };
  }

  const groups = new Map(
    (manifest?.program?.groups ?? []).map((group) => [String(group?.id ?? ""), group]),
  );
  const actionsByGroup = new Map();
  for (const action of buildingActions) {
    const groupId = String(action?.architect_group_id ?? "").trim();
    if (!groupId) continue;
    if (!actionsByGroup.has(groupId)) actionsByGroup.set(groupId, []);
    actionsByGroup.get(groupId).push(action);
  }
  const stepByAction = new Map(buildingActions.map((action, index) => [action, index + 1]));
  const beltCandidates = observedBeltCandidates(graph);
  const usedPorts = new Set();
  const actions = [];
  const evidence = [];

  for (const edge of edges) {
    const edgeId = String(edge?.id ?? "").trim() || "unknown";
    const producer = groups.get(String(edge?.from_program_group ?? ""));
    const consumer = groups.get(String(edge?.to_program_group ?? ""));
    const producerActions = actionsByGroup.get(producer?.id) ?? [];
    const consumerActions = actionsByGroup.get(consumer?.id) ?? [];
    if (!producer || !consumer || producerActions.length !== Number(producer.machines) ||
        consumerActions.length !== Number(consumer.machines)) {
      return {
        compiled: false,
        reason: "architect_material_edge_machine_groups_do_not_match_compiled_actions",
        edge_id: edgeId,
      };
    }
    if (producerActions.length !== consumerActions.length) {
      return {
        compiled: false,
        reason: "architect_material_edge_requires_splitter_or_merger_topology",
        edge_id: edgeId,
        producer_machines: producerActions.length,
        consumer_machines: consumerActions.length,
      };
    }
    if (!close(producer.machines_exact, producer.machines) ||
        !close(consumer.machines_exact, consumer.machines)) {
      return {
        compiled: false,
        reason: "architect_material_edge_requires_clocking_to_preserve_exact_rates",
        edge_id: edgeId,
      };
    }
    const item = catalogEntry(graph?.itemsByClass, edge?.item_class);
    if (!item || String(item.form ?? "").toUpperCase() !== "RF_SOLID") {
      return {
        compiled: false,
        reason: "architect_material_edge_is_not_a_proven_solid_conveyor_item",
        edge_id: edgeId,
        item_class: edge?.item_class ?? null,
      };
    }
    const requiredRate = finite(edge?.required_rate_per_minute);
    const laneRate = requiredRate === null ? null : requiredRate / consumerActions.length;
    const producerRate = finite(producer?.per_machine_output_rate_per_minute);
    if (laneRate === null || laneRate <= 0 || producerRate === null || producerRate <= 0 ||
        !close(laneRate, producerRate)) {
      return {
        compiled: false,
        reason: "architect_material_edge_lane_rates_require_balancing_topology",
        edge_id: edgeId,
        producer_rate_per_lane: producerRate,
        consumer_rate_per_lane: laneRate,
      };
    }
    const producerMetadata = buildRecipeMetadata(graph, producer.build_recipe_class);
    const consumerMetadata = buildRecipeMetadata(graph, consumer.build_recipe_class);
    const output = exactFactoryPort(producerMetadata?.building, "FCD_OUTPUT");
    const input = exactFactoryPort(consumerMetadata?.building, "FCD_INPUT");
    if (!producerMetadata || !consumerMetadata || !output.resolved || !input.resolved) {
      return {
        compiled: false,
        reason: "architect_material_edge_native_connectors_are_not_unambiguous",
        edge_id: edgeId,
        producer_connector: output,
        consumer_connector: input,
      };
    }
    const belt = beltCandidates.find((candidate) =>
      candidate.items_per_minute + EPSILON >= laneRate);
    if (!belt) {
      return {
        compiled: false,
        reason: "architect_material_edge_has_no_observed_unlocked_belt_capacity",
        edge_id: edgeId,
        required_items_per_minute: laneRate,
        observed_candidates: beltCandidates.map((candidate) => ({
          recipe_class: candidate.recipe_class,
          items_per_minute: candidate.items_per_minute,
        })),
      };
    }

    for (let index = 0; index < producerActions.length; index += 1) {
      const fromAction = producerActions[index];
      const toAction = consumerActions[index];
      const fromStep = stepByAction.get(fromAction);
      const toStep = stepByAction.get(toAction);
      const fromKey = `${fromStep}|${output.name}`;
      const toKey = `${toStep}|${input.name}`;
      if (!fromStep || !toStep || usedPorts.has(fromKey) || usedPorts.has(toKey)) {
        return {
          compiled: false,
          reason: "architect_material_edge_would_reuse_a_native_factory_port",
          edge_id: edgeId,
          lane: index + 1,
        };
      }
      usedPorts.add(fromKey);
      usedPorts.add(toKey);
      actions.push({
        action: "place_belt",
        recipe_class: belt.recipe_class,
        from_step: fromStep,
        to_step: toStep,
        from_connector_name: output.name,
        to_connector_name: input.name,
        commit: false,
      });
    }
    evidence.push({
      edge_id: edgeId,
      item_class: item.class_path ?? edge.item_class,
      lanes: producerActions.length,
      lane_rate_per_minute: laneRate,
      belt_recipe_class: belt.recipe_class,
      belt_capacity_per_minute: belt.items_per_minute,
      belt_capacity_observed_actor_id: belt.observed_actor_id,
      producer_connector_name: output.name,
      consumer_connector_name: input.name,
      certainty:
        "exact production provenance and rates + captured native endpoints + observed unlocked conveyor capacity; game hologram/readback still authoritative",
    });
  }

  return {
    compiled: true,
    actions,
    topology_schema: "aifactory.generated-blueprint/v2",
    evidence,
    limits: [
      "direct_equal_count_one_to_one_lanes_only",
      "fully_utilised_unclocked_machines_only",
      "one_exact_native_input_and_output_per_endpoint_class",
      "no_splitters_mergers_lifts_poles_fluids_or_external_io",
    ],
  };
}
