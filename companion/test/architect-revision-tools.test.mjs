import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectRevisionStore } from "../lib/architect-revisions.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { runSolverTool } from "../lib/tools.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

function toolGraph() {
  const snapshot = buildFactorySnapshot();
  snapshot.world.session_name = "Architect Tool Save";
  for (const actor of snapshot.actors) {
    if (actor.kind !== "buildable") continue;
    const isSmelter = actor.actor_id === SMELTER;
    actor.bounds = {
      origin: { ...actor.location },
      extent: isSmelter ? { x: 300, y: 450, z: 400 } : { x: 400, y: 300, z: 400 },
    };
    actor.rotation = { pitch: 0, yaw: 45, roll: 0 };
    if (actor.factory) actor.factory.production_cycle_seconds = 0;
  }
  return buildGraph(snapshot);
}

function run(graph, name, args, architect, emitted = null) {
  return JSON.parse(runSolverTool(
    graph,
    name,
    args,
    {
      services: {
        architect,
        actions: { emit: (actions) => emitted?.push(...actions) },
      },
    },
  ).serialized);
}

test("access reports survive get, preview and promotion without entering immutable revisions", () => {
  const graph = toolGraph();
  const architect = createArchitectRevisionStore().scope({ snapshot: graph.snapshot, chat_session_id: "access" });
  const design = run(graph, "design_megabase_concept", {
    item_name: "Iron Rod", target_rate_per_minute: 60,
    origin: { x: 100000, y: 100000, z: 500 }, style: "radial_hub_campus",
    architect_session_name: "Access", architect_select_revision: true,
  }, architect);
  assert.equal(design.access_catalog.compiled, true, JSON.stringify(design.access_catalog.issues));
  assert.ok(design.access_catalog.portals.length >= 4);
  const revisionId = design.architect_revision.revision.revision_id;
  const stored = architect.getRevision({ session_name: "Access", revision_id: revisionId });
  assert.equal(Object.hasOwn(stored.revision.manifest, "access_catalog"), false);
  const before = structuredClone(stored);
  for (const operation of ["get", "preview", "promotion_status"]) {
    const result = run(graph, "manage_architect_revisions", {
      operation, session_name: "Access", revision_id: revisionId,
    }, architect);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual((result.promotion ?? result).access_catalog, design.access_catalog);
  }
  assert.deepEqual(architect.getRevision({ session_name: "Access", revision_id: revisionId }), before);
});

test("stored requests without an enclosure mode still recompile their original front-only manifest", () => {
  const graph = toolGraph();
  const architect = createArchitectRevisionStore().scope({ snapshot: graph.snapshot, chat_session_id: "legacy-enclosure" });
  const front = run(graph, "design_megabase_concept", {
    item_name: "Iron Rod", target_rate_per_minute: 60,
    origin: { x: 100000, y: 100000, z: 500 }, style: "elevated_industrial_campus",
    enclosure_mode: "front_facade", architect_session_name: "Seed",
  }, architect);
  const exact = architect.getRevision({ session_name: "Seed", revision_id: front.architect_revision.revision.revision_id });
  const request = structuredClone(exact.revision.design_request);
  delete request.enclosure_mode;
  const legacy = architect.saveRevision({ session_name: "Legacy", label: "Old request",
    brief: { goal: "Keep the original front facade" }, manifest: exact.revision.manifest,
    design_request: request, select: true });
  assert.equal(legacy.ok, true, legacy.reason);
  const status = run(graph, "manage_architect_revisions", { operation: "promotion_status",
    session_name: "Legacy", revision_id: legacy.revision.revision_id }, architect);
  assert.equal(status.ok, true, status.reason);
  assert.equal(status.action_emitted, false);
});

test("model-facing Architect tools create, compare, select, roll back, and delete drafts", () => {
  const graph = toolGraph();
  const architect = createArchitectRevisionStore().scope({
    snapshot: graph.snapshot,
    chat_session_id: "architect-chat",
  });
  const baseRequest = {
    item_name: "Iron Rod",
    target_rate_per_minute: 60,
    origin: { x: 100_000, y: 100_000, z: 500 },
    style: "elevated_industrial_campus",
    architect_session_name: "Iron Rod Campus",
    architect_revision_label: "Option A",
    architect_brief: {
      goal: "Create a modular 60 Iron Rod/min campus",
      creative_direction: "Elevated and symmetrical",
      constraints: ["Use captured unlocks"],
    },
  };
  const optionA = run(graph, "design_megabase_concept", baseRequest, architect);
  assert.equal(optionA.compiled, true, optionA.reason);
  assert.equal(optionA.architect_revision.ok, true, optionA.architect_revision.reason);
  const optionAId = optionA.architect_revision.revision.revision_id;

  const optionB = run(graph, "design_megabase_concept", {
    ...baseRequest,
    architect_revision_label: "Option B",
    architect_parent_revision_id: optionAId,
    creative_parameters: { tower_floors: 10 },
  }, architect);
  assert.equal(optionB.architect_revision.ok, true, optionB.architect_revision.reason);
  const optionBId = optionB.architect_revision.revision.revision_id;

  const listed = run(graph, "manage_architect_revisions", {
    operation: "list",
    session_name: "Iron Rod Campus",
  }, architect);
  assert.equal(listed.ok, true);
  assert.equal(listed.architect_sessions[0].revision_count, 2);

  const compared = run(graph, "manage_architect_revisions", {
    operation: "compare",
    session_name: "Iron Rod Campus",
    left_revision_id: optionAId,
    right_revision_id: optionBId,
  }, architect);
  assert.equal(compared.ok, true, compared.reason);
  assert.ok(compared.geometry.changed_element_ids.length > 0);
  assert.ok(compared.production.left_machine_count > 0);

  const selected = run(graph, "manage_architect_revisions", {
    operation: "select",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
  }, architect);
  assert.equal(selected.ok, true, selected.reason);
  assert.equal(selected.selected_revision_id, optionBId);

  const promotionStatus = run(graph, "manage_architect_revisions", {
    operation: "promotion_status",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
  }, architect);
  assert.equal(promotionStatus.ok, true, promotionStatus.reason);
  assert.equal(promotionStatus.operation, "promotion_status");
  assert.equal(promotionStatus.action_emitted, false);
  assert.equal(promotionStatus.promotion.ready_for_native_generation, false);
  assert.ok(promotionStatus.promotion.blockers.length > 0);
  assert.ok(
    !promotionStatus.promotion.blockers.some((blocker) =>
      blocker.startsWith("architect_element_kind_has_no_native_compiler:")),
    "all current Architect massing kinds have native compilers; this fixture is blocked by missing exact live part evidence",
  );

  const promotionActions = [];
  const promotionRefused = run(graph, "manage_architect_revisions", {
    operation: "promote_selected",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
    blueprint_name: "Iron Rod Campus Option B",
    commit: true,
  }, architect, promotionActions);
  assert.equal(promotionRefused.ok, false);
  assert.equal(promotionRefused.reason, "architect_revision_is_not_ready_for_native_generation");
  assert.equal(promotionRefused.action_emitted, false);
  assert.equal(promotionActions.length, 0);

  const unselectedStatus = run(graph, "manage_architect_revisions", {
    operation: "promotion_status",
    session_name: "Iron Rod Campus",
    revision_id: optionAId,
  }, architect);
  assert.ok(
    unselectedStatus.promotion.blockers.includes("architect_revision_is_not_the_selected_revision"),
  );

  const rollback = run(graph, "manage_architect_revisions", {
    operation: "rollback",
    session_name: "Iron Rod Campus",
    revision_id: optionAId,
  }, architect);
  assert.equal(rollback.ok, true, rollback.reason);
  assert.equal(rollback.operation, "rollback");
  assert.equal(rollback.selected_revision_id, optionAId);

  const emitted = [];
  const previewed = run(graph, "manage_architect_revisions", {
    operation: "preview",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
  }, architect, emitted);
  assert.equal(previewed.ok, true, previewed.reason);
  assert.equal(previewed.architect_preview.selection_changed, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "architect_preview");
  const afterPreview = run(graph, "manage_architect_revisions", {
    operation: "list",
    session_name: "Iron Rod Campus",
  }, architect);
  assert.equal(afterPreview.architect_sessions[0].selected_revision_id, optionAId);

  const deleted = run(graph, "manage_architect_revisions", {
    operation: "delete_draft",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
  }, architect);
  assert.equal(deleted.ok, true, deleted.reason);
  assert.equal(deleted.effects.native_blueprint_files_deleted, false);
});
