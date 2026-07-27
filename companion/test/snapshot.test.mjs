import assert from "node:assert/strict";
import test from "node:test";
import { compactSnapshot, summarizeSnapshot } from "../lib/snapshot.mjs";

test("compaction removes reflection before authoritative core actor fields", () => {
  const snapshot = {
    data_policy: "authoritative_or_explicitly_unknown",
    actors: [
      {
        actor_id: "A",
        kind: "buildable",
        owner_mod: "ExampleMod",
        reflected_properties: [{ name: "Huge", value: "x".repeat(10_000) }],
      },
    ],
    content: { items: [], recipes: [] },
  };
  const result = compactSnapshot(snapshot, "actor A", 1000);
  assert.ok(result.omissions.includes("reflected_properties"));
  assert.equal(result.snapshot.actors[0].actor_id, "A");
  assert.equal(result.snapshot.actors[0].reflected_properties, undefined);
});

test("summary counts mod ownership without interpreting behavior", () => {
  const summary = summarizeSnapshot({
    world_revision: 4,
    mods: [{}, {}],
    content: { items: [{}], recipes: [{}, {}] },
    actors: [
      { kind: "buildable", owner_mod: "FactoryGame" },
      { kind: "buildable", owner_mod: "SomeMod" },
      { kind: "resource_node", owner_mod: "FactoryGame" },
    ],
  });
  assert.equal(summary.mods, 2);
  assert.equal(summary.actors, 3);
  assert.equal(summary.actors_by_owner_mod.FactoryGame, 2);
  assert.equal(summary.actors_by_owner_mod.SomeMod, 1);
});

test("hard compaction always returns valid JSON", () => {
  const result = compactSnapshot(
    {
      schema: "aifactory.snapshot",
      schema_version: 1,
      data_policy: "authoritative_or_explicitly_unknown",
      world_revision: 1,
      world: { map: "x".repeat(1000) },
      mods: [{ reference: "Big", description: "y".repeat(1000) }],
      content: { items: [{ description: "z".repeat(1000) }], recipes: [] },
      actors: [{ actor_id: "A", reflected_properties: [{ value: "q".repeat(1000) }] }],
    },
    "test",
    300,
  );
  assert.doesNotThrow(() => JSON.parse(result.serialized));
  assert.equal(JSON.parse(result.serialized).data_policy, "authoritative_or_explicitly_unknown");
});

test("hard compaction never drops exact interaction grounding", () => {
  const interactionContext = {
    captured_at_utc: "2026-01-01T00:00:00Z",
    player: { pawn_location: { x: 10, y: 20, z: 30 } },
    preferred_target: { available: true, actor_id: "Machine_Exact" },
  };
  const result = compactSnapshot(
    {
      schema: "aifactory.snapshot",
      schema_version: 1,
      data_policy: "authoritative_or_explicitly_unknown",
      world_revision: 2,
      interaction_context: interactionContext,
      actors: [{ actor_id: "Large", reflected_properties: [{ value: "x".repeat(5000) }] }],
      content: { items: [], recipes: [] },
    },
    "what is this",
    900,
  );
  assert.deepEqual(result.snapshot.interaction_context, interactionContext);
});
