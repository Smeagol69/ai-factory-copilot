import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  getCurrentSessionBlueprintRegistry,
  resolveCurrentSessionBlueprint,
} from "../lib/blueprint-session.mjs";
import { solveBlueprintLibrary } from "../lib/solvers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

function graphOf(names = [], { captured = true } = {}) {
  const graph = buildGraph(buildFactorySnapshot());
  graph.snapshot.world.session_name = "Playthrough";
  if (captured) {
    graph.snapshot.blueprint_library = {
      available: true,
      complete: true,
      registered_descriptor_count: names.length,
      registered_blueprint_names: names,
    };
  }
  return graph;
}

test("active Blueprint descriptors resolve case-insensitively to the game's spelling", () => {
  const graph = graphOf(["Copper Starter"]);
  const result = resolveCurrentSessionBlueprint(graph, "cOpPeR sTaRtEr");

  assert.equal(result.registered, true);
  assert.equal(result.blueprint_name, "Copper Starter");
  assert.equal(result.session_name, "Playthrough");
});

test("a captured empty active library is distinct from an uncaptured one", () => {
  const empty = getCurrentSessionBlueprintRegistry(graphOf());
  assert.equal(empty.available, true);
  assert.deepEqual(empty.names, []);

  const unknown = getCurrentSessionBlueprintRegistry(graphOf([], { captured: false }));
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, "blueprint_current_session_library_not_captured");
});

test("a partially serialised native registry is unknown, never treated as an empty library", () => {
  const graph = graphOf(["Visible Module"]);
  graph.snapshot.blueprint_library.complete = false;
  graph.snapshot.blueprint_library.reason =
    "one_or_more_registered_blueprint_descriptors_could_not_be_named";

  const registry = getCurrentSessionBlueprintRegistry(graph);
  const result = resolveCurrentSessionBlueprint(graph, "Hidden Module");
  assert.equal(registry.available, false);
  assert.equal(registry.reason, "one_or_more_registered_blueprint_descriptors_could_not_be_named");
  assert.equal(result.registered, false);
  assert.equal(result.reason, "one_or_more_registered_blueprint_descriptors_could_not_be_named");
});

test("blueprint listing says when an inspectable disk file cannot be armed in this save", () => {
  const result = solveBlueprintLibrary(graphOf(["Current Session Module"]), {}, {
    listBlueprints: () => [{
      name: "Archived Coal Plant",
      relative_path: "BP test/Archived Coal Plant.sbp",
      blueprint_reference: "BP test/Archived Coal Plant.sbp",
      contents: { recipes: [] },
      build_cost: [],
    }],
  });

  assert.equal(result.current_session_library.available, true);
  assert.equal(result.current_session_library.session_name, "Playthrough");
  assert.equal(result.blueprints[0].registered_in_current_session, false);
  assert.equal(
    result.blueprints[0].current_session_registration_reason,
    "blueprint_not_registered_for_current_session",
  );
});
