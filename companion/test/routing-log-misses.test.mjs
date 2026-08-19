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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  answerLocally,
  parseDesignPlaceRequest,
  parseTeleportRequest,
} from "../lib/router.mjs";
import { findDesign } from "../lib/designs.mjs";
import { buildGraph } from "../lib/graph.mjs";


/**
 * The near-miss suggestion, exercised against a temporary library rather than
 * the owner's real one.
 */
function nearestSavedName(typed, designs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-near-"));
  const previous = process.env.AIFACTORY_DESIGN_DIR;
  process.env.AIFACTORY_DESIGN_DIR = directory;
  try {
    for (const design of designs) {
      const slug = design.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      fs.writeFileSync(
        path.join(directory, `${slug}.json`),
        JSON.stringify({ schema: "aifactory.design/v1", name: design.name, buildings: [] }),
      );
    }
    return findDesign(typed).near ?? [];
  } finally {
    process.env.AIFACTORY_DESIGN_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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

test("place waypoint and name it concrete", () => {
  // Answered by a model because the multi-clause guard sees the "and" and
  // steps aside. It is not two requests -- it is one waypoint with a label,
  // and the map marker has carried a name field the whole time. Six markers
  // all called "Copilot waypoint" are no better than none.
  const { answer, emitted } = ask("place waypoint and name it concrete");
  assert.equal(answer.local.solver, "waypoint");
  assert.equal(emitted[0].name, "concrete");

  assert.equal(ask("waypoint here call it coal spot").emitted[0].name, "coal spot");
  // Unnamed still gets the default.
  assert.match(ask("waypoint here").emitted[0].name, /Copilot waypoint/);
});

test("place mk1 copper here on this node", () => {
  // Both location words survived into the name, so the route looked for a
  // design called "mk1 copper here" and found nothing. People do say it twice;
  // the name is what is left after both are taken off.
  assert.equal(parseDesignPlaceRequest("place mk1 copper here on this node").name, "mk1 copper");
  assert.equal(parseDesignPlaceRequest("place mega base here").name, "mega base");
  // A name that genuinely ends in a location word is not eaten to nothing.
  assert.equal(parseDesignPlaceRequest("place bus here").name, "bus");
});

test("place emga base here", () => {
  // One transposition from "mega base", and it fell through to a model that
  // cannot know what is saved on disk. The near name is offered, never chosen:
  // placing a 389-building design because two letters were swapped is exactly
  // the guess this project does not make.
  const saved = [{ name: "mega base" }, { name: "mk1 copper" }];
  const suggestion = nearestSavedName("emga base", saved);
  assert.deepEqual(suggestion, ["mega base"]);
  assert.deepEqual(nearestSavedName("atlantis", saved), []);
});

test("a named target is still a lookup, not a coordinate", () => {
  // The coordinate parser must not swallow the ordinary case.
  assert.notEqual(parseTeleportRequest("teleport me to the coal node")?.kind, "coordinates");
  assert.equal(parseTeleportRequest("teleport me to BP_ResourceNode217").actor_id, "BP_ResourceNode217");
});
