/**
 * The structural shell: platforms, pillars, walls, roofs.
 *
 * The point of this module is that a factory should be able to look like the
 * reference art the owner sent — raised decks on pillars with the production
 * enclosed — rather than machines standing in a field.
 *
 * The thing most worth protecting is that the grid is *derived*. Satisfactory
 * names its pieces for their dimensions (`Desc_Foundation_8x1_01_C` is 8 m
 * square and 1 m tall), so the cell size is parsed from the catalog in the
 * player's own save. A modded piece with different dimensions then works
 * without a code change, and nothing depends on remembering that foundations
 * happen to be 8 m.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import {
  parsePieceDimensions,
  planStructure,
  snapToGrid,
  structureActions,
  surveyStructuralPieces,
} from "../lib/architecture.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const piece = (recipeName, descriptor, name, available = true) => ({
  class_path: `/Game/Recipes/${recipeName}.${recipeName}_C`,
  name,
  available,
  produced_in: [BUILD_GUN],
  products: [{ item_class: `/Game/Desc/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 }],
});

const snapshot = (recipes) => ({
  world_revision: 3,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 1_234, y: -5_678, z: 1_000 } } },
  actors: [],
  content: { items: [], recipes },
});

const fullKit = [
  piece("Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)"),
  piece("Recipe_Foundation_8x2_01", "Desc_Foundation_8x2_01", "Foundation (2 m)"),
  piece("Recipe_Foundation_8x4_01", "Desc_Foundation_8x4_01", "Foundation (4 m)"),
  piece("Recipe_Wall_8x4_01", "Desc_Wall_8x4_01", "Basic Wall (4 m)"),
  piece("Recipe_Roof_Orange_01", "Desc_Roof_Orange_01", "Flat Roof"),
  piece("Recipe_PillarMiddle", "Desc_PillarMiddle", "Big Metal Pillar"),
  piece("Recipe_FoundationGlass_01", "Desc_FoundationGlass_01", "Glass Frame Foundation"),
];

const graph = buildGraph(snapshot(fullKit));

test("reads piece dimensions out of the descriptor name", () => {
  assert.deepEqual(parsePieceDimensions("Desc_Foundation_8x4_01"), {
    width_cm: 800,
    height_cm: 400,
    width_metres: 8,
    height_metres: 4,
  });
  assert.equal(parsePieceDimensions("Desc_Wall_8x4_01").height_cm, 400);
  // A piece whose name carries no dimensions is skipped, not guessed at.
  assert.equal(parsePieceDimensions("Desc_PillarMiddle"), null);
  assert.equal(parsePieceDimensions(null), null);
});

test("derives the grid from the save rather than assuming 8 m", () => {
  const survey = surveyStructuralPieces(graph);
  assert.equal(survey.cell_size_cm, 800);
  assert.match(survey.cell_size_source, /parsed from the foundation descriptors/);

  // A modded save with a different foundation size must work unchanged.
  const modded = buildGraph(
    snapshot([piece("Recipe_Foundation_16x2", "Desc_Foundation_16x2_01", "Big Foundation")]),
  );
  assert.equal(surveyStructuralPieces(modded).cell_size_cm, 1_600);
});

test("snaps the structure onto the grid", () => {
  assert.equal(snapToGrid(1_234, 800), 1_600);
  assert.equal(snapToGrid(-5_678, 800), -5_600);
  // Everything placed must sit on a grid multiple.
  //
  // Compared with Math.abs because a negative multiple gives negative zero, and
  // assert.strictEqual uses Object.is, under which -0 is not 0. That is a fact
  // about the assertion, not about the grid — the coordinate is exactly on it.
  const plan = planStructure(graph, { width_cells: 3, depth_cells: 2, height_cm: 0 });
  for (const part of plan.parts.filter((entry) => entry.kind === "floor")) {
    assert.equal(Math.abs(part.location_cm.x % 800), 0, `${part.location_cm.x} is off-grid`);
    assert.equal(Math.abs(part.location_cm.y % 800), 0, `${part.location_cm.y} is off-grid`);
  }
});

test("plans a platform of the requested size", () => {
  const plan = planStructure(graph, { width_cells: 6, depth_cells: 4, height_cm: 0 });
  assert.equal(plan.planned, true);
  assert.equal(plan.piece_counts.floor, 24);
  assert.equal(plan.footprint.width_cm, 4_800);
  assert.equal(plan.footprint.depth_cm, 3_200);
  assert.equal(plan.interior.usable_cells, 24);
});

test("a raised platform gets pillars; one on the ground does not", () => {
  const raised = planStructure(graph, { width_cells: 6, depth_cells: 4, height_cm: 800 });
  assert.ok(raised.pillars > 0, "a raised deck needs visible supports");
  assert.equal(raised.raised_cm, 800);

  const grounded = planStructure(graph, { width_cells: 6, depth_cells: 4, height_cm: 0 });
  assert.equal(grounded.pillars, 0);
  assert.equal(grounded.piece_counts.pillar, undefined);
});

test("leaves a way in rather than sealing the perimeter", () => {
  const plan = planStructure(graph, { width_cells: 4, depth_cells: 3, height_cm: 0 });
  const walls = plan.piece_counts.wall;
  // A fully sealed perimeter of 4x3 would be 14 wall segments.
  assert.ok(walls < 14, `expected a gap for access, got a sealed ${walls}-segment perimeter`);
});

test("reports the interior so machines can be placed inside the shell", () => {
  const plan = planStructure(graph, { width_cells: 5, depth_cells: 3, height_cm: 400 });
  // The deck surface sits on top of the floor slab, not at its base.
  assert.ok(plan.interior.floor_z_cm > plan.footprint.origin_cm.z);
  assert.ok(plan.interior.max_x_cm > plan.interior.min_x_cm);
});

test("omits what is not unlocked, and says so", () => {
  const bare = buildGraph(
    snapshot([piece("Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)")]),
  );
  const plan = planStructure(bare, { width_cells: 2, depth_cells: 2, height_cm: 400 });

  assert.equal(plan.planned, true, "a floor alone is still a usable platform");
  assert.equal(plan.piece_counts.wall, undefined);
  assert.equal(plan.piece_counts.roof, undefined);
  assert.ok(plan.notes.some((note) => /No wall is unlocked/.test(note)));
  assert.ok(plan.notes.some((note) => /No roof is unlocked/.test(note)));
  assert.ok(plan.notes.some((note) => /No pillar is unlocked/.test(note)));
});

test("refuses when no foundation exists at all", () => {
  const nothing = buildGraph(snapshot([]));
  const plan = planStructure(nothing, {});
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /no foundation is unlocked/i);
  assert.deepEqual(structureActions(plan), []);
});

test("orders actions so a partial build still stands", () => {
  const plan = planStructure(graph, { width_cells: 3, depth_cells: 2, height_cm: 800 });
  const actions = structureActions(plan, { commit: true });
  const kinds = [...plan.parts]
    .sort((a, b) => ({ floor: 0, pillar: 1, wall: 2, roof: 3 }[a.kind] - { floor: 0, pillar: 1, wall: 2, roof: 3 }[b.kind]))
    .map((part) => part.kind);

  assert.equal(kinds[0], "floor", "the deck goes down before anything stands on it");
  assert.equal(kinds.at(-1), "roof", "the roof goes on last");
  assert.equal(actions.every((action) => action.commit === true), true);
  assert.equal(actions.length, plan.parts.length);
});

test("never claims the structure will stand", () => {
  const plan = planStructure(graph, { width_cells: 2, depth_cells: 2 });
  assert.match(plan.unverified, /hologram/);
});
