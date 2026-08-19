/**
 * Questions the owner actually asked that reached a model.
 *
 * Taken from `routing.jsonl` in the live diagnostics folder, not invented. Of
 * 512 logged questions, 185 were answered by a model; these are the ones among
 * them that needed nothing a model provides. Each is here in the owner's own
 * words, typos and all where the typo is the point.
 *
 * This file is the record that they were fixed, and the guard that they stay
 * fixed. Real usage has been a better source of routing gaps than any amount
 * of reading the patterns.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally, parseTeleportRequest } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const PLAYER = { x: 372_000, y: -153_000, z: 4_000 };

const graph = buildGraph({
  world_revision: 5,
  world: { scan_center: PLAYER },
  interaction_context: { player: { pawn_available: true, pawn_location: PLAYER } },
  actors: [
    {
      actor_id: "BP_ResourceNode217",
      name: "Coal node",
      kind: "resource_node",
      resource_name: "Coal",
      node_type: "Node",
      location: { x: 372_500, y: -153_000, z: 4_000 },
    },
    {
      actor_id: "BP_ResourceNode9",
      name: "Biomass bush",
      kind: "resource_node",
      resource_name: "Biomass",
      location: { x: 373_000, y: -153_000, z: 4_000 },
    },
  ],
});

const ask = (question) => {
  const emitted = [];
  const answer = answerLocally(question, graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });
  return { answer, emitted };
};

test("the three coordinate teleports the owner tried in a row", () => {
  // Logged one after another, phrased three ways, none of which arrived. The
  // route deliberately sent raw coordinates to a model for "the plausibility
  // conversation" -- which never happened. The plausibility gate is in
  // validateAction and applies either way.
  for (const question of [
    "teleport me here x=372373.7, y=-153420.9, z=4006.0",
    "x=372373.7, y=-153420.9, z=4006.0 teleport me here",
    "teleport me to x=372373 y=-153420 z=4006",
  ]) {
    const { answer, emitted } = ask(question);
    assert.equal(answer?.local?.solver, "teleport_player", question);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "teleport_player");
    // Two of the three carry the decimal, one does not, so the check is that
    // the coordinate arrived rather than that it was rounded a particular way.
    assert.ok(Math.abs(emitted[0].target.x - 372_373.7) < 1, `x was ${emitted[0].target.x}`);
    assert.ok(Math.abs(emitted[0].target.y + 153_420.9) < 1, `y was ${emitted[0].target.y}`);
    assert.equal(emitted[0].snap_to_ground, true);
  }

  // Without a Z the numbers are a map reference, so it lands on the ground and
  // the reply says which it did.
  const { answer } = ask("tp to 372373 -153420");
  assert.match(answer.reply, /no height given/);
});

test("a lowercase actor id, which is how anyone would type it", () => {
  // "where is bp_resourcenode217" was answered by a model. The parser resolved
  // it to an actor_id correctly; solveActorLookup then compared ids
  // case-sensitively and matched nothing, so the route fell through. The name
  // comparison beside it had always been case-insensitive.
  for (const question of [
    "where is bp_resourcenode217",
    "teleport me to bp_resourcenode217",
    "waypoint bp_resourcenode217",
  ]) {
    const { answer } = ask(question);
    assert.ok(answer?.local?.solver, `"${question}" should be answered locally`);
    assert.match(answer.reply, /Coal node/, question);
  }
});

test("waypoint nearest source of biomass", () => {
  // Logged while the owner was testing the waypoint system. "source of" is not
  // part of the name, and leaving it in made the lookup hunt for a building
  // called "source of biomass".
  const { answer, emitted } = ask("waypoint nearest source of biomass");
  assert.equal(answer.local.solver, "waypoint");
  assert.equal(emitted[0].action, "waypoint");
  assert.deepEqual(emitted[0].location, { x: 373_000, y: -153_000, z: 4_000 });
});

test("a named target is still a lookup, not a coordinate", () => {
  // The coordinate parser must not swallow the ordinary case.
  assert.notEqual(parseTeleportRequest("teleport me to the coal node")?.kind, "coordinates");
  assert.equal(parseTeleportRequest("teleport me to BP_ResourceNode217").actor_id, "BP_ResourceNode217");
});
