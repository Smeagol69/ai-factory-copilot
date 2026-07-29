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
  parseLocateRequest,
  parseTeleportRequest,
  parseUndoRequest,
} from "../lib/router.mjs";

const snapshot = {
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
    commit: true,
  });
});

test("a teleport to an unresolvable name goes to the model rather than a guessed coordinate", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("teleport me to the sky temple", graph, services);
  assert.notEqual(answer?.local?.solver, "teleport_player");
  assert.equal(emitted.length, 0);
});

test("a raw coordinate teleport still goes to the model", () => {
  // Dropping a player at an arbitrary coordinate deserves the plausibility
  // conversation, which is judgement and therefore not local.
  assert.equal(parseTeleportRequest("teleport me to x=100, y=200"), null);
});

test("undo is answered locally and emits the reversal", () => {
  const emitted = [];
  const services = { actions: { emit: (actions) => emitted.push(...actions) } };
  const answer = answerLocally("undo that", graph, services);

  assert.equal(answer.local.solver, "undo_last");
  assert.deepEqual(emitted, [{ action: "undo_last", commit: true }]);

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
