/**
 * Remembering a piece of the world by name.
 *
 * The owner's ask: select what is standing, call it "mk1 copper node
 * blueprint", and later place it somewhere else by that name. This is not a
 * `.sbp` — see designs.mjs — it is a list of placements replayed through the
 * path that already works.
 *
 * The tests that matter are the ones about fidelity: a design that loses a
 * recipe or a facing rebuilds something else.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { captureDesign, planDesignPlacement } from "../lib/designs.mjs";

const building = (id, className, x, y, yaw, productionRecipe = null) => ({
  actor_id: id,
  name: id,
  class_path: `/Game/${className}.${className}`,
  kind: "buildable",
  owner_mod: "FactoryGame",
  location: { x, y, z: 100 },
  rotation: { pitch: 0, yaw, roll: 0 },
  built_with_recipe: `/Game/Recipes/Recipe_${className}.Recipe_${className}_C`,
  ...(productionRecipe
    ? { manufacturer: { recipe_class: `/Game/Recipes/${productionRecipe}.${productionRecipe}_C`, recipe_name: productionRecipe } }
    : {}),
});

const ANCHOR = { x: 1_000, y: 2_000, z: 100 };
const ACTORS = [
  building("a", "Build_SmelterMk1", 1_000, 2_000, 90, "Recipe_IngotCopper"),
  building("b", "Build_SmelterMk1", 2_100, 2_000, 90, "Recipe_IngotCopper"),
  building("c", "Build_ConstructorMk1", 3_200, 2_000, 90, "Recipe_Wire"),
  building("d", "Build_Foundation_8x1_01", 1_000, 1_000, 0),
];

const graphWith = (actors) =>
  buildGraph({
    world_revision: 7,
    world: { scan_center: ANCHOR },
    interaction_context: { player: { pawn_available: true, pawn_location: ANCHOR } },
    actors,
    content: { items: [], recipes: [] },
  });

const capture = (options = {}) =>
  captureDesign(graphWith(options.actors ?? ACTORS), { name: "test design", origin: ANCHOR, ...options });

test("a saved design keeps each building's recipe and facing", () => {
  const result = capture();
  assert.equal(result.saved, true);
  assert.equal(result.design.building_count, 4);

  const smelter = result.design.buildings.find((entry) => /SmelterMk1/.test(entry.class_path));
  assert.equal(smelter.yaw, 90);
  assert.match(smelter.production_recipe_class, /Recipe_IngotCopper/);
});

test("offsets are relative, so the design can be replayed anywhere", () => {
  const design = capture().design;
  const far = planDesignPlacement(design, { origin: { x: 50_000, y: 60_000, z: 500 } });
  assert.equal(far.planned, true);

  // The gap between the two smelters survives the move unchanged.
  const smelters = far.actions.filter((action) => /SmelterMk1/.test(action.recipe_class));
  assert.equal(Math.abs(smelters[1].location.x - smelters[0].location.x), 1_100);
  // And nothing is left at the original coordinates.
  assert.ok(far.actions.every((action) => action.location.x >= 50_000));
});

test("structural pieces are placed before what stands on them", () => {
  const actions = planDesignPlacement(capture().design, { origin: ANCHOR }).actions;
  const firstFoundation = actions.findIndex((action) => /Foundation/.test(action.recipe_class));
  const firstMachine = actions.findIndex((action) => /Smelter|Constructor/.test(action.recipe_class));
  assert.ok(firstFoundation >= 0);
  assert.ok(firstFoundation < firstMachine, "a foundation must go down before the machine on it");
});

test("a building the capture cannot describe is skipped, not approximated", () => {
  // No build recipe means replaying it would place some other building.
  const { built_with_recipe: _dropped, ...unknown } = ACTORS[0];
  const result = capture({ actors: [...ACTORS.slice(1), unknown] });
  assert.equal(result.saved, true);
  assert.equal(result.design.building_count, 3);
  assert.equal(result.skipped.length, 1);
});

test("the radius decides what is included", () => {
  // The constructor is 2.2 km... no, 22 m out; a 10 m radius must exclude it.
  const tight = capture({ radius_cm: 1_000 });
  assert.ok(tight.design.building_count < 4);
  const wide = capture({ radius_cm: 12_000 });
  assert.equal(wide.design.building_count, 4);
});

test("an empty area and a nameless design are both refused", () => {
  // Anchored far from anything, rather than a tiny radius: the building at the
  // anchor is zero away from it and no radius excludes that.
  const empty = captureDesign(graphWith(ACTORS), {
    name: "nothing here",
    origin: { x: 900_000, y: 900_000, z: 0 },
  });
  assert.equal(empty.saved, false);
  assert.match(empty.reason, /nothing is standing/i);

  assert.match(capture({ name: "" }).reason ?? "", /needs a name/i);
  assert.match(capture({ name: "!!!" }).reason ?? "", /no letters or digits/i);
});

test("a design written to disk reads back identically", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-designs-"));
  try {
    const design = capture().design;
    const file = path.join(directory, "test.json");
    fs.writeFileSync(file, JSON.stringify(design));
    const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      planDesignPlacement(reloaded, { origin: ANCHOR }).actions,
      planDesignPlacement(design, { origin: ANCHOR }).actions,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
