import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  ARCHITECT_STRUCTURAL_SCHEMA, ARCHITECT_STRUCTURAL_REQUEST_SCHEMA,
  compileArchitectStructuralRequest, compileArchitectStructuralPromotion,
} from "../lib/architect-structural.mjs";

// Input fixture copied from structural-blueprints.test.mjs.
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
const FLOOR = "/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Recipe_Foundation_Concrete_8x1.Recipe_Foundation_Concrete_8x1_C";
const WALL = "/Game/FactoryGame/Buildable/Building/Wall/ConcreteWallSet/Recipe_Wall_Concrete_8x4.Recipe_Wall_Concrete_8x4_C";
const args = { blueprint_name: "Test tunnel" };
const compile = (mutate, a = args) => { const s = fixture(); mutate?.(s); return compileArchitectStructuralRequest(buildGraph(s), a); };
const SHA = /^sha256:[0-9a-f]{64}$/;

test("default 2x1x2 shell: hand-computed 8 parts, pivots, pinned request, no production fields", () => {
  const r = compile();
  assert.equal(r.compiled, true, JSON.stringify(r));
  assert.equal(ARCHITECT_STRUCTURAL_SCHEMA, "architect.structure/v1");
  assert.equal(ARCHITECT_STRUCTURAL_REQUEST_SCHEMA, "architect.structure-request/v1");
  assert.deepEqual(r.design_request, { schema: "architect.structure-request/v1", type: "structure",
    parameters: { blueprint_name: "Test tunnel", width_cells: 2, depth_cells: 1, wall_courses: 2,
      open_ends: "both", foundation_recipe_class: FLOOR, wall_recipe_class: WALL } });
  const m = r.manifest;
  assert.equal(m.schema, "architect.structure/v1");
  assert.equal(m.compiled, true);
  assert.deepEqual(m.validation, { valid: true });
  assert.equal(m.style, "structural");
  assert.equal(m.part_count, 8);
  assert.equal(m.elements.length, 8);
  const at = role => m.elements.filter(e => e.role === role);
  // floor pivot: 50 = half of 100 cm thickness, local_min_z -50 -> centre z 50
  assert.deepEqual(at("floor").map(e => e.relative_location), [{ x: 400, y: 400, z: 50 }, { x: 1200, y: 400, z: 50 }]);
  // roof bottom = 100 + 2*400 = 900, plus 50 pivot offset
  assert.ok(at("roof").every(e => e.relative_location.z === 950));
  // wall pivot at base (local_min_z 0): courses at 100 and 500, x = 0 and 1600
  assert.deepEqual(at("wall").map(e => e.relative_location.z), [100, 100, 500, 500]);
  assert.deepEqual(at("wall").map(e => e.relative_location.x), [0, 1600, 0, 1600]);
  assert.deepEqual(at("wall").map(e => e.yaw), [0, 180, 0, 180]);
  assert.ok(at("floor").every(e => e.recipe_class === FLOOR && e.buildable_class.includes("Build_Foundation_Concrete_8x1")));
  assert.ok(at("wall").every(e => e.recipe_class === WALL && e.buildable_class.includes("Build_Wall_Concrete_8x4")));
  assert.ok(m.elements.every(e => /^part-\d{4}$/.test(e.part_id)));
  assert.equal(m.pieces.floor.measurement.local_min_z_cm, -50);
  assert.equal(m.pieces.wall.measurement.local_min_z_cm, 0);
  assert.equal(m.pieces.wall.measurement.wall_long_axis, "y");
  assert.deepEqual(m.shell.wall_centerline_width_cm, 1600);
  assert.match(m.design_family.fingerprint, SHA);
  assert.match(m.unlock_constraints.availability_fingerprint, SHA);
  assert.equal(m.unlock_constraints.captured_world_revision, 77);
  assert.equal(m.unlock_constraints.captured_at_utc, null);
  assert.ok(m.limitations.length > 0);
  const text = JSON.stringify({ manifest: m, design_request: r.design_request });
  assert.ok(!/commit|expect_world_revision|items_per_minute|target_rate/.test(text), text);
  assert.equal(r.layout.action.action, "generate_native_blueprint");
  assert.equal(r.layout.action.commit, false);
  assert.equal(m.action, undefined);
});

test("defaults are normalized; commit:true and invented buildables are never persisted", () => {
  const r = compile(null, { blueprint_name: "  Test   tunnel ", width_cells: 3, commit: true,
    buildables: [{ recipe_class: "/Invented" }], actions: [{}], brief: "a short cave tunnel", items_per_minute: 60 });
  assert.equal(r.compiled, true, JSON.stringify(r));
  assert.equal(r.design_request.parameters.blueprint_name, "Test tunnel");
  assert.equal(r.design_request.parameters.width_cells, 3);
  assert.equal(r.manifest.part_count, 10); // 3 floors + 3 roofs + 2 sides * 2 courses
  assert.ok(!JSON.stringify(r.design_request).includes("Invented"));
  assert.ok(!JSON.stringify(r.manifest).includes("Invented"));
  assert.equal(r.layout.action.commit, false);
  assert.equal(r.manifest.brief, "a short cave tunnel");
  const bare = compile(null, { blueprint_name: "x" });
  assert.equal(bare.design_request.parameters.open_ends, "both");
});

test("request replay recompiles identical geometry and the same pinned request", () => {
  const first = compile();
  const replay = compileArchitectStructuralPromotion(buildGraph(fixture()), first.design_request);
  assert.equal(replay.compiled, true, JSON.stringify(replay));
  assert.deepEqual(replay.buildables, first.layout.buildables);
  const again = compile(null, first.design_request.parameters);
  assert.deepEqual(again.manifest, first.manifest);
  assert.deepEqual(again.design_request, first.design_request);
});

test("global world_revision drift keeps design identity; only declared provenance moves", () => {
  const a = compile(), b = compile(s => { s.world_revision = 901; });
  assert.equal(b.compiled, true);
  assert.equal(b.manifest.unlock_constraints.captured_world_revision, 901);
  assert.equal(b.layout.action.expect_world_revision, "901");
  assert.equal(b.manifest.design_family.fingerprint, a.manifest.design_family.fingerprint);
  assert.equal(b.manifest.semantic_fingerprint, a.manifest.semantic_fingerprint);
  assert.equal(b.manifest.unlock_constraints.availability_fingerprint, a.manifest.unlock_constraints.availability_fingerprint);
  const strip = m => { const c = structuredClone(m); delete c.unlock_constraints.captured_world_revision; return c; };
  assert.deepEqual(strip(b.manifest), strip(a.manifest));
  const c = compile(s => { s.captured_at_utc = "2026-10-16T00:00:00Z"; });
  assert.equal(c.manifest.semantic_fingerprint, a.manifest.semantic_fingerprint);
});

test("changed measured geometry changes identity; changed unlock evidence changes availability fingerprint", () => {
  const a = compile();
  const geo = compile(s => { s.actors[0].bounds.origin.z = 3010; });
  assert.equal(geo.compiled, true, JSON.stringify(geo));
  assert.notEqual(geo.manifest.semantic_fingerprint, a.manifest.semantic_fingerprint);
  assert.notEqual(geo.manifest.design_family.fingerprint, a.manifest.design_family.fingerprint);
  assert.equal(geo.manifest.pieces.floor.measurement.local_min_z_cm, -40);
  const size = compile(null, { ...args, depth_cells: 2 });
  assert.notEqual(size.manifest.semantic_fingerprint, a.manifest.semantic_fingerprint);
  assert.equal(size.manifest.design_family.fingerprint, a.manifest.design_family.fingerprint);
  const unlock = compile(s => { s.content.recipes[1].produced_in.push("/Game/FactoryGame/Equipment/BuildGun/BP_BuildGunExtra.BP_BuildGunExtra_C"); });
  assert.equal(unlock.compiled, true);
  assert.notEqual(unlock.manifest.unlock_constraints.availability_fingerprint, a.manifest.unlock_constraints.availability_fingerprint);
  assert.equal(unlock.manifest.design_family.fingerprint, a.manifest.design_family.fingerprint);
});

test("unsupported, missing capture and unknown inputs refuse without action", () => {
  for (const alter of [s => { s.content.availability_known = false; }, s => { s.content.recipes[0].available = false; },
    s => { s.actors = []; }, s => { s.content = undefined; }]) {
    const r = compile(alter);
    assert.equal(r.compiled, false, JSON.stringify(r));
    assert.ok(r.reason);
    assert.equal(r.action, undefined); assert.equal(r.manifest, undefined);
  }
  for (const bad of [{ width_cells: 0 }, { open_ends: "none" }, { wall_recipe_class: "/Imaginary/Recipe" },
    { blueprint_name: "" }, { brief: 5 }]) {
    const r = compile(null, { ...args, ...bad });
    assert.equal(r.compiled, false, JSON.stringify(bad));
    assert.equal(r.action, undefined);
  }
  assert.equal(compileArchitectStructuralRequest(null, args).compiled, false);
  assert.equal(compileArchitectStructuralRequest(buildGraph(fixture()), null).compiled, false);
});

test("promotion is one default non-commit native action stamped with the current world revision", () => {
  const first = compile();
  const sink = []; // never handed to the module; no emission path exists here
  const s = fixture(); s.world_revision = 120;
  const p = compileArchitectStructuralPromotion(buildGraph(s), first.design_request);
  assert.equal(p.compiled, true, JSON.stringify(p));
  assert.equal(p.action.action, "generate_native_blueprint");
  assert.equal(p.action.commit, false);
  assert.equal(p.action.expect_world_revision, "120");
  const c = compileArchitectStructuralPromotion(buildGraph(s), first.design_request, { commit: true });
  assert.equal(c.compiled, true);
  assert.equal(c.action.commit, true);
  assert.equal(sink.length, 0);
  assert.equal(compileArchitectStructuralPromotion(buildGraph(s), first.design_request, { commit: "yes" }).compiled, false);
});

test("promotion fails closed on malformed or foreign requests and never falls back", () => {
  const good = compile().design_request, graph = buildGraph(fixture());
  const clone = f => { const r = structuredClone(good); f(r); return r; };
  const cases = [null, "x", [], clone(r => { r.schema = "other"; }), clone(r => { r.type = "production"; }),
    clone(r => { r.extra = 1; }), clone(r => { r.parameters.items_per_minute = 5; }),
    clone(r => { delete r.parameters.wall_recipe_class; }), clone(r => { delete r.parameters.foundation_recipe_class; }),
    clone(r => { r.parameters.width_cells = "2"; }), clone(r => { r.parameters.wall_courses = 7; }),
    clone(r => { r.parameters.open_ends = "none"; }), clone(r => { r.parameters.blueprint_name = ""; }),
    clone(r => { r.parameters.commit = true; }), clone(r => { r.parameters.wall_recipe_class = "/Imaginary/Recipe"; }),
    clone(r => { delete r.parameters; })];
  for (const bad of cases) {
    const r = compileArchitectStructuralPromotion(graph, bad);
    assert.equal(r.compiled, false, JSON.stringify(bad));
    assert.ok(r.reason);
    assert.equal(r.action, undefined);
  }
  const s = fixture(); s.content.recipes[0].available = false;
  const r = compileArchitectStructuralPromotion(buildGraph(s), good);
  assert.equal(r.compiled, false);
  assert.equal(r.action, undefined);
});
