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

test("marking where you are stopped needing a model", () => {
  // The owner's report was a copilot transcript flatly denying that waypoints
  // were possible. This is why: "put a waypoint here" -- the most obvious form
  // of the request there is -- fell through to a model, and "mark this spot"
  // was claimed by the overlay route, which went hunting for buildings *named*
  // "this spot". Neither needed reasoning: the position is in the snapshot.
  const here = buildGraph({
    world_revision: 5,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 1_000, y: 2_000, z: 500 } },
      preferred_target: { hit_location: { x: 1_500, y: 2_000, z: 520 } },
    },
    actors: [],
  });

  for (const question of [
    "put a waypoint here",
    "waypoint here",
    "mark this spot",
    "mark this",
    "drop a pin here",
    "set a marker here",
    "flag where i am standing",
    "mark my position",
  ]) {
    const emitted = [];
    const answer = answerLocally(question, here, {
      actions: { emit: (actions) => emitted.push(...actions) },
    });
    assert.equal(answer?.local?.solver, "waypoint", `"${question}" should be a local waypoint`);
    assert.equal(emitted.length, 1, `"${question}" should emit exactly one action`);
    assert.equal(emitted[0].action, "waypoint");
    // The aim point, because that is where the player is pointing.
    assert.deepEqual(emitted[0].location, { x: 1_500, y: 2_000, z: 520 });
  }
});

test("with nothing under the crosshair the waypoint lands at the player's feet", () => {
  const nowhere = buildGraph({
    world_revision: 6,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 700, y: 800, z: 90 } },
    },
    actors: [],
  });

  const emitted = [];
  const answer = answerLocally("waypoint here", nowhere, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });
  assert.equal(answer.local.solver, "waypoint");
  assert.deepEqual(emitted[0].location, { x: 700, y: 800, z: 90 });
  // And it says which it used, rather than letting the player assume.
  assert.match(emitted[0].name, /your position/);
});

test("naming a thing still marks the thing, not the player", () => {
  const world = buildGraph({
    world_revision: 7,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } },
      preferred_target: { hit_location: { x: 10, y: 10, z: 10 } },
    },
    actors: [
      {
        actor_id: "BP_ResourceNode217",
        name: "Coal node",
        kind: "resource_node",
        location: { x: 9_000, y: 9_000, z: 100 },
      },
    ],
  });

  const emitted = [];
  answerLocally("mark BP_ResourceNode217 on my map", world, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });
  assert.deepEqual(emitted[0].location, { x: 9_000, y: 9_000, z: 100 });
});

test("clearing holograms, overlays and opening the library all route locally", async () => {
  const { parseClearHologramRequest, parseClearRequest, parseLibraryPageRequest } =
    await import("../lib/router.mjs");

  // This route had never once fired: every \s+ in its pattern had lost its
  // backslash, so it asked for literal s characters where spaces belonged.
  for (const question of [
    "clear holograms",
    "clear the stuck hologram",
    "get rid of stray holograms",
    "remove all my holograms",
    "sweep up the leftover holograms",
  ]) {
    assert.equal(parseClearHologramRequest(question), true, question);
  }
  assert.equal(parseClearHologramRequest("clear waypoints"), false);
  assert.equal(parseClearHologramRequest("what is a hologram"), false);

  // Qualifiers stack in real speech. This was fixed for waypoints and not for
  // overlays, so "clear my overlays" went to a model.
  for (const question of [
    "clear my overlays",
    "clear all my highlights",
    "clear the overlays",
    "remove my markers",
  ]) {
    assert.deepEqual(parseClearRequest(question), { all: true }, question);
  }

  // Written, exported, and then never called from any route -- the quietest
  // way a feature can be missing, because everything about it looks present.
  for (const question of [
    "open the library",
    "show me the library",
    "where is the library page",
  ]) {
    assert.deepEqual(parseLibraryPageRequest(question), {}, question);
  }
});
