import test from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../lib/graph.mjs";
import { answerLocally, parseUnlockSchematicRequest } from "../lib/router.mjs";

const schematic = { name: "Monorail Train Technology", class_path: "/Game/Schematic_6-3.Schematic_6-3_C" };
const fixture = () => buildGraph({ world_revision: 185, actors: [], content: {},
  progression: { unpurchased_schematics: [schematic], purchased_schematics: [] } });

test("real train requests emit one native-dispatchable revision-stamped action without a model", () => {
  for (const q of ["unlock train tech", "unlock Monorail Train Technology and only that",
    "can you unlock trains for me just that milestone?"]) {
    const emitted = [];
    const result = answerLocally(q, fixture(), { actions: { emit: a => emitted.push(...a) } });
    assert.ok(result, q);
    assert.deepEqual(emitted, [{ action: "unlock_schematic", schematic_class: schematic.class_path,
      force: true, commit: true, expect_world_revision: "185", require_unchanged_world: false }]);
    assert.match(result.reply, /game will report/i);
  }
});

test("unlock route refuses ambiguity, conditional requests and extra actions", () => {
  for (const q of ["what does train tech cost", "unlock trains and give me iron", "unlock all trains",
    "unlock trains if I can afford it", "do not unlock trains", "unlock trains without changing anything"]) {
    assert.equal(parseUnlockSchematicRequest(q, fixture()), null, q);
  }
  const graph = fixture();
  graph.snapshot.progression.unpurchased_schematics.push({ ...schematic, class_path: "/Mod/Other.Other_C" });
  assert.equal(parseUnlockSchematicRequest("unlock trains", graph), null);
});
