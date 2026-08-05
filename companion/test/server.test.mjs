import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  ACTION_CONTRACT_VERSION,
  BRIDGE_VERSION,
  assessProviderConfiguration,
  assessProviderReadiness,
  createActionCollector,
  createBridgeServer,
  formatGroundingFailureReply,
  resolveRoutingLogPath,
} from "../server.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

let server;
let baseUrl;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-AIFactory-Schema": "1",
};

before(async () => {
  server = createBridgeServer({ env: { AI_PROVIDER: "mock" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("health endpoint reports localhost diagnostic mode and solver tools", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.schema, "aifactory.bridge.health");
  assert.equal(body.bridge_version, BRIDGE_VERSION);
  assert.equal(body.action_contract_version, ACTION_CONTRACT_VERSION);
  assert.equal(body.provider, "mock");
  assert.equal(body.readiness.ready, true);
  assert.equal(body.loopback_only, true);
  assert.equal(body.conveyor_speed_divisor, 2);
  assert.ok(body.solver_tools.includes("get_factory_summary"));
  assert.ok(body.solver_tools.includes("diagnose_bottlenecks"));
  assert.ok(body.solver_tools.includes("find_best_site"));
  assert.ok(body.solver_tools.length >= 16);
  assert.ok(body.solver_tools.includes("design_factory_layout"));
  assert.ok(body.solver_tools.includes("design_megabase_concept"));
  assert.ok(body.solver_tools.includes("perform_actions"));
  assert.equal(body.outside_references.web_search, false);
  assert.equal(body.outside_references.requested_but_unavailable, true);
  assert.equal(body.outside_references.restricted_to_configured_sources, false);
  assert.ok(body.outside_references.source_domains.includes("docs.ficsit.app"));
});

test("ask endpoint accepts an authoritative snapshot", async () => {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.ask",
      schema_version: 1,
      session_id: "test",
      question: "What is in this factory?",
      world_snapshot: {
        schema: "aifactory.snapshot",
        schema_version: 1,
        data_policy: "authoritative_or_explicitly_unknown",
        world_revision: 7,
        world: { map: "Persistent_Level" },
        mods: [{ reference: "SML" }],
        content: { items: [], recipes: [] },
        actors: [
          {
            actor_id: "Build_Constructor_C_1",
            kind: "buildable",
            owner_mod: "FactoryGame",
          },
        ],
        completeness: { actor_limit_reached: false },
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema, "aifactory.answer");
  assert.equal(body.provider, "solvers");
  assert.equal(body.answered_by, "local_solver");
  assert.equal(body.local.solver, "get_factory_summary");
  assert.equal(body.cost.usd, 0);
  assert.equal(body.world_revision, 7);
  assert.equal(body.retained_history_messages, 2);
  assert.match(body.reply, /1 actors/);
});

test("routing diagnostics are instance-scoped and carry request provenance", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-routing-"));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const routingLog = path.join(temporaryDirectory, "routing.jsonl");
  const diagnosticServer = createBridgeServer({
    env: {
      AI_PROVIDER: "mock",
      AIFACTORY_ROUTING_LOG: routingLog,
    },
  });

  assert.equal(resolveRoutingLogPath({ AI_PROVIDER: "mock" }), null);
  assert.equal(resolveRoutingLogPath({ AIFACTORY_ROUTING_LOG: "off" }), null);
  assert.equal(
    resolveRoutingLogPath({ AIFACTORY_ROUTING_LOG: routingLog }),
    path.resolve(routingLog),
  );
  assert.equal(
    resolveRoutingLogPath({ LOCALAPPDATA: temporaryDirectory }),
    path.join(
      temporaryDirectory,
      "FactoryGame",
      "Saved",
      "AIFactoryCopilot",
      "Diagnostics",
      "routing.jsonl",
    ),
  );

  try {
    await new Promise((resolve) => diagnosticServer.listen(0, "127.0.0.1", resolve));
    const address = diagnosticServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        schema: "aifactory.ask",
        schema_version: 1,
        session_id: "routing-provenance-test",
        question_received_at_game_utc: "2026-08-03T21:00:00.000Z",
        question: "Tell me a joke about this factory.",
        world_snapshot: {
          schema: "aifactory.snapshot",
          schema_version: 1,
          data_policy: "authoritative_or_explicitly_unknown",
          world_revision: 42,
          generated_at_utc: "2026-08-03T20:59:59.000Z",
          actors: [],
        },
      }),
    });
    assert.equal(response.status, 200);

    const localResponse = await fetch(`http://127.0.0.1:${address.port}/v1/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        schema: "aifactory.ask",
        schema_version: 1,
        session_id: "routing-provenance-local-test",
        question: "What is in this factory?",
        world_snapshot: {
          schema: "aifactory.snapshot",
          schema_version: 1,
          data_policy: "authoritative_or_explicitly_unknown",
          world_revision: 43,
          generated_at_utc: "2026-08-03T21:00:01.000Z",
          actors: [],
          content: { items: [], recipes: [] },
        },
      }),
    });
    assert.equal(localResponse.status, 200);
    const localBody = await localResponse.json();
    assert.equal(localBody.answered_by, "local_solver");
    assert.ok(Number.isInteger(localBody.bridge_elapsed_ms));
    assert.ok(localBody.bridge_elapsed_ms >= 0);
  } finally {
    if (diagnosticServer.listening) {
      await new Promise((resolve, reject) =>
        diagnosticServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  const entries = fs
    .readFileSync(routingLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].question, "Tell me a joke about this factory.");
  assert.equal(entries[0].answeredBy, "deterministic_diagnostic");
  assert.equal(entries[0].session_id, "routing-provenance-test");
  assert.equal(entries[0].provider, "mock");
  assert.equal(entries[0].model, "deterministic-diagnostic");
  assert.equal(entries[0].world_revision, 42);
  assert.equal(entries[0].snapshot_generated_at_utc, "2026-08-03T20:59:59.000Z");
  assert.equal(entries[0].question_received_at_game_utc, "2026-08-03T21:00:00.000Z");
  assert.match(entries[0].at, /^2026-/);
  assert.match(entries[0].bridge_received_at_utc, /^2026-/);
  assert.ok(Number.isInteger(entries[0].bridge_elapsed_ms));
  assert.ok(entries[0].bridge_elapsed_ms >= 0);
  assert.equal(entries[0].route_elapsed_ms, null);
  assert.equal(entries[1].answeredBy, "local_solver");
  assert.equal(entries[1].solver, "get_factory_summary");
  assert.ok(Number.isInteger(entries[1].bridge_elapsed_ms));
  assert.ok(entries[1].bridge_elapsed_ms >= 0);
  assert.ok(Number.isInteger(entries[1].route_elapsed_ms));
  assert.ok(entries[1].route_elapsed_ms >= 0);
});

test("reset endpoint clears one local conversation", async () => {
  const ask = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.ask",
      schema_version: 1,
      session_id: "reset-me",
      question: "Remember this.",
      world_snapshot: {
        schema: "aifactory.snapshot",
        schema_version: 1,
        data_policy: "authoritative_or_explicitly_unknown",
        actors: [],
      },
    }),
  });
  assert.equal(ask.status, 200);

  const reset = await fetch(`${baseUrl}/v1/reset`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.session.reset",
      schema_version: 1,
      session_id: "reset-me",
    }),
  });
  assert.equal(reset.status, 200);
  const body = await reset.json();
  assert.equal(body.reset, true);
  assert.equal(body.existed, true);
});

test("analyze endpoint returns the full solver report without calling a model", async () => {
  const response = await fetch(`${baseUrl}/v1/analyze`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.analyze",
      schema_version: 1,
      world_snapshot: buildFactorySnapshot(),
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema, "aifactory.analyze.answer");
  assert.equal(body.analysis.schema, "aifactory.analysis");
  assert.equal(body.analysis.world_revision, 41);
  assert.equal(body.analysis.machine_rates.machine_count, 4);
  assert.equal(body.analysis.power_circuits.circuits[0].headroom_mw, -25);
  assert.equal(body.analysis.bottlenecks.reported_machine_count, 4);

  const smelter = body.analysis.bottlenecks.reports.find((report) => report.actor_id === SMELTER);
  assert.equal(smelter.local_causes[0].cause, "input_starved");
});

test("analyze endpoint rejects a snapshot without the no-guessing policy", async () => {
  const response = await fetch(`${baseUrl}/v1/analyze`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.analyze",
      schema_version: 1,
      world_snapshot: { actors: [] },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /data policy/i);
});

test("analyze endpoint rejects an unsupported schema version", async () => {
  const response = await fetch(`${baseUrl}/v1/analyze`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ schema: "aifactory.analyze", schema_version: 99, world_snapshot: {} }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /schema version 1/);
});

test("ask endpoint records which solvers ran", async () => {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.ask",
      schema_version: 1,
      session_id: "solver-calls",
      question: "Why is the smelter stopped?",
      world_snapshot: buildFactorySnapshot(),
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.solver_calls.map((call) => call.tool),
    ["diagnose_bottlenecks", "get_power_circuits"],
  );
  assert.match(body.reply, /Deterministic solvers report 4 machine\(s\)/);
});

test("ask endpoint rejects snapshots without the no-guessing policy", async () => {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      schema: "aifactory.ask",
      schema_version: 1,
      question: "test",
      world_snapshot: {},
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /data policy/i);
});

test("POST endpoints reject browser and non-game request shapes", async () => {
  const missingSchema = await fetch(`${baseUrl}/v1/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingSchema.status, 403);

  const simpleBrowserPost = await fetch(`${baseUrl}/v1/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-AIFactory-Schema": "1",
    },
    body: "{}",
  });
  assert.equal(simpleBrowserPost.status, 415);

  const browserOrigin = await fetch(`${baseUrl}/v1/reset`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Origin: "https://example.invalid" },
    body: "{}",
  });
  assert.equal(browserOrigin.status, 403);
});

test("ask concurrency is rejected before a second request body is parsed", async () => {
  const limitedServer = createBridgeServer({
    env: { AI_PROVIDER: "mock", AIFACTORY_MAX_CONCURRENT_REQUESTS: "1" },
  });
  await new Promise((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  const address = limitedServer.address();
  const limitedUrl = `http://127.0.0.1:${address.port}`;
  const slowRequest = http.request(`${limitedUrl}/v1/ask`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      "Content-Length": "100000",
    },
  });
  slowRequest.on("error", () => {});
  slowRequest.write("{");

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`${limitedUrl}/v1/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /already handling 1 ask request/i);
  } finally {
    slowRequest.destroy();
    await new Promise((resolve, reject) =>
      limitedServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("provider readiness catches incomplete and recursive configurations", () => {
  assert.equal(assessProviderConfiguration("mock", {}).ready, true);
  assert.deepEqual(
    assessProviderConfiguration("anthropic", {}).issues,
    [
      "ANTHROPIC_API_KEY is not configured.",
      "ANTHROPIC_MODEL is not configured.",
    ],
  );
  const recursive = assessProviderConfiguration("hybrid", {
    AIFACTORY_CHEAP_PROVIDER: "hybrid",
    AIFACTORY_STRONG_PROVIDER: "openai",
    OPENAI_API_KEY: "test",
  });
  assert.equal(recursive.ready, false);
  assert.match(recursive.issues.join(" "), /cannot itself be hybrid/i);
});

test("local readiness verifies both endpoint reachability and the configured model", async () => {
  const ready = await assessProviderReadiness(
    "local",
    { LOCAL_AI_MODEL: "qwen3:8b", LOCAL_AI_BASE_URL: "http://127.0.0.1:11434/v1" },
    async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3:8b" }] }),
    }),
  );
  assert.equal(ready.operational_ready, true);

  const missing = await assessProviderReadiness(
    "local",
    { LOCAL_AI_MODEL: "missing", LOCAL_AI_BASE_URL: "http://127.0.0.1:11434/v1" },
    async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3:8b" }] }),
    }),
  );
  assert.equal(missing.operational_ready, false);
  assert.match(missing.issues.join(" "), /not listed/i);

  const offline = await assessProviderReadiness(
    "local",
    { LOCAL_AI_MODEL: "qwen3:8b" },
    async () => {
      throw new Error("connection refused");
    },
  );
  assert.equal(offline.operational_ready, false);
  assert.match(offline.issues.join(" "), /unreachable.*connection refused/i);
});

test("health reports provider-specific search switches exactly", async () => {
  const noSearchServer = createBridgeServer({
    env: {
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "test",
      OPENAI_WEB_SEARCH: "false",
    },
  });
  await new Promise((resolve) => noSearchServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = noSearchServer.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((response) =>
      response.json(),
    );
    assert.equal(health.outside_references.web_search, false);
    assert.equal(health.outside_references.requested_but_unavailable, true);
  } finally {
    await new Promise((resolve, reject) =>
      noSearchServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const unrestrictedServer = createBridgeServer({
    env: {
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "test",
      OPENAI_WEB_SEARCH_DOMAIN_FILTER: "false",
    },
  });
  await new Promise((resolve) => unrestrictedServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = unrestrictedServer.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((response) =>
      response.json(),
    );
    assert.equal(health.outside_references.web_search, true);
    assert.equal(health.outside_references.restricted_to_configured_sources, false);
  } finally {
    await new Promise((resolve, reject) =>
      unrestrictedServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a second write plan invalidates every write but preserves overlays", () => {
  const collector = createActionCollector();
  collector.emit([{ action: "teleport_player", commit: true }]);
  assert.throws(
    () => collector.emit([{ action: "place_building", commit: true }]),
    /more than one world-changing plan/i,
  );
  collector.emit([{ action: "highlight", commit: true }]);

  assert.match(collector.conflict, /All writes were removed/);
  assert.deepEqual(collector.actions, [{ action: "highlight", commit: true }]);
});

test("a dry-run preview may precede one committed write plan", () => {
  const collector = createActionCollector();
  collector.emit([{ action: "place_building", commit: false }]);
  collector.emit([{ action: "place_building", commit: true }]);
  assert.equal(collector.conflict, null);
  assert.deepEqual(
    collector.actions.map((action) => action.commit),
    [false, true],
  );
});

test("discard removes every action from a provider turn that failed", () => {
  const collector = createActionCollector();
  collector.emit([
    { action: "highlight", commit: true },
    { action: "teleport_player", commit: true },
  ]);
  collector.discard();
  assert.deepEqual(collector.actions, []);
});

test("a withheld historical-cause answer leads with the snapshot's real limit", () => {
  const reply = formatGroundingFailureReply(
    "why did the game place my starting area next to coal",
    "Current factory diagnostic.",
  );
  assert.match(reply, /^The snapshot records the current game state/i);
  assert.match(reply, /cannot establish why/i);
  assert.match(reply, /won't present correlation as a cause/i);
  assert.match(reply, /No model-proposed action was kept/i);
  assert.match(reply, /Current factory diagnostic\.$/);
});

test("a withheld live diagnostic asks for solver evidence instead of denying capability", () => {
  const reply = formatGroundingFailureReply(
    "why is my smelter starved",
    "Current factory diagnostic.",
  );
  assert.match(reply, /^The model's live-game claims were not backed/i);
  assert.match(reply, /usable deterministic evidence/i);
  assert.doesNotMatch(reply, /cannot establish why/i);
  assert.match(reply, /Current factory diagnostic\.$/);
});

test("a broken provider falls back to deterministic live analysis", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-provider-failure-"));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const routingLog = path.join(temporaryDirectory, "routing.jsonl");
  const fallbackServer = createBridgeServer({
    env: { AI_PROVIDER: "openai", AIFACTORY_ROUTING_LOG: routingLog },
  });
  await new Promise((resolve) => fallbackServer.listen(0, "127.0.0.1", resolve));
  const address = fallbackServer.address();
  const fallbackUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${fallbackUrl}/v1/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        schema: "aifactory.ask",
        schema_version: 1,
        question: "Tell me a joke about this factory.",
        world_snapshot: buildFactorySnapshot(),
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "fallback");
    assert.equal(body.answered_by, "deterministic_fallback");
    assert.match(body.provider_error, /OPENAI_API_KEY/);
    assert.equal(body.provider_failure.billing_state, "not_started");
    assert.equal(body.cost.usd, 0);
    assert.match(body.reply, /verified diagnostic below may not answer the original question/i);

    const routingEntry = JSON.parse(fs.readFileSync(routingLog, "utf8").trim());
    assert.deepEqual(routingEntry.provider_failure, {
      kind: "provider_error",
      provider: "openai",
      model: null,
      billing_state: "not_started",
      attempts: [],
    });
  } finally {
    await new Promise((resolve, reject) =>
      fallbackServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
