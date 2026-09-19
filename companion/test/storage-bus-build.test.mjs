import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { planStorageBus, storageBusActions } from "../lib/storage-bus.mjs";
import { validatePlan } from "../lib/actions.mjs";

const SPLITTER = "/Game/Build_ConveyorAttachmentSplitterSmart.Build_ConveyorAttachmentSplitterSmart_C";
const CONTAINER = "/Game/Build_StorageContainerMk1.Build_StorageContainerMk1_C";
const ORES = ["OreIron", "OreCopper", "Stone"];

function recipe(product, available = true) {
  const classPath = `/Game/Recipe_${product}.Recipe_${product}_C`;
  return {
    class_path: classPath,
    recipe_class: classPath,
    name: product,
    available,
    produced_in: ["/Game/BP_BuildGun.BP_BuildGun_C"],
    products: [{ item_class: `/Game/Desc_${product}.Desc_${product}_C` }],
  };
}

function splitterConnections(outputs) {
  const connections = [
    {
      kind: "factory",
      direction: "FCD_INPUT",
      component: "Input0",
      location: { x: -100, y: 0, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
    },
  ];
  for (let index = 0; index < outputs; index += 1) {
    connections.push({
      kind: "factory",
      direction: "FCD_OUTPUT",
      component: `Output${index}`,
      location: { x: 100, y: index * 50, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
    });
  }
  return connections;
}

/**
 * A graph shaped like the real one, including the two things the bridge's
 * unlock gate demands: a populated recipesByClass and an explicit
 * availability_known. Without those it refuses every generated blueprint, which
 * is correct - an unproven unlock state must never become a build.
 */
function makeGraph({ outputs = 3, ores = ORES } = {}) {
  const recipes = [
    recipe("ConveyorAttachmentSplitterSmart"),
    recipe("StorageContainerMk1"),
    recipe("ConveyorBeltMk1"),
    ...ores.map((ore) => recipe(ore)),
  ];
  const nodes = new Map();
  nodes.set("splitter", {
    actor_id: "splitter",
    class_path: SPLITTER,
    inventory_slot_count: 0,
    raw: { location: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 }, connections: splitterConnections(outputs) },
  });
  nodes.set("container", {
    actor_id: "container",
    class_path: CONTAINER,
    inventory_slot_count: 24,
    raw: {
      location: { x: 500, y: 0, z: 0 },
      connections: [
        { kind: "factory", direction: "FCD_INPUT", component: "Input0", location: { x: 450, y: 0, z: 0 } },
      ],
    },
  });
  ores.forEach((ore, index) => {
    nodes.set(`node_${index}`, {
      actor_id: `node_${index}`,
      raw: { resource_class: `/Game/Desc_${ore}.Desc_${ore}_C` },
    });
    nodes.set(`miner_${index}`, {
      actor_id: `miner_${index}`,
      inventory_slot_count: 1,
      raw: { extractor: { extractable_resource_actor_id: `node_${index}` }, connections: [] },
    });
  });

  return {
    nodes,
    recipesByClass: new Map(recipes.map((entry) => [entry.class_path, entry])),
    snapshot: {
      content: {
        availability_known: true,
        recipes,
        items: ores.map((ore) => ({ class_path: `/Game/Desc_${ore}.Desc_${ore}_C`, name: ore })),
      },
    },
  };
}

test("a planned bus survives the real bridge validator end to end", () => {
  // The point of this whole lane: the plan is not merely well-formed, it is
  // accepted by the same validator a live request goes through.
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, true, plan.reason);

  const actions = storageBusActions(plan, { blueprint_name: "Sorted Storage Bus", commit: true });
  const result = validatePlan(graph, actions);
  assert.equal(result.valid, true, JSON.stringify(result.rejected ?? result.reason));
  assert.equal(result.actions.length, 1, "exactly one action");
  assert.equal(result.actions[0].action, "generate_native_blueprint");
});

test("the emitted action uses the contract's own field names", () => {
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  const [action] = storageBusActions(plan, { blueprint_name: "Bus", commit: true });
  // `buildables`, not `parts` - the rename lives in the adapter so the plan
  // stays readable on its own terms.
  assert.ok(Array.isArray(action.buildables));
  assert.equal(action.parts, undefined);
  assert.equal(action.layout_schema, "aifactory.generated-blueprint/v4");
  assert.equal(action.blueprint_name, "Bus");
});

test("the sort rules survive into the validated action", () => {
  // Everything else is scaffolding; this is the part that makes the bus sort.
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  const actions = storageBusActions(plan, { blueprint_name: "Bus", commit: true });
  const validated = validatePlan(graph, actions);
  assert.equal(validated.valid, true, JSON.stringify(validated.rejected ?? ""));

  const splitters = validated.actions[0].buildables.filter((part) => part.role === "splitter");
  assert.ok(splitters.length >= 1);
  const rules = splitters.flatMap((part) => part.sort_rules ?? []);
  assert.equal(rules.length, ORES.length, "one rule per ore");
  for (const ore of ORES) {
    assert.ok(
      rules.some((rule) => rule.item_class === `/Game/Desc_${ore}.Desc_${ore}_C`),
      `${ore} has a filter`,
    );
  }
});

test("a native blueprint write must stand alone, and this emits exactly one", () => {
  // It writes a file and cannot be undone, so it may not share a transaction
  // with reversible writes. One action is the only shape that satisfies that.
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  assert.equal(storageBusActions(plan, { blueprint_name: "Bus", commit: true }).length, 1);
});

test("an uncompiled plan emits nothing at all", () => {
  // No partial build, ever: a refusal upstream must not become a half bus.
  assert.deepEqual(storageBusActions(null, { blueprint_name: "Bus" }), []);
  assert.deepEqual(storageBusActions({ planned: false }, { blueprint_name: "Bus" }), []);
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  assert.deepEqual(storageBusActions(plan, {}), [], "and no action without a name");
});

test("the unlock gate is not bypassed by this lane", () => {
  // An unproven unlock state must never become a build. Removing the capture
  // must refuse even though the plan itself is fine.
  const graph = makeGraph();
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, true);

  const blind = { ...graph, snapshot: { content: { ...graph.snapshot.content, availability_known: false } } };
  const result = validatePlan(blind, storageBusActions(plan, { blueprint_name: "Bus", commit: true }));
  assert.equal(result.valid, false);
  assert.equal(
    result.rejected[0].reason,
    "generated_blueprint_requires_authoritative_recipe_unlock_capture",
  );
});

test("the tool hands back a ready action without pre-committing it", () => {
  const source = fs
    .readFileSync(new URL("../lib/tools.mjs", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(source, /proposed_action: storageBusActions\(plan, \{ blueprint_name: name, commit: false \}\)\[0\]/);
  // The player approves the write; the tool never decides to build.
  assert.match(source, /must be the only/);
});
