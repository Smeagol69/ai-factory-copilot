/**
 * Working out where a belt goes.
 *
 * `design_factory_layout` places machines and leaves an aisle between rows, but
 * it has never connected anything — which is why the owner's actual request, a
 * compact belted Mk1 module, has been blocked. This is the missing half.
 *
 * The scanner already captures what routing needs: every factory connection's
 * world location, its outward normal, its direction, and whether something is
 * already attached. So nothing here has to guess at geometry; it reads it.
 *
 * What this module deliberately does *not* decide:
 *
 *   - **How long a belt may be.** `AFGConveyorBeltHologram::GetMaxSplineLength`
 *     is the game's own answer and it varies by belt. Hardcoding a number here
 *     would be a guess that goes stale, so the route reports its length and the
 *     mod's hologram accepts or refuses it. Same rule as everywhere else: the
 *     game is authoritative.
 *   - **Whether the path is clear.** Clearance is a physics query, and physics
 *     lives in the game. The route reports the straight line it wants; the
 *     hologram is what knows if a rock is in the way.
 *
 * So a route from here is a *proposal with evidence*, never a promise.
 */

import { distanceMeters } from "./graph.mjs";

/** Connection directions as the scanner spells them, plus bare fallbacks. */
const OUTPUT_DIRECTIONS = new Set(["FCD_OUTPUT", "OUTPUT", "FCD_ANY", "ANY"]);
const INPUT_DIRECTIONS = new Set(["FCD_INPUT", "INPUT", "FCD_ANY", "ANY"]);

function normalizeDirection(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isFactoryConnection(connection) {
  return String(connection?.kind ?? "").toLowerCase() === "factory";
}

function vectorOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v) {
  const magnitude = length(v);
  return magnitude > 0 ? { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude } : null;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
}

/**
 * Every connector on an actor that could take a new belt.
 *
 * An already-connected port is reported rather than skipped silently: "the
 * output is in use" is the answer to a routing failure far more often than
 * "there is no output", and the two are not the same problem.
 */
function connectorsOf(node, role) {
  const wanted = role === "output" ? OUTPUT_DIRECTIONS : INPUT_DIRECTIONS;
  const free = [];
  const occupied = [];

  for (const connection of node?.raw?.connections ?? []) {
    if (!isFactoryConnection(connection)) continue;
    if (!wanted.has(normalizeDirection(connection.direction))) continue;

    const location = vectorOf(connection.location);
    if (!location) continue;

    const entry = {
      component: connection.component ?? null,
      direction: connection.direction ?? null,
      location,
      normal: vectorOf(connection.normal),
      connected_to: connection.connected_component || null,
    };
    if (connection.connected) occupied.push(entry);
    else free.push(entry);
  }
  return { free, occupied };
}

function describeActor(node) {
  return node?.raw?.name ?? node?.actor_id ?? "unknown";
}

/**
 * Picks the connector pair a belt should run between, and measures it.
 *
 * Scoring is distance first, then how squarely the two ports face each other.
 * Facing matters because Satisfactory bends a belt to meet a connector's
 * normal: two ports pointing at each other take a straight belt, while two
 * pointing the same way take an S-bend that needs far more room than the
 * straight-line distance suggests. Reporting that is more useful than silently
 * preferring one.
 */
export function solveBeltRoute(graph, args = {}) {
  const { from_actor_id: fromId, to_actor_id: toId } = args;

  if (!fromId || !toId) {
    return {
      solver: "belt_route",
      routed: false,
      reason: "give from_actor_id and to_actor_id",
    };
  }
  if (fromId === toId) {
    return { solver: "belt_route", routed: false, reason: "a belt needs two different machines" };
  }

  const from = findNode(graph, fromId);
  const to = findNode(graph, toId);
  if (!from) return notFound(fromId);
  if (!to) return notFound(toId);

  const outputs = connectorsOf(from, "output");
  const inputs = connectorsOf(to, "input");

  if (outputs.free.length === 0) {
    return {
      solver: "belt_route",
      routed: false,
      reason:
        outputs.occupied.length > 0
          ? `every output on ${describeActor(from)} is already connected`
          : `${describeActor(from)} has no conveyor output`,
      occupied_outputs: outputs.occupied.map((entry) => entry.connected_to),
    };
  }
  if (inputs.free.length === 0) {
    return {
      solver: "belt_route",
      routed: false,
      reason:
        inputs.occupied.length > 0
          ? `every input on ${describeActor(to)} is already connected`
          : `${describeActor(to)} has no conveyor input`,
      occupied_inputs: inputs.occupied.map((entry) => entry.connected_to),
    };
  }

  let best = null;
  for (const output of outputs.free) {
    for (const input of inputs.free) {
      const span = subtract(input.location, output.location);
      const distanceCm = length(span);
      const heading = normalize(span);

      // +1 when the output points straight at the input, -1 when it points away.
      const outputAlignment = output.normal && heading ? dot(normalize(output.normal), heading) : null;
      // +1 when the input's outward normal points back at the output, which is
      // what "facing each other" means for two connectors.
      const inputAlignment = input.normal && heading ? -dot(normalize(input.normal), heading) : null;

      const candidate = {
        output,
        input,
        distance_cm: round(distanceCm),
        output_alignment: round(outputAlignment, 3),
        input_alignment: round(inputAlignment, 3),
      };
      // Distance dominates; alignment breaks ties, scaled so it can only
      // reorder pairs that are within a belt-width of each other.
      candidate.score =
        distanceCm - 100 * ((outputAlignment ?? 0) + (inputAlignment ?? 0));
      if (!best || candidate.score < best.score) best = candidate;
    }
  }

  const straight =
    (best.output_alignment ?? 0) > 0.95 && (best.input_alignment ?? 0) > 0.95;
  const facingAway = (best.output_alignment ?? 0) < 0;

  const notes = [];
  if (facingAway) {
    notes.push(
      "The output points away from the target, so the belt has to loop around it. " +
        "Rotating the source machine, or routing through a splitter, is usually shorter.",
    );
  } else if (!straight) {
    notes.push(
      "The connectors are not squarely aligned, so the belt will bend. " +
        "The game decides whether that bend fits its radius.",
    );
  }
  if (outputs.free.length > 1 || inputs.free.length > 1) {
    notes.push(
      `Chose the closest of ${outputs.free.length} free output(s) and ` +
        `${inputs.free.length} free input(s).`,
    );
  }

  return {
    solver: "belt_route",
    routed: true,
    from: { actor_id: from.actor_id, name: describeActor(from), connector: best.output.component },
    to: { actor_id: to.actor_id, name: describeActor(to), connector: best.input.component },
    start_cm: best.output.location,
    end_cm: best.input.location,
    length_cm: best.distance_cm,
    length_meters: round(best.distance_cm / 100),
    straight,
    alignment: {
      output: best.output_alignment,
      input: best.input_alignment,
      meaning:
        "1.0 is pointing straight at the other connector, 0 is perpendicular, " +
        "negative is pointing away.",
    },
    notes,
    // Stated rather than assumed, because both are the game's call and this
    // module cannot see either.
    unverified:
      "Maximum belt length and path clearance are decided by the game's " +
      "conveyor hologram, not here. This route is a proposal; the mod reports " +
      "what was actually built.",
  };
}

/** Return the captured recipe for a running manufacturer, accepting full or short paths. */
function recipeOf(graph, node) {
  const wanted = String(node?.recipe_class ?? "").trim();
  if (!wanted) return null;
  const exact = graph?.recipesByClass?.get?.(wanted);
  if (exact) return exact;
  const short = wanted.split(".").pop();
  for (const [classPath, recipe] of graph?.recipesByClass ?? []) {
    if (String(classPath).split(".").pop() === short) return recipe;
  }
  return null;
}

function itemClasses(entries) {
  return new Set(
    (entries ?? [])
      .map((entry) => String(entry?.item_class ?? "").trim())
      .filter(Boolean),
  );
}

/**
 * Items this actor is proven to produce from the current snapshot.
 *
 * Manufacturers use their current recipe. Resource extractors have no recipe,
 * so their resource node is the authoritative source instead. Inventory
 * contents are deliberately not used: an old stack does not prove what a
 * reconfigured machine will produce next.
 */
function producedItemClasses(graph, node) {
  const recipe = recipeOf(graph, node);
  if (recipe) return itemClasses(recipe.products);

  const resourceActorId = node?.raw?.extractor?.extractable_resource_actor_id;
  if (!resourceActorId) return new Set();
  const resourceNode = findNode(graph, resourceActorId);
  const resourceClass = String(resourceNode?.raw?.resource_class ?? "").trim();
  return resourceClass ? new Set([resourceClass]) : new Set();
}

function consumedItemClasses(graph, node) {
  return itemClasses(recipeOf(graph, node)?.ingredients);
}

function capturedPlayerPosition(graph) {
  const direct = vectorOf(graph?.snapshot?.interaction_context?.player?.pawn_location);
  if (direct) return direct;
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node?.kind === "player") return vectorOf(node?.raw?.location);
  }
  return null;
}

function displayItem(graph, itemClass) {
  const exact = graph?.itemsByClass?.get?.(itemClass);
  if (exact?.name) return exact.name;
  const short = String(itemClass).split(".").pop();
  for (const [classPath, item] of graph?.itemsByClass ?? []) {
    if (String(classPath).split(".").pop() === short && item?.name) return item.name;
  }
  return itemClass;
}

/**
 * Find the nearest free output/input pair whose live recipes prove item
 * compatibility.
 *
 * This is intentionally narrower than "connect anything nearby". A short belt
 * between incompatible machines is still the wrong belt. Modded machines and
 * recipes work without a table because the comparison is over the captured
 * item class paths. Anything without enough recipe/resource evidence is left
 * out and reported, never inferred from its name.
 */
export function solveNearestCompatibleBeltRoute(graph, args = {}) {
  const radius = Number(args.radius_m ?? 100);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 5_000) {
    return {
      solver: "nearest_compatible_belt_route",
      routed: false,
      reason: "radius_m must be between 0 and 5000",
      source: "authoritative_snapshot",
      certainty: "exact_for_captured_data",
    };
  }

  const player = capturedPlayerPosition(graph);
  if (!player) {
    return {
      solver: "nearest_compatible_belt_route",
      routed: false,
      reason: "the snapshot did not contain the player's position",
      missing: ["interaction_context.player.pawn_location"],
      source: "authoritative_snapshot",
      certainty: "unknown",
    };
  }

  const nearby = [];
  let omittedWithoutProductionEvidence = 0;
  for (const node of graph?.nodes?.values?.() ?? []) {
    const location = vectorOf(node?.raw?.location);
    if (!location || node?.kind !== "buildable") continue;
    const distanceFromPlayer = distanceMeters(player, location);
    if (distanceFromPlayer === null || distanceFromPlayer > radius) continue;

    const produces = producedItemClasses(graph, node);
    const consumes = consumedItemClasses(graph, node);
    if (produces.size === 0 && consumes.size === 0) {
      omittedWithoutProductionEvidence += 1;
      continue;
    }
    nearby.push({ node, produces, consumes, distance_from_player_m: distanceFromPlayer });
  }

  const candidates = [];
  for (const source of nearby) {
    if (source.produces.size === 0) continue;
    for (const target of nearby) {
      if (source.node.actor_id === target.node.actor_id || target.consumes.size === 0) continue;
      const compatible = [...source.produces].filter((itemClass) => target.consumes.has(itemClass));
      if (compatible.length === 0) continue;

      const route = solveBeltRoute(graph, {
        from_actor_id: source.node.actor_id,
        to_actor_id: target.node.actor_id,
      });
      if (!route.routed) continue;
      candidates.push({
        route,
        compatible,
        furthest_from_player_m: Math.max(
          source.distance_from_player_m,
          target.distance_from_player_m,
        ),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      (a.route.length_cm ?? Number.POSITIVE_INFINITY) -
        (b.route.length_cm ?? Number.POSITIVE_INFINITY) ||
      a.furthest_from_player_m - b.furthest_from_player_m ||
      String(a.route.from.actor_id).localeCompare(String(b.route.from.actor_id)) ||
      String(a.route.to.actor_id).localeCompare(String(b.route.to.actor_id)),
  );

  if (candidates.length === 0) {
    return {
      solver: "nearest_compatible_belt_route",
      routed: false,
      reason:
        `no recipe-compatible pair of free factory output/input ports was captured within ${round(radius)} m`,
      radius_m: round(radius),
      examined_production_actors: nearby.length,
      omitted_without_recipe_or_resource_evidence: omittedWithoutProductionEvidence,
      source: "authoritative_snapshot",
      certainty: "exact_for_captured_data",
    };
  }

  const best = candidates[0];
  return {
    ...best.route,
    solver: "nearest_compatible_belt_route",
    radius_m: round(radius),
    compatible_item_classes: best.compatible,
    compatible_items: best.compatible.map((itemClass) => displayItem(graph, itemClass)),
    candidate_count: candidates.length,
    furthest_endpoint_from_player_m: round(best.furthest_from_player_m),
    source: "authoritative_snapshot",
    certainty: "exact_for_captured_data_except_game_owned_hologram_checks",
  };
}

function findNode(graph, actorId) {
  const wanted = String(actorId);
  const direct = graph?.nodes?.get?.(wanted);
  if (direct) return direct;
  for (const node of graph?.nodes?.values?.() ?? []) {
    const id = String(node.actor_id ?? "");
    if (id === wanted || id.endsWith(wanted) || node.raw?.name === wanted) return node;
  }
  return null;
}

function notFound(actorId) {
  return {
    solver: "belt_route",
    routed: false,
    reason: `no actor in the snapshot matches "${actorId}"`,
  };
}

/**
 * Routes a whole chain: miner -> smelter -> constructor, in the order given.
 *
 * This is the shape the owner asked for — "a miner belted into a smelter
 * belting into the next thing" — so it is one call rather than a belt at a
 * time. A failure anywhere is reported with the successful legs intact, because
 * knowing that three of four legs route is what tells you which machine to
 * move.
 */
export function solveBeltChain(graph, args = {}) {
  const chain = Array.isArray(args.actor_ids) ? args.actor_ids : [];
  if (chain.length < 2) {
    return { solver: "belt_chain", routed: false, reason: "give at least two actor_ids, in flow order" };
  }

  const legs = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    legs.push(
      solveBeltRoute(graph, { from_actor_id: chain[index], to_actor_id: chain[index + 1] }),
    );
  }

  const routed = legs.filter((leg) => leg.routed);
  return {
    solver: "belt_chain",
    routed: routed.length === legs.length,
    legs,
    total_length_meters: round(
      routed.reduce((sum, leg) => sum + (leg.length_meters ?? 0), 0),
    ),
    failed_legs: legs
      .map((leg, index) => (leg.routed ? null : { leg: index + 1, reason: leg.reason }))
      .filter(Boolean),
  };
}

export { distanceMeters };

/* ---------------- planning a whole belted module ---------------- */

/**
 * Learns where a building's conveyor connectors sit, from the player's own.
 *
 * The same trick `measureBuilding` uses for footprints: rather than shipping a
 * table of offsets that goes stale with every game patch and knows nothing
 * about modded buildings, read them off machines already standing in this
 * world. A connector's world position minus its building's origin, un-rotated
 * by the building's yaw, is a local offset that holds for every instance.
 *
 * Returns null when this world contains no example. That is a real answer —
 * "I have never seen one of these, so I do not know where its belt goes" — and
 * it is why the module planner is two-phase rather than guessing.
 */
export function measureConnectors(graph, classPath) {
  const samples = { inputs: [], outputs: [] };
  let seen = 0;

  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node.class_path !== classPath) continue;
    const origin = vectorOf(node.raw?.location);
    if (!origin) continue;

    const yaw = Number(node.raw?.rotation?.yaw ?? 0);
    const radians = (-yaw * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    let used = false;
    for (const connection of node.raw?.connections ?? []) {
      if (!isFactoryConnection(connection)) continue;
      const world = vectorOf(connection.location);
      if (!world) continue;

      const dx = world.x - origin.x;
      const dy = world.y - origin.y;
      const local = {
        x: round(dx * cos - dy * sin),
        y: round(dx * sin + dy * cos),
        z: round(world.z - origin.z),
      };

      const direction = normalizeDirection(connection.direction);
      if (OUTPUT_DIRECTIONS.has(direction)) samples.outputs.push(local);
      else if (INPUT_DIRECTIONS.has(direction)) samples.inputs.push(local);
      used = true;
    }
    if (used) seen += 1;
  }

  if (seen === 0) return null;
  return {
    class_path: classPath,
    inputs: samples.inputs,
    outputs: samples.outputs,
    measured_from: seen,
    source: "measured_from_your_own_buildings_captured_connector_positions",
    certainty: "authoritative",
  };
}

/**
 * Plans a compact belted module anchored on a resource node.
 *
 * The request was: "a miner belted into a smelter belting into the next thing
 * then splitted, super compact, node-hugging, so I can build over it." Two
 * things about that shape the design.
 *
 * **It is two-phase, and that is not a limitation to apologise for.** Belts
 * connect *connectors*, and a connector does not exist until its machine does —
 * the game decides where a placed machine actually ends up, snapping and
 * adjusting as it goes. So phase one places machines and phase two routes belts
 * between the connectors the world reports. Predicting connector positions and
 * building belts to where a machine *should* be would produce a plan that looks
 * right and fails on contact.
 *
 * **Compactness is bounded by the game, not by us.** Machines are spaced by
 * their measured footprints plus the smallest gap that still clears; the mod's
 * hologram is what finally accepts or refuses each placement.
 */
export function planBeltedModule(graph, args = {}) {
  const { anchor_actor_id: anchorId, chain = [], spacing_cm: spacingOverride } = args;

  if (!anchorId) {
    return { solver: "belted_module", planned: false, reason: "give an anchor_actor_id (the resource node)" };
  }
  if (chain.length === 0) {
    return { solver: "belted_module", planned: false, reason: "give a chain of buildings, in flow order" };
  }

  const anchor = findNode(graph, anchorId);
  if (!anchor) return { solver: "belted_module", planned: false, reason: `no actor matches "${anchorId}"` };

  const anchorLocation = vectorOf(anchor.raw?.location);
  if (!anchorLocation) {
    return { solver: "belted_module", planned: false, reason: "the anchor has no captured position" };
  }
  if (anchor.raw?.kind === "resource_node" && anchor.raw?.node_type === "Deposit") {
    return {
      solver: "belted_module",
      planned: false,
      reason: "that is a hand-mined deposit, which cannot host a miner",
    };
  }

  // Flow runs along +X from the node by default: a single axis keeps every belt
  // straight, which is both the shortest and the easiest to build over.
  const spacing = Number.isFinite(Number(spacingOverride)) ? Number(spacingOverride) : null;
  const steps = [];
  let cursorX = anchorLocation.x;
  const unmeasured = [];

  for (const [index, entry] of chain.entries()) {
    const classPath = typeof entry === "string" ? entry : entry?.class_path;
    const footprint = typeof entry === "object" ? entry?.footprint_cm ?? null : null;

    const measured = classPath ? measureConnectors(graph, classPath) : null;
    if (!measured) unmeasured.push(classPath ?? `step ${index + 1}`);

    // The first machine sits on the node itself; a miner has to.
    const width = Number.isFinite(Number(footprint)) ? Number(footprint) : null;
    const gap = spacing ?? (width !== null ? width : DEFAULT_MODULE_SPACING_CM);
    if (index > 0) cursorX += gap;

    steps.push({
      order: index + 1,
      class_path: classPath ?? null,
      location_cm: index === 0
        ? { ...anchorLocation }
        : { x: round(cursorX), y: anchorLocation.y, z: anchorLocation.z },
      on_the_node: index === 0,
      connectors_known: Boolean(measured),
      connector_offsets: measured ?? null,
    });
  }

  return {
    solver: "belted_module",
    planned: true,
    anchor: { actor_id: anchor.actor_id, name: anchor.raw?.name ?? null, location_cm: anchorLocation },
    steps,
    belt_legs: steps.slice(0, -1).map((step, index) => ({
      leg: index + 1,
      from_order: step.order,
      to_order: steps[index + 1].order,
      route_after_placement: true,
    })),
    how_to_build:
      "Place the machines first, then ask to belt them together. Belts join " +
      "connectors, and a connector only exists once its machine does — the game " +
      "decides where a placed machine actually ends up. Routing to a predicted " +
      "position would give you a plan that looks right and fails on contact.",
    unmeasured_buildings: unmeasured,
    unverified:
      unmeasured.length > 0
        ? `No example of ${unmeasured.join(", ")} exists in this world, so their ` +
          "connector positions are unknown until one is built. Spacing for those " +
          "is a default, not a measurement."
        : "Spacing came from your own buildings; the game's hologram still has the final say on each placement.",
  };
}

/** Used only when a building has never been seen in this world. */
const DEFAULT_MODULE_SPACING_CM = 1_200;
