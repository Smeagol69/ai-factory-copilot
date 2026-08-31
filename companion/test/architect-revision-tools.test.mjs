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

function run(graph, name, args, architect) {
  return JSON.parse(runSolverTool(
    graph,
    name,
    args,
    { services: { architect, actions: { emit: () => {} } } },
  ).serialized);
}

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

  const rollback = run(graph, "manage_architect_revisions", {
    operation: "rollback",
    session_name: "Iron Rod Campus",
    revision_id: optionAId,
  }, architect);
  assert.equal(rollback.ok, true, rollback.reason);
  assert.equal(rollback.operation, "rollback");
  assert.equal(rollback.selected_revision_id, optionAId);

  const deleted = run(graph, "manage_architect_revisions", {
    operation: "delete_draft",
    session_name: "Iron Rod Campus",
    revision_id: optionBId,
  }, architect);
  assert.equal(deleted.ok, true, deleted.reason);
  assert.equal(deleted.effects.native_blueprint_files_deleted, false);
});
