/**
 * Native whole-factory export is deliberately a bridge contract test, not a
 * fake `.sbp` writer. The game owns serialisation, proxy/lightweight handling,
 * extractor anchors, and the final archive result; the bridge only proves that
 * it handed the game one exact player-marked selection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateAction, validatePlan } from "../lib/actions.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { parseNativeBlueprintExportRequest, answerLocally } from "../lib/router.mjs";
import { SOLVER_TOOLS } from "../lib/tools.mjs";
import { MINER, SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const SELECTED = [MINER, SMELTER];

function graphWithNativeExportSelection({ selectedIds = SELECTED, count = selectedIds.length } = {}) {
  const snapshot = buildFactorySnapshot();
  for (const [index, actorId] of SELECTED.entries()) {
    const actor = snapshot.actors.find((entry) => entry.actor_id === actorId);
    // The scanner emits these for real AFGBuildables. Deliberately make the
    // boxes asymmetric so the test proves an envelope is calculated, not
    // copied from an actor centre or a hard-coded designer size.
    actor.bounds = {
      origin: { x: 1_000 + index * 2_000, y: 2_000, z: 300 + index * 100 },
      extent: { x: 150 + index * 10, y: 250 + index * 10, z: 350 + index * 10 },
    };
  }
  snapshot.interaction_context.dismantle_selection = {
    available: true,
    actor_ids: selectedIds,
    count,
    note: "Actors marked with the dismantle tool. Read only.",
  };
  return buildGraph(snapshot);
}

function exportProposal(overrides = {}) {
  return {
    action: "export_native_blueprint",
    blueprint_name: "Northern Steel Works",
    selection_source: "dismantle_selection",
    selected_actor_ids: SELECTED,
    commit: true,
    ...overrides,
  };
}

function sink() {
  const emitted = [];
  return { emitted, actions: { emit: (actions) => emitted.push(...actions) } };
}

test("parses only an explicit native whole-factory export request", () => {
  assert.deepEqual(
    parseNativeBlueprintExportRequest('export this factory as blueprint "Northern Steel Works"'),
    { name: "Northern Steel Works" },
  );
  assert.deepEqual(
    parseNativeBlueprintExportRequest("please package selected base as a native blueprint called Sky Foundry"),
    { name: "Sky Foundry" },
  );
  for (const question of [
    "save this as a blueprint",
    "how do i export a factory as a blueprint",
    "export this factory",
    "export all factories as blueprint everything",
    "place northern steel works blueprint here",
  ]) {
    assert.equal(parseNativeBlueprintExportRequest(question), null, question);
  }
});

test("native export action is bound to the exact captured dismantle selection and its measured envelope", () => {
  const graph = graphWithNativeExportSelection();
  const result = validateAction(graph, exportProposal());

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.deepEqual(result.action.selected_actor_ids, SELECTED);
  assert.equal(result.action.selection_source, "dismantle_selection");
  assert.equal(result.action.selected_actor_count, 2);
  assert.equal(result.action.expect_world_revision, "41");
  assert.equal(result.action.require_unchanged_world, false);
  assert.deepEqual(result.action.captured_selection_bounds_cm, {
    minimum: { x: 850, y: 1_740, z: -50 },
    maximum: { x: 3_160, y: 2_260, z: 760 },
    units: "unreal_centimeters",
  });
  assert.equal(result.checks.bounds_are_capture_evidence_only, true);
  assert.equal(result.checks.arbitrary_export_size_cap, "none");
  assert.match(result.warnings.join(" "), /not proof that an .sbp was written/i);
});

test("a model cannot replace, subset, or invent the player's export selection", () => {
  const graph = graphWithNativeExportSelection();
  for (const selectedActorIds of [[MINER], [SMELTER, MINER, "Invented"], [MINER, MINER]]) {
    const result = validateAction(graph, exportProposal({ selected_actor_ids: selectedActorIds }));
    assert.equal(result.valid, false, JSON.stringify(selectedActorIds));
    assert.match(result.reason, /selected_actor_ids/);
  }
  assert.equal(
    validateAction(graph, exportProposal({ selection_source: "radius" })).reason,
    "native_blueprint_export_requires_dismantle_selection",
  );
});

test("export refuses missing selection evidence rather than guessing a radius or crosshair region", () => {
  const noSelectionSnapshot = buildFactorySnapshot();
  const noSelection = validateAction(buildGraph(noSelectionSnapshot), exportProposal());
  assert.equal(noSelection.valid, false);
  assert.equal(noSelection.reason, "dismantle_selection_is_not_available");

  const empty = graphWithNativeExportSelection({ selectedIds: [], count: 0 });
  const emptyResult = validateAction(empty, exportProposal({ selected_actor_ids: [] }));
  assert.equal(emptyResult.valid, false);
  assert.equal(emptyResult.reason, "selected_actor_ids_are_required");
});

test("an export has no arbitrary factory-size cap, but the durable file write is standalone", () => {
  const actorIds = Array.from({ length: 600 }, (_, index) => `Buildable_${index}`);
  const graph = buildGraph({
    world_revision: 88,
    interaction_context: {
      dismantle_selection: { available: true, actor_ids: actorIds, count: actorIds.length },
    },
    actors: actorIds.map((actor_id, index) => ({
      actor_id,
      name: actor_id,
      kind: "buildable",
      class_path: "/Game/Test.Build_Test_C",
      location: { x: index * 100, y: 0, z: 0 },
      bounds: { origin: { x: index * 100, y: 0, z: 0 }, extent: { x: 50, y: 50, z: 50 } },
    })),
  });
  const exportAction = {
    action: "export_native_blueprint",
    blueprint_name: "Six Hundred Selected Buildings",
    selection_source: "dismantle_selection",
    selected_actor_ids: actorIds,
    commit: true,
  };
  const accepted = validatePlan(graph, [exportAction]);
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  assert.equal(accepted.actions[0].selected_actor_count, 600);

  const mixed = validatePlan(graph, [
    exportAction,
    { action: "waypoint", location: { x: 0, y: 0, z: 0 }, commit: true },
  ]);
  assert.equal(mixed.valid, false);
  assert.equal(mixed.reason, "native_blueprint_export_must_be_a_standalone_commit");
});

test("the local route submits a request but never claims an .sbp already exists", () => {
  const services = sink();
  const answer = answerLocally(
    "export this factory as blueprint Northern Steel Works",
    graphWithNativeExportSelection(),
    services,
  );

  assert.equal(answer?.local?.solver, "native_blueprint_export");
  assert.match(answer.reply, /submitted a native blueprint export request/i);
  assert.match(answer.reply, /not.*saved yet/i);
  assert.match(answer.reply, /game-side exporter/i);
  assert.equal(services.emitted.length, 1);
  assert.equal(services.emitted[0].action, "export_native_blueprint");
  assert.deepEqual(services.emitted[0].selected_actor_ids, SELECTED);
  assert.equal(services.emitted[0].commit, true);
});

test("the model-facing action schema exposes only the selection contract, not a guessed region", () => {
  const performActions = SOLVER_TOOLS.find((tool) => tool.name === "perform_actions");
  const item = performActions.parameters.properties.actions.items;
  assert.ok(item.properties.action.enum.includes("export_native_blueprint"));
  assert.deepEqual(item.properties.selection_source.enum, ["dismantle_selection"]);
  assert.match(item.properties.selected_actor_ids.description, /exactly once/i);
  assert.equal(item.properties.captured_selection_bounds_cm, undefined);
  assert.equal(item.properties.radius_cm, undefined);
});

test("the phrasings people actually use all reach the exporter", async () => {
  const { parseNativeBlueprintExportRequest, parseDesignSaveRequest } =
    await import("../lib/router.mjs");

  // The original pattern took only "export this factory as blueprint X".
  // Everything else here failed, which is the same narrowness the routing log
  // kept exposing on other routes.
  const expected = {
    "export this factory as blueprint Northern Steel Works": "Northern Steel Works",
    "save this selection as a blueprint called Mega Base": "Mega Base",
    "export selected as blueprint MegaBase": "MegaBase",
    "save this megabase as a native blueprint called Home": "Home",
    "package my base as blueprint Ross": "Ross",
  };
  for (const [question, name] of Object.entries(expected)) {
    assert.equal(parseNativeBlueprintExportRequest(question)?.name, name, question);
  }
});

test("widening the export verb does not steal a design save", async () => {
  const { parseNativeBlueprintExportRequest, parseDesignSaveRequest } =
    await import("../lib/router.mjs");

  // Accepting "save" here is the risky part: "save this as mk1 copper" is the
  // design route, and parseDesignSaveRequest even strips a trailing
  // "blueprint". The word "blueprint" in the middle is what separates them.
  for (const question of [
    "save this as mk1 copper",
    "save this as bench mk1",
    "save this as a mk1 copper blueprint",
  ]) {
    assert.equal(parseNativeBlueprintExportRequest(question), null, question);
    assert.ok(parseDesignSaveRequest(question), `${question} should still be a design save`);
  }
});
