import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { FOUNDATION_CM, designFactoryLayout, detectBaseGrid, measureBuilding } from "../lib/designer.mjs";
import { CONSTRUCTOR, SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

/**
 * The fixture's machines carry bounds and rotations so the designer has real
 * geometry to measure, the same way it would off a live save.
 */
function graphWithGeometry({ yaw = 0, spread = false } = {}) {
  const snapshot = buildFactorySnapshot();
  let index = 0;
  for (const actor of snapshot.actors) {
    if (actor.kind !== "buildable") continue;
    const isSmelter = actor.actor_id === SMELTER;
    // Constructors are 8x6 m, smelters 6x9 m, matching the real game closely
    // enough that the layout arithmetic is checkable by hand.
    actor.bounds = {
      origin: { ...actor.location },
      extent: isSmelter ? { x: 300, y: 450, z: 400 } : { x: 400, y: 300, z: 400 },
    };
    // A base that agrees on its alignment, unless the test wants disagreement.
    actor.rotation = { pitch: 0, yaw: spread ? index * 30 : yaw, roll: 0 };
    index += 1;
  }
  return buildGraph(snapshot);
}

/** Stop production so the plan is not offset by existing surplus. */
function graphForPlanning(options) {
  const graph = graphWithGeometry(options);
  for (const node of graph.nodes.values()) {
    if (node.raw?.factory) node.raw.factory.production_cycle_seconds = 0;
    delete node.raw?.extractor;
  }
  return buildGraph(graph.snapshot);
}

/* ---------------- measuring the player's own buildings ---------------- */

test("measures a machine's footprint from the player's own copies", () => {
  const graph = graphWithGeometry();
  const constructor = graph.nodes.get(CONSTRUCTOR);
  const measured = measureBuilding(graph, [constructor.class_path]);

  // Extent is a half-size, so 400 becomes 800 cm across.
  assert.equal(measured.width_cm, 800);
  assert.equal(measured.depth_cm, 600);
  assert.match(measured.source, /measured_from_your_own_buildings/);
});

test("reads the build recipe off a real machine, not the production recipe", () => {
  const graph = graphWithGeometry();
  const constructor = graph.nodes.get(CONSTRUCTOR);
  const measured = measureBuilding(graph, [constructor.class_path]);

  // Placing a constructor needs the recipe that builds one, which is a
  // different thing from Recipe_IronRod that it happens to be running.
  assert.equal(measured.build_recipe_class, constructor.built_with_recipe);
  assert.notEqual(measured.build_recipe_class, constructor.recipe_class);
});

test("a building the player does not own cannot be measured", () => {
  const graph = graphWithGeometry();
  assert.equal(measureBuilding(graph, ["Build_Blender_C"]), null);
});

/* ---------------- reading the base's grid ---------------- */

test("detects the alignment the base is already built on", () => {
  const grid = detectBaseGrid(graphWithGeometry({ yaw: 45 }));
  assert.equal(grid.detected, true);
  assert.equal(grid.yaw_degrees, 45);
  assert.equal(grid.yaw_agreement_percent, 100);
});

test("reports a mixed base as a best guess rather than a fact", () => {
  const grid = detectBaseGrid(graphWithGeometry({ spread: true }));
  assert.equal(grid.certainty, "mixed_alignment_best_guess");
  assert.ok(grid.yaw_agreement_percent < 50);
});

test("an empty world has no grid to match and says so", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.actors = [];
  const grid = detectBaseGrid(buildGraph(snapshot));
  assert.equal(grid.detected, false);
  assert.equal(grid.reason, "no_buildings_captured");
});

/* ---------------- layout ---------------- */

const ORIGIN = { x: 100_000, y: 100_000, z: 500 };

test("requires a real origin instead of inventing one", () => {
  const layout = designFactoryLayout(graphWithGeometry(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
  });
  assert.equal(layout.designed, false);
  assert.equal(layout.reason, "origin_requires_an_explicit_x_y_and_z");
  assert.match(layout.how_to_get_one, /find_best_site/);
});

test("produces one placement per machine the plan calls for", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });

  assert.equal(layout.designed, true);
  // 4 constructors + 2 smelters, from the production plan.
  assert.equal(layout.placements.length, 6);
  assert.equal(layout.layout.rows.length, 2);
  assert.equal(layout.layout.rows[0].machines, 4);
  assert.equal(layout.layout.rows[1].machines, 2);
});

test("every emitted action places a machine by its build recipe", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });

  const productionRecipes = new Set(
    layout.production_plan.steps.map((step) => step.recipe_class),
  );

  assert.equal(layout.actions.length, layout.placements.length);
  for (const action of layout.actions) {
    assert.equal(action.action, "place_building");
    assert.ok(action.recipe_class, "a placement without a build recipe cannot be executed");
    // The distinction that matters: this is the recipe that *builds the
    // machine* (Recipe_ConstructorMk1), never the one the machine *runs*
    // (Recipe_IronRod). Placing with the latter would fail in-world.
    assert.ok(
      !productionRecipes.has(action.recipe_class),
      `${action.recipe_class} is a production recipe, not a build recipe`,
    );
    // Nothing is committed by designing; that is a separate decision.
    assert.equal(action.commit, false);
    assert.equal(Number.isFinite(action.location.z), true);
  }
});

test("rotates the layout onto the alignment the base already uses", () => {
  const straight = designFactoryLayout(graphForPlanning({ yaw: 0 }), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });
  const angled = designFactoryLayout(graphForPlanning({ yaw: 45 }), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });

  assert.equal(straight.placements[0].yaw, 0);
  assert.equal(angled.placements[0].yaw, 45);
  assert.equal(angled.aligned_to_base, true);
  // A rotated grid puts the machines somewhere genuinely different.
  assert.notEqual(straight.placements[0].location.x, angled.placements[0].location.x);
});

test("align_to_base false uses world axes instead", () => {
  const layout = designFactoryLayout(graphForPlanning({ yaw: 45 }), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
    align_to_base: false,
  });
  assert.equal(layout.placements[0].yaw, 0);
  assert.equal(layout.aligned_to_base, false);
});

test("machines in a row do not overlap each other", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });

  const firstRow = layout.placements.filter((entry) => entry.step_index === 1);
  for (let index = 1; index < firstRow.length; index += 1) {
    const gap = Math.abs(firstRow[index].location.x - firstRow[index - 1].location.x);
    assert.ok(
      gap >= firstRow[index].footprint_cm.width,
      `machines ${index} and ${index + 1} are ${gap} cm apart but ${firstRow[index].footprint_cm.width} cm wide`,
    );
  }
});

test("refuses ground that is already occupied instead of building through it", () => {
  const graph = graphForPlanning();
  // Drop the layout straight on top of an existing machine.
  const occupied = graph.nodes.get(CONSTRUCTOR).raw.location;
  const layout = designFactoryLayout(graph, {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: { x: occupied.x, y: occupied.y, z: occupied.z },
  });

  assert.ok(layout.blocked.length > 0, "the existing constructor should block at least one slot");
  assert.ok(layout.blocked[0].blocked_by, "a blocked slot names what is in the way");
  // Blocked slots are reported, never emitted as actions.
  assert.equal(layout.actions.length, layout.placements.length);
  assert.ok(!layout.actions.some((action) =>
    layout.blocked.some((entry) =>
      entry.location.x === action.location.x && entry.location.y === action.location.y)));
});

test("a machine the player has never built is reported, not guessed", () => {
  const graph = graphForPlanning();
  // Remove every smelter so the ingot step has nothing to measure.
  const snapshot = graph.snapshot;
  snapshot.actors = snapshot.actors.filter((actor) => actor.actor_id !== SMELTER);

  const layout = designFactoryLayout(buildGraph(snapshot), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });

  const missing = layout.unplaceable.find((entry) => entry.step === "Iron Ingot");
  assert.ok(missing, "the smelter step should be reported as unplaceable");
  assert.equal(missing.reason, "you_own_no_building_of_this_type_to_measure");
  assert.match(missing.fix, /Place one of these by hand/);
});

test("reports its footprint in metres and foundations", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });
  assert.ok(layout.layout.footprint_m.width > 0);
  assert.ok(layout.layout.footprint_m.depth > 0);
  assert.ok(layout.layout.foundations_required > 0);
  assert.equal(layout.layout.aisle_cm, FOUNDATION_CM);
});

test("states that it places machines only, not belts", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    use_existing_surplus: false,
    origin: ORIGIN,
  });
  assert.match(layout.caveats.belts, /Belts, pipes, and power poles are not placed/);
  assert.match(layout.caveats.validity, /game's own construction check is the final word/);
});

test("refuses an implausibly large layout rather than emitting hundreds of actions", () => {
  const layout = designFactoryLayout(graphForPlanning(), {
    item_name: "Iron Rod",
    target_rate_per_minute: 100_000,
    use_existing_surplus: false,
    origin: ORIGIN,
  });
  assert.equal(layout.designed, false);
  assert.equal(layout.reason, "layout_too_large");
  assert.match(layout.suggestion, /lower rate/);
});
