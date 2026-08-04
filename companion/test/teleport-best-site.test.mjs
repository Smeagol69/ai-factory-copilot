/**
 * "teleport me to the best hub location".
 *
 * Typed live, and it failed in an instructive way: the phrase is not a name, so
 * the teleport route ignored it and the question reached a model. The local
 * model then answered from the snapshot without calling `find_best_site`, the
 * grounding gate withheld the draft, and the whole thing fell through to a paid
 * tier that was out of credit. 47 seconds, no answer.
 *
 * Every part of the request is deterministic: score the sites, take the winner,
 * move there. `parseWaypointRequest` already treated the same phrasing this way;
 * teleport simply had not caught up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally, parseTeleportRequest } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const node = (name, x, y, resource) => ({
  actor_id: name,
  name,
  kind: "resource_node",
  location: { x, y, z: 100 },
  resource_name: resource,
  purity: "normal",
  node_type: "Node",
  occupied: false,
});

const graph = buildGraph({
  world_revision: 21,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [
    node("BP_Iron_1", 1_000, 0, "Iron Ore"),
    node("BP_Copper_1", 1_400, 300, "Copper Ore"),
    node("BP_Limestone_1", 1_200, -300, "Limestone"),
  ],
});

test("recognises the computed destination rather than treating it as a name", () => {
  for (const phrase of [
    "teleport me to the best hub location",
    "take me to the best base spot",
    "tp to the optimal hub site",
  ]) {
    assert.equal(parseTeleportRequest(phrase)?.kind, "best_site", phrase);
  }
});

test("a named destination is still a lookup, not a site search", () => {
  const parsed = parseTeleportRequest("teleport me to BP_Iron_1");
  assert.equal(parsed.kind, undefined);
  assert.equal(parsed.actor_id, "BP_Iron_1");
});

test("teleports to the scored site locally, so it costs nothing", () => {
  const emitted = [];
  const answer = answerLocally("teleport me to the best hub location", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.provider, "solvers", "must not reach a model");
  assert.equal(answer.local.solver, "teleport_player");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "teleport_player");
  // The stamp the mod requires on every committed write.
  assert.equal(emitted[0].expect_world_revision, "21");
  // The destination must come from the solver, not from thin air.
  assert.ok(Number.isFinite(emitted[0].target.x));
});

test("a world with nothing to score falls through rather than teleporting nowhere", () => {
  const empty = buildGraph({
    world_revision: 1,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
    actors: [],
  });
  const emitted = [];
  const answer = answerLocally("teleport me to the best hub location", empty, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });
  assert.notEqual(answer?.local?.solver, "teleport_player");
  assert.equal(emitted.length, 0, "never move the player to a site that was not scored");
});
