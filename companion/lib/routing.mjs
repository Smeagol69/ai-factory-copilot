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
