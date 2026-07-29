import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { askLocal, askProvider } from "../lib/providers.mjs";
import { buildLeanPayload, compactModelView } from "../lib/snapshot.mjs";
import { chatCompletionsToolDefinitions } from "../lib/tools.mjs";
import { CONSTRUCTOR, MINER, PLAYER, SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

const snapshot = buildFactorySnapshot();

function makeContext(overrides = {}) {
  return {
    question: "why is the smelter stopped",
    snapshot,
    serializedSnapshot: "{}",
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
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`Unexpected fetch call ${calls.length}`);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null },
      json: async () => next.json,
      text: async () => JSON.stringify(next.json ?? {}),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/* ---------------- lean payload ---------------- */

test("the catalog and reflection stay off the model payload", () => {
  const { payload, serialized } = buildLeanPayload(snapshot);
  assert.equal(payload.content, undefined);
  assert.doesNotMatch(serialized, /reflected_properties/);
  // Recipe *definitions* are gone (that is the bulk); the recipe a machine is
  // running stays, because grounding an answer needs it.
  assert.doesNotMatch(serialized, /duration_seconds/);
  assert.doesNotMatch(serialized, /"ingredients"/);
  assert.match(serialized, /"recipe_class":"Recipe_IngotIron"/);
});

test("every omission names the solver that serves it", () => {
  const { omissions } = buildLeanPayload(snapshot);
  const catalog = omissions.find((entry) => entry.startsWith("content_catalog"));
  assert.match(catalog, /find_recipes/);
  assert.ok(omissions.some((entry) => entry.startsWith("reflected_properties")));
});

test("grounding is preserved in full", () => {
  const { payload } = buildLeanPayload(snapshot);
  assert.equal(payload.interaction_context.preferred_target.actor_id, SMELTER);
  assert.equal(payload.data_policy, "authoritative_or_explicitly_unknown");
  assert.equal(payload.world_revision, 41);
  assert.ok(payload.units);
});

test("the actor being looked at is never dropped, however far away", () => {
  const far = buildFactorySnapshot();
  far.actors.find((actor) => actor.actor_id === SMELTER).location = { x: 9e6, y: 9e6, z: 9e6 };
  const { payload } = buildLeanPayload(far, { maxActors: 1 });
  assert.equal(payload.actors_nearest_to_the_player.length, 1);
  assert.equal(payload.actors_nearest_to_the_player[0].actor_id, SMELTER);
});

test("remaining actors are ordered by distance from the player", () => {
  const { payload } = buildLeanPayload(snapshot);
  const ids = payload.actors_nearest_to_the_player.map((actor) => actor.actor_id);
  // Focus target first, then nearest-first from the player at the origin.
  assert.equal(ids[0], SMELTER);
  assert.ok(ids.indexOf(MINER) < ids.indexOf(CONSTRUCTOR));
});

test("truncating actors is declared and states the solvers still see them", () => {
  const { payload, omissions } = buildLeanPayload(snapshot, { maxActors: 3 });
  assert.equal(payload.actors_nearest_to_the_player.length, 3);
  assert.equal(payload.completeness.actors_included, 3);
  assert.equal(payload.completeness.total_actors_in_snapshot, 10);
  const entry = omissions.find((text) => text.startsWith("actors_beyond"));
  assert.match(entry, /still visible to the solvers/);
});

test("a character budget bounds the payload independently of actor count", () => {
  const { payload } = buildLeanPayload(snapshot, { maxActors: 500, maxCharacters: 1500 });
  assert.ok(payload.actors_nearest_to_the_player.length < 10);
});

test("progression summary retains the live objective and recipe availability", () => {
  const { payload } = buildLeanPayload(snapshot);
  assert.equal(payload.progression_summary.purchased_schematic_count, 1);
  assert.equal(payload.progression_summary.highest_available_tech_tier, 5);
  assert.equal(
    payload.progression_summary.onboarding.current_step.title,
    "Build the HUB",
  );
  assert.equal(payload.progression_summary.recipe_availability.known, true);
  assert.equal(payload.progression_summary.recipe_availability.available_recipe_count, 5);
  assert.equal(payload.visible_ui.rendered_text[1].text, "Build the HUB");
  assert.match(payload.visible_ui.source, /no screenshot or OCR/);
  assert.match(payload.progression_summary.detail, /get_unlock_status/);
  assert.equal(payload.progression, undefined);
});

test("the payload declares that omissions are not absence", () => {
  const { payload } = buildLeanPayload(snapshot);
  assert.equal(payload.completeness.view, "lean");
  assert.match(payload.completeness.policy, /Never treat an omission as absence/);
});

test("falls back to the player actor when interaction_context is absent", () => {
  const without = buildFactorySnapshot();
  delete without.interaction_context;
  const { payload } = buildLeanPayload(without, { maxActors: 2 });
  // The player sits at the origin, so ordering still works off the actor.
  assert.ok(payload.actors_nearest_to_the_player.some((actor) => actor.actor_id === PLAYER));
});

test("survives a snapshot with no actors and no content", () => {
  const { payload, omissions } = buildLeanPayload({ world_revision: 3 });
  assert.deepEqual(payload.actors_nearest_to_the_player, []);
  assert.deepEqual(omissions, []);
});

test("the lean payload is dramatically smaller than the snapshot", () => {
  const full = JSON.stringify(snapshot).length;
  const { serialized } = buildLeanPayload(snapshot);
  assert.ok(serialized.length < full, `${serialized.length} should be under ${full}`);
});

/* ---------------- local / free provider ---------------- */

test("chat completions tools nest under function, unlike the responses shape", () => {
  const tools = chatCompletionsToolDefinitions();
  assert.ok(tools.length >= 15);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.name, "string");
    assert.equal(tool.function.parameters.type, "object");
    assert.equal(tool.name, undefined);
  }
});

test("local provider requires a model rather than guessing one", async () => {
  await assert.rejects(() => askLocal(makeContext(), {}), /LOCAL_AI_MODEL must be set/);
});

test("local provider talks to an ollama-style endpoint by default", async () => {
  const stub = stubFetch([
    { json: { choices: [{ message: { role: "assistant", content: "It is starved." } }] } },
  ]);
  try {
    const answer = await askLocal(makeContext(), { LOCAL_AI_MODEL: "qwen3" });
    assert.equal(stub.calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(stub.calls[0].body.model, "qwen3");
    assert.equal(answer.provider, "local");
    assert.equal(answer.reply, "It is starved.");
    // No key is required for a local server.
    assert.equal(stub.calls[0].headers.Authorization, undefined);
  } finally {
    stub.restore();
  }
});

test("local provider runs solver tool calls and feeds results back", async () => {
  const stub = stubFetch([
    {
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_power_circuits", arguments: '{"circuit_id":1}' } },
              ],
            },
          },
        ],
      },
    },
    { json: { choices: [{ message: { role: "assistant", content: "Circuit 1 is short." } }] } },
  ]);
  try {
    const answer = await askLocal(makeContext(), { LOCAL_AI_MODEL: "qwen3" });
    assert.equal(stub.calls.length, 2);
    assert.equal(answer.solver_calls[0].tool, "get_power_circuits");

    const toolMessage = stub.calls[1].body.messages.at(-1);
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_1");
    assert.equal(JSON.parse(toolMessage.content).circuits[0].headroom_mw, -25);
  } finally {
    stub.restore();
  }
});

test("a local model without tool support is flagged, not trusted", async () => {
  const stub = stubFetch([
    { json: { choices: [{ message: { role: "assistant", content: "Roughly 30 per minute." } }] } },
  ]);
  try {
    const answer = await askLocal(makeContext(), { LOCAL_AI_MODEL: "tiny", LOCAL_AI_TOOLS: "false" });
    assert.equal(stub.calls[0].body.tools, undefined);
    assert.match(answer.reply, /solver tools are disabled/);
  } finally {
    stub.restore();
  }
});

test("a hosted OpenAI-compatible gateway can still send a key", async () => {
  const stub = stubFetch([
    { json: { choices: [{ message: { role: "assistant", content: "ok" } }] } },
  ]);
  try {
    await askLocal(makeContext(), {
      LOCAL_AI_MODEL: "some-model",
      LOCAL_AI_BASE_URL: "https://gateway.example.com/v1/",
      LOCAL_AI_API_KEY: "k",
    });
    assert.equal(stub.calls[0].url, "https://gateway.example.com/v1/chat/completions");
    assert.equal(stub.calls[0].headers.Authorization, "Bearer k");
  } finally {
    stub.restore();
  }
});

test("askProvider routes local and ollama, and names every option on error", async () => {
  const stub = stubFetch([
    { json: { choices: [{ message: { role: "assistant", content: "ok" } }] } },
    { json: { choices: [{ message: { role: "assistant", content: "ok" } }] } },
  ]);
  try {
    assert.equal((await askProvider("local", makeContext(), { LOCAL_AI_MODEL: "m" })).provider, "local");
    assert.equal((await askProvider("ollama", makeContext(), { LOCAL_AI_MODEL: "m" })).provider, "local");
  } finally {
    stub.restore();
  }
  await assert.rejects(
    () => askProvider("gpt9", makeContext(), {}),
    /Use mock, local, openai, anthropic, or hybrid/,
  );
});

/* ---------------- rate limit retry ---------------- */

test("a 429 is retried using the provider's own retry-after", async () => {
  const stub = stubFetch([
    { ok: false, status: 429, headers: { "retry-after-ms": "5" }, json: { error: { message: "TPM" } } },
    { json: { choices: [{ message: { role: "assistant", content: "recovered" } }] } },
  ]);
  try {
    const answer = await askLocal(makeContext(), { LOCAL_AI_MODEL: "m" });
    assert.equal(stub.calls.length, 2);
    assert.equal(answer.reply, "recovered");
  } finally {
    stub.restore();
  }
});

test("retries are bounded and the limit error is surfaced", async () => {
  const limited = {
    ok: false,
    status: 429,
    headers: { "retry-after-ms": "1" },
    json: { error: { message: "Rate limit reached on tokens per min (TPM)" } },
  };
  const stub = stubFetch([limited, limited, limited]);
  try {
    await assert.rejects(
      () => askLocal(makeContext(), { LOCAL_AI_MODEL: "m", AIFACTORY_MAX_RATE_LIMIT_RETRIES: "2" }),
      /HTTP 429.*tokens per min/s,
    );
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

/* ---------------- model-view compaction ---------------- */

test("float noise is trimmed to a tenth of a centimetre", () => {
  const compacted = compactModelView({ location: { x: -102972.88472716082, y: 39196.03913922996 } });
  assert.equal(compacted.location.x, -102972.9);
  assert.equal(compacted.location.y, 39196);
});

test("integers are left exact", () => {
  // Counts, ids, and revisions must not be rounded into something else.
  const compacted = compactModelView({ count: 42, revision: 18, tier: 3 });
  assert.deepEqual(compacted, { count: 42, revision: 18, tier: 3 });
});

test("identity scale and zero velocity are dropped as uninformative", () => {
  const compacted = compactModelView({
    scale: { x: 1, y: 1, z: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    location: { x: 1, y: 2, z: 3 },
  });
  assert.equal("scale" in compacted, false);
  assert.equal("velocity" in compacted, false);
  assert.deepEqual(compacted.location, { x: 1, y: 2, z: 3 });
});

test("a non-identity scale or real velocity is kept", () => {
  const compacted = compactModelView({
    scale: { x: 2, y: 1, z: 1 },
    velocity: { x: 0, y: 0, z: 5 },
  });
  assert.deepEqual(compacted.scale, { x: 2, y: 1, z: 1 });
  assert.deepEqual(compacted.velocity, { x: 0, y: 0, z: 5 });
});

test("strings, booleans, and nulls pass through untouched", () => {
  const input = { actor_id: "/Game/X.Y_C", ok: true, missing: null, list: ["a", 1.25] };
  const compacted = compactModelView(input);
  assert.equal(compacted.actor_id, "/Game/X.Y_C");
  assert.equal(compacted.ok, true);
  assert.equal(compacted.missing, null);
  assert.deepEqual(compacted.list, ["a", 1.3]);
});

test("compaction shrinks the payload without dropping actors", () => {
  const snapshot = {
    schema: "aifactory.snapshot",
    actors: Array.from({ length: 5 }, (_, index) => ({
      actor_id: `actor-${index}`,
      kind: "buildable",
      location: { x: 1.23456789012, y: 2.3456789012, z: 3.456789012 },
      scale: { x: 1, y: 1, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    })),
  };
  const lean = buildLeanPayload(snapshot, { maxActors: 120, maxCharacters: 200_000 });
  assert.equal(lean.payload.actors_nearest_to_the_player.length, 5);
  assert.equal(lean.serialized.includes("1.23456789012"), false);
  assert.equal(lean.serialized.includes('"scale"'), false);
});
