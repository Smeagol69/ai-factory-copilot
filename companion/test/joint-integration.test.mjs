import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeServer } from "../server.mjs";
import { createSnapshotCache } from "../lib/snapshot-cache.mjs";
import { createTerrainCache, defaultCachePath } from "../lib/terrain-cache.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

test("terrain cache respects the injected environment and supports memory-only operation", () => {
  assert.equal(defaultCachePath({}), null);
  assert.equal(defaultCachePath({ LOCALAPPDATA: "ignored", AIFACTORY_TERRAIN_CACHE: "off" }), null);
  assert.equal(defaultCachePath({ AIFACTORY_TERRAIN_CACHE: "./custom-terrain.json" }), path.resolve("./custom-terrain.json"));
  const cache = createTerrainCache({ env: {} });
  assert.equal(cache.filePath, null);
  assert.equal(cache.size, 0);
  const snapshot = { actors: [{ actor_id: "isolated-node", terrain: { sampled: true, verdict: "flat_and_clear" } }] };
  assert.equal(cache.harvest(snapshot).learned, 1);
  assert.equal(cache.flush(), false);
  assert.equal(cache.size, 1);
});

test("observe caches changed same-revision data while saved-base commands remain free", async t => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, "aifactory-joint-"));
  const server = createBridgeServer({ env: { AI_PROVIDER: "mock", AIFACTORY_ROUTING_LOG: "off",
    AIFACTORY_TERRAIN_CACHE: "off", AIFACTORY_SNAPSHOT_CACHE: directory } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(fs.realpathSync(directory)), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (endpoint, body) => {
    const response = await fetch(url + endpoint, { method: "POST",
      headers: { "content-type": "application/json", "X-AIFactory-Schema": "1" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const snapshot = buildFactorySnapshot();
  snapshot.world = { ...snapshot.world, map: "Persistent_Level", session_name: "isolated joint integration", scan_radius_meters: 250 };
  const observe = () => post("/v1/observe", { schema: "aifactory.observe", schema_version: 1, world_snapshot: snapshot });
  const first = await observe();
  assert.equal(first.schema, "aifactory.observe.ack");
  assert.equal(first.stored, true);
  assert.equal(first.actions, undefined);
  assert.equal(first.reply, undefined);
  assert.equal((await observe()).stored, false);
  snapshot.generated_at_utc = "2026-09-23T01:00:00Z";
  assert.equal((await observe()).stored, false, "capture time alone need not rewrite identical world data");
  snapshot.world.scan_center = { x: 800, y: 1600, z: 2400 };
  assert.equal((await observe()).stored, true, "moving a nearby capture changes its coverage without changing revision");
  snapshot.actors[0].integration_inventory_readback = { item: "fixture", count: 7 };
  assert.equal((await observe()).stored, true, "changed state at an unchanged structural revision must be retained");
  const cache = createSnapshotCache({ directory });
  assert.deepEqual(cache.read(first.save_id, { slot: "latest" }).snapshot.actors[0].integration_inventory_readback,
    { item: "fixture", count: 7 });
  delete snapshot.world.scan_radius_meters;
  assert.deepEqual((await observe()).slots_written, ["latest", "world"]);
  snapshot.world.scan_radius_meters = 250;
  assert.deepEqual((await observe()).slots_written, ["latest"]);
  assert.equal(cache.read(first.save_id).whole_world, true);
  for (const [question, commit] of [["check base chatgpt", false], ["restore base chatgpt", true]]) {
    const answer = await post("/v1/ask", { schema: "aifactory.ask", schema_version: 1,
      session_id: "joint-integration", question, world_snapshot: snapshot });
    assert.equal(answer.provider, "solvers");
    assert.equal(answer.cost.usd, 0);
    assert.equal(answer.actions.length, 1);
    assert.equal(answer.actions[0].action, "restore_base");
    assert.equal(answer.actions[0].commit, commit);
  }
});
