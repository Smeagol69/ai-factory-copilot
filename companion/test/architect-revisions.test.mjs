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
