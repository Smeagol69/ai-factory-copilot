/**
 * The layer where a model designs and the planner keeps it honest.
 *
 * Everything else here follows "the model never produces a number a solver
 * could". Architecture needed that rule to have a shape rather than just a
 * prohibition, because the buildings the owner wants genuinely require
 * judgement — a tower offset rather than centred, wings of unequal length.
 *
 * So the model writes named blocks in whole cells and this checks them. The
 * checks below are the ones that matter: a model will cheerfully describe two
 * blocks that occupy the same ground, both sounding entirely reasonable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { planStructure, planTower } from "../lib/architecture.mjs";
import { compositionActions, planComposition, validateComposition } from "../lib/composition.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const piece = (className, descriptor, name) => ({
  class_path: `/Game/Recipes/${className}.${className}_C`,
  name,
  available: true,
  produced_in: [BUILD_GUN],
  products: [{ item_class: `/Game/Desc/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 }],
});

const graph = buildGraph({
  world_revision: 5,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 1_000 } } },
  actors: [],
  content: {
    items: [],
    recipes: [
      piece("Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)"),
      piece("Recipe_Foundation_8x2_01", "Desc_Foundation_8x2_01", "Foundation (2 m)"),
      piece("Recipe_Wall_8x4_01", "Desc_Wall_8x4_01", "Basic Wall (4 m)"),
      piece("Recipe_Roof_Orange_01", "Desc_Roof_Orange_01", "Flat Roof"),
      piece("Recipe_PillarMiddle", "Desc_PillarMiddle", "Big Metal Pillar"),
    ],
  },
});

const plan = (composition) =>
  planComposition(graph, { composition, plan_structure: planStructure, plan_tower: planTower });

test("refuses two blocks sharing the same ground, naming both", () => {
  // The failure a model actually makes. The game would refuse the second
  // block's foundations one at a time and leave a half-built mess.
  const result = plan({
    blocks: [
      { name: "hall", grid_x: 0, grid_y: 0, width_cells: 6, depth_cells: 6 },
      { name: "annex", grid_x: 3, grid_y: 3, width_cells: 6, depth_cells: 6 },
    ],
  });

  assert.equal(result.planned, false);
  assert.ok(result.problems.some((problem) => /"hall".*"annex".*overlap/.test(problem)));
  assert.deepEqual(compositionActions(result), []);
});

test("allows an overlap at a different height — that is a cantilever", () => {
  // The reference builds all overhang. Refusing this would forbid the shape.
  const result = plan({
    blocks: [
      { name: "base", grid_x: 0, grid_y: 0, width_cells: 6, depth_cells: 6, raised_cells: 0 },
      { name: "overhang", grid_x: 3, grid_y: 3, width_cells: 6, depth_cells: 6, raised_cells: 4 },
    ],
  });
  assert.equal(result.planned, true, JSON.stringify(result.problems));
});

test("names the block and field for anything unbuildable", () => {
  // "Invalid composition" tells a model nothing it can act on.
  const result = validateComposition({
    blocks: [
      { name: "ok", grid_x: 0, grid_y: 0, width_cells: 4, depth_cells: 4 },
      { name: "bad", grid_x: 0, grid_y: 9, width_cells: 999, depth_cells: 4 },
      { name: "ok", grid_x: 0, grid_y: 20, width_cells: 4, depth_cells: 4 },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => /"bad".*width_cells/.test(problem)));
  assert.ok(result.problems.some((problem) => /duplicate name/.test(problem)));
});

test("a bridge must join two real blocks", () => {
  const result = validateComposition({
    blocks: [{ name: "tower", grid_x: 0, grid_y: 0, width_cells: 4, depth_cells: 4 }],
    bridges: [{ from: "tower", to: "wing that does not exist" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => /not a block in this composition/.test(problem)));
});

test("places blocks at their grid offsets, in cells not centimetres", () => {
  const result = plan({
    blocks: [
      { name: "west", grid_x: -9, grid_y: 0, width_cells: 4, depth_cells: 4 },
      { name: "east", grid_x: 9, grid_y: 0, width_cells: 4, depth_cells: 4 },
    ],
  });

  assert.equal(result.planned, true);
  const [west, east] = result.blocks;
  const cell = result.grid_cell_cm;
  // 18 cells apart as described, whatever the cell size turns out to be.
  assert.equal(east.footprint.origin_cm.x - west.footprint.origin_cm.x, 18 * cell);
});

test("bridges span between the blocks they name", () => {
  const result = plan({
    blocks: [
      { name: "a", grid_x: 0, grid_y: 0, width_cells: 4, depth_cells: 4, raised_cells: 2 },
      { name: "b", grid_x: 10, grid_y: 0, width_cells: 4, depth_cells: 4, raised_cells: 2 },
    ],
    bridges: [{ from: "a", to: "b", level: 1 }],
  });

  assert.equal(result.planned, true);
  assert.equal(result.bridges.length, 1);
  assert.ok(result.bridges[0].pieces > 0, "a span needs pieces in it");
  assert.ok(result.piece_counts.bridge > 0);
});

test("says when a block came out different from the design", () => {
  // A five-storey tower arriving as three reads as a bug unless the reason
  // travels with it.
  const result = plan({
    blocks: [
      { name: "spire", grid_x: 0, grid_y: 0, width_cells: 6, depth_cells: 6, levels: 5, inset_cells: 1 },
    ],
  });

  assert.equal(result.planned, true);
  assert.ok(result.blocks[0].levels < 5);
  assert.ok(
    result.notes.some((note) => /"spire" was asked for 5 storeys and fits/.test(note)),
    `expected the shortfall to be explained, got ${JSON.stringify(result.notes)}`,
  );
});

test("warns when nothing houses production", () => {
  const result = plan({ blocks: [{ name: "shell", grid_x: 0, grid_y: 0, width_cells: 4, depth_cells: 4 }] });
  assert.ok(result.notes.some((note) => /shell only/.test(note)));
});

test("builds decks and supports before the shell and bridges", () => {
  const result = plan({
    blocks: [
      { name: "a", grid_x: 0, grid_y: 0, width_cells: 3, depth_cells: 3, raised_cells: 2 },
      { name: "b", grid_x: 8, grid_y: 0, width_cells: 3, depth_cells: 3, raised_cells: 2 },
    ],
    bridges: [{ from: "a", to: "b" }],
  });
  const kinds = [...result.parts]
    .sort((a, b) => ({ floor: 0, pillar: 1, wall: 2, roof: 3, ramp: 4, bridge: 5 }[a.kind] -
      { floor: 0, pillar: 1, wall: 2, roof: 3, ramp: 4, bridge: 5 }[b.kind]))
    .map((part) => part.kind);
  assert.equal(kinds[0], "floor");
  assert.equal(kinds.at(-1), "bridge", "a walkway needs both decks to exist first");
});

test("refuses an empty composition rather than building nothing quietly", () => {
  assert.equal(validateComposition({ blocks: [] }).valid, false);
  assert.equal(validateComposition(null).valid, false);
  assert.deepEqual(compositionActions({ planned: false }), []);
});
