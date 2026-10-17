import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { createArchitectRevisionStore } from "../lib/architect-revisions.mjs";
import { compileStructuralBlueprint } from "../lib/structural-blueprints.mjs";
import { runSolverTool } from "../lib/tools.mjs";

function fixture() {
  const paths = ["/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/",
    "/Game/FactoryGame/Buildable/Building/Wall/ConcreteWallSet/"];
  const names = ["Foundation_Concrete_8x1", "Wall_Concrete_8x4"];
  const asset = (i, prefix) => `${paths[i]}${prefix}_${names[i]}.${prefix}_${names[i]}_C`;
  return { world_revision: 77, captured_at_utc: "2026-10-16T20:00:00Z",
    world: { map: "FactoryMap", session_name: "Structural Architect" },
    actors: names.map((name, i) => ({ actor_id: `piece-${i}`, class_path: asset(i, "Build"),
      location: { x: 1000, y: 2000, z: 3000 }, rotation: { pitch: 0, yaw: 0, roll: 0 },
      scale: { x: 1, y: 1, z: 1 }, bounds: {
        origin: { x: 1000, y: 2000, z: i ? 3200 : 3000 },
        extent: i ? { x: 25, y: 400, z: 200 } : { x: 400, y: 400, z: 50 },
      } })),
    content: { availability_known: true,
      items: names.map((name, i) => ({ class_path: asset(i, "Desc"), name, building: { class_path: asset(i, "Build") } })),
      recipes: names.map((name, i) => ({ class_path: asset(i, "Recipe"), name, available: true,
        products: [{ item_class: asset(i, "Desc"), amount: 1 }], ingredients: [],
        produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"] })),
    } };
}

function harness(snapshot = fixture()) {
  const graph = buildGraph(snapshot), emitted = [];
  const architect = createArchitectRevisionStore().scope({ snapshot, chat_session_id: "architect-chat" });
  const services = { architect, actions: { emit: actions => emitted.push(...actions) } };
  const run = (name, args, current = graph, svc = services) => JSON.parse(runSolverTool(current, name, args, { services: svc }).serialized);
  const create = extra => run("design_structure_blueprint", { blueprint_name: "Cave Entrance",
    architect_session_name: "Entrance", architect_brief: { goal: "A sheltered cave entrance" }, ...extra });
  const manage = (operation, revision_id, extra = {}, current = graph, svc = services) => run("manage_architect_revisions",
    { operation, session_name: "Entrance", revision_id, ...extra }, current, svc);
  return { graph, emitted, architect, services, run, create, manage };
}

test("structural Architect saves a no-production revision and replays the exact local shell", () => {
  const h = harness(), created = h.create();
  assert.equal(created.architect_revision?.ok, true, JSON.stringify(created));
  assert.equal(h.emitted.length, 0);
  const id = created.architect_revision.revision.revision_id;
  const got = h.manage("get", id);
  assert.equal(got.ok, true);
  assert.equal(got.revision.manifest.schema, "architect.structure/v1");
  assert.equal(got.revision.design_request.schema, "architect.structure-request/v1");
  assert.equal(got.revision.manifest.part_count, 8);
  assert.equal(got.revision.brief.goal, "A sheltered cave entrance");
  assert.equal(got.revision.manifest.program, undefined);
  assert.equal(got.revision.design_request.parameters.item_name, undefined);
  assert.equal(got.access_catalog, undefined);
  assert.equal(got.elevation, undefined);
  const preview = h.manage("preview", id);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.layout.part_count, 8);
  assert.deepEqual(preview.layout.buildables, compileStructuralBlueprint(h.graph, { blueprint_name: "Cave Entrance" }).buildables);
  assert.equal(preview.action_emitted, false);
  assert.equal(h.emitted.length, 0);
});

test("a requested structural revision never falls back to a direct write without its store", () => {
  const h = harness();
  const result = h.run("design_structure_blueprint", { blueprint_name: "Entrance",
    architect_session_name: "Entrance", commit: true }, h.graph, { actions: h.services.actions });
  assert.equal(result.architect_revision?.ok, false);
  assert.equal(result.action_emitted, false);
  assert.equal(h.emitted.length, 0);
});

test("structural child revision comparison, selection and rollback preserve the original", () => {
  const h = harness(), first = h.create(), a = first.architect_revision?.revision.revision_id;
  assert.ok(a, JSON.stringify(first));
  const second = h.create({ blueprint_name: "Wide Entrance", width_cells: 3,
    architect_revision_label: "Wider", architect_parent_revision_id: a });
  const b = second.architect_revision.revision.revision_id;
  const compared = h.manage("compare", undefined, { left_revision_id: a, right_revision_id: b });
  assert.equal(compared.ok, true);
  assert.equal(compared.production.applicable, false);
  assert.equal(compared.geometry.left_element_count, 8);
  assert.equal(compared.geometry.right_element_count, 10);
  assert.equal(h.manage("select", b).ok, true);
  assert.equal(h.manage("rollback", a).selected_revision_id, a);
  assert.equal(h.manage("get", a).revision.manifest.part_count, 8);
  assert.equal(h.emitted.length, 0);
});

test("structural promotion gates selection, explicit commit and sink, then emits one freshly stamped native action", () => {
  const h = harness(), created = h.create({ commit: true });
  assert.equal(created.architect_revision?.ok, true, JSON.stringify(created));
  assert.equal(h.emitted.length, 0, "saving a revision cannot bypass selected promotion");
  const id = created.architect_revision.revision.revision_id;
  assert.equal(h.manage("promotion_status", id).promotion.ready_for_native_generation, false);
  assert.equal(h.manage("promote_selected", id, { commit: true }).action_emitted, false);
  assert.equal(h.manage("select", id).ok, true);
  const status = h.manage("promotion_status", id, { commit: true });
  assert.equal(status.promotion.ready_for_native_generation, true, JSON.stringify(status));
  assert.equal(status.action_emitted, false);
  assert.equal(status.promotion.operational_readiness.ready, false);
  assert.equal(h.manage("promote_selected", id).action_emitted, false);
  const missingSink = h.manage("promote_selected", id, { commit: true }, h.graph, { architect: h.architect });
  assert.equal(missingSink.action_emitted, false);
  const drift = fixture(); drift.world_revision = 999; drift.captured_at_utc = "2026-10-16T20:10:00Z";
  const promoted = h.manage("promote_selected", id, { commit: true }, buildGraph(drift));
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  assert.equal(promoted.evidence.world_revision_drift, true);
  assert.equal(promoted.action_emitted, true);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].action, "generate_native_blueprint");
  assert.equal(h.emitted[0].layout_schema, "aifactory.generated-blueprint/v1");
  assert.equal(h.emitted[0].expect_world_revision, "999");
  assert.equal(h.emitted[0].commit, true);
});

test("structural replay and promotion refuse changed relevant pivots, missing geometry and unavailable recipes", () => {
  const h = harness(), created = h.create({ architect_select_revision: true });
  assert.equal(created.architect_revision?.ok, true, JSON.stringify(created));
  const id = created.architect_revision.revision.revision_id;
  for (const alter of [s => { s.actors[0].bounds.origin.z += 10; },
    s => { s.actors = []; }, s => { s.content.recipes[1].available = false; },
    s => { s.content.availability_known = false; }]) {
    const current = fixture(); alter(current);
    const result = h.manage("promote_selected", id, { commit: true }, buildGraph(current));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.notEqual(result.action_emitted, true);
  }
  assert.equal(h.emitted.length, 0);
});

test("a replacement capture sample with the same measured geometry preserves the structural revision", () => {
  const h = harness(), created = h.create({ architect_select_revision: true });
  assert.equal(created.architect_revision?.ok, true, JSON.stringify(created));
  const current = fixture();
  current.actors.forEach((actor, i) => { actor.actor_id = `replacement-sample-${i}`; });
  const result = h.manage("promotion_status", created.architect_revision.revision.revision_id, {}, buildGraph(current));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.promotion.ready_for_native_generation, true);
  assert.equal(h.emitted.length, 0);
});

test("a no-session structural call retains its existing layout and direct-save behavior", () => {
  const h = harness(), args = { blueprint_name: "Legacy tunnel" };
  const { action, ...expected } = compileStructuralBlueprint(h.graph, args);
  assert.deepEqual(h.run("design_structure_blueprint", args), { ...expected,
    action_emitted: false, status: "layout_only_no_file_written" });
  const saved = h.run("design_structure_blueprint", { ...args, commit: true });
  assert.equal(saved.status, "native_generation_requested_pending_game_readback");
  assert.equal(h.emitted.length, 1);
});
