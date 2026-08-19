/**
 * Three questions a player asks constantly, all of which were reaching a model.
 *
 * "Where am I", "what am I looking at" and "how many X do I have" contain
 * nothing to reason about: the position and the crosshair target are fields in
 * the capture, and a count is a count. Paying per request to have the snapshot
 * read back is the exact thing the deterministic routes exist to prevent.
 *
 * The count is the one worth being careful about. The first version read the
 * length of `matches`, which `solveActorLookup` caps by `limit` -- so it
 * answered "how many smelters" with 1 when there were 2. A confidently wrong
 * number is worse than paying for the answer, so the total is taken from
 * `match_count` and the capped list is used only to name the nearest one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  answerLocally,
  parseHowManyRequest,
  parseLookingAtRequest,
  parseWhereAmIRequest,
} from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const PLAYER = { x: 1_000, y: 2_000, z: 500 };

const graph = buildGraph({
  world_revision: 5,
  world: { scan_center: PLAYER },
  interaction_context: {
    player: { pawn_available: true, pawn_location: PLAYER },
    preferred_target: {
      available: true,
      hit_location: { x: 1_500, y: 2_000, z: 520 },
      actor_id: "BP_ResourceNode217",
      actor_name: "Coal node",
      actor_snapshot: {
        kind: "resource_node",
        name: "Coal node",
        location: { x: 1_500, y: 2_000, z: 520 },
        node_type: "Node",
        purity: "normal",
        occupied: false,
        actor_id: "BP_ResourceNode217",
        resource_name: "Coal",
      },
    },
  },
  actors: [
    { actor_id: "BP_ResourceNode217", name: "Coal node", kind: "resource_node", location: { x: 1_500, y: 2_000, z: 520 } },
    { actor_id: "Build_SmelterMk1_C_9", name: "Smelter", kind: "buildable", location: { x: 1_100, y: 2_000, z: 500 } },
    { actor_id: "Build_SmelterMk1_C_10", name: "Smelter", kind: "buildable", location: { x: 1_700, y: 2_000, z: 500 } },
  ],
});

const ask = (question) => answerLocally(question, graph, { actions: { emit: () => {} } });

test("where am I is answered from the capture", () => {
  for (const question of ["where am i", "whats my position", "what is my location", "my coordinates"]) {
    const answer = ask(question);
    assert.equal(answer?.local?.solver, "where_am_i", question);
    assert.match(answer.reply, /x=1000, y=2000, z=500/);
  }
});

test("what am I looking at names the crosshair target", () => {
  for (const question of ["what am i looking at", "what is under my crosshair", "whats this"]) {
    const answer = ask(question);
    assert.equal(answer?.local?.solver, "looking_at", question);
    assert.match(answer.reply, /Coal node/);
  }

  // An ordinary node type adds nothing next to the name, so it is left out --
  // "Coal node — a Node" is noise.
  const reply = ask("what am i looking at").reply;
  assert.ok(!/a Node/.test(reply), reply);
  assert.match(reply, /normal purity/);
  assert.match(reply, /free for a miner/);
});

test("aiming at nothing says so rather than guessing", () => {
  const empty = buildGraph({
    world_revision: 6,
    world: { scan_center: PLAYER },
    interaction_context: { player: { pawn_available: true, pawn_location: PLAYER } },
    actors: [],
  });
  const answer = answerLocally("what am i looking at", empty, { actions: { emit: () => {} } });
  assert.equal(answer.local.solver, "looking_at");
  assert.match(answer.reply, /Nothing the capture could identify/);
});

test("a count is the whole count, not the page of it that came back", () => {
  const answer = ask("how many smelters do i have");
  assert.equal(answer.local.solver, "how_many");
  // Two smelters. The lookup returns one match because it is limited; the
  // count must not come from that list.
  assert.match(answer.reply, /\*\*2\*\*/);
  assert.match(answer.reply, /nearest 1 m away/);

  assert.match(ask("count my smelters").reply, /\*\*2\*\*/);

  // Nothing found is an answer, and it says why the capture might be wrong
  // rather than asserting the player owns none.
  const none = ask("how many constructors");
  assert.equal(none.local.solver, "how_many");
  assert.match(none.reply, /Nothing matching/);
  assert.match(none.reply, /scans a radius/);
});

test("how far is Pythagoras on two points the capture already holds", () => {
  const far = buildGraph({
    world_revision: 8,
    world: { scan_center: PLAYER },
    interaction_context: { player: { pawn_available: true, pawn_location: PLAYER } },
    actors: [
      { actor_id: "BP_ResourceNode217", name: "Coal node", kind: "resource_node", location: { x: 9_000, y: 2_000, z: 500 } },
    ],
  });
  const askFar = (question) => answerLocally(question, far, { actions: { emit: () => {} } });

  for (const question of [
    "how far is the coal node",
    "how far away is the coal node",
    "distance to the coal node",
    "how far to the coal node",
  ]) {
    const answer = askFar(question);
    assert.equal(answer?.local?.solver, "how_far", question);
    // 8 000 cm along x.
    assert.match(answer.reply, /\*\*80 m\*\*/);
  }

  // Nothing found gets no distance invented for it.
  const missing = askFar("how far is atlantis");
  assert.equal(missing.local.solver, "how_far");
  assert.match(missing.reply, /Nothing matching/);
  assert.ok(!/\d+ m\b/.test(missing.reply.split("\n")[0]));
});

test("the tier question is answered whichever way it is phrased", () => {
  // "what tier am i" was local and "whats my tier" was not, which is the sort
  // of gap only trying the phrasings finds.
  for (const question of ["what tier am i", "whats my tier", "my tier", "what milestone", "which tier"]) {
    assert.equal(ask(question)?.local?.solver, "get_unlock_status", question);
  }
});

test("questions that only look like counts are left to a model", () => {
  // These need rates, power figures or judgement. Answering them with an actor
  // count would be confidently wrong.
  for (const question of [
    "how many items per minute",
    "how many mw am i producing",
    "how much power do i have",
  ]) {
    assert.equal(parseHowManyRequest(question), null, question);
  }

  // And the other two parsers do not claim neighbouring phrasings.
  assert.equal(parseWhereAmIRequest("where is the coal node"), null);
  assert.equal(parseLookingAtRequest("what is a smelter"), null);
});
