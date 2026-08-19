/**
 * Looking a thing up by name.
 *
 * This exists because of a live failure: the model was asked to place a miner
 * on `BP_ResourceNode12_91`, a node that was in the world but not in the
 * reduced view it had been given, and it correctly said it had no way to find
 * it. Correct, and useless. The lookup searches the complete snapshot, and the
 * routing makes it free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { solveActorLookup } from "../lib/solvers.mjs";
import {
  answerLocally,
  explainRoutingMiss,
  isUnactionableInput,
  parseClearWaypointRequest,
  parseLocateRequest,
  parseNearbyResourceRequest,
  parsePlaceRequest,
  parseTeleportRequest,
  parseWaypointRequest,
  parseUndoRequest,
} from "../lib/router.mjs";

const snapshot = {
  world_revision: 73,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [
    {
      actor_id: "/Game/Map.Map:PersistentLevel.BP_ResourceNode12_91",
      name: "BP_ResourceNode12_91",
      kind: "resource_node",
      location: { x: 10_000, y: 0, z: 0 },
      resource_name: "Iron Ore",
      purity: "impure",
      node_type: "Node",
      occupied: false,
    },
    {
      actor_id: "/Game/Map.Map:PersistentLevel.BP_ResourceDeposit521",
      name: "BP_ResourceDeposit521",
      kind: "resource_node",
      location: { x: 5_000, y: 0, z: 0 },
      resource_name: "Iron Ore",
      purity: "pure",
      node_type: "Deposit",
      occupied: false,
    },
    {
      actor_id: "/Game/Map.Map:PersistentLevel.BP_ResourceNode99",
      name: "BP_ResourceNode99",
      kind: "resource_node",
      location: { x: 20_000, y: 0, z: 0 },
      resource_name: "Coal",
      purity: "normal",
      node_type: "Node",
      occupied: true,
    },
    {
      actor_id: "/Game/Map.Map:PersistentLevel.Build_ConstructorMk1_C_7",
      name: "Build_ConstructorMk1_C_7",
      kind: "buildable",
      location: { x: 1_000, y: 0, z: 0 },
    },
  ],
};

const graph = buildGraph(snapshot);

test("finds an actor by its exact name and reports where it is", () => {
  const result = solveActorLookup(graph, { actor_id: "BP_ResourceNode12_91" });
  assert.equal(result.matches.length, 1);
  const [match] = result.matches;
  assert.equal(match.name, "BP_ResourceNode12_91");
  assert.equal(match.location_cm.x, 10_000);
  assert.equal(match.distance_meters, 100);
});

test("says whether a node can actually host a miner, and why not when it cannot", () => {
  const [deposit] = solveActorLookup(graph, { actor_id: "BP_ResourceDeposit521" }).matches;
  assert.equal(deposit.can_host_a_miner, false);
  assert.match(deposit.why_not, /hand-mined deposit/);

  const [node] = solveActorLookup(graph, { actor_id: "BP_ResourceNode12_91" }).matches;
  assert.equal(node.can_host_a_miner, true);
  assert.equal(node.why_not, undefined);

  const [occupied] = solveActorLookup(graph, { actor_id: "BP_ResourceNode99" }).matches;
  assert.equal(occupied.can_host_a_miner, false);
  assert.match(occupied.why_not, /already built/);
});

test("searches by resource and returns nearest first", () => {
  const result = solveActorLookup(graph, { resource_name: "Iron Ore" });
  assert.equal(result.matches.length, 2);
  assert.deepEqual(
    result.matches.map((m) => m.name),
    ["BP_ResourceDeposit521", "BP_ResourceNode12_91"],
  );
});

test("an absent name returns no matches rather than a guess", () => {
  const result = solveActorLookup(graph, { actor_id: "BP_DoesNotExist" });
  assert.equal(result.matches.length, 0);
});

test("parses the lookup phrasings and refuses the siting ones", () => {
  assert.deepEqual(parseLocateRequest("where is BP_ResourceNode12_91"), {
    actor_id: "BP_ResourceNode12_91",
    target: "BP_ResourceNode12_91",
  });
  assert.equal(parseLocateRequest("wheres the nearest coal").name_contains, "coal");
  assert.equal(parseLocateRequest("locate my constructors").name_contains, "constructors");

  // These belong to find_best_site or to the model, not here.
  assert.equal(parseLocateRequest("where should i build my hub"), null);
  assert.equal(parseLocateRequest("where is the best place for a smelter"), null);
  assert.equal(parseLocateRequest("where is it and then build there"), null);
});

test("a lookup is answered locally, so it costs nothing", () => {
  const answer = answerLocally("where is BP_ResourceNode12_91", graph, {});
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "locate");
  assert.match(answer.reply, /BP_ResourceNode12_91/);
  assert.match(answer.reply, /x=10000/);
});

test("an unmatched lookup falls through to the model rather than denying it", () => {
  // The parse guesses at the target, so "no match" may only mean the guess was
  // wrong. Answering "it does not exist" locally would be answering it wrong.
  const answer = answerLocally("where is the thing i built yesterday", graph, {});
  assert.notEqual(answer?.local?.solver, "locate");
});

test("parses nearby resource queries without inventing a radius", () => {
  assert.deepEqual(parseNearbyResourceRequest("what resource nodes are near me?"), {
    radius_m: null,
    limit: 8,
  });
  assert.deepEqual(parseNearbyResourceRequest("which resources are within 150 m of me"), {
    radius_m: 150,
    limit: 8,
  });
  assert.deepEqual(parseNearbyResourceRequest("list resource nodes around my position within 250m"), {
    radius_m: 250,
    limit: 8,
  });

  assert.equal(parseNearbyResourceRequest("what resource nodes are near me and which is best"), null);
  assert.equal(parseNearbyResourceRequest("why are resource nodes near me"), null);
});

test("nearby resources are answered exactly from the captured player position", () => {
  const answer = answerLocally("what resource nodes are near me", graph, {});

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "nearby_resources");
  assert.match(answer.reply, /Iron Ore.*100 m/);
  assert.match(answer.reply, /Coal.*200 m/);
  assert.doesNotMatch(answer.reply, /BP_ResourceDeposit521/);
  assert.doesNotMatch(answer.reply, /within \d+ m/i);
});

test("an explicit nearby-resource radius is applied exactly", () => {
  const answer = answerLocally("which resource nodes are within 150m of me", graph, {});

  assert.equal(answer.local.solver, "nearby_resources");
  assert.match(answer.reply, /within \*\*150 m\*\*/);
  assert.match(answer.reply, /Iron Ore.*100 m/);
  assert.doesNotMatch(answer.reply, /Coal/);
});

test("nearby-resource routing names the missing player-position field", () => {
  const withoutPosition = structuredClone(snapshot);
  delete withoutPosition.interaction_context.player.pawn_location;
  for (const actor of withoutPosition.actors) {
    if (actor.kind === "player") delete actor.location;
  }

  const answer = answerLocally(
    "what resource nodes are near me",
    buildGraph(withoutPosition),
    {},
  );
  assert.equal(answer.local.solver, "nearby_resources");
  assert.match(answer.reply, /interaction_context\.player\.pawn_location/);
});

test("input that cannot mean anything never reaches a model", () => {
  // A stray "1" typed into the chat panel cost $0.25 in a live session.
  for (const meaningless of ["1", "?", "42", "x", "  ", "..."]) {
    assert.equal(isUnactionableInput(meaningless), true, `expected "${meaningless}" to be unactionable`);
  }
  for (const real of ["yes", "do it", "undo", "why", "where is coal"]) {
    assert.equal(isUnactionableInput(real), false, `expected "${real}" to be actionable`);
  }

  const answer = answerLocally("1", graph, {});
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "clarify");
});

test("teleporting to a named thing is a lookup plus a move, so it costs nothing", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("teleport me to BP_ResourceNode12_91", graph, services);

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "teleport_player");
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    action: "teleport_player",
    target: { x: 10_000, y: 0, z: 0 },
    snap_to_ground: true,
    snap_clearance_cm: 200,
    commit: true,
    expect_world_revision: "73",
    require_unchanged_world: false,
  });
});

test("a teleport to an unresolvable name goes to the model rather than a guessed coordinate", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("teleport me to the sky temple", graph, services);
  assert.notEqual(answer?.local?.solver, "teleport_player");
  assert.equal(emitted.length, 0);
});

test("a coordinate teleport is read here, not sent away for a conversation", () => {
  // This test used to assert the opposite: a raw coordinate "deserves the
  // plausibility conversation, which is judgement and therefore not local".
  //
  // The routing log disagreed. The owner asked three times in a row, phrased
  // three different ways, and never arrived — the conversation the model was
  // supposed to add never happened, the request simply failed. And the
  // plausibility check is deterministic anyway: validateAction refuses beyond
  // MAX_TELEPORT_METERS and warns when ground snapping is off. The model was
  // contributing nothing except the failure.
  assert.deepEqual(parseTeleportRequest("teleport me to x=100, y=200"), {
    kind: "coordinates",
    target: { x: 100, y: 200, z: 0 },
    had_z: false,
  });

  // Both orders, because both are in the log: the coordinate was tried before
  // the verb as well as after it.
  const before = parseTeleportRequest("x=372373.7, y=-153420.9, z=4006.0 teleport me here");
  assert.equal(before.kind, "coordinates");
  assert.deepEqual(before.target, { x: 372_373.7, y: -153_420.9, z: 4_006 });
  assert.equal(before.had_z, true);

  // Bare numbers count, but only at a magnitude that reads as a world
  // coordinate -- "teleport me to 3 smelters" must not become a position.
  assert.equal(parseTeleportRequest("tp to 372373 -153420").kind, "coordinates");
  assert.notEqual(parseTeleportRequest("teleport me to the coal node")?.kind, "coordinates");

  // A named place is still a lookup, not a coordinate.
  assert.equal(parseTeleportRequest("teleport me to BP_ResourceNode217").actor_id, "BP_ResourceNode217");
});

test("undo is answered locally and emits the reversal", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("undo that", graph, services);

  assert.equal(answer.local.solver, "undo_last");
  assert.deepEqual(emitted, [{
    action: "undo_last",
    commit: true,
    expect_world_revision: "73",
    require_unchanged_world: false,
  }]);

  // Anything else attached to it is a different request.
  assert.equal(parseUndoRequest("undo and then place a smelter"), false);
});

test("a routing miss names the route it nearly took and the word that blocked it", () => {
  assert.match(
    explainRoutingMiss("where should i build my hub next to that lake"),
    /find_best_site matched .* but left: .*lake/,
  );
  assert.equal(explainRoutingMiss("tell me a joke"), "no route pattern matched");
});

/* ---------------- placing and marking without a model ---------------- */

test("a placement request is three lookups, so it costs nothing", () => {
  const parsed = parsePlaceRequest("place a mk1 miner on this node facing north");
  assert.deepEqual(parsed.target, { kind: "aim" });
  assert.equal(parsed.building, "a mk1 miner");
  assert.equal(parsed.facing.yaw, 0);
  assert.equal(parsed.facing.described, "north");
});

test("placement refuses the cases that genuinely need a model", () => {
  // Multiple buildings, a layout, or a connection is a design problem.
  for (const question of [
    "place a mk1 miner on this node and belt it to a smelter",
    "build me a fully functional mk1 module on this node",
    "place three miners on these nodes",
    "place a miner on this node facing sideways",
  ]) {
    assert.equal(parsePlaceRequest(question), null, question);
  }
});

test("a waypoint uses the game's own marker system", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("waypoint BP_ResourceNode12_91", graph, services);

  assert.equal(answer.local.solver, "waypoint");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "waypoint");
  assert.deepEqual(emitted[0].location, { x: 10_000, y: 0, z: 0 });
  assert.equal(emitted[0].name, "BP_ResourceNode12_91");
  // The distance readout is the reason for using the game's markers at all.
  assert.match(answer.reply, /compass/);
});

test("clear waypoints uses the dedicated map-marker action", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };

  assert.equal(parseClearWaypointRequest("clear all waypoints"), true);
  const answer = answerLocally("clear all waypoints", graph, services);

  assert.equal(answer.local.solver, "clear_waypoints");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "clear_waypoints");
  assert.equal(emitted[0].all, true);
  assert.equal(emitted[0].commit, true);
  assert.equal(emitted[0].expect_world_revision, "73");
});

test("waypointing the best site asks the site solver, not the model", () => {
  const parsed = parseWaypointRequest("create me a waypoint for best hub location");
  assert.equal(parsed.kind, "best_site");
});

test("a drawn overlay request is still an overlay, not a waypoint", () => {
  // Many targets seen at once through terrain is what the line batcher is for;
  // a single destination with a distance is what the map marker is for.
  assert.equal(parseWaypointRequest("show me every beryl nut in 100m"), null);
});
