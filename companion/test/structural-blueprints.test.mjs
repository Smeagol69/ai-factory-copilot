import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { compileStructuralBlueprint } from "../lib/structural-blueprints.mjs";
import { runSolverTool } from "../lib/tools.mjs";

function fixture() {
  const paths = [
    "/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/",
    "/Game/FactoryGame/Buildable/Building/Wall/ConcreteWallSet/",
  ];
  const names = ["Foundation_Concrete_8x1", "Wall_Concrete_8x4"];
  const asset = (i, prefix) => `${paths[i]}${prefix}_${names[i]}.${prefix}_${names[i]}_C`;
  return { world_revision: 77, actors: names.map((name, i) => ({ actor_id: `piece-${i}`,
    class_path: asset(i, "Build"), location: { x: 1000, y: 2000, z: 3000 },
    rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 },
    bounds: { origin: { x: 1000, y: 2000, z: i ? 3200 : 3000 },
      extent: i ? { x: 25, y: 400, z: 200 } : { x: 400, y: 400, z: 50 } },
  })), content: { availability_known: true,
    items: names.map((name, i) => ({ class_path: asset(i, "Desc"), name,
      building: { class_path: asset(i, "Build") } })),
    recipes: names.map((name, i) => ({ class_path: asset(i, "Recipe"), name, available: true,
      products: [{ item_class: asset(i, "Desc"), amount: 1 }], ingredients: [],
      produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"] })),
  } };
}
const args = { blueprint_name: "Test tunnel" };

test("tunnel Blueprint derives floor-centre and wall-base pivots and preserves both open ends", () => {
  const result = compileStructuralBlueprint(buildGraph(fixture()), args);
  assert.equal(result.compiled, true, JSON.stringify(result));
  assert.equal(result.part_count, 8); // 2 floors + 2 ceilings + 2 sides * 2 courses
  const parts = result.buildables;
  assert.deepEqual(parts.filter(p => p.role === "floor").map(p => p.relative_location),
    [{ x: 400, y: 400, z: 50 }, { x: 1200, y: 400, z: 50 }]);
  assert.ok(parts.filter(p => p.role === "roof").every(p => p.relative_location.z === 950));
  const walls = parts.filter(p => p.role === "wall");
  assert.deepEqual(walls.map(p => p.relative_location.z), [100, 100, 500, 500]);
  assert.deepEqual(walls.map(p => p.yaw), [0, 180, 0, 180]);
  assert.ok(walls.every(p => p.relative_location.y === 400));
  assert.equal(result.action.action, "generate_native_blueprint");
  assert.equal(result.action.commit, false);
  assert.equal(result.action.expect_world_revision, "77");
});

test("open-front enclosure adds an oriented back wall for every column and course", () => {
  const result = compileStructuralBlueprint(buildGraph(fixture()), { ...args, depth_cells: 3, open_ends: "front" });
  assert.equal(result.compiled, true, JSON.stringify(result));
  assert.equal(result.part_count, 28); // 12 slabs + 12 side walls + 4 back walls
  const back = result.buildables.filter(p => p.role === "wall" && p.relative_location.y === 2400);
  assert.equal(back.length, 4);
  assert.ok(back.every(p => p.yaw === 90));
  assert.ok(result.buildables.filter(p => p.role === "wall").every(p => p.relative_location.y !== 0));
});

test("measurements invert rotated bounds and adapt to a wall whose long axis is X", () => {
  const snapshot = fixture();
  const actor = snapshot.actors[1];
  actor.rotation.yaw = 30;
  actor.bounds.extent.x = 400 * Math.cos(Math.PI / 6) + 25 * 0.5;
  actor.bounds.extent.y = 400 * 0.5 + 25 * Math.cos(Math.PI / 6);
  const result = compileStructuralBlueprint(buildGraph(snapshot), args);
  assert.equal(result.compiled, true, JSON.stringify(result));
  assert.ok(result.buildables.filter(p => p.role === "wall").every(p => [90, 270].includes(p.yaw)));
});

test("missing, pooled, singular, scaled or incompatible mesh evidence refuses a guessed shell", () => {
  for (const alter of [
    s => { s.actors = []; },
    s => { s.actors[1].bounds.extent = { x: 0, y: 0, z: 0 }; },
    s => { s.actors[1].rotation.yaw = 45; },
    s => { s.actors[1].rotation.pitch = 10; },
    s => { s.actors[1].scale.x = 2; },
    s => { s.actors[1].bounds.extent.z = 300; },
    s => { s.content.recipes[1].available = false; },
    s => { s.content.availability_known = false; },
  ]) {
    const snapshot = fixture(); alter(snapshot);
    const result = compileStructuralBlueprint(buildGraph(snapshot), { ...args, commit: true });
    assert.equal(result.compiled, false, JSON.stringify(result));
    assert.equal(result.action, undefined);
  }
});

test("shell parameters are bounded and unknown recipe selection never silently falls back", () => {
  const graph = buildGraph(fixture());
  for (const extra of [{ width_cells: 0 }, { depth_cells: 7 }, { wall_courses: 1.5 },
    { width_cells: "2" }, { open_ends: "none" }, { commit: "true" },
    { foundation_recipe_class: "/Imaginary/Recipe" }, { wall_recipe_class: "/Imaginary/Recipe" },
    { wall_recipe_class: false }, { foundation_recipe_class: "" }]) {
    assert.equal(compileStructuralBlueprint(graph, { ...args, ...extra }).compiled, false);
  }
});

test("tool preview emits nothing; explicit save emits one native action and never claims success", () => {
  const graph = buildGraph(fixture()), emitted = [];
  const services = { actions: { emit: actions => emitted.push(...actions) } };
  const run = a => JSON.parse(runSolverTool(graph, "design_structure_blueprint", a, { services }).serialized);
  const preview = run(args);
  assert.equal(preview.compiled, true, JSON.stringify(preview));
  assert.equal(preview.action_emitted, false);
  assert.equal(emitted.length, 0);
  const saved = run({ ...args, commit: true });
  assert.equal(saved.status, "native_generation_requested_pending_game_readback");
  assert.equal(saved.action_emitted, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "generate_native_blueprint");
  assert.equal(emitted[0].commit, true);
  const noSink = JSON.parse(runSolverTool(graph, "design_structure_blueprint", { ...args, commit: true }).serialized);
  assert.equal(noSink.action_emitted, false);
  assert.equal(noSink.status, "native_action_sink_unavailable_no_file_written");
});
