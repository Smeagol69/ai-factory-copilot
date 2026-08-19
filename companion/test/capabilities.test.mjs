/**
 * The capability list has to be true.
 *
 * "what can you do" and "help" are the first things anyone asks, and both were
 * reaching a model — which has to guess at its own capabilities and gets it
 * wrong in the expensive direction. That is not hypothetical: the owner's
 * waypoint complaint was a transcript of this copilot flatly denying it could
 * place waypoints, while the action to do it had been shipped for weeks.
 *
 * A fixed list fixes that only if the list is kept honest. So every example
 * phrase in it is run back through the router here. A phrase nobody can act on
 * fails the suite rather than disappointing a player, which is the same
 * contract the library page's buttons and the README's phrases are held to.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as router from "../lib/router.mjs";
import { CAPABILITY_EXAMPLES, answerLocally, parseCapabilityRequest } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const parsers = Object.entries(router).filter(
  ([name, value]) => /^parse/.test(name) && typeof value === "function",
);

/** Does anything at all in the router claim this phrase? */
function understood(phrase) {
  for (const [name, parse] of parsers) {
    if (name === "parseCapabilityRequest") continue;
    let result;
    try {
      result = parse(phrase);
    } catch {
      continue;
    }
    if (result !== null && result !== false && result !== undefined) return name;
  }
  return router.routeQuestion(phrase) ? `route:${router.routeQuestion(phrase).name}` : null;
}

test("every phrase the copilot advertises is one it can act on", () => {
  const broken = [];
  for (const [heading, examples] of CAPABILITY_EXAMPLES) {
    for (const example of examples) {
      if (!understood(example)) broken.push(`${heading}: "${example}"`);
    }
  }
  assert.deepEqual(broken, [], `advertised but unhandled:\n${broken.join("\n")}`);
});

test("the check would notice a phrase that stopped working", () => {
  // Guarding the guard. An advertised phrase nobody handles must come back
  // unrecognised, or the test above proves nothing.
  assert.equal(understood("make me a cup of tea please"), null);
  assert.ok(understood("undo"));
});

test("the list covers every group and asking for it costs nothing", () => {
  const graph = buildGraph({
    world_revision: 1,
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
    actors: [],
  });

  const emitted = [];
  for (const question of ["help", "what can you do", "what can i ask", "what commands"]) {
    const answer = answerLocally(question, graph, {
      actions: { emit: (actions) => emitted.push(...actions) },
    });
    assert.equal(answer?.local?.solver, "capabilities", question);
    // Reading a list is not a reason to touch the world.
    assert.equal(emitted.length, 0);
  }

  const reply = answerLocally("help", graph, { actions: { emit: () => {} } }).reply;
  for (const [heading] of CAPABILITY_EXAMPLES) assert.ok(reply.includes(heading), heading);
  assert.match(reply, /reversible/);

  // Neighbouring questions are not swallowed: "help me build a smelter" is a
  // build request, not a request for the menu.
  assert.equal(parseCapabilityRequest("help me build a smelter"), null);
  assert.equal(parseCapabilityRequest("what can you do about my power"), null);
});
