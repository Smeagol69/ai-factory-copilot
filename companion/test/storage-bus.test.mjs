import assert from "node:assert/strict";
import test from "node:test";

import { planStorageBus } from "../lib/storage-bus.mjs";

const SPLITTER = "/Game/FactoryGame/Buildable/Factory/CA_Splitter/Build_ConveyorAttachmentSplitterSmart.Build_ConveyorAttachmentSplitterSmart_C";
const CONTAINER = "/Game/FactoryGame/Buildable/Factory/StorageContainerMk1/Build_StorageContainerMk1.Build_StorageContainerMk1_C";

/** A captured splitter instance with one input and `outputs` outputs. */
function splitterNode(outputs = 3) {
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
  return {
    actor_id: "splitter_instance",
    class_path: SPLITTER,
    inventory_slot_count: 0,
    raw: { location: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 }, connections },
  };
}

function containerNode(id = "container_instance") {
  return {
    actor_id: id,
    class_path: CONTAINER,
    inventory_slot_count: 24,
    raw: {
      location: { x: 500, y: 0, z: 0 },
      connections: [
        { kind: "factory", direction: "FCD_INPUT", component: "Input0", location: { x: 450, y: 0, z: 0 } },
      ],
    },
  };
}

function minerNode(id, resourceActorId) {
  return {
    actor_id: id,
    class_path: "/Game/Build_MinerMk1.Build_MinerMk1_C",
    inventory_slot_count: 1,
    raw: { extractor: { extractable_resource_actor_id: resourceActorId }, connections: [] },
  };
}

function resourceNode(id, resourceClass) {
  return { actor_id: id, class_path: "node", raw: { resource_class: resourceClass } };
}

function recipe(productShort, available = true) {
  return {
    class_path: `/Game/Recipe_${productShort}.Recipe_${productShort}_C`,
    recipe_class: `/Game/Recipe_${productShort}.Recipe_${productShort}_C`,
    name: productShort,
    available,
    produced_in: ["/Game/BP_BuildGun.BP_BuildGun_C"],
    products: [{ item_class: `/Game/Desc_${productShort}.Desc_${productShort}_C` }],
  };
}

function makeGraph({ outputs = 3, items = ["OreIron", "OreCopper"], available = true } = {}) {
  const nodes = new Map();
  nodes.set("splitter_instance", splitterNode(outputs));
  nodes.set("container_instance", containerNode());
  items.forEach((item, index) => {
    const nodeId = `node_${index}`;
    nodes.set(nodeId, resourceNode(nodeId, `/Game/Desc_${item}.Desc_${item}_C`));
    nodes.set(`miner_${index}`, minerNode(`miner_${index}`, nodeId));
  });
  return {
    nodes,
    snapshot: {
      content: {
        recipes: [
          recipe("ConveyorAttachmentSplitterSmart", available),
          recipe("StorageContainerMk1", true),
          recipe("ConveyorBeltMk1", true),
        ],
      },
    },
  };
}

test("a bus is composed from measured evidence, not vanilla assumptions", () => {
  const plan = planStorageBus(makeGraph(), { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, true, plan.reason);
  assert.equal(plan.evidence.splitter.measured_outputs, 3);
  assert.equal(plan.evidence.splitter.source, "per_instance_captured_connector_topology");
  assert.equal(plan.evidence.items_from, "captured_extractors");
  assert.equal(plan.schema, "aifactory.generated-blueprint/v4");
});

test("one lane per extracted item, each with its own container and filter", () => {
  const plan = planStorageBus(makeGraph({ items: ["OreIron", "OreCopper", "Stone"] }), {
    splitter_class_path: SPLITTER,
  });
  assert.equal(plan.lanes.length, 3);
  for (const lane of plan.lanes) {
    const container = plan.parts.find((part) => part.part_id === lane.container_part_id);
    assert.ok(container, `${lane.container_part_id} exists`);
    const splitter = plan.parts.find((part) => part.part_id === lane.splitter_part_id);
    const rule = splitter.sort_rules.find((entry) => entry.output_index === lane.output_index);
    assert.equal(rule.item_class, lane.item_class, "the filter names this lane's item");
    // The lane is actually belted: a sorted output that is not is the failure
    // the export refuses.
    assert.ok(
      plan.conveyors.some(
        (link) => link.from_part_id === lane.splitter_part_id && link.to_part_id === lane.container_part_id,
      ),
      "the lane has a belt",
    );
  }
});

test("every sorted output on a splitter is belted, which the export requires", () => {
  const plan = planStorageBus(makeGraph({ items: ["A", "B", "C", "D", "E"] }), {
    splitter_class_path: SPLITTER,
  });
  assert.equal(plan.planned, true, plan.reason);
  for (const part of plan.parts) {
    if (part.role !== "splitter" || !part.sort_rules) continue;
    const sorted = new Set(part.sort_rules.map((rule) => rule.output_index)).size;
    const belted = plan.conveyors.filter((link) => link.from_part_id === part.part_id).length;
    assert.ok(belted >= sorted, `${part.part_id}: ${sorted} sorted vs ${belted} belted`);
  }
});

test("no splitter claims more links than it has ports", () => {
  const plan = planStorageBus(makeGraph({ outputs: 3, items: ["A", "B", "C", "D", "E", "F"] }), {
    splitter_class_path: SPLITTER,
  });
  assert.equal(plan.planned, true, plan.reason);
  for (const part of plan.parts) {
    if (part.role !== "splitter") continue;
    const out = plan.conveyors.filter((link) => link.from_part_id === part.part_id).length;
    const into = plan.conveyors.filter((link) => link.to_part_id === part.part_id).length;
    assert.ok(out <= 3, `${part.part_id} uses ${out} of 3 outputs`);
    assert.ok(into <= 1, `${part.part_id} uses ${into} of 1 input`);
  }
});

test("the intake is left free on purpose", () => {
  // The whole reason the export rule is participation rather than saturation.
  const plan = planStorageBus(makeGraph(), { splitter_class_path: SPLITTER });
  const first = plan.parts[0];
  assert.equal(plan.intake.part_id, first.part_id);
  assert.equal(plan.intake.free, true);
  assert.equal(
    plan.conveyors.some((link) => link.to_part_id === first.part_id),
    false,
    "nothing feeds the first splitter inside the blueprint",
  );
});

test("overflow is unfiltered and terminal, so a full lane cannot stall the bus", () => {
  const plan = planStorageBus(makeGraph(), { splitter_class_path: SPLITTER });
  assert.equal(plan.overflow.unfiltered, true);
  const overflow = plan.parts.find((part) => part.part_id === plan.overflow.container_part_id);
  assert.ok(overflow, "the overflow container exists");
  assert.ok(
    plan.conveyors.some((link) => link.to_part_id === overflow.part_id),
    "something belts into overflow",
  );
  assert.equal(
    plan.conveyors.some((link) => link.from_part_id === overflow.part_id),
    false,
    "nothing leaves it",
  );
});

test("every part id is unique and every link names real parts", () => {
  const plan = planStorageBus(makeGraph({ items: ["A", "B", "C", "D"] }), {
    splitter_class_path: SPLITTER,
  });
  const ids = plan.parts.map((part) => part.part_id);
  assert.equal(new Set(ids).size, ids.length, "part ids are unique");
  const linkIds = plan.conveyors.map((link) => link.link_id);
  assert.equal(new Set(linkIds).size, linkIds.length, "link ids are unique");
  for (const link of plan.conveyors) {
    assert.ok(ids.includes(link.from_part_id), `${link.link_id} from a real part`);
    assert.ok(ids.includes(link.to_part_id), `${link.link_id} to a real part`);
  }
});

test("a locked splitter refuses rather than planning something unbuildable", () => {
  const plan = planStorageBus(makeGraph({ available: false }), { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /not unlocked/);
  assert.deepEqual(plan.missing, ["unlocked_splitter_recipe"]);
});

test("no captured splitter means refuse and say what to build", () => {
  const graph = makeGraph();
  graph.nodes.delete("splitter_instance");
  const plan = planStorageBus(graph, { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, false);
  assert.match(plan.note ?? "", /Build one anywhere first/);
});

test("a two-output splitter still sorts; a one-output one cannot", () => {
  const two = planStorageBus(makeGraph({ outputs: 2 }), { splitter_class_path: SPLITTER });
  assert.equal(two.planned, true, two.reason);
  const one = planStorageBus(makeGraph({ outputs: 1 }), { splitter_class_path: SPLITTER });
  assert.equal(one.planned, false);
  assert.match(one.reason, /at least two outputs|fewer than two outputs/);
});

test("nothing being extracted refuses instead of planning an empty hub", () => {
  const plan = planStorageBus(makeGraph({ items: [] }), { splitter_class_path: SPLITTER });
  assert.equal(plan.planned, false);
  assert.deepEqual(plan.missing, ["items_to_sort"]);
});

test("an explicit item list overrides the census and says so", () => {
  const plan = planStorageBus(makeGraph(), {
    splitter_class_path: SPLITTER,
    items: ["/Game/Desc_Coal.Desc_Coal_C"],
  });
  assert.equal(plan.planned, true, plan.reason);
  assert.equal(plan.lanes.length, 1);
  assert.equal(plan.lanes[0].item_class, "/Game/Desc_Coal.Desc_Coal_C");
  assert.equal(plan.evidence.items_from, "explicit_request");
});
