/**
 * Fail-closed AI Architect fluid topology adapter.
 *
 * Generated Blueprint v3 already owns the native pipeline writer and game-side
 * reciprocal readback. This adapter only maps an exact semantic fluid edge to
 * that primitive when one straight, one-to-one lane is completely proven.
 * Pumps, head lift, junctions, bent routes and external hookups stay blockers.
 */

const EPSILON = 1e-6;
const SECONDS_PER_MINUTE = 60;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortClass(value) {
  return String(value ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
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

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function isFluidForm(value) {
  const form = String(value ?? "").trim().toUpperCase();
  return form === "RF_LIQUID" || form === "RF_GAS";
}

function buildRecipeMetadata(graph, recipeClass) {
  const recipe = catalogEntry(graph?.recipesByClass, recipeClass);
  const item = catalogEntry(graph?.itemsByClass, recipe?.products?.[0]?.item_class);
  return recipe && item?.building
    ? { recipe, item, building: item.building }
    : null;
}

function exactPipePort(building, wanted) {
  const captured = Array.isArray(building?.native_pipe_connections)
    ? building.native_pipe_connections
    : null;
  if (!captured) {
    return {
      resolved: false,
      reason: `architect_${wanted.toLowerCase()}_pipe_ports_were_not_captured`,
    };
  }
  const matches = captured
    .filter((entry) => {
      const type = String(entry?.pipe_connection_type ?? "").trim().toUpperCase();
      return type === wanted || type === "PCT_ANY";
    })
    .map((entry) => ({
      name: String(entry?.component_name ?? "").trim(),
      component_class_path: String(entry?.component_class_path ?? "").trim(),
      location: vector(entry?.native_default_location_cm),
      normal: vector(entry?.native_default_normal),
      clearance_cm: finite(entry?.connector_clearance_cm),
      snapping_disallowed: entry?.snapping_disallowed === true,
      pipe_connection_type: String(entry?.pipe_connection_type ?? "").trim(),
    }))
    .filter((entry) => entry.name && entry.component_class_path && entry.location &&
      entry.normal && Math.hypot(entry.normal.x, entry.normal.y, entry.normal.z) > EPSILON &&
      !entry.snapping_disallowed);
  if (matches.length !== 1) {
    return {
      resolved: false,
      reason: `architect_${wanted.toLowerCase()}_needs_one_exact_native_pipe_port`,
      captured_port_count: captured.length,
      matching_usable_port_count: matches.length,
    };
  }
  return { resolved: true, ...matches[0] };
}

function pipelineCandidates(graph) {
  const candidates = [];
  for (const recipe of graph?.recipesByClass?.values?.() ?? []) {
    if (recipe?.available !== true ||
        !(recipe.produced_in ?? []).some(isBuildGunProducer)) continue;
    const item = catalogEntry(graph?.itemsByClass, recipe?.products?.[0]?.item_class);
    const building = item?.building;
    if (String(building?.native_topology_kind ?? "") !== "pipeline") continue;
    const flowLimit = finite(building?.pipeline_flow_limit_m3_s);
    const minimum = finite(building?.pipeline_min_length_cm);
    const maximum = finite(building?.pipeline_max_length_cm);
    const buildableClass = String(building?.class_path ?? "").trim();
    if (!buildableClass || flowLimit === null || flowLimit <= 0 ||
        minimum === null || minimum <= 0 || maximum === null || maximum < minimum) continue;
    candidates.push({
      recipe_class: recipe.class_path,
      item_class: item.class_path,
      building_class: buildableClass,
      flow_limit_m3_s: flowLimit,
      capacity_m3_per_minute: flowLimit * SECONDS_PER_MINUTE,
      minimum_length_cm: minimum,
      maximum_length_cm: maximum,
      maximum_length_source: building.pipeline_max_length_source ?? null,
    });
  }
  return candidates.sort((left, right) =>
    left.capacity_m3_per_minute - right.capacity_m3_per_minute ||
    String(left.recipe_class).localeCompare(String(right.recipe_class)));
}

function close(left, right) {
  return Math.abs(Number(left) - Number(right)) <= EPSILON;
}

function rotateYaw(value, yawDegrees) {
  const radians = Number(yawDegrees) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: value.x * cosine - value.y * sine,
    y: value.x * sine + value.y * cosine,
    z: value.z,
  };
}

function transformedPort(action, port) {
  const origin = vector(action?.location);
  const yaw = finite(action?.yaw);
  if (!origin || yaw === null) return null;
  const offset = rotateYaw(port.location, yaw);
  const normal = rotateYaw(port.normal, yaw);
  const normalLength = Math.hypot(normal.x, normal.y, normal.z);
  if (normalLength <= EPSILON) return null;
  return {
    location: {
      x: origin.x + offset.x,
      y: origin.y + offset.y,
      z: origin.z + offset.z,
    },
    normal: {
      x: normal.x / normalLength,
      y: normal.y / normalLength,
      z: normal.z / normalLength,
    },
  };
}

function directAlignment(fromAction, output, toAction, input) {
  const from = transformedPort(fromAction, output);
  const to = transformedPort(toAction, input);
  if (!from || !to) return { aligned: false, reason: "non_finite_transformed_connector" };
  const delta = {
    x: to.location.x - from.location.x,
    y: to.location.y - from.location.y,
    z: to.location.z - from.location.z,
  };
  const distance = Math.hypot(delta.x, delta.y, delta.z);
  if (!Number.isFinite(distance) || distance <= EPSILON) {
    return { aligned: false, reason: "connector_endpoints_have_no_finite_separation" };
  }
  const travel = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
  const fromAlignment = from.normal.x * travel.x +
    from.normal.y * travel.y + from.normal.z * travel.z;
  const toAlignment = to.normal.x * travel.x +
    to.normal.y * travel.y + to.normal.z * travel.z;
  const minimum = 0.995;
  return {
    aligned: fromAlignment >= minimum && toAlignment <= -minimum,
    reason: "connector_endpoints_require_explicit_multi_leg_route",
    distance_cm: distance,
    from_alignment: fromAlignment,
    to_alignment: toAlignment,
  };
}

function exactRecipeFluid(graph, recipeClass, side, itemClass) {
  const recipe = catalogEntry(graph?.recipesByClass, recipeClass);
  const entries = side === "producer" ? recipe?.products : recipe?.ingredients;
  if (!recipe || !Array.isArray(entries)) return false;
  const fluids = entries.filter((entry) =>
    isFluidForm(catalogEntry(graph?.itemsByClass, entry?.item_class)?.form));
  return fluids.length === 1 && shortClass(fluids[0]?.item_class) === shortClass(itemClass);
}

/** Partition all exact semantic material edges; unknown forms are never omitted. */
export function partitionArchitectMaterialEdges(graph, manifest) {
  const edges = manifest?.program?.material_edges;
  if (!Array.isArray(edges)) {
    return { partitioned: false, reason: "architect_manifest_has_no_exact_material_edge_array" };
  }
  const solid_edges = [];
  const fluid_edges = [];
  for (const edge of edges) {
    const item = catalogEntry(graph?.itemsByClass, edge?.item_class);
    const form = String(item?.form ?? "").trim().toUpperCase();
    if (form === "RF_SOLID") solid_edges.push(edge);
    else if (form === "RF_LIQUID" || form === "RF_GAS") fluid_edges.push(edge);
    else {
      return {
        partitioned: false,
        reason: "architect_material_edge_transport_form_is_not_proven",
        edge_id: edge?.id ?? null,
        item_class: edge?.item_class ?? null,
        captured_form: form || null,
      };
    }
  }
  return { partitioned: true, solid_edges, fluid_edges, total_edges: edges.length };
}

/** Compile every supplied liquid/gas dependency or refuse the set whole. */
export function compileArchitectPipelines(graph, manifest, buildingActions) {
  const edges = manifest?.program?.material_edges;
  if (!Array.isArray(edges)) {
    return { compiled: false, reason: "architect_manifest_has_no_exact_material_edge_array" };
  }
  if (edges.length === 0) {
    return {
      compiled: true,
      pipeline_connections: [],
      topology_schema: "aifactory.generated-blueprint/v1",
      evidence: [],
      note: "No internal liquid or gas dependency exists in this manifest.",
    };
  }
  if (!Array.isArray(buildingActions) ||
      buildingActions.some((action) => action?.action !== "place_building")) {
    return { compiled: false, reason: "architect_fluid_topology_requires_the_exact_building_action_sequence" };
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
  const candidates = pipelineCandidates(graph);
  const usedPorts = new Set();
  const pipelineConnections = [];
  const evidence = [];

  for (const edge of edges) {
    const edgeId = String(edge?.id ?? "").trim() || "unknown";
    const item = catalogEntry(graph?.itemsByClass, edge?.item_class);
    if (!item || !isFluidForm(item.form)) {
      return {
        compiled: false,
        reason: "architect_material_edge_is_not_a_proven_liquid_or_gas",
        edge_id: edgeId,
        item_class: edge?.item_class ?? null,
      };
    }
    const producer = groups.get(String(edge?.from_program_group ?? ""));
    const consumer = groups.get(String(edge?.to_program_group ?? ""));
    const producerActions = actionsByGroup.get(producer?.id) ?? [];
    const consumerActions = actionsByGroup.get(consumer?.id) ?? [];
    if (!producer || !consumer || producerActions.length !== Number(producer.machines) ||
        consumerActions.length !== Number(consumer.machines)) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_machine_groups_do_not_match_compiled_actions",
        edge_id: edgeId,
      };
    }
    const supplementalInput = (manifest?.program?.external_inputs ?? []).find(
      (input) => input?.consumer_group === consumer.id &&
        shortClass(input?.item_class) === shortClass(edge?.item_class) &&
        finite(input?.rate_per_minute) > EPSILON,
    );
    if (supplementalInput) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_requires_junction_for_external_supplement",
        edge_id: edgeId,
        internal_rate_m3_per_minute: finite(edge?.required_rate_per_minute),
        external_rate_m3_per_minute: finite(supplementalInput.rate_per_minute),
      };
    }
    if (producerActions.length !== consumerActions.length) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_requires_junction_topology",
        edge_id: edgeId,
        producer_machines: producerActions.length,
        consumer_machines: consumerActions.length,
      };
    }
    if (!close(producer.machines_exact, producer.machines) ||
        !close(consumer.machines_exact, consumer.machines)) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_requires_clocking_to_preserve_exact_rates",
        edge_id: edgeId,
      };
    }
    if (!exactRecipeFluid(graph, producer.production_recipe_class, "producer", edge.item_class) ||
        !exactRecipeFluid(graph, consumer.production_recipe_class, "consumer", edge.item_class)) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_recipe_to_port_identity_is_ambiguous",
        edge_id: edgeId,
        item_class: edge.item_class,
      };
    }
    const requiredRate = finite(edge?.required_rate_per_minute);
    const laneRate = requiredRate === null ? null : requiredRate / consumerActions.length;
    const producerRate = finite(producer?.per_machine_output_rate_per_minute);
    if (laneRate === null || laneRate <= 0 || producerRate === null || producerRate <= 0 ||
        !close(laneRate, producerRate)) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_lane_rates_require_balancing_topology",
        edge_id: edgeId,
        producer_rate_m3_per_minute_per_lane: producerRate,
        consumer_rate_m3_per_minute_per_lane: laneRate,
      };
    }
    const producerMetadata = buildRecipeMetadata(graph, producer.build_recipe_class);
    const consumerMetadata = buildRecipeMetadata(graph, consumer.build_recipe_class);
    const output = exactPipePort(producerMetadata?.building, "PCT_PRODUCER");
    const input = exactPipePort(consumerMetadata?.building, "PCT_CONSUMER");
    if (!producerMetadata || !consumerMetadata || !output.resolved || !input.resolved) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_native_connectors_are_not_unambiguous",
        edge_id: edgeId,
        producer_connector: output,
        consumer_connector: input,
      };
    }
    const pipeline = candidates.find((candidate) =>
      candidate.capacity_m3_per_minute + EPSILON >= laneRate);
    if (!pipeline) {
      return {
        compiled: false,
        reason: "architect_fluid_edge_has_no_unlocked_pipeline_with_captured_capacity",
        edge_id: edgeId,
        required_m3_per_minute: laneRate,
        captured_candidates: candidates.map((candidate) => ({
          recipe_class: candidate.recipe_class,
          capacity_m3_per_minute: candidate.capacity_m3_per_minute,
        })),
      };
    }

    const laneDiagnostics = [];
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
          reason: "architect_fluid_edge_would_reuse_a_native_pipe_port",
          edge_id: edgeId,
          lane: index + 1,
        };
      }
      const alignment = directAlignment(fromAction, output, toAction, input);
      if (!alignment.aligned) {
        return {
          compiled: false,
          reason: "architect_fluid_edge_requires_explicit_multi_leg_route",
          edge_id: edgeId,
          lane: index + 1,
          direct_route_diagnostic: alignment,
        };
      }
      if (alignment.distance_cm < pipeline.minimum_length_cm ||
          alignment.distance_cm > pipeline.maximum_length_cm) {
        return {
          compiled: false,
          reason: "architect_fluid_edge_exceeds_captured_native_length_limits",
          edge_id: edgeId,
          lane: index + 1,
          distance_cm: alignment.distance_cm,
          captured_minimum_cm: pipeline.minimum_length_cm,
          captured_maximum_cm: pipeline.maximum_length_cm,
        };
      }
      usedPorts.add(fromKey);
      usedPorts.add(toKey);
      laneDiagnostics.push(alignment);
      pipelineConnections.push({
        recipe_class: pipeline.recipe_class,
        from_step: fromStep,
        to_step: toStep,
        from_connector_name: output.name,
        to_connector_name: input.name,
      });
    }
    evidence.push({
      edge_id: edgeId,
      item_class: item.class_path ?? edge.item_class,
      item_form: item.form,
      lanes: producerActions.length,
      lane_rate_m3_per_minute: laneRate,
      pipeline_recipe_class: pipeline.recipe_class,
      pipeline_capacity_m3_per_minute: pipeline.capacity_m3_per_minute,
      captured_flow_limit_m3_s: pipeline.flow_limit_m3_s,
      captured_length_range_cm: {
        minimum: pipeline.minimum_length_cm,
        maximum: pipeline.maximum_length_cm,
      },
      producer_connector_name: output.name,
      consumer_connector_name: input.name,
      direct_lane_distances_cm: laneDiagnostics.map((entry) => entry.distance_cm),
      certainty:
        "exact production provenance and m3/min rates + captured native pipe endpoints, flow limit and hologram length; game serializer/readback still authoritative",
    });
  }

  return {
    compiled: true,
    pipeline_connections: pipelineConnections,
    topology_schema: "aifactory.generated-blueprint/v3",
    evidence,
    limits: [
      "direct_equal_count_one_to_one_fluid_lanes_only",
      "fully_utilised_unclocked_machines_only",
      "one_exact_native_fluid_input_and_output_per_endpoint_recipe",
      "no_pumps_head_lift_junctions_bent_routes_or_external_fluid_io",
    ],
  };
}
