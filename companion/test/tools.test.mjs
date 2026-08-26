import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  SOLVER_TOOLS,
  anthropicToolDefinitions,
  openAIToolDefinitions,
  runSolverTool,
  serializeToolResult,
} from "../lib/tools.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const graph = buildGraph(buildFactorySnapshot());

test("every solver tool has a name, description, and object schema", () => {
  assert.ok(SOLVER_TOOLS.length >= 15);
  for (const tool of SOLVER_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.run, "function");
  }
  const names = SOLVER_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
});

test("exposes the roadmap solver set to the model", () => {
  const names = SOLVER_TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "audit_blueprint_placement",
    "clear_highlight",
    "design_base",
    "design_composition",
    "design_factory_layout",
    "design_megabase_concept",
    "diagnose_bottlenecks",
    "find_belt_candidates",
    "find_best_site",
    "find_recipes",
    "get_build_cost",
    "get_factory_summary",
    "get_item_balance",
    "get_machine_rates",
    "get_power_circuits",
    "get_transport_capacity",
    "get_unlock_status",
    "highlight",
    "inspect_blueprint_layout",
    "list_blueprints",
    "locate",
    "perform_actions",
    "plan_belt_route",
    "plan_belted_module",
    "plan_production",
    "plan_splitter_fan_out",
    "plan_structure",
  ]);
});

test("the native Blueprint inspector exposes bounded exact transport and physical-power views", () => {
  const blueprintInspector = SOLVER_TOOLS.find((tool) => tool.name === "inspect_blueprint_layout");
  assert.ok(blueprintInspector);
  assert.equal(blueprintInspector.parameters.properties.maximum_connections.type, "number");
  assert.equal(blueprintInspector.parameters.properties.maximum_power_wires.type, "number");
  assert.match(blueprintInspector.description, /reciprocal conveyor\/pipe component links/i);
  assert.match(blueprintInspector.description, /physical native power-wire endpoint pairs/i);
  assert.match(blueprintInspector.description, /mHiddenConnections logical circuit relationships are deliberately excluded/i);
  assert.match(blueprintInspector.description, /does not infer item\/fluid direction/i);
  assert.match(blueprintInspector.description, /electricity direction\/load\/capacity/i);
});

test("the runtime Blueprint audit describes Resource Anchor evidence and client uncertainty", () => {
  const runtimeAudit = SOLVER_TOOLS.find((tool) => tool.name === "audit_blueprint_placement");
  assert.ok(runtimeAudit);
  assert.match(runtimeAudit.description, /Blueprint Resource Anchors/i);
  assert.match(runtimeAudit.description, /saved resource\/purity/i);
  assert.match(runtimeAudit.description, /client-null transient Anchor node is unknown/i);
});

test("emits the flat Responses API function-tool shape", () => {
  const definitions = openAIToolDefinitions();
  assert.equal(definitions.length, SOLVER_TOOLS.length);
  for (const definition of definitions) {
    assert.equal(definition.type, "function");
    assert.equal(typeof definition.name, "string");
    assert.equal(typeof definition.parameters, "object");
    assert.equal(definition.strict, false);
    assert.equal(definition.function, undefined);
  }
});

test("emits the Messages API tool shape", () => {
  const definitions = anthropicToolDefinitions();
  assert.equal(definitions.length, SOLVER_TOOLS.length);
  for (const definition of definitions) {
    assert.equal(typeof definition.name, "string");
    assert.equal(definition.input_schema.type, "object");
    assert.equal(definition.parameters, undefined);
  }
});

test("dispatches a tool call to its solver", () => {
  const result = runSolverTool(graph, "get_machine_rates", { actor_ids: [SMELTER] });
  const parsed = JSON.parse(result.serialized);

  assert.equal(result.name, "get_machine_rates");
  assert.equal(result.truncated, false);
  assert.equal(parsed.solver, "machine_rates");
  assert.equal(parsed.machines.length, 1);
  assert.equal(parsed.machines[0].actor_id, SMELTER);
});

test("dispatches the belt candidate census as a bounded read-only solver", () => {
  const result = runSolverTool(graph, "find_belt_candidates", { limit: 3 });
  const parsed = JSON.parse(result.serialized);

  assert.equal(result.name, "find_belt_candidates");
  assert.equal(parsed.solver, "belt_candidates");
  assert.ok(Array.isArray(parsed.candidates));
  assert.ok(parsed.candidates.length <= 3);
  assert.equal(parsed.returned_candidate_count, parsed.candidates.length);
});

test("dispatches the aimed runtime Blueprint placement audit without an action sink", () => {
  const auditedGraph = buildGraph(buildFactorySnapshot());
  auditedGraph.snapshot.interaction_context.preferred_target.blueprint_instance_audit = {
    available: true,
    source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
    certainty: "authoritative",
    target_actor_id: SMELTER,
    target_relation: "blueprint_proxy",
    blueprint_proxy_id: SMELTER,
    blueprint_name: "Runtime Test",
    replication_state: "ready",
    proxy_buildings_registered_and_valid: true,
    member_counts_complete: true,
    extractor_observation_complete: true,
    actor_member_count: 0,
    lightweight_member_count: 0,
    member_count: 0,
    extractor_count: 0,
    extractor_binding_counts: { bound: 0, unbound: 0, replication_pending: 0, unknown: 0 },
    extractor_details_returned: 0,
    extractor_details_capped_omitted: 0,
    extractors: [],
  };

  const result = runSolverTool(auditedGraph, "audit_blueprint_placement", {});
  const parsed = JSON.parse(result.serialized);

  assert.equal(result.name, "audit_blueprint_placement");
  assert.equal(parsed.solver, "blueprint_placement_audit");
  assert.equal(parsed.inspection_complete, true);
  assert.equal(parsed.extractor_count, 0);
});

test("treats missing arguments as an empty query", () => {
  for (const argument of [undefined, null, "not-an-object"]) {
    const result = runSolverTool(graph, "get_item_balance", argument);
    assert.equal(JSON.parse(result.serialized).solver, "item_balance");
  }
});

test("reports an unknown tool name with the available names", () => {
  const result = runSolverTool(graph, "get_everything", {});
  const parsed = JSON.parse(result.serialized);
  assert.match(parsed.error, /Unknown solver tool/);
  assert.ok(parsed.available_tools.includes("get_machine_rates"));
});

test("turns a solver crash into an explicit unknown", () => {
  const brokenGraph = { ...graph, nodes: null };
  const result = runSolverTool(brokenGraph, "get_machine_rates", {});
  const parsed = JSON.parse(result.serialized);
  assert.match(parsed.error, /Solver failed/);
  assert.match(parsed.policy, /unknown/);
});

test("transport capacity defaults to problems only through the tool layer", () => {
  const defaulted = JSON.parse(runSolverTool(graph, "get_transport_capacity", {}).serialized);
  const everything = JSON.parse(
    runSolverTool(graph, "get_transport_capacity", { only_problems: false }).serialized,
  );
  assert.equal(defaulted.conveyors.length, 1);
  assert.equal(everything.conveyors.length, 2);
});

test("caps oversized results and records what was truncated", () => {
  const big = { solver: "test", world_revision: 1, rows: Array.from({ length: 500 }, (_, index) => ({ index })) };
  const bounded = serializeToolResult(big, 2000);
  const parsed = JSON.parse(bounded.serialized);

  assert.equal(bounded.truncated, true);
  assert.ok(parsed.rows.length < 500);
  assert.equal(parsed.tool_result_truncation.array_item_limit, bounded.array_item_limit);
  assert.ok(parsed.tool_result_truncation.truncated_paths.some((path) => path.startsWith("rows[")));
  assert.match(parsed.tool_result_truncation.policy, /treated as unknown/);
  assert.ok(bounded.serialized.length <= 2000);
});

test("leaves a result that already fits untouched", () => {
  const small = { solver: "test", rows: [1, 2, 3] };
  const bounded = serializeToolResult(small, 100_000);
  assert.equal(bounded.truncated, false);
  assert.equal(JSON.parse(bounded.serialized).tool_result_truncation, undefined);
});

test("falls back to a narrow-your-question notice when nothing fits", () => {
  const wide = {
    solver: "machine_rates",
    world_revision: 3,
    note: "x".repeat(5000),
  };
  const bounded = serializeToolResult(wide, 200);
  const parsed = JSON.parse(bounded.serialized);
  assert.equal(parsed.solver, "machine_rates");
  assert.match(parsed.error, /exceeded the tool result budget/);
  assert.match(parsed.policy, /narrower question/);
});
