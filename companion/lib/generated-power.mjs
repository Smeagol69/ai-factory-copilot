/**
 * Deterministic internal power topology for planner-generated Blueprints.
 *
 * Nothing in here knows that a vanilla Mk.1 pole has four links, that a wire
 * reaches 100 m, or that a particular modded machine can daisy-chain. Those
 * are native class-default facts captured by the game beside each building
 * descriptor. When that capture is absent or ambiguous, power stays explicit
 * and ungenerated instead of being guessed.
 */

const DEFAULT_POLE_CORRIDOR_OFFSET_CM = 800;
const MAX_GENERATED_POWER_POLES = 256;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function shortClass(value) {
  return String(value ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

function catalogEntryByClass(map, classPath) {
  const exact = map?.get?.(classPath);
  if (exact) return exact;
  const wanted = shortClass(classPath);
  if (!wanted) return null;
  const matches = [...(map?.values?.() ?? [])].filter(
    (entry) => shortClass(entry?.class_path) === wanted,
  );
  return matches.length === 1 ? matches[0] : null;
}

function buildRecipeMetadata(graph, recipeClass) {
  const recipe = catalogEntryByClass(graph?.recipesByClass, recipeClass);
  if (!recipe) return null;
  const product = (recipe.products ?? [])[0];
  const item = catalogEntryByClass(graph?.itemsByClass, product?.item_class);
  return item?.building && typeof item.building === "object"
    ? { recipe, item, building: item.building }
    : null;
}

function visibleConnectors(building) {
  const connectors = Array.isArray(building?.native_circuit_connections)
    ? building.native_circuit_connections.filter((connection) => connection?.hidden !== true)
    : [];
  return connectors.map((connection) => ({
    name: String(connection?.component_name ?? "").trim(),
    circuit_type_class_path: String(connection?.circuit_type_class_path ?? "").trim(),
    max_links: finite(connection?.max_links),
  }));
}

function availableBuildGunRecipes(graph) {
  return [...(graph?.recipesByClass?.values?.() ?? [])].filter(
    (recipe) => recipe?.available === true &&
      (recipe.produced_in ?? []).some((producer) => String(producer).includes("BP_BuildGun")),
  );
}

function selectWire(graph) {
  const candidates = availableBuildGunRecipes(graph)
    .map((recipe) => buildRecipeMetadata(graph, recipe.class_path))
    .filter((entry) => entry?.building?.native_topology_kind === "power_wire")
    .map((entry) => ({
      recipe_class: entry.recipe.class_path,
      name: entry.item.name ?? entry.recipe.name,
      owner_mod: entry.recipe.owner_mod ?? entry.item.owner_mod ?? null,
      max_length_cm: finite(entry.building.wire_max_length_cm),
    }))
    .filter((entry) => entry.max_length_cm !== null && entry.max_length_cm > 0)
    .sort((left, right) =>
      right.max_length_cm - left.max_length_cm ||
      String(left.recipe_class).localeCompare(String(right.recipe_class))
    );
  return candidates[0] ?? null;
}

function poleTier(entry) {
  const text = `${entry?.item?.name ?? ""} ${entry?.item?.class_path ?? ""}`;
  const match = text.match(/(?:mk\.?\s*|mark\s*)(\d+)/i);
  return match ? Number(match[1]) : null;
}

function selectGroundPole(graph, preferredTier = null) {
  const candidates = availableBuildGunRecipes(graph)
    .map((recipe) => buildRecipeMetadata(graph, recipe.class_path))
    .filter((entry) =>
      entry?.building?.native_topology_kind === "power_pole" &&
      entry?.building?.power_pole_type === "PPT_POLE"
    )
    .map((entry) => {
      const connectors = visibleConnectors(entry.building);
      return {
        recipe_class: entry.recipe.class_path,
        name: entry.item.name ?? entry.recipe.name,
        owner_mod: entry.recipe.owner_mod ?? entry.item.owner_mod ?? null,
        tier: poleTier(entry),
        connectors,
        capacity: connectors.length === 1 ? connectors[0].max_links : null,
        connector_name: connectors.length === 1 ? connectors[0].name : null,
        circuit_type_class_path:
          connectors.length === 1 ? connectors[0].circuit_type_class_path : null,
      };
    })
    .filter((entry) =>
      entry.capacity !== null && entry.capacity >= 3 &&
      (preferredTier === null || entry.tier === Number(preferredTier))
    )
    .sort((left, right) =>
      right.capacity - left.capacity ||
      (right.tier ?? -1) - (left.tier ?? -1) ||
      String(left.recipe_class).localeCompare(String(right.recipe_class))
    );
  return candidates[0] ?? null;
}

function squaredDistance(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function withinWireLength(left, right, maxLengthCm) {
  return squaredDistance(left, right) <= maxLengthCm ** 2;
}

function machineCapabilities(graph, actions) {
  const machines = [];
  const unavailable = [];
  for (const [index, action] of actions.entries()) {
    const role = String(action?.generated_role ?? "").trim();
    const manufacturer = role === "machine" &&
      Boolean(String(action?.production_recipe_class ?? "").trim());
    const miner = role === "miner";
    if (action?.action !== "place_building" || (!manufacturer && !miner)) {
      continue;
    }
    const location = vector(action.location);
    const metadata = buildRecipeMetadata(graph, action.recipe_class);
    const connectors = visibleConnectors(metadata?.building);
    const minerCapability = !miner || (
      metadata?.building?.native_topology_kind === "resource_extractor" &&
      metadata?.building?.supports_generated_blueprint_resource_anchor === true
    );
    if (!location || !metadata || !minerCapability || connectors.length !== 1 ||
        connectors[0].max_links === null || connectors[0].max_links < 1 ||
        !connectors[0].circuit_type_class_path) {
      unavailable.push({
        step: index + 1,
        recipe_class: action.recipe_class ?? null,
        role,
        reason: !metadata
          ? "native_building_connector_metadata_not_captured"
          : !minerCapability
            ? "generated_miner_lacks_captured_resource_anchor_capability"
          : connectors.length !== 1
            ? "generated_powered_buildable_needs_exactly_one_visible_native_circuit_connector"
            : "generated_powered_buildable_connector_capacity_or_circuit_type_is_unknown",
      });
      continue;
    }
    machines.push({
      step: index + 1,
      location,
      capacity: connectors[0].max_links,
      connector_name: connectors[0].name,
      circuit_type_class_path: connectors[0].circuit_type_class_path,
      recipe_class: metadata.recipe.class_path,
    });
  }
  return { machines, unavailable };
}

function directChain(machines, wire) {
  if (machines.length === 1) {
    return {
      possible: true,
      ordered: machines,
      connections: [],
      external_step: machines[0].step,
    };
  }
  const oneLink = machines.filter((machine) => machine.capacity === 1);
  if (oneLink.length > 1 || machines.some((machine) => machine.capacity < 1)) {
    return { possible: false, reason: "machine_connector_capacity_requires_distribution_poles" };
  }
  const ordered = [
    ...machines.filter((machine) => machine.capacity >= 2),
    ...oneLink,
  ];
  if (ordered[0]?.capacity < 2 ||
      ordered.slice(0, -1).some((machine) => machine.capacity < 2)) {
    return { possible: false, reason: "machine_connector_capacity_requires_distribution_poles" };
  }
  const connections = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    if (!withinWireLength(ordered[index].location, ordered[index + 1].location, wire.max_length_cm)) {
      return { possible: false, reason: "machine_chain_exceeds_captured_wire_length" };
    }
    connections.push({
      recipe_class: wire.recipe_class,
      from_step: ordered[index].step,
      to_step: ordered[index + 1].step,
      from_connector_name: ordered[index].connector_name,
      to_connector_name: ordered[index + 1].connector_name,
    });
  }
  return { possible: true, ordered, connections, external_step: ordered[0].step };
}

function poleCountFor(machineCount, capacity) {
  for (let poles = 1; poles <= MAX_GENERATED_POWER_POLES; poles += 1) {
    // Two links per trunk hop, counted once at each endpoint, and one free
    // link on the first pole is reserved for the player's external grid.
    if (poles * (capacity - 2) + 1 >= machineCount) return poles;
  }
  return null;
}

function centroid(machines) {
  const total = machines.reduce(
    (sum, machine) => ({
      x: sum.x + machine.location.x,
      y: sum.y + machine.location.y,
      z: sum.z + machine.location.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: total.x / machines.length,
    y: total.y / machines.length,
    z: Math.min(...machines.map((machine) => machine.location.z)),
  };
}

function poleTopology(machines, pole, wire, buildingActionCount, options) {
  const count = poleCountFor(machines.length, pole.capacity);
  if (count === null) {
    return { possible: false, reason: "generated_power_pole_limit_exceeded" };
  }

  const orderedMachines = [...machines].sort((left, right) =>
    left.location.z - right.location.z ||
    left.location.y - right.location.y ||
    left.location.x - right.location.x ||
    left.step - right.step
  );
  const groups = [];
  let cursor = 0;
  for (let poleIndex = 0; poleIndex < count; poleIndex += 1) {
    const chainDegree = count === 1 ? 0 : (poleIndex === 0 || poleIndex === count - 1 ? 1 : 2);
    const externalReservation = poleIndex === 0 ? 1 : 0;
    const slots = pole.capacity - chainDegree - externalReservation;
    groups.push(orderedMachines.slice(cursor, cursor + slots));
    cursor += slots;
  }
  if (cursor < orderedMachines.length || groups.some((group) => group.length === 0)) {
    return { possible: false, reason: "captured_power_pole_capacity_cannot_cover_generated_machines" };
  }

  const footprintOrigin = vector(options?.shell_footprint?.origin_cm);
  const offset = finite(options?.pole_corridor_offset_cm) ?? DEFAULT_POLE_CORRIDOR_OFFSET_CM;
  const corridorY = footprintOrigin
    ? footprintOrigin.y - offset
    : Math.min(...orderedMachines.map((machine) => machine.location.y)) - offset;
  const poles = groups.map((group, index) => {
    const center = centroid(group);
    return {
      step: buildingActionCount + index + 1,
      location: { x: center.x, y: corridorY, z: center.z },
      group,
    };
  });

  const connections = [];
  for (let index = 0; index < poles.length - 1; index += 1) {
    if (!withinWireLength(poles[index].location, poles[index + 1].location, wire.max_length_cm)) {
      return { possible: false, reason: "generated_power_pole_trunk_exceeds_captured_wire_length" };
    }
    connections.push({
      recipe_class: wire.recipe_class,
      from_step: poles[index].step,
      to_step: poles[index + 1].step,
      from_connector_name: pole.connector_name,
      to_connector_name: pole.connector_name,
    });
  }
  for (const generatedPole of poles) {
    for (const machine of generatedPole.group) {
      if (!withinWireLength(generatedPole.location, machine.location, wire.max_length_cm)) {
        return { possible: false, reason: "generated_machine_drop_exceeds_captured_wire_length" };
      }
      connections.push({
        recipe_class: wire.recipe_class,
        from_step: generatedPole.step,
        to_step: machine.step,
        from_connector_name: pole.connector_name,
        to_connector_name: machine.connector_name,
      });
    }
  }

  return {
    possible: true,
    poles,
    connections,
    external_step: poles[0].step,
  };
}

/**
 * Add capacity-safe internal power buildables and physical wires to a generated
 * Blueprint action list. The first endpoint always keeps one exact native link
 * free for the player's external circuit.
 */
export function planGeneratedBlueprintPower(graph, actions, options = {}) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { planned: false, reason: "generated_power_needs_a_nonempty_action_plan" };
  }
  const firstNonBuilding = actions.findIndex((action) => action?.action !== "place_building");
  const buildingActionCount = firstNonBuilding < 0 ? actions.length : firstNonBuilding;
  if (actions.slice(buildingActionCount).some((action) => action?.action !== "place_belt")) {
    return { planned: false, reason: "generated_power_requires_buildings_before_transport_actions" };
  }

  const { machines, unavailable } = machineCapabilities(graph, actions);
  if (unavailable.length > 0) {
    return {
      planned: false,
      reason: "generated_machine_power_capability_is_not_authoritative",
      unavailable,
    };
  }
  if (machines.length === 0) {
    return { planned: false, reason: "generated_blueprint_has_no_powered_machine_or_miner" };
  }
  const circuitTypes = new Set(machines.map((machine) => machine.circuit_type_class_path));
  if (circuitTypes.size !== 1) {
    return { planned: false, reason: "generated_machine_circuit_types_do_not_match" };
  }

  const wire = selectWire(graph);
  if (!wire) {
    return { planned: false, reason: "no_unlocked_native_power_wire_with_captured_length" };
  }

  const chain = directChain(machines, wire);
  if (chain.possible) {
    return {
      planned: true,
      mode: machines.length === 1 ? "single_external_machine_endpoint" : "native_machine_daisy_chain",
      actions: [...actions],
      power_connections: chain.connections,
      machines: machines.length,
      poles: 0,
      wires: chain.connections.length,
      external_connection: {
        step: chain.external_step,
        reserved_links: 1,
        note: "Connect the placed Blueprint's reserved endpoint to the live grid.",
      },
      wire,
      certainty: "captured_native_connector_capacity_and_wire_length; exact staged endpoints required",
    };
  }

  const pole = selectGroundPole(graph, options.preferred_pole_tier ?? null);
  if (!pole || pole.circuit_type_class_path !== [...circuitTypes][0]) {
    return {
      planned: false,
      reason: options.preferred_pole_tier == null
        ? "no_unlocked_compatible_ground_power_pole_with_captured_capacity"
        : "requested_power_pole_tier_is_not_unlocked_with_captured_capacity",
      direct_chain_reason: chain.reason,
    };
  }
  const topology = poleTopology(machines, pole, wire, buildingActionCount, options);
  if (!topology.possible) {
    return { planned: false, reason: topology.reason, direct_chain_reason: chain.reason };
  }

  const poleActions = topology.poles.map((generatedPole) => ({
    action: "place_building",
    recipe_class: pole.recipe_class,
    location: generatedPole.location,
    exact_z: true,
    yaw: 0,
    generated_role: "machine",
    commit: actions[0]?.commit === true,
  }));
  return {
    planned: true,
    mode: "captured_capacity_power_pole_trunk",
    actions: [
      ...actions.slice(0, buildingActionCount),
      ...poleActions,
      ...actions.slice(buildingActionCount),
    ],
    power_connections: topology.connections,
    machines: machines.length,
    poles: topology.poles.length,
    wires: topology.connections.length,
    external_connection: {
      step: topology.external_step,
      reserved_links: 1,
      note: "Connect the first generated pole's reserved endpoint to the live grid.",
    },
    pole,
    wire,
    certainty: "captured_native_connector_capacity_and_wire_length; exact staged endpoints required",
  };
}

