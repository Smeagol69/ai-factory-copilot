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

/**
 * Pick a physical free-port pair for an explicitly temporary live test.
 *
 * A pair whose captured recipes prove different items is never returned. When
 * one side has no selected/captured recipe, the geometry can still be tested,
 * but the result says compatibility is unknown and names the missing evidence.
 * This is not a fallback used by production planning; callers must opt in to
 * the separate test route that makes the temporary intent explicit.
 */
export function solveTemporaryFreeBeltRoute(graph, args = {}) {
  const radius = Number(args.radius_m ?? 100);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 5_000) {
    return {
      solver: "temporary_free_belt_route",
      routed: false,
      reason: "radius_m must be between 0 and 5000",
      source: "authoritative_snapshot",
      certainty: "exact_for_captured_data",
    };
  }

  const player = capturedPlayerPosition(graph);
  if (!player) {
    return {
      solver: "temporary_free_belt_route",
      routed: false,
      reason: "the snapshot did not contain the player's position",
      missing: ["interaction_context.player.pawn_location"],
      source: "authoritative_snapshot",
      certainty: "unknown",
    };
  }

  const nearby = [];
  for (const node of graph?.nodes?.values?.() ?? []) {
    const location = vectorOf(node?.raw?.location);
    if (!location || node?.kind !== "buildable") continue;
    // A loose belt segment is transport, not a production endpoint. Connecting
    // two conveyor actors would test a different hologram/snap case.
    if (node?.role === "conveyor" || node?.role === "pipeline") continue;
    const distanceFromPlayer = distanceMeters(player, location);
    if (distanceFromPlayer === null || distanceFromPlayer > radius) continue;
    nearby.push({
      node,
      produces: producedItemClasses(graph, node),
      consumes: consumedItemClasses(graph, node),
      distance_from_player_m: distanceFromPlayer,
    });
  }

  const candidates = [];
  let provenIncompatiblePairs = 0;
  for (const source of nearby) {
    for (const target of nearby) {
      if (source.node.actor_id === target.node.actor_id) continue;

      const compatible = [...source.produces].filter((itemClass) => target.consumes.has(itemClass));
      const bothKnown = source.produces.size > 0 && target.consumes.size > 0;
      if (bothKnown && compatible.length === 0) {
        provenIncompatiblePairs += 1;
        continue;
      }

      const route = solveBeltRoute(graph, {
        from_actor_id: source.node.actor_id,
        to_actor_id: target.node.actor_id,
      });
      if (!route.routed) continue;

      const missing = [];
      if (source.produces.size === 0) missing.push("source_current_recipe_or_resource");
      if (target.consumes.size === 0) missing.push("target_current_recipe");
      candidates.push({
        route,
        compatible,
        compatibility: compatible.length > 0 ? "proven" : "unknown",
        missing,
        furthest_from_player_m: Math.max(
          source.distance_from_player_m,
          target.distance_from_player_m,
        ),
      });
    }
  }

  // A proven-compatible pair is always safer than an unknown one. Inside each
  // evidence tier, "nearest" means the shortest proposed belt.
  candidates.sort(
    (a, b) =>
      Number(a.compatibility !== "proven") - Number(b.compatibility !== "proven") ||
      (a.route.length_cm ?? Number.POSITIVE_INFINITY) -
        (b.route.length_cm ?? Number.POSITIVE_INFINITY) ||
      a.furthest_from_player_m - b.furthest_from_player_m ||
      String(a.route.from.actor_id).localeCompare(String(b.route.from.actor_id)) ||
      String(a.route.to.actor_id).localeCompare(String(b.route.to.actor_id)),
  );

  if (candidates.length === 0) {
    return {
      solver: "temporary_free_belt_route",
      routed: false,
      reason:
        `no free factory output/input pair that was not proven incompatible was captured within ${round(radius)} m`,
      radius_m: round(radius),
      proven_incompatible_pairs_refused: provenIncompatiblePairs,
      source: "authoritative_snapshot",
      certainty: "exact_for_captured_data",
    };
  }

  const best = candidates[0];
  return {
    ...best.route,
    solver: "temporary_free_belt_route",
    radius_m: round(radius),
    compatibility: best.compatibility,
    compatible_item_classes: best.compatible,
    compatible_items: best.compatible.map((itemClass) => displayItem(graph, itemClass)),
    missing_compatibility_evidence: best.missing,
    candidate_count: candidates.length,
    furthest_endpoint_from_player_m: round(best.furthest_from_player_m),
    source: "authoritative_snapshot",
    certainty:
      best.compatibility === "proven"
        ? "exact_for_captured_data_except_game_owned_hologram_checks"
        : "geometry_exact_item_compatibility_unknown",
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

/* ---------------- splitting one output across several machines ---------------- */

/**
 * Plans a splitter and the belts around it.
 *
 * The owner's request was "a miner belted into a smelter belting into the next
 * thing then splitted" — `planBeltedModule` builds the linear part, and this is
 * the fan-out. One producer feeding several consumers needs a splitter between
 * them, positioned so all of its belts stay short and straight.
 *
 * How many outputs a splitter has is **measured, not assumed**. If the player
 * already owns one, its connectors are read off it the same way
 * `measureConnectors` reads any building. If they do not, the plan says the
 * count is unverified rather than inventing a number — the same rule that keeps
 * belt length in the game's hands.
 */
function rotateYaw(vector, yawDegrees) {
  const radians = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
    z: vector.z,
  };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function interpolate(a, b, amount) {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  };
}

function connectorName(component) {
  return String(component ?? "").split(".").pop() || null;
}

/**
 * Connector topology belongs to one splitter instance, not to the whole class.
 * `measureConnectors` intentionally pools offsets from every instance for
 * layout sampling; counting that pooled array made two three-output splitters
 * look like one six-output splitter. This keeps instances separate and accepts
 * the capacity only when every captured example agrees.
 */
function measureSplitterTopology(graph, classPath) {
  if (!classPath) {
    return {
      resolved: false,
      reason: "give splitter_class_path so its connector topology can be measured",
      missing: ["splitter_class_path"],
    };
  }

  const instances = [];
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node.class_path !== classPath) continue;
    const origin = vectorOf(node.raw?.location);
    if (!origin) continue;
    const yaw = Number(node.raw?.rotation?.yaw ?? 0);
    if (!Number.isFinite(yaw)) continue;

    const inputs = [];
    const outputs = [];
    for (const connection of node.raw?.connections ?? []) {
      if (!isFactoryConnection(connection)) continue;
      const world = vectorOf(connection.location);
      if (!world) continue;
      const local = rotateYaw(subtract(world, origin), -yaw);
      const measured = {
        component_name: connectorName(connection.component),
        offset_cm: {
          x: round(local.x),
          y: round(local.y),
          z: round(local.z),
        },
      };
      const direction = normalizeDirection(connection.direction);
      if (direction === "FCD_OUTPUT" || direction === "OUTPUT") outputs.push(measured);
      else if (direction === "FCD_INPUT" || direction === "INPUT") inputs.push(measured);
    }
    if (inputs.length > 0 || outputs.length > 0) {
      inputs.sort((a, b) => String(a.component_name).localeCompare(String(b.component_name)));
      outputs.sort((a, b) => String(a.component_name).localeCompare(String(b.component_name)));
      instances.push({ actor_id: node.actor_id, inputs, outputs });
    }
  }

  if (instances.length === 0) {
    return {
      resolved: false,
      reason: "no captured splitter of that class exists, so its connectors are unknown",
      missing: ["captured_splitter_connector_topology"],
      class_path: classPath,
    };
  }

  const inputCounts = [...new Set(instances.map((instance) => instance.inputs.length))];
  const outputCounts = [...new Set(instances.map((instance) => instance.outputs.length))];
  if (inputCounts.length !== 1 || outputCounts.length !== 1) {
    return {
      resolved: false,
      reason: "captured splitters of that class disagree on connector counts",
      observed_input_counts: inputCounts,
      observed_output_counts: outputCounts,
      measured_from: instances.length,
      class_path: classPath,
    };
  }
  if (inputCounts[0] !== 1 || outputCounts[0] < 2) {
    return {
      resolved: false,
      reason:
        "this planner requires a measured one-input splitter with at least two outputs; " +
        `captured topology was ${inputCounts[0]} input(s), ${outputCounts[0]} output(s)`,
      measured_from: instances.length,
      class_path: classPath,
    };
  }

  const topology = instances[0];
  const outputCentroid = topology.outputs.reduce(
    (sum, output) => add(sum, output.offset_cm),
    { x: 0, y: 0, z: 0 },
  );
  outputCentroid.x /= topology.outputs.length;
  outputCentroid.y /= topology.outputs.length;
  outputCentroid.z /= topology.outputs.length;
  const localForward = normalize({
    x: outputCentroid.x - topology.inputs[0].offset_cm.x,
    y: outputCentroid.y - topology.inputs[0].offset_cm.y,
    z: 0,
  });
  if (!localForward) {
    return {
      resolved: false,
      reason: "captured splitter geometry does not establish an input-to-output facing direction",
      measured_from: instances.length,
      class_path: classPath,
    };
  }

  return {
    resolved: true,
    class_path: classPath,
    input: topology.inputs[0],
    outputs: topology.outputs,
    output_capacity: outputCounts[0],
    local_forward: localForward,
    measured_from: instances.length,
    source: "per_instance_captured_connector_topology",
    certainty: "authoritative_for_captured_splitter_class",
  };
}

function assignOutputs(outputs, targets) {
  const available = [...outputs];
  const assignments = [];
  for (const target of targets) {
    let bestIndex = 0;
    for (let index = 1; index < available.length; index += 1) {
      if (
        length(subtract(target.connector.location, available[index].world_location)) <
        length(subtract(target.connector.location, available[bestIndex].world_location))
      ) {
        bestIndex = index;
      }
    }
    assignments.push({ target, output: available.splice(bestIndex, 1)[0] });
  }
  return assignments;
}

export function planSplitterFanOut(graph, args = {}) {
  const {
    from_actor_id: fromId,
    to_actor_ids: toIds = [],
    splitter_class_path: splitterClass = null,
  } = args;

  if (!fromId) {
    return { solver: "splitter_fan_out", planned: false, reason: "give from_actor_id, the machine being split" };
  }
  if (!Array.isArray(toIds) || toIds.length < 2) {
    return {
      solver: "splitter_fan_out",
      planned: false,
      reason: "give at least two to_actor_ids — one consumer needs a belt, not a splitter",
    };
  }

  const topology = measureSplitterTopology(graph, splitterClass);
  if (!topology.resolved) {
    return { solver: "splitter_fan_out", planned: false, ...topology };
  }

  const from = findNode(graph, fromId);
  if (!from) return { solver: "splitter_fan_out", planned: false, reason: `no actor matches "${fromId}"` };

  const source = connectorsOf(from, "output");
  if (source.free.length === 0) {
    return {
      solver: "splitter_fan_out",
      planned: false,
      reason:
        source.occupied.length > 0
          ? `every output on ${describeActor(from)} is already connected`
          : `${describeActor(from)} has no conveyor output`,
    };
  }

  const produces = producedItemClasses(graph, from);
  if (produces.size === 0) {
    return {
      solver: "splitter_fan_out",
      planned: false,
      reason: `${describeActor(from)} has no captured current recipe or extracted resource`,
      missing: ["source_current_recipe_or_resource"],
    };
  }

  // Resolve consumers and prove item compatibility before doing geometry. A
  // free input carrying the wrong item is not a usable fan-out target.
  const targets = [];
  const unusable = [];
  const seenTargets = new Set();
  for (const id of toIds) {
    const node = findNode(graph, id);
    if (!node) {
      unusable.push({ actor_id: id, reason: "no actor in the snapshot matches it" });
      continue;
    }
    if (node.actor_id === from.actor_id || seenTargets.has(node.actor_id)) {
      unusable.push({ actor_id: id, name: describeActor(node), reason: "duplicate or source actor is not a consumer" });
      continue;
    }
    seenTargets.add(node.actor_id);

    const inputs = connectorsOf(node, "input");
    if (inputs.free.length === 0) {
      unusable.push({
        actor_id: id,
        name: describeActor(node),
        reason:
          inputs.occupied.length > 0
            ? "every input is already connected"
            : "it has no conveyor input",
      });
      continue;
    }

    const consumes = consumedItemClasses(graph, node);
    if (consumes.size === 0) {
      unusable.push({
        actor_id: id,
        name: describeActor(node),
        reason: "no captured current recipe proves what this consumer accepts",
        missing: ["target_current_recipe"],
      });
      continue;
    }
    // A normal splitter cannot filter a mixed belt. Every item the source can
    // put on that belt therefore has to be accepted by every consumer; a
    // one-item intersection would still send the other coproducts there and
    // eventually clog it. Smart/programmable routing needs its own planner.
    const incompatible = [...produces].filter((itemClass) => !consumes.has(itemClass));
    if (incompatible.length > 0) {
      unusable.push({
        actor_id: id,
        name: describeActor(node),
        reason: "captured recipes prove this input cannot accept every item on the source belt",
        source_item_classes: [...produces],
        target_item_classes: [...consumes],
        incompatible_source_item_classes: incompatible,
      });
      continue;
    }
    targets.push({ node, connector: inputs.free[0], compatible: [...produces] });
  }

  if (targets.length < 2) {
    return {
      solver: "splitter_fan_out",
      planned: false,
      reason: "fewer than two recipe-compatible consumers can take a belt",
      unusable,
    };
  }

  const targetCentroid = targets.reduce(
    (sum, target) => add(sum, target.connector.location),
    { x: 0, y: 0, z: 0 },
  );
  targetCentroid.x /= targets.length;
  targetCentroid.y /= targets.length;
  targetCentroid.z /= targets.length;

  // Use the source port nearest the consumers rather than whichever component
  // happened to be emitted first.
  const output = source.free.reduce((best, candidate) =>
    length(subtract(candidate.location, targetCentroid)) < length(subtract(best.location, targetCentroid))
      ? candidate
      : best,
  );
  const horizontalHeading = normalize({
    x: targetCentroid.x - output.location.x,
    y: targetCentroid.y - output.location.y,
    z: 0,
  });
  if (!horizontalHeading) {
    return {
      solver: "splitter_fan_out",
      planned: false,
      reason: "source output and consumer centroid do not establish a horizontal placement direction",
      missing: ["nonzero_horizontal_span"],
      unusable,
    };
  }

  const outputCapacity = topology.output_capacity;
  const splittersNeeded = Math.ceil((targets.length - 1) / (outputCapacity - 1));
  const desiredYaw = (Math.atan2(horizontalHeading.y, horizontalHeading.x) * 180) / Math.PI;
  const localYaw = (Math.atan2(topology.local_forward.y, topology.local_forward.x) * 180) / Math.PI;
  const splitterYaw = round(((desiredYaw - localYaw) % 360 + 360) % 360);
  const rotatedInputOffset = rotateYaw(topology.input.offset_cm, splitterYaw);

  // Every position is interpolated from captured endpoints. There is no
  // "standard" standoff: the input connector measurement translates each
  // desired path point into the actor origin the hologram should try.
  const splitters = Array.from({ length: splittersNeeded }, (_, index) => {
    const inputWorld = interpolate(output.location, targetCentroid, (index + 1) / (splittersNeeded + 1));
    const location = subtract(inputWorld, rotatedInputOffset);
    const outputs = topology.outputs.map((measured, outputIndex) => ({
      index: outputIndex + 1,
      component_name_sample: measured.component_name,
      world_location: add(location, rotateYaw(measured.offset_cm, splitterYaw)),
    }));
    return {
      splitter: index + 1,
      class_path: splitterClass,
      location_cm: { x: round(location.x), y: round(location.y), z: round(location.z) },
      yaw_degrees: splitterYaw,
      input_world_cm: { x: round(inputWorld.x), y: round(inputWorld.y), z: round(inputWorld.z) },
      outputs,
    };
  });

  targets.sort(
    (a, b) =>
      dot(subtract(a.connector.location, output.location), horizontalHeading) -
        dot(subtract(b.connector.location, output.location), horizontalHeading) ||
      String(a.node.actor_id).localeCompare(String(b.node.actor_id)),
  );

  const legs = [];
  const chainLegs = [];
  let targetIndex = 0;
  for (let index = 0; index < splitters.length; index += 1) {
    const splitter = splitters[index];
    const hasNext = index < splitters.length - 1;
    let continuation = null;
    let consumerOutputs = [...splitter.outputs];
    if (hasNext) {
      continuation = consumerOutputs.reduce((best, candidate) =>
        dot(subtract(candidate.world_location, splitter.input_world_cm), horizontalHeading) >
        dot(subtract(best.world_location, splitter.input_world_cm), horizontalHeading)
          ? candidate
          : best,
      );
      consumerOutputs = consumerOutputs.filter((candidate) => candidate.index !== continuation.index);
      chainLegs.push({
        from_splitter: index + 1,
        from_output: continuation.index,
        from_component_name_sample: continuation.component_name_sample,
        to_splitter: index + 2,
        length_meters: round(
          length(subtract(splitters[index + 1].input_world_cm, continuation.world_location)) / 100,
        ),
      });
    }

    const count = hasNext
      ? Math.min(outputCapacity - 1, targets.length - targetIndex)
      : targets.length - targetIndex;
    const group = targets.slice(targetIndex, targetIndex + count);
    targetIndex += count;
    const assignments = assignOutputs(consumerOutputs, group);
    for (const { target, output: assigned } of assignments) {
      legs.push({
        leg: legs.length + 1,
        from_splitter: index + 1,
        from_splitter_output: assigned.index,
        from_component_name_sample: assigned.component_name_sample,
        to_actor_id: target.node.actor_id,
        to_name: describeActor(target.node),
        to_connector: target.connector.component,
        compatible_item_classes: target.compatible,
        compatible_items: target.compatible.map((itemClass) => displayItem(graph, itemClass)),
        length_meters: round(length(subtract(target.connector.location, assigned.world_location)) / 100),
      });
    }
  }

  const notes = [];
  if (splittersNeeded > 1) {
    notes.push(
      `${targets.length} consumers need ${splittersNeeded} chained splitters at the measured ` +
        `${outputCapacity}-output capacity. Each non-final splitter reserves one output for the next.`,
    );
  }
  if (unusable.length > 0) {
    notes.push(`${unusable.length} named machine(s) could not take this item; see unusable.`);
  }

  const first = splitters[0];
  return {
    solver: "splitter_fan_out",
    planned: true,
    splitter: {
      ...first,
      outputs_available: outputCapacity,
      outputs_source: "measured_per_instance_from_your_own_splitter",
      measured_from: topology.measured_from,
    },
    splitters,
    splitters_needed: splittersNeeded,
    feed: {
      from_actor_id: from.actor_id,
      from_name: describeActor(from),
      from_connector: output.component,
      to_splitter: 1,
      length_meters: round(length(subtract(first.input_world_cm, output.location)) / 100),
    },
    chain_legs: chainLegs,
    legs,
    unusable,
    notes,
    source: "authoritative_snapshot_and_per_instance_connector_measurement",
    certainty: "calculated_from_captured_geometry_and_recipe_compatibility",
    unverified:
      "Positions are proposals derived from captured connector geometry. Clearance, maximum belt length, " +
      "terrain fit and the final placed transforms are decided by the game's holograms. Route belts only " +
      "after the splitters exist and their real connection components are captured.",
  };
}
