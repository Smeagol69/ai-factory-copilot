import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  SYSTEM_INSTRUCTIONS,
  SolverGroundingError,
  askAnthropic,
  askLocal,
  askMock,
  askOpenAI,
  missingRequiredSolverGrounding,
  solverEvidenceMetadata,
  userInput,
} from "../lib/providers.mjs";
import { runSolverTool } from "../lib/tools.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const snapshot = buildFactorySnapshot();

function makeContext(overrides = {}) {
  return {
    question: "Give me a concise status acknowledgement.",
    snapshot,
    serializedSnapshot: JSON.stringify(snapshot),
    serializedDerivedFacts: "{}",
    serializedAnalysisDigest: '{"schema":"aifactory.analysis_digest"}',
    omissions: [],
    summary: { world_revision: 41, actors: 9, recipes: 5, items: 6, mods: 1, actors_by_owner_mod: {} },
    graph: buildGraph(snapshot),
    history: [],
    ...overrides,
  };
}

/** Replaces global fetch with a queue of canned JSON responses. */
function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`Unexpected fetch call ${calls.length}`);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.json,
      text: async () => JSON.stringify(next.json),
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("system instructions require solver tools for quantitative claims", () => {
  assert.match(SYSTEM_INSTRUCTIONS, /Call the deterministic solver tools/);
  assert.match(SYSTEM_INSTRUCTIONS, /diagnose_bottlenecks/);
  assert.match(SYSTEM_INSTRUCTIONS, /find_belt_candidates/);
  assert.match(SYSTEM_INSTRUCTIONS, /audit_blueprint_placement/);
  assert.match(SYSTEM_INSTRUCTIONS, /the solver\s*\n?is correct/);
});

test("the analysis digest is offered to the model as a headline only", () => {
  const text = userInput(makeContext());
  assert.match(text, /DETERMINISTIC ANALYSIS DIGEST/);
  assert.match(text, /call solver tools for detail/);
});

test("userInput omits the digest section when none was supplied", () => {
  const text = userInput({ ...makeContext(), serializedAnalysisDigest: undefined });
  assert.doesNotMatch(text, /DETERMINISTIC ANALYSIS DIGEST/);
});

test("openai runs a requested solver and feeds the result back", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "resp_1",
        output: [
          {
            type: "function_call",
            name: "get_power_circuits",
            call_id: "call_1",
            arguments: JSON.stringify({ circuit_id: 1 }),
          },
        ],
      },
    },
    {
      json: {
        id: "resp_2",
        output_text: "Circuit 1 is 25 MW short.",
        output: [{ type: "message", content: [{ type: "output_text", text: "Circuit 1 is 25 MW short." }] }],
      },
    },
  ]);

  try {
    const answer = await askOpenAI(
      makeContext({ question: "What is power circuit 1 doing?" }),
      { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
    );

    assert.equal(stub.calls.length, 2);
    assert.equal(answer.reply, "Circuit 1 is 25 MW short.");
    assert.equal(answer.response_id, "resp_2");
    assert.deepEqual(answer.solver_calls[0].arguments, { circuit_id: 1 });
    assert.equal(answer.solver_calls[0].tool, "get_power_circuits");
    assert.deepEqual(answer.solver_calls[0].evidence, {
      usable: true,
      reason: "usable",
      source: "authoritative_power_circuit_state",
      certainty: "calculated",
      row_count: 1,
      target_match: true,
    });

    const secondInput = stub.calls[1].body.input;
    const toolOutput = secondInput.find((item) => item.type === "function_call_output");
    assert.equal(toolOutput.call_id, "call_1");
    const solverResult = JSON.parse(toolOutput.output);
    assert.equal(solverResult.solver, "power_circuits");
    assert.equal(solverResult.circuits[0].headroom_mw, -25);
    // The model's own tool call is resent because store is false.
    assert.ok(secondInput.some((item) => item.type === "function_call"));
    assert.equal(stub.calls[1].body.store, false);
  } finally {
    stub.restore();
  }
});

test("openai advertises solver tools alongside web search", async () => {
  const stub = stubFetch([{ json: { id: "r", output_text: "done", output: [] } }]);
  try {
    await askOpenAI(makeContext(), { OPENAI_API_KEY: "test" });
    const tools = stub.calls[0].body.tools;
    assert.ok(tools.some((tool) => tool.type === "web_search"));
    assert.ok(tools.some((tool) => tool.name === "diagnose_bottlenecks"));
  } finally {
    stub.restore();
  }
});

test("openai prompt says search is unavailable when its search tool is disabled", async () => {
  const stub = stubFetch([{ json: { id: "r", output_text: "done", output: [] } }]);
  try {
    await askOpenAI(makeContext(), {
      OPENAI_API_KEY: "test",
      OPENAI_WEB_SEARCH: "false",
    });
    assert.match(stub.calls[0].body.instructions, /web search is turned off/);
    assert.doesNotMatch(stub.calls[0].body.instructions, /docs\.ficsit\.app/);
    assert.ok(
      !(stub.calls[0].body.tools ?? []).some((tool) => tool.type === "web_search"),
    );
  } finally {
    stub.restore();
  }
});

test("openai omits solver tools when no graph was built", async () => {
  const stub = stubFetch([{ json: { id: "r", output_text: "done", output: [] } }]);
  try {
    await askOpenAI(makeContext({ graph: undefined }), {
      OPENAI_API_KEY: "test",
      OPENAI_WEB_SEARCH: "false",
    });
    assert.equal(stub.calls[0].body.tools, undefined);
  } finally {
    stub.restore();
  }
});

test("openai stops after the configured solver round limit", async () => {
  const toolRound = {
    json: {
      id: "loop",
      usage: { input_tokens: 10, output_tokens: 2 },
      output: [
        { type: "function_call", name: "get_item_balance", call_id: "c", arguments: "{}" },
      ],
    },
  };
  const stub = stubFetch(Array.from({ length: 12 }, () => toolRound));
  try {
    let caught;
    try {
      await askOpenAI(makeContext(), {
        OPENAI_API_KEY: "test",
        OPENAI_WEB_SEARCH: "false",
        AIFACTORY_MAX_SOLVER_ROUNDS: "2",
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? "", /kept requesting solver tools after 2 rounds/);
    assert.equal(caught?.provider, "openai");
    assert.equal(caught?.model, "gpt-5.6-sol");
    assert.equal(caught?.response_id, "loop");
    assert.deepEqual(caught?.usage, {
      input_tokens: 30,
      output_tokens: 6,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    assert.equal(caught?.cache?.effective_input_tokens, 30);
  } finally {
    stub.restore();
  }
});

test("openai surfaces a malformed tool argument list as an empty query", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "r1",
        output: [{ type: "function_call", name: "get_item_balance", call_id: "c1", arguments: "{not json" }],
      },
    },
    { json: { id: "r2", output_text: "ok", output: [] } },
  ]);
  try {
    const answer = await askOpenAI(makeContext(), { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" });
    assert.deepEqual(answer.solver_calls[0].arguments, {});
    const output = stub.calls[1].body.input.find((item) => item.type === "function_call_output");
    assert.equal(JSON.parse(output.output).solver, "item_balance");
  } finally {
    stub.restore();
  }
});

test("anthropic runs a requested solver and returns a tool_result turn", async () => {
  const stub = stubFetch([
    {
      json: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Checking the balance." },
          { type: "tool_use", id: "tu_1", name: "get_item_balance", input: { item_class: "Desc_LiquidOil" } },
        ],
      },
    },
    {
      json: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Crude oil is 30 m3/min short." }],
      },
    },
  ]);

  try {
    const answer = await askAnthropic(
      makeContext({ question: "What is my crude oil balance per minute?" }),
      {
        ANTHROPIC_API_KEY: "test",
        ANTHROPIC_MODEL: "claude-test",
      },
    );

    assert.equal(stub.calls.length, 2);
    assert.equal(answer.reply, "Crude oil is 30 m3/min short.");
    assert.equal(answer.solver_calls[0].tool, "get_item_balance");

    const messages = stub.calls[1].body.messages;
    assert.equal(messages.at(-2).role, "assistant");
    assert.equal(messages.at(-1).role, "user");
    const toolResult = messages.at(-1).content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "tu_1");
    const parsed = JSON.parse(toolResult.content);
    assert.equal(parsed.items[0].net_display_units_per_minute, -30);
    assert.ok(stub.calls[0].body.tools.some((tool) => tool.name === "get_item_balance"));
  } finally {
    stub.restore();
  }
});

test("anthropic still requires an explicit model", async () => {
  await assert.rejects(
    () => askAnthropic(makeContext(), { ANTHROPIC_API_KEY: "test" }),
    /ANTHROPIC_MODEL must be explicitly configured/,
  );
});

test("anthropic honours a configured max token budget", async () => {
  const stub = stubFetch([{ json: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }]);
  try {
    await askAnthropic(makeContext(), {
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_MODEL: "claude-test",
      ANTHROPIC_MAX_TOKENS: "4096",
    });
    assert.equal(stub.calls[0].body.max_tokens, 4096);
  } finally {
    stub.restore();
  }
});

test("anthropic errors retain billed usage and model metadata", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "anthropic-failure",
        stop_reason: "end_turn",
        content: [],
        usage: {
          input_tokens: 40,
          output_tokens: 5,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    },
  ]);
  try {
    let caught;
    try {
      await askAnthropic(makeContext(), {
        ANTHROPIC_API_KEY: "test",
        ANTHROPIC_MODEL: "claude-test",
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? "", /returned no text content/);
    assert.equal(caught?.provider, "anthropic");
    assert.equal(caught?.model, "claude-test");
    assert.equal(caught?.response_id, "anthropic-failure");
    assert.deepEqual(caught?.usage, {
      input_tokens: 40,
      output_tokens: 5,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    });
    assert.equal(caught?.cache?.effective_input_tokens, 55);
  } finally {
    stub.restore();
  }
});

test("a live-game answer is withheld when the required solver was skipped", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "ungrounded",
        usage: {
          input_tokens: 123,
          input_tokens_details: { cached_tokens: 23 },
          output_tokens: 7,
        },
        output_text: "Your grid has 400 MW of capacity.",
        output: [],
      },
    },
  ]);
  try {
    let caught;
    try {
      await askOpenAI(
        makeContext({ question: "What is my current power capacity?" }),
        { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SolverGroundingError);
    assert.match(caught.message, /required solver tool\(s\): get_power_circuits/);
    assert.doesNotMatch(caught.message, /400 MW/);
    assert.equal(caught.code, "solver_grounding_required");
    assert.equal(caught.provider, "openai");
    assert.equal(caught.model, "gpt-5.6-sol");
    assert.equal(caught.response_id, "ungrounded");
    assert.deepEqual(caught.usage, {
      input_tokens: 100,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 23,
    });
    assert.equal(caught.cache.saved_input_tokens, 21);
  } finally {
    stub.restore();
  }
});

test("failed, unknown, empty, and wrong-target tool results are not grounding evidence", () => {
  const context = makeContext({ question: "What is power circuit 1 doing?" });
  const graph = context.graph;
  const cases = [
    {
      label: "failed",
      result: runSolverTool({}, "get_power_circuits", {}),
      args: {},
      reason: "solver_error",
    },
    {
      label: "unknown",
      result: {
        serialized: JSON.stringify({
          solver: "power_circuits",
          certainty: "unknown",
          circuits: [{ circuit_id: 1 }],
        }),
        truncated: false,
      },
      args: { circuit_id: 1 },
      reason: "unknown_result",
    },
    {
      label: "empty",
      result: runSolverTool(graph, "get_power_circuits", { circuit_id: 999 }),
      args: { circuit_id: 999 },
      reason: "empty_result",
    },
    {
      label: "wrong target",
      result: runSolverTool(graph, "get_power_circuits", { circuit_id: 2 }),
      args: { circuit_id: 2 },
      reason: "target_mismatch",
    },
  ];

  for (const entry of cases) {
    const evidence = solverEvidenceMetadata(
      context,
      "get_power_circuits",
      entry.args,
      entry.result,
    );
    assert.equal(evidence.usable, false, entry.label);
    assert.equal(evidence.reason, entry.reason, entry.label);
    assert.ok(
      missingRequiredSolverGrounding(context.question, [
        { tool: "get_power_circuits", evidence },
      ]).length > 0,
      entry.label,
    );
  }
});

test("a refused route cannot ground a model claim that the route is valid", () => {
  const context = makeContext({
    question: "Using plan_belt_route only, check this belt to this merger.",
  });
  const evidence = solverEvidenceMetadata(
    context,
    "plan_belt_route",
    { from_actor_id: "belt", to_actor_id: "merger" },
    {
      serialized: JSON.stringify({
        solver: "belt_route",
        routed: false,
        reason: "the connectors are already touching",
      }),
      truncated: false,
    },
  );

  assert.equal(evidence.usable, false);
  assert.equal(evidence.reason, "unknown_result");
  assert.deepEqual(
    missingRequiredSolverGrounding(context.question, [
      { tool: "plan_belt_route", evidence },
    ]),
    [["plan_belt_route"]],
  );
});

test("naming a solver requires usable evidence from that exact solver", () => {
  const question =
    "Using plan_belt_route only, check these two captured actors without changing anything.";
  assert.deepEqual(missingRequiredSolverGrounding(question, []), [["plan_belt_route"]]);
  assert.deepEqual(
    missingRequiredSolverGrounding(question, [
      { tool: "plan_belt_route", evidence: { usable: true } },
    ]),
    [],
  );
});

test("local provider forces one explicitly named solver on its first round", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "local-tool-call",
        usage: { prompt_tokens: 20, completion_tokens: 4 },
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "local-call-1",
              type: "function",
              function: { name: "get_factory_summary", arguments: "{}" },
            }],
          },
        }],
      },
    },
    {
      json: {
        id: "local-final",
        usage: { prompt_tokens: 30, completion_tokens: 8 },
        choices: [{ message: { role: "assistant", content: "The solver returned the factory summary." } }],
      },
    },
  ]);
  try {
    const answer = await askLocal(
      makeContext({ question: "Using get_factory_summary only, report the captured factory." }),
      { LOCAL_AI_MODEL: "local-test" },
    );

    assert.deepEqual(stub.calls[0].body.tool_choice, {
      type: "function",
      function: { name: "get_factory_summary" },
    });
    assert.deepEqual(
      stub.calls[0].body.tools.map((tool) => tool.function.name),
      ["get_factory_summary"],
    );
    assert.equal(stub.calls[0].body.reasoning_effort, "none");
    assert.match(
      stub.calls[0].body.messages.map((message) => message.content).join("\n"),
      /CURRENT-TURN AUTHORITATIVE WORLD SNAPSHOT/,
    );
    assert.equal(stub.calls[1].body.tool_choice, "auto");
    assert.equal(answer.solver_calls[0].tool, "get_factory_summary");
  } finally {
    stub.restore();
  }
});

test("local provider leaves tool selection automatic when multiple solvers are named", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "local-multi",
        choices: [{ message: { role: "assistant", content: "Which comparison do you want?" } }],
      },
    },
  ]);
  try {
    await askLocal(
      makeContext({ question: "Should I use plan_production or design_factory_layout?" }),
      { LOCAL_AI_MODEL: "local-test", LOCAL_AI_BASE_URL: "http://lmstudio:1234/v1" },
    );
    assert.equal(stub.calls[0].body.tool_choice, "auto");
    assert.equal(stub.calls[0].body.reasoning_effort, undefined);
  } finally {
    stub.restore();
  }
});

test("local megabase dispatch uses the compact core schema", async () => {
  const argumentsJson = JSON.stringify({
    item_name: "Iron Plate",
    target_rate_per_minute: 5,
    origin: { x: 1000, y: 2000, z: 3000 },
    style: "elevated_industrial_campus",
  });
  const stub = stubFetch([
    {
      json: {
        id: "megabase-call",
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "megabase-1",
            type: "function",
            function: { name: "design_megabase_concept", arguments: argumentsJson },
          }],
        } }],
      },
    },
    {
      json: {
        id: "megabase-final",
        choices: [{ message: {
          role: "assistant",
          content: "The preview remains concept-only and is not construction-ready.",
        } }],
      },
    },
  ]);
  try {
    let caught;
    try {
      await askLocal(
        makeContext({ question: "Using design_megabase_concept only, preview 5 Iron Plate per minute." }),
        { LOCAL_AI_MODEL: "local-test" },
      );
    } catch (error) {
      caught = error;
    }
    const definition = stub.calls[0].body.tools[0].function;
    assert.deepEqual(Object.keys(definition.parameters.properties), [
      "item_name",
      "target_rate_per_minute",
      "origin",
      "style",
      "design_family_id",
      "match_design_family_fingerprint",
      "commissioning_phases",
    ]);
    assert.deepEqual(definition.parameters.required, [
      "item_name",
      "target_rate_per_minute",
      "origin",
      "style",
    ]);
    assert.equal(definition.parameters.properties.creative_parameters, undefined);
    assert.equal(
      stub.calls[0].body.messages.at(-1).content,
      "Using design_megabase_concept only, preview 5 Iron Plate per minute.",
    );
    assert.doesNotMatch(
      stub.calls[0].body.messages.map((message) => message.content).join("\n"),
      /CURRENT-TURN AUTHORITATIVE WORLD SNAPSHOT/,
    );
    // This fixture lacks the measured height/footprint data the real save has,
    // so grounding correctly rejects its result; the provider must still have
    // dispatched the exact named tool with the compact schema.
    assert.ok(caught instanceof SolverGroundingError);
    assert.equal(caught.solver_calls[0].tool, "design_megabase_concept");
  } finally {
    stub.restore();
  }
});

test("local structure dispatch replaces an invented origin with captured player XYZ", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "structure-call",
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "structure-1",
            type: "function",
            function: {
              name: "plan_structure",
              arguments: JSON.stringify({
                origin_cm: { x: 0, y: 0, z: 0 },
                width_cells: 2,
                depth_cells: 2,
                height_cm: 400,
              }),
            },
          }],
        } }],
      },
    },
    {
      json: {
        id: "structure-final",
        choices: [{ message: { role: "assistant", content: "The structure preview was refused." } }],
      },
    },
  ]);
  try {
    const capturedPosition = { x: 12345, y: -6789, z: 4321 };
    let caught;
    try {
      await askLocal(
        makeContext({
          question: "Using plan_structure only, preview a shell at my captured position.",
          snapshot: {
            ...snapshot,
            interaction_context: {
              ...snapshot.interaction_context,
              player: {
                ...snapshot.interaction_context.player,
                pawn_location: capturedPosition,
              },
            },
          },
        }),
        { LOCAL_AI_MODEL: "local-test" },
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SolverGroundingError);
    assert.deepEqual(caught.solver_calls[0].arguments.origin_cm, capturedPosition);
    assert.notDeepEqual(caught.solver_calls[0].arguments.origin_cm, { x: 0, y: 0, z: 0 });
  } finally {
    stub.restore();
  }
});

test("local architecture dispatch parses labeled XYZ instead of trusting model coordinates", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "structure-explicit-call",
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "structure-explicit-1",
            type: "function",
            function: {
              name: "plan_structure",
              arguments: JSON.stringify({
                origin_cm: { x: 9, y: 9, z: 9 },
                width_cells: 2,
                depth_cells: 2,
              }),
            },
          }],
        } }],
      },
    },
    {
      json: {
        id: "structure-explicit-final",
        choices: [{ message: { role: "assistant", content: "The structure preview was refused." } }],
      },
    },
  ]);
  try {
    let caught;
    try {
      await askLocal(
        makeContext({ question: "Using plan_structure only at x=1234.5, y=-20, z=987." }),
        { LOCAL_AI_MODEL: "local-test" },
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SolverGroundingError);
    assert.deepEqual(caught.solver_calls[0].arguments.origin_cm, {
      x: 1234.5,
      y: -20,
      z: 987,
    });
  } finally {
    stub.restore();
  }
});

test("free belt-pair claims require the candidate solver, not the transport-capacity solver", () => {
  const question = "List every recipe-compatible pair with free conveyor ports in my factory.";
  assert.deepEqual(missingRequiredSolverGrounding(question, []), [["find_belt_candidates"]]);

  const context = makeContext({ question });
  const result = {
    serialized: JSON.stringify({
      solver: "belt_candidates",
      candidate_count: 1,
      candidates: [{ from: { actor_id: "Source" }, to: { actor_id: "Target" } }],
      source: "authoritative_snapshot_recipe_compatibility_and_connector_geometry",
      certainty: "exact_for_captured_data_except_game_owned_hologram_checks",
    }),
    truncated: false,
  };
  const evidence = solverEvidenceMetadata(context, "find_belt_candidates", { limit: 25 }, result);
  assert.equal(evidence.usable, true);
  assert.deepEqual(
    missingRequiredSolverGrounding(question, [
      { tool: "find_belt_candidates", evidence },
    ]),
    [],
  );
});

test("a complete zero-candidate census can ground a truthful absence", () => {
  const question = "Are there any free conveyor pairs in my factory?";
  const context = makeContext({ question });
  const result = {
    serialized: JSON.stringify({
      solver: "belt_candidates",
      candidate_count: 0,
      candidates: [],
      source: "authoritative_snapshot_recipe_compatibility_and_connector_geometry",
      certainty: "exact_for_captured_data_except_game_owned_hologram_checks",
    }),
    truncated: false,
  };
  const evidence = solverEvidenceMetadata(context, "find_belt_candidates", {}, result);
  assert.equal(evidence.usable, true);
  assert.deepEqual(
    missingRequiredSolverGrounding(question, [
      { tool: "find_belt_candidates", evidence },
    ]),
    [],
  );
});

test("runtime Blueprint placement auditing has its own grounding and preserves replication-pending evidence", () => {
  const question = "Check this blueprint placement and tell me whether its miner is bound.";
  const context = makeContext({ question });
  assert.deepEqual(missingRequiredSolverGrounding(question, []), [["audit_blueprint_placement"]]);

  const pending = {
    serialized: JSON.stringify({
      solver: "blueprint_placement_audit",
      available: true,
      inspection_complete: false,
      target_actor_id: SMELTER,
      replication_state: "replication_pending",
      source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
      certainty: "partial",
    }),
    truncated: false,
  };
  const evidence = solverEvidenceMetadata(context, "audit_blueprint_placement", {}, pending);
  assert.deepEqual(evidence, {
    usable: true,
    reason: "usable",
    source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
    certainty: "partial",
    row_count: 1,
    target_match: true,
  });
  assert.deepEqual(
    missingRequiredSolverGrounding(question, [{ tool: "audit_blueprint_placement", evidence }]),
    [],
  );

  const fallbackEvidence = solverEvidenceMetadata(
    context,
    "audit_blueprint_placement",
    {},
    {
      ...pending,
      serialized: JSON.stringify({
        ...JSON.parse(pending.serialized),
        target_actor_id: "Camera-visible Blueprint miner",
        audited_actor_id: "Camera-visible Blueprint miner",
        preferred_target_actor_id: SMELTER,
        selected_from: "camera_visibility_trace_fallback",
      }),
    },
  );
  assert.equal(fallbackEvidence.usable, true);
  assert.equal(fallbackEvidence.target_match, true);

  const wrongTarget = solverEvidenceMetadata(
    context,
    "audit_blueprint_placement",
    {},
    {
      ...pending,
      serialized: JSON.stringify({
        ...JSON.parse(pending.serialized),
        target_actor_id: "A different aimed actor",
      }),
    },
  );
  assert.equal(wrongTarget.usable, false);
  assert.equal(wrongTarget.reason, "target_mismatch");

  const unavailable = solverEvidenceMetadata(
    context,
    "audit_blueprint_placement",
    {},
    {
      serialized: JSON.stringify({
        solver: "blueprint_placement_audit",
        available: false,
        reason: "preferred_target_is_not_a_native_blueprint_proxy_or_actor_member",
        source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
        certainty: "unknown",
      }),
      truncated: false,
    },
  );
  assert.equal(unavailable.usable, false);
  assert.equal(unavailable.reason, "unknown_result");
});

test("factory-overview claims require the captured factory summary", () => {
  const question = "What is in this factory?";
  assert.deepEqual(missingRequiredSolverGrounding(question, []), [["get_factory_summary"]]);
  assert.deepEqual(
    missingRequiredSolverGrounding(question, [
      { tool: "get_factory_summary", evidence: { usable: true } },
    ]),
    [],
  );
});

test("conceptual and explicitly external questions do not demand live-save solvers", () => {
  assert.deepEqual(
    missingRequiredSolverGrounding(
      "How does the Blueprint Designer work according to the official docs?",
      [],
    ),
    [],
  );
  assert.deepEqual(
    missingRequiredSolverGrounding("How do world coordinates work?", []),
    [],
  );
  assert.ok(
    missingRequiredSolverGrounding("Explain why the smelter is stopped.", [])
      .length > 0,
  );
});

test("find_recipes grounds recipe-rate comparisons but not current machine output", () => {
  const recipeCall = { tool: "find_recipes", evidence: { usable: true } };
  assert.deepEqual(
    missingRequiredSolverGrounding(
      "Which alternate recipe makes iron rods at the highest rate?",
      [recipeCall],
    ),
    [],
  );
  assert.ok(
    missingRequiredSolverGrounding(
      "What is my current machine output rate?",
      [recipeCall],
    ).length > 0,
  );
});

test("separate targeted calls can jointly ground a multi-item question", () => {
  const context = makeContext({
    question: "Compare the balance of Desc_IronIngot and Desc_IronRod.",
  });
  const calls = ["Desc_IronIngot", "Desc_IronRod"].map((itemClass) => {
    const args = { item_class: itemClass };
    const result = runSolverTool(context.graph, "get_item_balance", args);
    return {
      tool: "get_item_balance",
      evidence: solverEvidenceMetadata(
        context,
        "get_item_balance",
        args,
        result,
      ),
    };
  });
  assert.ok(calls.every((call) => call.evidence.usable));
  assert.deepEqual(missingRequiredSolverGrounding(context.question, calls), []);
});

test("a clarification question is not mistaken for an ungrounded factual answer", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "clarify",
        output_text: "Which machine do you mean?",
        output: [],
      },
    },
  ]);
  try {
    const answer = await askOpenAI(
      makeContext({ question: "What is my current output rate?" }),
      { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
    );
    assert.equal(answer.reply, "Which machine do you mean?");
  } finally {
    stub.restore();
  }
});

test("a clarification prefix cannot smuggle an ungrounded factual answer", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "clarification-smuggle",
        output_text: "Which machine do you mean? Your current output is 60 items per minute.",
        output: [],
      },
    },
  ]);
  try {
    await assert.rejects(
      () =>
        askOpenAI(
          makeContext({ question: "What is my current output rate?" }),
          { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
        ),
      (error) =>
        error instanceof SolverGroundingError &&
        error.code === "solver_grounding_required",
    );
  } finally {
    stub.restore();
  }
});

test("find_recipes can answer a registered recipe-rate question", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "recipe-call",
        output: [
          {
            type: "function_call",
            name: "find_recipes",
            call_id: "recipe-1",
            arguments: JSON.stringify({ item_class: "Desc_IronRod" }),
          },
        ],
      },
    },
    {
      json: {
        id: "recipe-answer",
        output_text: "Alternate: Steel Rod has the highest registered base rate.",
        output: [],
      },
    },
  ]);
  try {
    const answer = await askOpenAI(
      makeContext({
        question: "Which alternate recipe makes Desc_IronRod at the highest rate?",
      }),
      { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
    );
    assert.equal(answer.solver_calls[0].tool, "find_recipes");
    assert.equal(answer.solver_calls[0].evidence.usable, true);
  } finally {
    stub.restore();
  }
});

test("power capacity does not accidentally require the transport solver", async () => {
  const stub = stubFetch([
    {
      json: {
        id: "power-call",
        output: [
          {
            type: "function_call",
            name: "get_power_circuits",
            call_id: "power-1",
            arguments: "{}",
          },
        ],
      },
    },
    {
      json: {
        id: "power-answer",
        output_text: "The power solver reports the current capacity.",
        output: [],
      },
    },
  ]);
  try {
    const answer = await askOpenAI(
      makeContext({ question: "What is my current power capacity?" }),
      { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" },
    );
    assert.equal(answer.solver_calls[0].tool, "get_power_circuits");
  } finally {
    stub.restore();
  }
});

test("mock mode exercises the solvers so they can be verified without a model", async () => {
  const answer = await askMock(makeContext());
  assert.equal(answer.provider, "mock");
  // The findings are narrated now rather than tallied: a consequence in the
  // headline, the machines named, the provenance stated. Same guarantee as
  // before -- the solvers ran and their output reached the reply -- but checked
  // against prose a player can act on instead of a cause-count string.
  assert.match(answer.reply, /Your circuit is over capacity/);
  assert.match(answer.reply, /Affected: /);
  assert.match(answer.reply, /Read from 4 stalled machines across 2 power circuits/);
  assert.match(answer.reply, /from captured state/);
  assert.deepEqual(
    answer.solver_calls.map((call) => call.tool),
    ["diagnose_bottlenecks", "get_power_circuits"],
  );
});

test("mock mode still answers when no graph was built", async () => {
  const answer = await askMock(makeContext({ graph: undefined }));
  assert.deepEqual(answer.solver_calls, []);
  assert.doesNotMatch(answer.reply, /stalled machine|Nothing is stalled/);
});
