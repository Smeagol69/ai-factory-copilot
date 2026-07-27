import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  buildSystemInstructions,
  askAnthropic,
  askOpenAI,
  collectAnthropicSources,
} from "../lib/providers.mjs";
import {
  OFFICIAL_SOURCE_DOMAINS,
  anthropicWebSearchTool,
  openAIWebSearchTool,
  resolveSourcePolicy,
  sourceInstructions,
} from "../lib/sources.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const snapshot = buildFactorySnapshot();

function makeContext(overrides = {}) {
  return {
    question: "whats the best alt recipe for rods",
    snapshot,
    serializedSnapshot: JSON.stringify(snapshot),
    serializedDerivedFacts: "{}",
    serializedAnalysisDigest: "{}",
    omissions: [],
    summary: { world_revision: 41, actors: 10, recipes: 5, items: 6, mods: 1, actors_by_owner_mod: {} },
    graph: buildGraph(snapshot),
    history: [],
    ...overrides,
  };
}

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
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ANTHROPIC_ENV = { ANTHROPIC_API_KEY: "test", ANTHROPIC_MODEL: "claude-test" };
const textAnswer = { stop_reason: "end_turn", content: [{ type: "text", text: "Use the alternate." }] };

/* ---------------- source policy ---------------- */

test("official source list leads with Coffee Stain and the modding docs", () => {
  assert.ok(OFFICIAL_SOURCE_DOMAINS.includes("satisfactorygame.com"));
  assert.ok(OFFICIAL_SOURCE_DOMAINS.includes("docs.ficsit.app"));
  assert.ok(OFFICIAL_SOURCE_DOMAINS.includes("satisfactory.wiki.gg"));
  assert.ok(OFFICIAL_SOURCE_DOMAINS.includes("reddit.com"));
  assert.ok(OFFICIAL_SOURCE_DOMAINS.indexOf("docs.ficsit.app") < OFFICIAL_SOURCE_DOMAINS.indexOf("reddit.com"));
});

test("search and official restriction are on by default", () => {
  const policy = resolveSourcePolicy({});
  assert.equal(policy.enabled, true);
  assert.equal(policy.restrictToOfficial, true);
  assert.deepEqual(policy.domains, OFFICIAL_SOURCE_DOMAINS);
  assert.equal(policy.domainsAreConfigured, false);
});

test("accepts a configured domain list and strips scheme and path", () => {
  const policy = resolveSourcePolicy({
    AIFACTORY_SOURCE_DOMAINS: "https://example.com/wiki/Page, docs.example.org ",
  });
  assert.deepEqual(policy.domains, ["example.com", "docs.example.org"]);
  assert.equal(policy.domainsAreConfigured, true);
});

test("search can be turned off entirely", () => {
  const policy = resolveSourcePolicy({ AIFACTORY_WEB_SEARCH: "false" });
  assert.equal(policy.enabled, false);
  assert.equal(anthropicWebSearchTool(policy), null);
  assert.equal(openAIWebSearchTool(policy, {}), null);
});

/* ---------------- tool shapes ---------------- */

test("messages API search tool restricts domains at the API level", () => {
  const tool = anthropicWebSearchTool(resolveSourcePolicy({}), {});
  assert.equal(tool.type, "web_search_20260209");
  assert.equal(tool.name, "web_search");
  assert.equal(tool.max_uses, 5);
  assert.deepEqual(tool.allowed_domains, OFFICIAL_SOURCE_DOMAINS);
});

test("search tool falls back to the basic variant for older models", () => {
  const basic = anthropicWebSearchTool(resolveSourcePolicy({}), { ANTHROPIC_WEB_SEARCH_BASIC: "true" });
  assert.equal(basic.type, "web_search_20250305");
  const pinned = anthropicWebSearchTool(resolveSourcePolicy({}), {
    ANTHROPIC_WEB_SEARCH_TOOL: "web_search_20250305",
  });
  assert.equal(pinned.type, "web_search_20250305");
});

test("dropping the restriction leaves the domain filter off the tool", () => {
  const tool = anthropicWebSearchTool(resolveSourcePolicy({ AIFACTORY_RESTRICT_SOURCES: "false" }), {});
  assert.equal(tool.allowed_domains, undefined);
});

test("responses API domain filtering is opt-in", () => {
  const policy = resolveSourcePolicy({});
  assert.equal(openAIWebSearchTool(policy, {}).filters, undefined);
  const filtered = openAIWebSearchTool(policy, { OPENAI_WEB_SEARCH_DOMAIN_FILTER: "true" });
  assert.deepEqual(filtered.filters.allowed_domains, OFFICIAL_SOURCE_DOMAINS);
});

/* ---------------- system prompt ---------------- */

test("system prompt lists the sources and subordinates them to the save", () => {
  const text = buildSystemInstructions({});
  assert.match(text, /docs\.ficsit\.app/);
  assert.match(text, /satisfactory\.wiki\.gg/);
  assert.match(text, /Do not rely on sources outside that list/);
  assert.match(text, /live save state always wins/);
});

test("system prompt accepts casual phrasing instead of demanding a rewrite", () => {
  const text = buildSystemInstructions({});
  assert.match(text, /misspelled\s+wording/);
  assert.match(text, /answer the question they meant/);
  assert.match(text, /Never tell the player to rephrase/);
});

test("system prompt says search is off when it is disabled", () => {
  const text = buildSystemInstructions({ AIFACTORY_WEB_SEARCH: "false" });
  assert.match(text, /web search is turned off/);
  assert.doesNotMatch(text, /docs\.ficsit\.app/);
});

test("unrestricted mode still prefers the official sources", () => {
  const text = sourceInstructions(resolveSourcePolicy({ AIFACTORY_RESTRICT_SOURCES: "false" }));
  assert.match(text, /Prefer those sources/);
  assert.doesNotMatch(text, /Do not rely on sources outside/);
});

/* ---------------- reasoning configuration ---------------- */

test("adaptive thinking is requested explicitly and never as a token budget", async () => {
  const stub = stubFetch([{ json: textAnswer }]);
  try {
    await askAnthropic(makeContext(), ANTHROPIC_ENV);
    const body = stub.calls[0].body;
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(body.thinking.budget_tokens, undefined);
  } finally {
    stub.restore();
  }
});

test("thinking tokens get real headroom by default", async () => {
  const stub = stubFetch([{ json: textAnswer }]);
  try {
    await askAnthropic(makeContext(), ANTHROPIC_ENV);
    // Thinking is drawn from max_tokens; a small budget truncates the answer.
    assert.equal(stub.calls[0].body.max_tokens, 16000);
  } finally {
    stub.restore();
  }
});

test("thinking can be turned off and effort configured", async () => {
  const stub = stubFetch([{ json: textAnswer }, { json: textAnswer }]);
  try {
    await askAnthropic(makeContext(), { ...ANTHROPIC_ENV, ANTHROPIC_THINKING: "off" });
    assert.equal(stub.calls[0].body.thinking, undefined);

    await askAnthropic(makeContext(), { ...ANTHROPIC_ENV, ANTHROPIC_EFFORT: "high" });
    assert.deepEqual(stub.calls[1].body.output_config, { effort: "high" });
  } finally {
    stub.restore();
  }
});

test("effort is omitted unless configured", async () => {
  const stub = stubFetch([{ json: textAnswer }]);
  try {
    await askAnthropic(makeContext(), ANTHROPIC_ENV);
    assert.equal(stub.calls[0].body.output_config, undefined);
  } finally {
    stub.restore();
  }
});

/* ---------------- search wiring ---------------- */

test("the search tool is offered alongside the solvers", async () => {
  const stub = stubFetch([{ json: textAnswer }]);
  try {
    await askAnthropic(makeContext(), ANTHROPIC_ENV);
    const tools = stub.calls[0].body.tools;
    assert.ok(tools.some((tool) => tool.name === "web_search"));
    assert.ok(tools.some((tool) => tool.name === "diagnose_bottlenecks"));
  } finally {
    stub.restore();
  }
});

test("openai advertises the search tool without an unverified filter shape", async () => {
  const stub = stubFetch([{ json: { id: "r", output_text: "ok", output: [] } }]);
  try {
    await askOpenAI(makeContext(), { OPENAI_API_KEY: "test" });
    const search = stub.calls[0].body.tools.find((tool) => tool.type === "web_search");
    assert.equal(search.search_context_size, "low");
    assert.equal(search.filters, undefined);
    assert.match(stub.calls[0].body.instructions, /docs\.ficsit\.app/);
  } finally {
    stub.restore();
  }
});

/* ---------------- paused turns ---------------- */

test("a paused turn is resumed instead of returned half finished", async () => {
  const stub = stubFetch([
    { json: { stop_reason: "pause_turn", content: [{ type: "text", text: "Searching" }] } },
    { json: textAnswer },
  ]);
  try {
    const answer = await askAnthropic(makeContext(), ANTHROPIC_ENV);
    assert.equal(stub.calls.length, 2);
    assert.equal(answer.reply, "Use the alternate.");
    // The paused assistant turn is resent so the server can resume it.
    assert.equal(stub.calls[1].body.messages.at(-1).role, "assistant");
  } finally {
    stub.restore();
  }
});

test("resuming a paused turn does not consume solver rounds", async () => {
  const paused = { json: { stop_reason: "pause_turn", content: [{ type: "text", text: "..." }] } };
  const stub = stubFetch([paused, paused, { json: textAnswer }]);
  try {
    const answer = await askAnthropic(makeContext(), {
      ...ANTHROPIC_ENV,
      AIFACTORY_MAX_SOLVER_ROUNDS: "1",
    });
    assert.equal(answer.reply, "Use the alternate.");
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("an endlessly paused turn is bounded", async () => {
  const paused = { json: { stop_reason: "pause_turn", content: [{ type: "text", text: "..." }] } };
  const stub = stubFetch(Array.from({ length: 12 }, () => paused));
  try {
    await assert.rejects(
      () => askAnthropic(makeContext(), { ...ANTHROPIC_ENV, AIFACTORY_MAX_PAUSE_RESUMES: "2" }),
      /paused the turn 2 times without finishing/,
    );
  } finally {
    stub.restore();
  }
});

/* ---------------- citations ---------------- */

test("collects cited pages from a successful search result", () => {
  const sources = new Map();
  const errors = [];
  collectAnthropicSources(
    {
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            { type: "web_search_result", url: "https://satisfactory.wiki.gg/wiki/Iron_Rod", title: "Iron Rod" },
            { type: "web_search_result", url: "https://docs.ficsit.app/", title: "Modding Docs" },
          ],
        },
      ],
    },
    sources,
    errors,
  );
  assert.deepEqual([...sources.keys()], [
    "https://satisfactory.wiki.gg/wiki/Iron_Rod",
    "https://docs.ficsit.app/",
  ]);
  assert.deepEqual(errors, []);
});

test("a failed search returns an object, not a list, and is reported", () => {
  const sources = new Map();
  const errors = [];
  collectAnthropicSources(
    {
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_2",
          content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
        },
      ],
    },
    sources,
    errors,
  );
  assert.equal(sources.size, 0);
  assert.deepEqual(errors, [{ error_code: "max_uses_exceeded", tool_use_id: "srvtoolu_2" }]);
});

test("collects citations attached to text blocks", () => {
  const sources = new Map();
  collectAnthropicSources(
    {
      content: [
        {
          type: "text",
          text: "Alternate: Steel Rod gives 48/min.",
          citations: [{ url: "https://satisfactory.wiki.gg/wiki/Steel_Rod", title: "Steel Rod" }],
        },
      ],
    },
    sources,
    [],
  );
  assert.equal(sources.get("https://satisfactory.wiki.gg/wiki/Steel_Rod").title, "Steel Rod");
});

test("ignores non-http citation urls", () => {
  const sources = new Map();
  collectAnthropicSources(
    { content: [{ type: "text", text: "x", citations: [{ url: "javascript:alert(1)" }, { url: null }] }] },
    sources,
    [],
  );
  assert.equal(sources.size, 0);
});

test("cited pages are appended to the in-game reply", async () => {
  const stub = stubFetch([
    {
      json: {
        stop_reason: "end_turn",
        content: [
          {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://satisfactory.wiki.gg/wiki/Rotor", title: "Rotor" },
            ],
          },
          { type: "text", text: "Rotors need 5 rods." },
        ],
      },
    },
  ]);
  try {
    const answer = await askAnthropic(makeContext(), ANTHROPIC_ENV);
    assert.match(answer.reply, /Rotors need 5 rods\./);
    assert.match(answer.reply, /External sources:/);
    assert.match(answer.reply, /satisfactory\.wiki\.gg\/wiki\/Rotor/);
    assert.equal(answer.sources.length, 1);
  } finally {
    stub.restore();
  }
});

test("a search failure is stated in the reply rather than hidden", async () => {
  const stub = stubFetch([
    {
      json: {
        stop_reason: "end_turn",
        content: [
          { type: "web_search_tool_result", content: { error_code: "unavailable" } },
          { type: "text", text: "Answering from the save only." },
        ],
      },
    },
  ]);
  try {
    const answer = await askAnthropic(makeContext(), ANTHROPIC_ENV);
    assert.match(answer.reply, /Web search did not complete \(unavailable\)/);
    assert.deepEqual(answer.search_errors, [{ error_code: "unavailable", tool_use_id: null }]);
  } finally {
    stub.restore();
  }
});
