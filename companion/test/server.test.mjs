import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBridgeServer } from "../server.mjs";
import { SMELTER, buildFactorySnapshot } from "./fixtures/factory.mjs";

let server;
let baseUrl;

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
  assert.equal(body.provider, "mock");
  assert.equal(body.loopback_only, true);
  assert.equal(body.conveyor_speed_divisor, 2);
  assert.ok(body.solver_tools.includes("diagnose_bottlenecks"));
  assert.ok(body.solver_tools.includes("find_best_site"));
  assert.equal(body.solver_tools.length, 9);
});

test("ask endpoint accepts an authoritative snapshot", async () => {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  assert.equal(body.provider, "mock");
  assert.equal(body.world_revision, 7);
  assert.equal(body.retained_history_messages, 2);
  assert.match(body.reply, /1 actors/);
});

test("reset endpoint clears one local conversation", async () => {
  const ask = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: "aifactory.analyze", schema_version: 99, world_snapshot: {} }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /schema version 1/);
});

test("ask endpoint records which solvers ran", async () => {
  const response = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
