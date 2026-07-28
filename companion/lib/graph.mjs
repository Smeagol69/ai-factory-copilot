/**
 * Builds the cached production graph the deterministic solvers run on.
 *
 * Every value here is either copied from the authoritative snapshot or derived
 * by arithmetic/graph traversal over snapshot fields. Nothing is inferred about
 * behavior the snapshot does not state. Unresolvable references are recorded
 * explicitly instead of being guessed.
 */

const CONVEYOR_SPEED_TO_ITEMS_PER_MINUTE_DIVISOR = 2;
const PIPE_FLOW_SECONDS_PER_MINUTE = 60;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finitePositive(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** `FCD_OUTPUT` / `PCT_PRODUCER` style enum names to a stable direction. */
export function normalizeConnectionDirection(kind, direction) {
  const text = String(direction ?? "").toUpperCase();
  if (kind === "pipe") {
    if (text.includes("PRODUCER")) return "output";
    if (text.includes("CONSUMER")) return "input";
    if (text.includes("ANY")) return "any";
    return "unknown";
  }
  if (text.includes("OUTPUT")) return "output";
  if (text.includes("INPUT")) return "input";
  if (text.includes("ANY")) return "any";
  if (text.includes("SNAP")) return "snap_only";
  return "unknown";
}

/** `EProductionStatus` enum names to a stable status. */
export function normalizeProductionStatus(status) {
  const text = String(status ?? "").toUpperCase();
  if (text.includes("ERROR")) return "error";
  if (text.includes("STANDBY")) return "standby";
  if (text.includes("PRODUCING")) return "producing";
  if (text.includes("NONE")) return "none";
  return "unknown";
}

function reflectedNumber(actor, propertyName) {
  for (const property of actor?.reflected_properties ?? []) {
    if (property?.name !== propertyName) continue;
    const parsed = finiteNumber(property.value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function inventoryTotals(actor) {
  const perItem = new Map();
  let stackCount = 0;
  let slotCount = 0;
  for (const inventory of actor?.inventories ?? []) {
    slotCount += finiteNumber(inventory?.slots) ?? 0;
    for (const stack of inventory?.stacks ?? []) {
      const itemClass = stack?.item_class;
      if (!itemClass) continue;
      const amount = finiteNumber(stack.amount) ?? 0;
      perItem.set(itemClass, (perItem.get(itemClass) ?? 0) + amount);
      stackCount += 1;
    }
  }
  return { perItem, stackCount, slotCount };
}

function classifyActor(actor) {
  if (actor?.kind === "resource_node") return "resource_node";
  if (actor?.kind !== "buildable") return actor?.kind ?? "unknown";
  if (actor?.transport?.kind === "conveyor") return "conveyor";
  if (actor?.transport?.kind === "pipeline") return "pipeline";
  if (actor?.manufacturer) return "manufacturer";
  if (actor?.factory) return "factory";
  return "buildable";
}

/**
 * Conveyor throughput.
 *
 * `reported_speed` is the engine's `mSpeed` and `item_spacing_cm` is the engine
 * constant `AFGBuildableConveyorBase::ITEM_SPACING` (120 cm). Items per minute is
 * therefore speed divided by spacing, once both are in the same time base — but
 * the header does not document whether `mSpeed` is cm/s or cm/min. Both readings
 * give 60 items/min for a Mk1 belt, so the divisor is configurable and the raw
 * inputs travel with the result rather than being hidden behind it.
 */
function conveyorThroughput(actor, divisor) {
  const reportedSpeed = finitePositive(actor?.transport?.reported_speed);
  if (reportedSpeed === null) return null;
  return {
    reported_speed: reportedSpeed,
    item_spacing_cm: finitePositive(actor?.transport?.item_spacing_cm),
    items_per_minute: reportedSpeed / divisor,
    conversion: `items_per_minute = reported_speed / ${divisor}`,
    assumption:
      "reported_speed is treated as centimetres per second, giving reported_speed * 60 / ITEM_SPACING, which reduces to reported_speed / 2 at the stock 120 cm spacing.",
    verification_required:
      "Confirm against one known belt in a live save; correct with AIFACTORY_BELT_SPEED_DIVISOR if the engine reports cm/min instead.",
    source: "engine_item_spacing_constant_with_assumed_speed_unit",
    certainty: "calculated_from_convention",
  };
}

function pipelineThroughput(actor) {
  const flowLimit = finitePositive(actor?.transport?.reported_flow_limit);
  if (flowLimit === null) return null;
  return {
    reported_flow_limit_cubic_meters_per_second: flowLimit,
    cubic_meters_per_minute: flowLimit * PIPE_FLOW_SECONDS_PER_MINUTE,
    reported_flow_cubic_meters_per_second: finiteNumber(actor?.transport?.reported_flow),
    reported_content: finiteNumber(actor?.transport?.reported_content),
    reported_max_content: finiteNumber(actor?.transport?.reported_max_content),
    fluid_class: actor?.transport?.fluid_class || null,
    conversion: "cubic_meters_per_minute = reported_flow_limit * 60",
    source: "authoritative_pipeline_flow_limit",
    certainty: "calculated",
  };
}

/**
 * Component paths are `<actor path>.<component name>`. Peers are resolved from
 * the emitted component map first, then by trimming the path back to a known
 * actor. Anything still unresolved is reported, never assumed.
 */
function makeComponentResolver(actorsById, componentOwner) {
  return function resolveComponent(componentPath) {
    if (!componentPath) return null;
    const direct = componentOwner.get(componentPath);
    if (direct) return direct;

    let candidate = componentPath;
    for (let depth = 0; depth < 8; depth += 1) {
      const cut = candidate.lastIndexOf(".");
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
      if (actorsById.has(candidate)) return candidate;
    }
    return null;
  };
}

/** Straight-line distance between two captured positions, in metres. */
export function distanceMeters(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x ?? 0) - Number(b.x ?? 0);
  const dy = Number(a.y ?? 0) - Number(b.y ?? 0);
  const dz = Number(a.z ?? 0) - Number(b.z ?? 0);
  const cm = Math.hypot(dx, dy, dz);
  return Number.isFinite(cm) ? cm / 100 : null;
}

export function buildGraph(snapshot, options = {}) {
  const conveyorDivisor =
    finitePositive(options.conveyorSpeedDivisor) ?? CONVEYOR_SPEED_TO_ITEMS_PER_MINUTE_DIVISOR;

  const actors = snapshot?.actors ?? [];
  const actorsById = new Map();
  const componentOwner = new Map();
  const nodes = new Map();

  for (const actor of actors) {
    const actorId = actor?.actor_id;
    if (!actorId) continue;
    actorsById.set(actorId, actor);
    for (const connection of actor.connections ?? []) {
      if (connection?.component) componentOwner.set(connection.component, actorId);
    }
    for (const inventory of actor.inventories ?? []) {
      if (inventory?.component) componentOwner.set(inventory.component, actorId);
    }
  }

  const resolveComponent = makeComponentResolver(actorsById, componentOwner);
  const unresolvedConnections = [];

  for (const actor of actors) {
    const actorId = actor?.actor_id;
    if (!actorId) continue;
    const totals = inventoryTotals(actor);
    nodes.set(actorId, {
      actor_id: actorId,
      name: actor.name ?? null,
      class_path: actor.class_path ?? null,
      owner_mod: actor.owner_mod ?? null,
      kind: actor.kind ?? null,
      role: classifyActor(actor),
      location_cm: actor.location ?? null,
      built_with_recipe: actor.built_with_recipe || null,
      recipe_class: actor.manufacturer?.recipe_class || null,
      recipe_name: actor.manufacturer?.recipe_name || null,
      production_status: normalizeProductionStatus(actor.factory?.production_status),
      is_producing: actor.factory?.is_producing ?? null,
      inventory_by_item: totals.perItem,
      inventory_stack_count: totals.stackCount,
      inventory_slot_count: totals.slotCount,
      conveyor: conveyorThroughput(actor, conveyorDivisor),
      pipeline: pipelineThroughput(actor),
      power_circuit_id: null,
      item_inputs: [],
      item_outputs: [],
      fluid_inputs: [],
      fluid_outputs: [],
      unconnected_item_inputs: 0,
      unconnected_item_outputs: 0,
      unconnected_fluid_ports: 0,
      raw: actor,
    });
  }

  const circuits = new Map();

  for (const actor of actors) {
    const actorId = actor?.actor_id;
    const node = nodes.get(actorId);
    if (!node) continue;

    for (const connection of actor.connections ?? []) {
      const kind = connection?.kind;

      if (kind === "power") {
        const circuitId = finiteNumber(connection?.circuit?.circuit_id);
        if (circuitId === null) continue;
        node.power_circuit_id = circuitId;
        if (!circuits.has(circuitId)) {
          circuits.set(circuitId, {
            circuit_id: circuitId,
            fuse_triggered: Boolean(connection.circuit.fuse_triggered),
            production_capacity_mw: finiteNumber(connection.circuit.production_capacity_mw),
            maximum_consumption_mw: finiteNumber(connection.circuit.maximum_consumption_mw),
            battery_store_mwh: finiteNumber(connection.circuit.battery_store_mwh),
            battery_capacity_mwh: finiteNumber(connection.circuit.battery_capacity_mwh),
            battery_input_mw: finiteNumber(connection.circuit.battery_input_mw),
            battery_output_mw: finiteNumber(connection.circuit.battery_output_mw),
            member_actor_ids: [],
          });
        }
        circuits.get(circuitId).member_actor_ids.push(actorId);
        continue;
      }

      if (kind !== "factory" && kind !== "pipe") continue;

      const direction = normalizeConnectionDirection(kind, connection.direction);
      const isItem = kind === "factory";

      if (!connection.connected || !connection.connected_component) {
        if (direction === "input") {
          if (isItem) node.unconnected_item_inputs += 1;
          else node.unconnected_fluid_ports += 1;
        } else if (direction === "output") {
          if (isItem) node.unconnected_item_outputs += 1;
          else node.unconnected_fluid_ports += 1;
        }
        continue;
      }

      const peerActorId = resolveComponent(connection.connected_component);
      if (!peerActorId) {
        unresolvedConnections.push({
          actor_id: actorId,
          kind,
          direction,
          connected_component: connection.connected_component,
          reason: "peer_actor_not_present_in_snapshot",
        });
        continue;
      }

      const edge = {
        peer_actor_id: peerActorId,
        component: connection.component ?? null,
        peer_component: connection.connected_component,
        fluid_class: connection.fluid_class || null,
      };
      if (direction === "output") {
        (isItem ? node.item_outputs : node.fluid_outputs).push(edge);
      } else if (direction === "input") {
        (isItem ? node.item_inputs : node.fluid_inputs).push(edge);
      }
    }
  }

  const recipesByClass = new Map();
  for (const recipe of snapshot?.content?.recipes ?? []) {
    if (recipe?.class_path) recipesByClass.set(recipe.class_path, recipe);
  }
  const itemsByClass = new Map();
  for (const item of snapshot?.content?.items ?? []) {
    if (item?.class_path) itemsByClass.set(item.class_path, item);
  }

  return {
    snapshot,
    world_revision: snapshot?.world_revision ?? null,
    conveyor_speed_divisor: conveyorDivisor,
    actorsById,
    nodes,
    circuits,
    recipesByClass,
    itemsByClass,
    unresolvedConnections,
    resolveComponent,
  };
}

/**
 * Follows conveyor/pipeline chains so machine-to-machine flow can be reasoned
 * about, and reports the narrowest transport segment on each path.
 */
export function traceDownstream(graph, startActorId, transportKey = "item") {
  const outputsKey = transportKey === "item" ? "item_outputs" : "fluid_outputs";
  const transportRoles = transportKey === "item" ? ["conveyor"] : ["pipeline"];
  const results = [];
  const visited = new Set([startActorId]);
  const reportedCycles = new Set();
  const queue = [];

  for (const edge of graph.nodes.get(startActorId)?.[outputsKey] ?? []) {
    queue.push({ actorId: edge.peer_actor_id, path: [], limit: null });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const node = graph.nodes.get(current.actorId);
    if (!node) {
      results.push({
        endpoint_actor_id: null,
        via_transport_actor_ids: current.path,
        limiting_items_per_minute: current.limit,
        terminated: "peer_actor_not_present_in_snapshot",
      });
      continue;
    }

    if (transportRoles.includes(node.role)) {
      if (visited.has(current.actorId)) {
        if (!reportedCycles.has(current.actorId)) {
          reportedCycles.add(current.actorId);
          results.push({
            endpoint_actor_id: null,
            via_transport_actor_ids: [...current.path, current.actorId],
            limiting_items_per_minute: current.limit,
            terminated: "transport_cycle_detected",
          });
        }
        continue;
      }
      visited.add(current.actorId);

      const segmentLimit =
        transportKey === "item"
          ? (node.conveyor?.items_per_minute ?? null)
          : (node.pipeline?.cubic_meters_per_minute ?? null);
      const limit =
        segmentLimit === null
          ? current.limit
          : current.limit === null
            ? segmentLimit
            : Math.min(current.limit, segmentLimit);
      const path = [...current.path, current.actorId];

      const continuations = node[outputsKey] ?? [];
      if (continuations.length === 0) {
        results.push({
          endpoint_actor_id: null,
          via_transport_actor_ids: path,
          limiting_items_per_minute: limit,
          terminated: "transport_chain_has_no_connected_output",
        });
        continue;
      }
      for (const edge of continuations) {
        queue.push({ actorId: edge.peer_actor_id, path, limit });
      }
      continue;
    }

    results.push({
      endpoint_actor_id: current.actorId,
      endpoint_role: node.role,
      via_transport_actor_ids: current.path,
      limiting_items_per_minute: current.limit,
      terminated: "endpoint",
    });
  }

  return results;
}

/** Upstream mirror of {@link traceDownstream}. */
export function traceUpstream(graph, startActorId, transportKey = "item") {
  const inputsKey = transportKey === "item" ? "item_inputs" : "fluid_inputs";
  const transportRoles = transportKey === "item" ? ["conveyor"] : ["pipeline"];
  const results = [];
  const visited = new Set([startActorId]);
  const reportedCycles = new Set();
  const queue = [];

  for (const edge of graph.nodes.get(startActorId)?.[inputsKey] ?? []) {
    queue.push({ actorId: edge.peer_actor_id, path: [], limit: null });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const node = graph.nodes.get(current.actorId);
    if (!node) {
      results.push({
        endpoint_actor_id: null,
        via_transport_actor_ids: current.path,
        limiting_items_per_minute: current.limit,
        terminated: "peer_actor_not_present_in_snapshot",
      });
      continue;
    }

    if (transportRoles.includes(node.role)) {
      if (visited.has(current.actorId)) {
        if (!reportedCycles.has(current.actorId)) {
          reportedCycles.add(current.actorId);
          results.push({
            endpoint_actor_id: null,
            via_transport_actor_ids: [...current.path, current.actorId],
            limiting_items_per_minute: current.limit,
            terminated: "transport_cycle_detected",
          });
        }
        continue;
      }
      visited.add(current.actorId);

      const segmentLimit =
        transportKey === "item"
          ? (node.conveyor?.items_per_minute ?? null)
          : (node.pipeline?.cubic_meters_per_minute ?? null);
      const limit =
        segmentLimit === null
          ? current.limit
          : current.limit === null
            ? segmentLimit
            : Math.min(current.limit, segmentLimit);
      const path = [...current.path, current.actorId];

      const continuations = node[inputsKey] ?? [];
      if (continuations.length === 0) {
        results.push({
          endpoint_actor_id: null,
          via_transport_actor_ids: path,
          limiting_items_per_minute: limit,
          terminated: "transport_chain_has_no_connected_input",
        });
        continue;
      }
      for (const edge of continuations) {
        queue.push({ actorId: edge.peer_actor_id, path, limit });
      }
      continue;
    }

    results.push({
      endpoint_actor_id: current.actorId,
      endpoint_role: node.role,
      via_transport_actor_ids: current.path,
      limiting_items_per_minute: current.limit,
      terminated: "endpoint",
    });
  }

  return results;
}

export { finiteNumber, finitePositive, reflectedNumber, inventoryTotals };
