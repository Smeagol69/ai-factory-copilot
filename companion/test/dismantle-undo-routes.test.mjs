/**
 * The last mechanical requests that were still costing money.
 *
 * Measured against the live bridge: "dismantle <thing>", "what can I undo", and
 * "clear all my waypoints" all reached a model. None of them need one.
 *
 * Dismantle is deliberately the most conservative route in the router. It is the
 * one write the undo journal cannot always reverse, so it only accepts a single
 * explicitly named target — "dismantle all the belts" goes to a model, because
 * that is the phrasing where a misparse costs someone their factory.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  answerLocally,
  parseClearWaypointRequest,
  parseDismantleRequest,
  parseUndoHistoryRequest,
  parseUndoRequest,
} from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const graph = buildGraph({
  world_revision: 44,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [
    {
      actor_id: "Build_ConveyorBeltMk1_C_7",
      name: "Build_ConveyorBeltMk1_C_7",
      kind: "buildable",
      location: { x: 500, y: 0, z: 0 },
    },
  ],
});

test("dismantles one named building locally", () => {
  const emitted = [];
  const answer = answerLocally("dismantle Build_ConveyorBeltMk1_C_7", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "dismantle");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "dismantle");
  assert.equal(emitted[0].actor_id, "Build_ConveyorBeltMk1_C_7");
  assert.equal(emitted[0].expect_world_revision, "44");
});

test("a generic name matching more than one building emits no dismantle", () => {
  const ambiguousGraph = buildGraph({
    world_revision: 45,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
    actors: [
      {
        actor_id: "Build_ConstructorMk1_C_1",
        name: "Build_ConstructorMk1_C_1",
        kind: "buildable",
        location: { x: 100, y: 0, z: 0 },
      },
      {
        actor_id: "Build_ConstructorMk1_C_2",
        name: "Build_ConstructorMk1_C_2",
        kind: "buildable",
        location: { x: 200, y: 0, z: 0 },
      },
    ],
  });
  const emitted = [];
  const answer = answerLocally("remove the constructor", ambiguousGraph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.local.solver, "dismantle_ambiguous");
  assert.match(answer.reply, /found \*\*2\*\* buildings/);
  assert.match(answer.reply, /Build_ConstructorMk1_C_1/);
  assert.match(answer.reply, /Build_ConstructorMk1_C_2/);
  assert.match(answer.reply, /No action was emitted/);
  assert.deepEqual(emitted, []);
});

test("anything that reads as more than one building is refused", () => {
  // This is the case worth being slow about. A misparse here is irreversible.
  for (const phrase of [
    "dismantle all the belts",
    "dismantle everything",
    "remove these constructors",
    "demolish both smelters",
  ]) {
    assert.equal(parseDismantleRequest(phrase), null, phrase);
  }
});

test("a single named target is still accepted in several phrasings", () => {
  assert.equal(parseDismantleRequest("dismantle Build_X_C_1").actor_id, "Build_X_C_1");
  assert.equal(parseDismantleRequest("tear down Build_X_C_1").actor_id, "Build_X_C_1");
  assert.equal(parseDismantleRequest("remove the constructor").name_contains, "constructor");
});

test("asking about undo is answered without pretending to read the journal", () => {
  const answer = answerLocally("what can i undo", graph, {});
  assert.equal(answer.local.solver, "undo_history");
  // The journal is game-side. Claiming to list it would be inventing.
  assert.match(answer.reply, /kept by the mod/);
  assert.match(answer.reply, /undo/i);
});

test("the undo question and the undo action stay distinct", () => {
  assert.equal(parseUndoHistoryRequest("what can i undo"), true);
  assert.equal(parseUndoRequest("what can i undo"), false);
  assert.equal(parseUndoHistoryRequest("undo"), false);
  assert.equal(parseUndoRequest("undo"), true);
  // "undo history" reads as a question, not a request to reverse anything.
  assert.equal(parseUndoHistoryRequest("undo history"), true);
});

test("clearing waypoints accepts stacked qualifiers", () => {
  // "clear all my waypoints" failed while "clear my waypoints" worked: the
  // pattern allowed one qualifier, and real phrasing stacks them.
  for (const phrase of [
    "clear waypoints",
    "clear my waypoints",
    "clear all my waypoints",
    "delete every waypoint",
    "wipe all waypoints",
  ]) {
    assert.equal(parseClearWaypointRequest(phrase), true, phrase);
  }
  // Overlays are a different thing and must not be swept up.
  assert.equal(parseClearWaypointRequest("clear all my highlights"), false);
});
