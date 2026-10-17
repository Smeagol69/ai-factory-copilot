import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareArchitectRevisions,
  createArchitectRevisionStore,
  deriveArchitectScope,
  fingerprintArchitectManifest,
  resolveArchitectStoreDirectory,
} from "../lib/architect-revisions.mjs";

const FAMILY = `sha256:${"a".repeat(64)}`;
const UNLOCK = `sha256:${"b".repeat(64)}`;
const OTHER_UNLOCK = `sha256:${"c".repeat(64)}`;

function snapshot(session = "Architect Test Save", map = "FactoryMap") {
  return {
    schema: "aifactory.snapshot",
    world_revision: 41,
    world: { map, session_name: session },
  };
}

function manifest({
  style = "elevated_industrial_campus",
  unlock = UNLOCK,
  worldRevision = 41,
  x = 1000,
  blockers = ["machine_logistics_power_and_circulation_are_not_routed"],
} = {}) {
  return {
    schema: "megabase.design/v1",
    compiled: true,
    validation: { valid: true, issues: [] },
    style,
    design_family: { fingerprint: FAMILY },
    unlock_constraints: {
      availability_fingerprint: unlock,
      captured_world_revision: worldRevision,
      captured_at_utc: "2026-08-31T00:00:00.000Z",
    },
    program: { groups: [{ id: "wire", machine_count: 4 }] },
    elements: [{
      id: "hall-a",
      kind: "production_zone",
      world_origin_cm: { x, y: 2000, z: 3000 },
      world_size_cm: { x: 8000, y: 6400, z: 3200 },
      world_yaw_degrees: 0,
    }],
    connections: [{ id: "bridge-a", from: "hall-a", to: "tower" }],
    footprint: { width_cm: 8000, depth_cm: 6400, height_cm: 3200 },
    construction_ready: false,
    construction_blockers: blockers,
  };
}

function brief(goal = "Build a compact 120 Wire/min campus") {
  return {
    goal,
    creative_direction: "Elevated industrial with a strong central landmark",
    constraints: ["Use current unlocks", "Keep two commissioning phases"],
  };
}

function designRequest(x = 1000) {
  return {
    item_name: "Wire",
    target_rate_per_minute: 120,
    origin: { x, y: 2000, z: 3000 },
    style: "elevated_industrial_campus",
  };
}

test("scope identity requires and separates exact map, save, and chat sessions", () => {
  const a = deriveArchitectScope(snapshot("Save A"), "chat-a");
  const b = deriveArchitectScope(snapshot("Save B"), "chat-a");
  const c = deriveArchitectScope(snapshot("Save A"), "chat-b");
  assert.equal(a.ok, true);
  assert.notEqual(a.scope_id, b.scope_id);
  assert.notEqual(a.scope_id, c.scope_id);
  assert.equal(deriveArchitectScope({ world: { map: "FactoryMap" } }, "chat-a").ok, false);
});

test("disk store survives restart with immutable parented revisions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "architect-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let tick = 0;
  const now = () => `2026-08-31T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  const firstStore = createArchitectRevisionStore({ directory, now });
  const scoped = firstStore.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const optionA = scoped.saveRevision({
    session_name: "Wire Campus",
    label: "Option A",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  assert.equal(optionA.ok, true, optionA.reason);
  // Captured from the claim-only 40141af implementation: extending the store
  // must not rename any existing production revision or family fingerprint.
  assert.equal(optionA.revision.revision_id, "sha256:e4a87113b06d63ee95440d7973ed00d3278fa226307fe6985997bdf9e7bf8471");
  assert.equal(optionA.revision.manifest_fingerprint, "sha256:5bf9ce0d13daa9dd9f2fbf24268cae9ac6f0e4087e319e076eed0f0105cccf4b");
  const optionB = scoped.saveRevision({
    session_name: "Wire Campus",
    label: "Option B — shifted hall",
    parent_revision_id: optionA.revision.revision_id,
    brief: brief("Shift the hall but preserve the production goal"),
    manifest: manifest({ x: 1800 }),
    design_request: designRequest(1800),
    select: true,
  });
  assert.equal(optionB.ok, true, optionB.reason);
  assert.equal(optionB.revision.parent_revision_id, optionA.revision.revision_id);

  const restarted = createArchitectRevisionStore({ directory, now });
  const restored = restarted.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const listed = restored.list({ session_name: "Wire Campus" });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(listed.architect_sessions[0].revision_count, 2);
  assert.equal(
    listed.architect_sessions[0].selected_revision_id,
    optionB.revision.revision_id,
  );
  const exact = restored.getRevision({
    session_name: "Wire Campus",
    revision_id: optionA.revision.revision_id,
  });
  assert.equal(exact.revision.manifest.elements[0].world_origin_cm.x, 1000);
  const isolated = restarted.scope({ snapshot: snapshot(), chat_session_id: "chat-b" }).list();
  assert.equal(isolated.ok, true);
  assert.deepEqual(isolated.architect_sessions, []);
});

test("selection recompile ignores global revision drift but refuses unlock or semantic drift", () => {
  const store = createArchitectRevisionStore();
  const scoped = store.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const saved = scoped.saveRevision({
    session_name: "Wire Campus",
    label: "Option A",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  assert.equal(saved.ok, true);

  const movingWorld = scoped.selectRevision({
    session_name: "Wire Campus",
    revision_id: saved.revision.revision_id,
    recompiled_manifest: manifest({ worldRevision: 999 }),
  });
  assert.equal(movingWorld.ok, true, movingWorld.reason);
  assert.equal(movingWorld.evidence.world_revision_drift, true);

  const staleUnlock = scoped.selectRevision({
    session_name: "Wire Campus",
    revision_id: saved.revision.revision_id,
    recompiled_manifest: manifest({ unlock: OTHER_UNLOCK, worldRevision: 1000 }),
  });
  assert.equal(staleUnlock.ok, false);
  assert.equal(staleUnlock.reason, "architect_revision_unlock_fingerprint_is_stale");

  const changedGeometry = scoped.selectRevision({
    session_name: "Wire Campus",
    revision_id: saved.revision.revision_id,
    recompiled_manifest: manifest({ x: 1800, worldRevision: 1001 }),
  });
  assert.equal(changedGeometry.ok, false);
  assert.equal(changedGeometry.reason, "architect_revision_recompile_no_longer_matches");
});

test("comparison reports exact deltas and cost stays explicitly unknown", () => {
  const store = createArchitectRevisionStore();
  const scoped = store.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const left = scoped.saveRevision({
    session_name: "Compare",
    label: "A",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  const changed = manifest({ x: 1800, blockers: [] });
  changed.elements.push({
    id: "tower",
    kind: "vertical_landmark",
    world_origin_cm: { x: 9000, y: 2000, z: 3000 },
    world_size_cm: { x: 3200, y: 3200, z: 9600 },
    world_yaw_degrees: 0,
  });
  const right = scoped.saveRevision({
    session_name: "Compare",
    label: "B",
    parent_revision_id: left.revision.revision_id,
    brief: brief("Add a tower and shift the hall"),
    manifest: changed,
    design_request: designRequest(1800),
  });
  const compared = scoped.compare({
    session_name: "Compare",
    left_revision_id: left.revision.revision_id,
    right_revision_id: right.revision.revision_id,
  });
  assert.equal(compared.ok, true);
  assert.deepEqual(compared.geometry.added_element_ids, ["tower"]);
  assert.deepEqual(compared.geometry.changed_element_ids, ["hall-a"]);
  assert.deepEqual(compared.blockers.resolved, [
    "machine_logistics_power_and_circulation_are_not_routed",
  ]);
  assert.equal(compared.cost.certainty, "unknown");
  assert.equal(compareArchitectRevisions(left, right).ok, false);
});

test("deletion is metadata-only and protects selected or parent revisions", () => {
  const store = createArchitectRevisionStore();
  const scoped = store.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const parent = scoped.saveRevision({
    session_name: "Delete",
    label: "Parent",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  const child = scoped.saveRevision({
    session_name: "Delete",
    label: "Child",
    parent_revision_id: parent.revision.revision_id,
    brief: brief("Child"),
    manifest: manifest({ x: 1800 }),
    design_request: designRequest(1800),
  });
  assert.equal(scoped.deleteDraft({
    session_name: "Delete",
    revision_id: parent.revision.revision_id,
  }).reason, "architect_revision_with_children_cannot_be_deleted");

  const deleted = scoped.deleteDraft({
    session_name: "Delete",
    revision_id: child.revision.revision_id,
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.effects, {
    architect_metadata_deleted: true,
    native_blueprint_files_deleted: false,
    placed_actors_deleted: false,
    game_save_mutated: false,
  });

  const selected = scoped.saveRevision({
    session_name: "Delete",
    label: "Selected",
    brief: brief("Selected"),
    manifest: manifest({ x: 2600 }),
    design_request: designRequest(2600),
    select: true,
  });
  assert.equal(scoped.deleteDraft({
    session_name: "Delete",
    revision_id: selected.revision.revision_id,
  }).reason, "architect_selected_revision_cannot_be_deleted");
});

test("corrupt store fails closed and is not overwritten", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "architect-corrupt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createArchitectRevisionStore({ directory });
  const scoped = store.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(scoped.file_path, "{not-json", "utf8");
  const before = fs.readFileSync(scoped.file_path, "utf8");
  const refused = scoped.saveRevision({
    session_name: "Wire",
    label: "A",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "architect_store_is_corrupt_or_unreadable");
  assert.equal(fs.readFileSync(scoped.file_path, "utf8"), before);
});

test("valid JSON with a tampered immutable manifest fails its content address", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "architect-tamper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createArchitectRevisionStore({ directory });
  const scoped = store.scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const saved = scoped.saveRevision({
    session_name: "Wire",
    label: "A",
    brief: brief(),
    manifest: manifest(),
    design_request: designRequest(),
  });
  assert.equal(saved.ok, true);
  const state = JSON.parse(fs.readFileSync(scoped.file_path, "utf8"));
  const session = Object.values(state.sessions)[0];
  session.revisions[0].manifest.elements[0].world_origin_cm.x += 1;
  fs.writeFileSync(scoped.file_path, JSON.stringify(state), "utf8");

  const restarted = createArchitectRevisionStore({ directory }).scope({
    snapshot: snapshot(),
    chat_session_id: "chat-a",
  });
  const refused = restarted.list();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "architect_store_revision_is_invalid");
});

test("configured storage path follows explicit env and defaults to LocalAppData", () => {
  assert.equal(resolveArchitectStoreDirectory({ AIFACTORY_ARCHITECT_STORE: "off" }), null);
  assert.equal(
    resolveArchitectStoreDirectory({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }),
    path.join(
      "C:\\Users\\test\\AppData\\Local",
      "FactoryGame",
      "Saved",
      "AIFactoryCopilot",
      "Architect",
    ),
  );
});

test("revision fingerprints are semantic but preserve exact family and unlock evidence", () => {
  const a = fingerprintArchitectManifest(manifest({ worldRevision: 41 }));
  const b = fingerprintArchitectManifest(manifest({ worldRevision: 99 }));
  assert.equal(a.ok, true);
  assert.equal(a.manifest_fingerprint, b.manifest_fingerprint);
  assert.equal(a.design_family_fingerprint, FAMILY);
  assert.equal(a.unlock_fingerprint, UNLOCK);
});

function structuralManifest({ worldRevision = 41, z = 50, unlock = UNLOCK } = {}) {
  return {
    schema: "architect.structure/v1", compiled: true, validation: { valid: true },
    style: "structural", design_family: { fingerprint: FAMILY },
    unlock_constraints: { availability_fingerprint: unlock,
      captured_world_revision: worldRevision, captured_at_utc: null },
    elements: [{ id: "floor-1", role: "floor", buildable_class: "/Captured/Foundation",
      relative_location: { x: 400, y: 400, z }, yaw: 0 }],
    dimensions: { width_cells: 1, depth_cells: 1, wall_courses: 2 },
    part_count: 1, limitations: ["world_placement_and_cave_clearance_not_checked"],
  };
}

function structuralRequest() {
  return { schema: "architect.structure-request/v1", type: "structure", parameters: {
    blueprint_name: "Entrance", width_cells: 1, depth_cells: 1, wall_courses: 2,
    open_ends: "front", foundation_recipe_class: "/Captured/FoundationRecipe",
    wall_recipe_class: "/Captured/WallRecipe",
  } };
}

test("typed structural and legacy production revisions coexist across a disk restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "architect-mixed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scoped = createArchitectRevisionStore({ directory }).scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const production = scoped.saveRevision({ session_name: "Mixed", label: "Production",
    brief: brief(), manifest: manifest(), design_request: designRequest() });
  assert.equal(production.ok, true);
  const entrance = scoped.saveRevision({ session_name: "Mixed", label: "Entrance",
    brief: { goal: "Make a sheltered entrance" }, manifest: structuralManifest(),
    design_request: structuralRequest(), select: true });
  assert.equal(entrance.ok, true, entrance.reason);
  const restarted = createArchitectRevisionStore({ directory }).scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const exact = restarted.getRevision({ session_name: "Mixed", revision_id: entrance.revision.revision_id });
  assert.equal(exact.ok, true, exact.reason);
  assert.equal(exact.revision.manifest.schema, "architect.structure/v1");
  assert.equal(exact.revision.design_request.type, "structure");
  assert.equal(exact.revision.design_request.parameters.item_name, undefined);
  assert.equal(restarted.list().architect_sessions[0].revision_count, 2);
});

test("structural revisions compare geometry without fictional production or routed topology", () => {
  const scoped = createArchitectRevisionStore().scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const left = scoped.saveRevision({ session_name: "Entrance", label: "A", brief: { goal: "Entrance" },
    manifest: structuralManifest(), design_request: structuralRequest() });
  assert.equal(left.ok, true, left.reason);
  const right = scoped.saveRevision({ session_name: "Entrance", label: "B", brief: { goal: "Raised entrance" },
    parent_revision_id: left.revision.revision_id, manifest: structuralManifest({ z: 100 }), design_request: structuralRequest() });
  assert.equal(right.ok, true, right.reason);
  const compared = scoped.compare({ session_name: "Entrance", left_revision_id: left.revision.revision_id, right_revision_id: right.revision.revision_id });
  assert.deepEqual(compared.geometry.changed_element_ids, ["floor-1"]);
  assert.deepEqual(compared.production, { applicable: false, reason: "structural_design_has_no_production_target" });
  assert.deepEqual(compared.topology, { applicable: false, reason: "structural_shell_does_not_compile_connections" });
  assert.equal(scoped.selectRevision({ session_name: "Entrance", revision_id: right.revision.revision_id,
    recompiled_manifest: structuralManifest({ z: 100, worldRevision: 900 }) }).ok, true);
  const rollback = scoped.selectRevision({ session_name: "Entrance", revision_id: left.revision.revision_id,
    recompiled_manifest: structuralManifest({ worldRevision: 901 }), operation: "rollback" });
  assert.equal(rollback.ok, true, rollback.reason);
  assert.equal(rollback.evidence.world_revision_drift, true);
  assert.equal(scoped.deleteDraft({ session_name: "Entrance", revision_id: right.revision.revision_id }).ok, true);
});

test("typed structural storage refuses unknown schemas, missing provenance and request mismatch", () => {
  const scoped = createArchitectRevisionStore().scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const save = (m, r = structuralRequest()) => scoped.saveRevision({ session_name: "Entrance", label: "A",
    brief: { goal: "Entrance" }, manifest: m, design_request: r });
  const unknown = structuralManifest(); unknown.schema = "architect.structure/v99";
  assert.equal(save(unknown).ok, false);
  const missing = structuralManifest(); delete missing.unlock_constraints.captured_world_revision;
  assert.equal(save(missing).ok, false);
  assert.equal(save(structuralManifest(), designRequest()).ok, false);
  assert.equal(save(manifest(), structuralRequest()).ok, false);
  const unknownRequest = structuralRequest(); unknownRequest.schema = "architect.structure-request/v99";
  assert.equal(save(structuralManifest(), unknownRequest).ok, false);
  const invented = structuralRequest(); invented.parameters.item_name = "Iron Plate";
  assert.equal(save(structuralManifest(), invented).ok, false);
});

test("structural fingerprints exclude brief and sampled actor identity but retain measured pivots", () => {
  const a = structuralManifest();
  a.brief = "A sheltered entrance";
  a.pieces = { floor: { measurement: { sample_actor_id: "captured-a", local_min_z_cm: -50 } } };
  const b = structuredClone(a); delete b.brief;
  b.pieces.floor.measurement.sample_actor_id = "same-geometry-new-sample";
  assert.equal(fingerprintArchitectManifest(a).manifest_fingerprint,
    fingerprintArchitectManifest(b).manifest_fingerprint);
  b.pieces.floor.measurement.local_min_z_cm = -40;
  assert.notEqual(fingerprintArchitectManifest(a).manifest_fingerprint,
    fingerprintArchitectManifest(b).manifest_fingerprint);
});

test("structural comparison uses native part_id identities for every piece", () => {
  const a = structuralManifest();
  a.elements = [{ part_id: "part-0001", relative_location: { x: 0, y: 0, z: 50 } },
    { part_id: "part-0002", relative_location: { x: 0, y: 0, z: 950 } }];
  const b = structuredClone(a); b.elements[1].relative_location.z += 10;
  const compared = compareArchitectRevisions({ manifest: a, construction_blockers: [] },
    { manifest: b, construction_blockers: [] });
  assert.equal(compared.geometry.left_element_count, 2);
  assert.deepEqual(compared.geometry.changed_element_ids, ["part-0002"]);
});

test("a structural pinned-request change on disk invalidates its immutable revision", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "architect-request-tamper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scoped = createArchitectRevisionStore({ directory }).scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  const saved = scoped.saveRevision({ session_name: "Entrance", label: "A", brief: { goal: "Entrance" },
    manifest: structuralManifest(), design_request: structuralRequest() });
  assert.equal(saved.ok, true, saved.reason);
  const state = JSON.parse(fs.readFileSync(scoped.file_path, "utf8"));
  Object.values(state.sessions)[0].revisions[0].design_request.parameters.width_cells = 2;
  fs.writeFileSync(scoped.file_path, JSON.stringify(state));
  const reopened = createArchitectRevisionStore({ directory }).scope({ snapshot: snapshot(), chat_session_id: "chat-a" });
  assert.equal(reopened.list().reason, "architect_store_revision_is_invalid");
});
