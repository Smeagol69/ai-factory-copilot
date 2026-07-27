import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { SYSTEM_INSTRUCTIONS, askAnthropic, askMock, askOpenAI, userInput } from "../lib/providers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const snapshot = buildFactorySnapshot();

function makeContext(overrides = {}) {
  return {
    question: "Why is the smelter stopped?",
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
    const answer = await askOpenAI(makeContext(), { OPENAI_API_KEY: "test", OPENAI_WEB_SEARCH: "false" });

    assert.equal(stub.calls.length, 2);
    assert.equal(answer.reply, "Circuit 1 is 25 MW short.");
    assert.equal(answer.response_id, "resp_2");
    assert.deepEqual(answer.solver_calls[0].arguments, { circuit_id: 1 });
    assert.equal(answer.solver_calls[0].tool, "get_power_circuits");

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
      output: [
        { type: "function_call", name: "get_item_balance", call_id: "c", arguments: "{}" },
      ],
    },
  };
  const stub = stubFetch(Array.from({ length: 12 }, () => toolRound));
  try {
    await assert.rejects(
      () =>
        askOpenAI(makeContext(), {
          OPENAI_API_KEY: "test",
          OPENAI_WEB_SEARCH: "false",
          AIFACTORY_MAX_SOLVER_ROUNDS: "2",
        }),
      /kept requesting solver tools after 2 rounds/,
    );
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
    const answer = await askAnthropic(makeContext(), {
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_MODEL: "claude-test",
    });

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

test("mock mode exercises the solvers so they can be verified without a model", async () => {
  const answer = await askMock(makeContext());
  assert.equal(answer.provider, "mock");
  assert.match(answer.reply, /Deterministic solvers report 4 machine\(s\) with findings/);
  assert.match(answer.reply, /power_capacity_deficit: 2/);
  assert.match(answer.reply, /across 2 power circuit\(s\)/);
  assert.deepEqual(
    answer.solver_calls.map((call) => call.tool),
    ["diagnose_bottlenecks", "get_power_circuits"],
  );
});

test("mock mode still answers when no graph was built", async () => {
  const answer = await askMock(makeContext({ graph: undefined }));
  assert.deepEqual(answer.solver_calls, []);
  assert.doesNotMatch(answer.reply, /Deterministic solvers report/);
});
