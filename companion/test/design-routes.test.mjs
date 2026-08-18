/**
 * The design routes end to end, which nothing covered before.
 *
 * Save, list and place had tests for their *parsers* and for the planning
 * functions underneath, and nothing at all for the route bodies in between --
 * the part that assembles the reply, picks the anchor out of the snapshot,
 * decides what to say about what it left out, and hands actions to the emitter.
 * Every one of those was changed while adding links, rotation and overclock,
 * and a mistake in any of them would only have shown up in a loaded save.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { answerLocally } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

// A directory of its own, so the owner's real designs are never read or written
// by a test run.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-routes-"));
process.env.AIFACTORY_DESIGN_DIR = directory;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

const ANCHOR = { x: 1_000, y: 2_000, z: 500 };

const actor = (id, className, x, y, extra = {}) => ({
  actor_id: id,
  name: id,
  class_path: `/Game/${className}.${className}`,
  kind: "buildable",
  owner_mod: "FactoryGame",
  location: { x, y, z: ANCHOR.z },
  rotation: { pitch: 0, yaw: 0, roll: 0 },
  built_with_recipe: `/Game/Recipes/Recipe_${className}.Recipe_${className}_C`,
  ...extra,
});

const ACTORS = [
  actor("miner", "Build_MinerMk1", 1_000, 2_000),
  actor("smelter", "Build_SmelterMk1", 2_000, 2_000, {
    manufacturer: { recipe_class: "/G/Recipe_IngotCopper.Recipe_IngotCopper_C" },
    factory: { current_potential: 1.5 },
  }),
  actor("floor", "Build_Foundation_8x4_01", 1_000, 1_000),
  actor("belt", "Build_ConveyorBeltMk1", 1_500, 2_000),
  actor("wire", "Build_PowerLine", 1_200, 2_000),
];

const graph = buildGraph({
  world_revision: 91,
  world: { scan_center: ANCHOR },
  interaction_context: {
    player: { pawn_available: true, pawn_location: ANCHOR },
    preferred_target: { hit_location: ANCHOR },
    dismantle_selection: { actor_ids: ACTORS.map((entry) => entry.actor_id) },
  },
  actors: ACTORS,
  content: { items: [], recipes: [] },
});

const ask = (question, emitted = []) => ({
  answer: answerLocally(question, graph, { actions: { emit: (actions) => emitted.push(...actions) } }),
  emitted,
});

test("saving reports each cause separately and owns up to the overclock", () => {
  const { answer } = ask("save this as bench mk1");
  assert.equal(answer.local.solver, "design_save");

  // Three of the five are placements; the belt and the wire are links.
  assert.match(answer.reply, /3 buildings/);
  assert.match(answer.reply, /the ones you marked with the dismantle tool/);

  // Two different reasons, counted apart rather than lumped under one sentence.
  assert.match(answer.reply, /1 left out:.*two connections/);
  assert.match(answer.reply, /1 left out:.*wire between two power connections/);

  // And the Power Shard, said at save time rather than discovered later.
  assert.match(answer.reply, /1 of them are overclocked/);
  assert.match(answer.reply, /rebuild at 100%/);

  const written = JSON.parse(fs.readFileSync(path.join(directory, "bench-mk1.json"), "utf8"));
  assert.equal(written.building_count, 3);
  assert.equal(written.links.length, 2);
  assert.equal(written.buildings.find((entry) => /Smelter/.test(entry.class_path)).potential, 1.5);
});

test("the list quotes what will be placed, not what was saved", () => {
  const { answer } = ask("list designs");
  assert.equal(answer.local.solver, "design_library");
  assert.match(answer.reply, /bench mk1\*\* — 3 buildings \(2 belt\/wire link\(s\) not replayed\)/);
  assert.match(answer.reply, /rotated 90/);
});

test("placing emits the three placements, each meaning its own height", () => {
  const { answer, emitted } = ask("place bench mk1 here");
  assert.equal(answer.local.solver, "design_place");
  assert.equal(emitted.length, 3);

  // The whole point of the Z fix: a saved arrangement means its heights.
  assert.ok(emitted.every((action) => action.exact_z === true));
  assert.ok(emitted.every((action) => action.expect_world_revision === "91"));

  // Structure first, and no link ever reaches the game.
  assert.match(emitted[0].recipe_class, /Foundation/);
  assert.ok(emitted.every((action) => !/ConveyorBelt|PowerLine/.test(action.recipe_class)));

  // The reply says what it is not building, and why.
  assert.match(answer.reply, /2 belt\(s\), lift\(s\) or power line\(s\)/);
  assert.match(answer.reply, /1 of them were overclocked/);
});

test("a turn reaches the emitted actions, and keeps the design rigid", () => {
  const straight = ask("place bench mk1 here").emitted;
  const turned = ask("place bench mk1 here rotated 90").emitted;

  const gap = (actions) => {
    const from = actions.find((action) => /Miner/.test(action.recipe_class)).location;
    const to = actions.find((action) => /Smelter/.test(action.recipe_class)).location;
    return Math.round(Math.hypot(to.x - from.x, to.y - from.y));
  };

  assert.equal(gap(turned), gap(straight), "a turn must not change any distance");
  assert.notDeepEqual(
    turned.map((action) => action.location),
    straight.map((action) => action.location),
    "a turn must actually move things",
  );
  assert.ok(turned.every((action) => action.yaw === 90));
});

test("a name that matches nothing saved falls through rather than guessing", () => {
  const { answer, emitted } = ask("place something nobody saved here");
  assert.equal(emitted.length, 0);
  // Either another planner claims it or it reaches a model; what must not
  // happen is this route building the wrong design because the name was close.
  assert.notEqual(answer?.local?.solver, "design_place");
});
