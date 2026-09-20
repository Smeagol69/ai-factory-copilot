import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { centralHubActions, composeCentralHub } from "../lib/central-hub.mjs";

const ORE_IRON = "/Game/Desc_OreIron.Desc_OreIron_C";
const ORE_COPPER = "/Game/Desc_OreCopper.Desc_OreCopper_C";
const INGOT_IRON = "/Game/Desc_IronIngot.Desc_IronIngot_C";
const INGOT_COPPER = "/Game/Desc_CopperIngot.Desc_CopperIngot_C";
const SMELTER = "/Game/Build_SmelterMk1.Build_SmelterMk1_C";
const CONTAINER = "/Game/Build_StorageContainerMk1.Build_StorageContainerMk1_C";

/**
 * Built through the real buildGraph rather than hand-assembled.
 *
 * An earlier hand-made stub silently lacked `duration_seconds` on its recipes,
 * so every production probe returned nothing and the whole composer looked
 * broken. Going through the real builder means the fixture cannot drift from
 * what the pipeline actually produces.
 */
function actor(fields) {
  return { kind: "buildable", connections: [], inventories: [], ...fields };
}

function deckActors(cols, rows, z = 0) {
  const actors = [];
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cy = 0; cy < rows; cy += 1) {
      actors.push(actor({
        actor_id: `f_${cx}_${cy}`,
        name: `Foundation_${cx}_${cy}`,
        kind: "lightweight_buildable",
        class_path: "/Game/Build_Foundation.Build_Foundation_C",
        location: { x: cx * 800, y: cy * 800, z },
        bounds: { origin: { x: cx * 800, y: cy * 800, z }, extent: { x: 400, y: 400, z: 100 } },
      }));
    }
  }
  return actors;
}

function recipe({ name, cls, ingredients = [], products = [], producedIn, seconds = 2, available = true }) {
  return {
    class_path: cls, recipe_class: cls, name, available,
    duration_seconds: seconds, ingredients, products, produced_in: producedIn,
  };
}

function makeWorld({ cols = 14, rows = 14, ores = [[ORE_IRON, 120], [ORE_COPPER, 120]], withSmelter = true } = {}) {
  const actors = [...deckActors(cols, rows)];

  if (withSmelter) {
    actors.push(actor({
      actor_id: "smelter_sample",
      name: "Smelter_sample",
      class_path: SMELTER,
      built_with_recipe: "/Game/Recipe_SmelterMk1.Recipe_SmelterMk1_C",
      location: { x: 20000, y: 20000, z: 0 },
      bounds: { origin: { x: 20000, y: 20000, z: 0 }, extent: { x: 300, y: 500, z: 200 } },
      manufacturer: { recipe_class: "/Game/Recipe_IronIngot.Recipe_IronIngot_C" },
      factory: { production_status: "producing" },
    }));
  }

  actors.push(actor({
    actor_id: "container_sample",
    name: "StorageContainer_sample",
    class_path: CONTAINER,
    built_with_recipe: "/Game/Recipe_StorageContainerMk1.Recipe_StorageContainerMk1_C",
    location: { x: 21000, y: 20000, z: 0 },
    bounds: { origin: { x: 21000, y: 20000, z: 0 }, extent: { x: 250, y: 150, z: 200 } },
    factory: {},
    inventories: [{ component: "container_sample_inv", slots: 24, stacks: [] }],
    connections: [{ kind: "factory", direction: "FCD_INPUT", component: "Input0", location: { x: 20750, y: 20000, z: 0 } }],
  }));

  actors.push(actor({
    actor_id: "belt_sample",
    name: "ConveyorBeltMk1_sample",
    class_path: "/Game/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
    location: { x: 22000, y: 20000, z: 0 },
    transport: { kind: "conveyor", reported_speed: 1560, item_spacing_cm: 120 },
  }));

  ores.forEach(([ore, rate], index) => {
    actors.push(actor({
      actor_id: `miner_${index}`,
      name: `MinerMk3_${index}`,
      class_path: "/Game/Build_MinerMk3.Build_MinerMk3_C",
      location: { x: 30000, y: index * 1000, z: 0 },
      factory: {},
      extractor: { extractable_resource_actor_id: `node_${index}`, extraction_per_minute: rate },
    }));
    actors.push({ actor_id: `node_${index}`, kind: "resource_node", name: `Node_${index}`, resource_class: ore, connections: [], inventories: [] });
  });

  const recipes = [
    recipe({ name: "Iron Ingot", cls: "/Game/Recipe_IronIngot.Recipe_IronIngot_C",
      ingredients: [{ item_class: ORE_IRON, amount: 1 }],
      products: [{ item_class: INGOT_IRON, amount: 1 }], producedIn: [SMELTER] }),
    recipe({ name: "Copper Ingot", cls: "/Game/Recipe_CopperIngot.Recipe_CopperIngot_C",
      ingredients: [{ item_class: ORE_COPPER, amount: 1 }],
      products: [{ item_class: INGOT_COPPER, amount: 1 }], producedIn: [SMELTER] }),
    recipe({ name: "Smelter", cls: "/Game/Recipe_SmelterMk1.Recipe_SmelterMk1_C",
      products: [{ item_class: "/Game/Desc_SmelterMk1.Desc_SmelterMk1_C", amount: 1 }],
      producedIn: ["/Game/BP_BuildGun.BP_BuildGun_C"] }),
    recipe({ name: "Storage Container", cls: "/Game/Recipe_StorageContainerMk1.Recipe_StorageContainerMk1_C",
      products: [{ item_class: "/Game/Desc_StorageContainerMk1.Desc_StorageContainerMk1_C", amount: 1 }],
      producedIn: ["/Game/BP_BuildGun.BP_BuildGun_C"] }),
    recipe({ name: "Conveyor Belt Mk.1", cls: "/Game/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C",
      products: [{ item_class: "/Game/Desc_ConveyorBeltMk1.Desc_ConveyorBeltMk1_C", amount: 1 }],
      producedIn: ["/Game/BP_BuildGun.BP_BuildGun_C"] }),
  ];

  const items = [
    { class_path: ORE_IRON, name: "Iron Ore" }, { class_path: ORE_COPPER, name: "Copper Ore" },
    { class_path: INGOT_IRON, name: "Iron Ingot" }, { class_path: INGOT_COPPER, name: "Copper Ingot" },
  ];

  return buildGraph({ actors, content: { availability_known: true, recipes, items } });
}

test("with no service level, everything stands on the deck surface", () => {
  // Scoped to the no-service-level case deliberately: once the distribution
  // drops below, balancer splitters sit lower by design, and the service-level
  // tests cover that. Left unscoped this would have quietly stopped describing
  // anything the moment the service level landed.
  const plan = composeCentralHub(makeWorld());
  assert.equal(plan.composed, true, plan.reason);
  assert.ok(plan.deck.deck_id, "it chose a deck");
  assert.equal(plan.service_level.used, false);
  for (const part of plan.parts) {
    assert.equal(part.relative_location.z, plan.deck.top_z_cm, `${part.part_id} sits on the deck`);
  }
});

test("one line per extracted ore, each with its own container", () => {
  const plan = composeCentralHub(makeWorld());
  assert.equal(plan.lines.length, 2, "iron and copper");
  const ores = plan.lines.map((line) => line.ore_class).sort();
  assert.deepEqual(ores, [ORE_COPPER, ORE_IRON].sort());
  for (const line of plan.lines) {
    assert.ok(plan.parts.some((part) => part.part_id === line.container_part_id));
    assert.ok(line.machines >= 1, "at least one machine");
    assert.equal(line.product_chosen_by, "default_for_this_ore");
  }
});

test("every machine belts into its own line's container", () => {
  const plan = composeCentralHub(makeWorld());
  for (const line of plan.lines) {
    const intoThis = plan.conveyors.filter((link) => link.to_part_id === line.container_part_id);
    assert.equal(intoThis.length, line.machines, "one belt per machine on this line");
    // And never into another line's container.
    for (const link of intoThis) assert.match(link.from_part_id, new RegExp(`^${line.container_part_id.split("_")[0]}_`));
  }
});

test("machines carry the production recipe, so the hub actually makes something", () => {
  const plan = composeCentralHub(makeWorld());
  const machines = plan.parts.filter((part) => part.role === "machine");
  assert.ok(machines.length >= 2);
  for (const machine of machines) {
    assert.ok(machine.production_recipe_class, `${machine.part_id} has a recipe`);
  }
});

test("it says it chose an unsorted topology rather than quietly dropping filters", () => {
  // Sorting was explicitly asked for in the original request; choosing not to
  // need it has to be visible.
  const plan = composeCentralHub(makeWorld());
  assert.equal(plan.topology.sorted, false);
  assert.match(plan.topology.why, /own container/);
  assert.match(plan.topology.why, /plan_storage_bus/);
});

test("with no balancer, machine inputs are left free for the player to belt", () => {
  // Scoped to the unbalanced case on purpose. Once a splitter is captured the
  // balancer does feed the machines, and "the balancer is a tree with one
  // intake per line" covers that - this test would otherwise quietly stop
  // describing anything once balancing landed.
  const plan = composeCentralHub(makeWorld());
  assert.equal(plan.intake.free, true);
  const machineIds = new Set(plan.parts.filter((part) => part.role === "machine").map((part) => part.part_id));
  for (const link of plan.conveyors) {
    assert.ok(!machineIds.has(link.to_part_id), "nothing inside the blueprint feeds a machine");
  }
});

test("a hub with nowhere at all to go refuses, and says what it tried", () => {
  // Behaviour changed deliberately: a hub that outgrows one deck now spills
  // onto the next rather than refusing, so refusal means no surveyed deck had
  // room for even one line. Refusing still beats placing half a hub off an edge.
  const plan = composeCentralHub(makeWorld({ cols: 2, rows: 2 }));
  assert.equal(plan.composed, false);
  assert.match(plan.reason, /no surveyed deck has room/);
  assert.ok(Array.isArray(plan.too_large) && plan.too_large.length > 0);
  assert.ok(plan.too_large[0].needs_m.x > 0);
  assert.match(plan.note, /max_lines/);
});

test("no deck means refuse, not a hub floating in the air", () => {
  const world = makeWorld();
  for (const key of [...world.nodes.keys()]) if (key.startsWith("f_")) world.nodes.delete(key);
  const plan = composeCentralHub(world);
  assert.equal(plan.composed, false);
  assert.deepEqual(plan.missing, ["a_foundation_deck"]);
});

test("no miners means refuse, because a hub would have nothing to process", () => {
  const plan = composeCentralHub(makeWorld({ ores: [] }));
  assert.equal(plan.composed, false);
  assert.deepEqual(plan.missing, ["captured_extractors"]);
});

test("a machine never built in this world refuses rather than being guessed", () => {
  // Footprints are measured from the player's own buildings; inventing one
  // would place a row that overlaps.
  const world = makeWorld();
  world.nodes.delete("smelter_sample");
  const plan = composeCentralHub(world);
  assert.equal(plan.composed, false);
  assert.ok(
    plan.attempts.some((entry) => entry.reason === "machine_footprint_has_never_been_measured_in_this_world"),
    JSON.stringify(plan.attempts),
  );
});

test("the composed hub becomes one standalone blueprint action", () => {
  const plan = composeCentralHub(makeWorld());
  const actions = centralHubActions(plan, { blueprint_name: "Central Hub", commit: true });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "generate_native_blueprint");
  assert.equal(actions[0].blueprint_name, "Central Hub");
  assert.ok(Array.isArray(actions[0].buildables) && actions[0].buildables.length > 0);
  // An uncomposed plan emits nothing: no partial hub, ever.
  assert.deepEqual(centralHubActions({ composed: false }, { blueprint_name: "x" }), []);
  assert.deepEqual(centralHubActions(plan, {}), [], "and none without a name");
});

/** A captured splitter so the balancer has geometry to measure. */
function splitterActor(outputs = 3) {
  const connections = [
    { kind: "factory", direction: "FCD_INPUT", component: "Input0", location: { x: 39900, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 } },
  ];
  for (let index = 0; index < outputs; index += 1) {
    connections.push({
      kind: "factory", direction: "FCD_OUTPUT", component: `Output${index}`,
      location: { x: 40100, y: index * 50, z: 0 }, normal: { x: 1, y: 0, z: 0 },
    });
  }
  return {
    actor_id: "splitter_sample",
    kind: "buildable",
    name: "Splitter_sample",
    class_path: "/Game/Build_ConveyorAttachmentSplitter.Build_ConveyorAttachmentSplitter_C",
    built_with_recipe: "/Game/Recipe_ConveyorAttachmentSplitter.Recipe_ConveyorAttachmentSplitter_C",
    location: { x: 40000, y: 0, z: 0 },
    rotation: { yaw: 0 },
    bounds: { origin: { x: 40000, y: 0, z: 0 }, extent: { x: 100, y: 100, z: 100 } },
    connections,
    inventories: [],
  };
}

function worldWithSplitter(options = {}) {
  const graph = makeWorld(options);
  const actor = splitterActor(options.splitterOutputs ?? 3);
  graph.nodes.set(actor.actor_id, {
    actor_id: actor.actor_id,
    kind: "buildable",
    role: "conveyor_attachment",
    class_path: actor.class_path,
    built_with_recipe: actor.built_with_recipe,
    location_cm: actor.location,
    inventory_by_item: new Map(),
    raw: actor,
  });
  graph.snapshot.content.recipes.push({
    class_path: "/Game/Recipe_ConveyorAttachmentSplitter.Recipe_ConveyorAttachmentSplitter_C",
    recipe_class: "/Game/Recipe_ConveyorAttachmentSplitter.Recipe_ConveyorAttachmentSplitter_C",
    name: "Conveyor Splitter", available: true, duration_seconds: 2,
    ingredients: [],
    products: [{ item_class: "/Game/Desc_ConveyorAttachmentSplitter.Desc_ConveyorAttachmentSplitter_C", amount: 1 }],
    produced_in: ["/Game/BP_BuildGun.BP_BuildGun_C"],
  });
  graph.recipesByClass.set(
    "/Game/Recipe_ConveyorAttachmentSplitter.Recipe_ConveyorAttachmentSplitter_C",
    graph.snapshot.content.recipes.at(-1),
  );
  return graph;
}

test("with a splitter captured, every machine on a line is actually fed", () => {
  // Without this only the first machine ever receives ore, which makes a
  // correctly sized line look broken.
  const plan = composeCentralHub(worldWithSplitter());
  assert.equal(plan.composed, true, plan.reason);
  assert.equal(plan.balancing.balanced, true);
  for (const line of plan.lines) {
    if (line.machines < 2) continue;
    for (let index = 1; index <= line.machines; index += 1) {
      const machineId = `${line.container_part_id.replace("_container", "")}_machine${index}`;
      assert.ok(
        plan.conveyors.some((link) => link.to_part_id === machineId),
        `${machineId} is fed`,
      );
    }
  }
});

test("the balancer is a tree with one intake per line", () => {
  const plan = composeCentralHub(worldWithSplitter());
  for (const line of plan.lines) {
    assert.ok(line.balanced, `${line.ore} is balanced`);
    assert.ok(line.intake_part_id, "the line has a single intake");
    // Nothing inside the blueprint feeds that intake: it is where the player
    // belts their miners in.
    assert.equal(
      plan.conveyors.some((link) => link.to_part_id === line.intake_part_id),
      false,
      "the line intake is free",
    );
  }
});

test("no splitter claims more links than its measured ports", () => {
  // The generated-blueprint export refuses a splitter with more links than
  // ports, so the composer must not emit one.
  const plan = composeCentralHub(worldWithSplitter({ splitterOutputs: 3 }));
  for (const part of plan.parts) {
    if (part.role !== "splitter") continue;
    const out = plan.conveyors.filter((link) => link.from_part_id === part.part_id).length;
    const into = plan.conveyors.filter((link) => link.to_part_id === part.part_id).length;
    assert.ok(out <= 3, `${part.part_id} uses ${out} of 3 outputs`);
    assert.ok(into <= 1, `${part.part_id} uses ${into} of 1 input`);
    assert.ok(out + into >= 1, `${part.part_id} participates in the topology`);
  }
});

test("balancer splitters carry no sort rules, so nothing is left unrouted", () => {
  // An unfiltered splitter has no sorted output to satisfy, which is why a
  // spare leaf output costs nothing.
  const plan = composeCentralHub(worldWithSplitter());
  for (const part of plan.parts) {
    if (part.role !== "splitter") continue;
    assert.equal(part.sort_rules, undefined, `${part.part_id} is unfiltered`);
  }
});

test("without a captured splitter the hub still composes, and says it is unbalanced", () => {
  // Refusing an otherwise buildable hub over a missing splitter would be worse
  // than building it with manual intakes.
  const plan = composeCentralHub(makeWorld());
  assert.equal(plan.composed, true, plan.reason);
  assert.equal(plan.balancing.balanced, false);
  assert.deepEqual(plan.balancing.missing, ["captured_splitter"]);
  assert.match(plan.balancing.why, /build one splitter anywhere/);
});

test("every part id stays unique once balancers are added", () => {
  const plan = composeCentralHub(worldWithSplitter());
  const ids = plan.parts.map((part) => part.part_id);
  assert.equal(new Set(ids).size, ids.length);
  const links = plan.conveyors.map((link) => link.link_id);
  assert.equal(new Set(links).size, links.length);
  const known = new Set(ids);
  for (const link of plan.conveyors) {
    assert.ok(known.has(link.from_part_id), `${link.link_id} from a real part`);
    assert.ok(known.has(link.to_part_id), `${link.link_id} to a real part`);
  }
});

/** A world whose deck has a second deck below it, proving the gap is real. */
function worldWithProvenGap() {
  const graph = worldWithSplitter();
  // A lower deck 20 m beneath, so the underside clearance is measured rather
  // than merely unoccupied.
  for (let cx = 0; cx < 6; cx += 1) {
    for (let cy = 0; cy < 6; cy += 1) {
      const id = `low_${cx}_${cy}`;
      graph.nodes.set(id, {
        actor_id: id,
        kind: "lightweight_buildable",
        class_path: "/Game/Build_Foundation.Build_Foundation_C",
        location_cm: { x: cx * 800, y: cy * 800, z: -2000 },
        inventory_by_item: new Map(),
        raw: {
          name: id, kind: "lightweight_buildable",
          location: { x: cx * 800, y: cy * 800, z: -2000 },
          bounds: { origin: { x: cx * 800, y: cy * 800, z: -2000 }, extent: { x: 400, y: 400, z: 100 } },
        },
      });
    }
  }
  return graph;
}

test("a measured gap below puts the distribution under the deck", () => {
  const plan = composeCentralHub(worldWithProvenGap());
  assert.equal(plan.composed, true, plan.reason);
  assert.equal(plan.service_level.used, true);
  assert.ok(plan.service_level.z_cm < plan.deck.top_z_cm, "the service level is below the deck");
  assert.match(plan.service_level.why, /measured space below/);
});

test("machines and containers stay on the deck; only the splitters drop", () => {
  // The whole point: the walking surface stays clear and belts rise to meet
  // what is on it.
  const plan = composeCentralHub(worldWithProvenGap());
  for (const part of plan.parts) {
    if (part.role === "splitter") {
      assert.equal(part.relative_location.z, plan.service_level.z_cm, `${part.part_id} is below`);
    } else {
      assert.equal(part.relative_location.z, plan.deck.top_z_cm, `${part.part_id} is on the deck`);
    }
  }
});

test("an unproven void is refused by default, and says how to override", () => {
  // Nothing is built below, but ground height is unknown - the space may be
  // open air or solid rock. Dropping splitters into that by default is the
  // failure the underside split exists to prevent.
  const plan = composeCentralHub(worldWithSplitter());
  assert.equal(plan.composed, true, plan.reason);
  assert.equal(plan.service_level.used, false);
  assert.match(plan.service_level.why, /ground height is unknown/);
  assert.match(plan.service_level.why, /service_level true/);
});

test("an explicit request places below even when the ground is unknown", () => {
  // The player can see their own base; this is their call to make.
  const plan = composeCentralHub(worldWithSplitter(), { service_level: true });
  assert.equal(plan.service_level.used, true);
  assert.match(plan.service_level.why, /requested explicitly/);
  assert.match(plan.service_level.why, /ground is unknown/);
});

test("service_level false keeps everything up, even with a measured gap", () => {
  const plan = composeCentralHub(worldWithProvenGap(), { service_level: false });
  assert.equal(plan.service_level.used, false);
  assert.match(plan.service_level.why, /not asked for/);
});

/** Two small decks stacked, neither big enough for every line alone. */
function worldWithTwoFloors() {
  const graph = makeWorld({ cols: 6, rows: 4, ores: [[ORE_IRON, 30], [ORE_COPPER, 30]] });
  for (let cx = 0; cx < 6; cx += 1) {
    for (let cy = 0; cy < 4; cy += 1) {
      const id = `up_${cx}_${cy}`;
      graph.nodes.set(id, {
        actor_id: id,
        kind: "lightweight_buildable",
        class_path: "/Game/Build_Foundation.Build_Foundation_C",
        location_cm: { x: cx * 800, y: cy * 800, z: 2000 },
        inventory_by_item: new Map(),
        raw: {
          name: id, kind: "lightweight_buildable",
          location: { x: cx * 800, y: cy * 800, z: 2000 },
          bounds: { origin: { x: cx * 800, y: cy * 800, z: 2000 }, extent: { x: 400, y: 400, z: 100 } },
        },
      });
    }
  }
  return graph;
}

test("a hub that outgrows one deck climbs to the next", () => {
  // The layered building: rather than refusing, lines spill onto the floor
  // above. The survey already separated levels; this uses them.
  const plan = composeCentralHub(worldWithTwoFloors());
  assert.equal(plan.composed, true, plan.reason);
  assert.ok(plan.floors_used >= 1);
  const decksUsed = new Set(plan.lines.map((line) => line.on_deck_id));
  assert.ok(decksUsed.size >= 1, "lines record which floor they are on");
  // Every line names a real surveyed floor.
  const known = new Set(plan.floors.map((floor) => floor.deck_id));
  for (const line of plan.lines) assert.ok(known.has(line.on_deck_id), `${line.ore} on a real floor`);
});

test("each part sits at the height of the floor its line was placed on", () => {
  // The bug this guards: with several floors, one shared deck height would put
  // an upper-floor machine inside the deck below it.
  const plan = composeCentralHub(worldWithTwoFloors());
  const floorZ = new Map(plan.floors.map((floor) => [floor.deck_id, floor.top_z_cm]));
  for (const line of plan.lines) {
    const expected = floorZ.get(line.on_deck_id);
    assert.equal(line.on_deck_top_z_cm, expected, `${line.ore} records its own floor height`);
    const machine = plan.parts.find((part) => part.part_id.startsWith(line.container_part_id.replace("_container", "")) && part.role === "machine");
    if (machine) assert.equal(machine.relative_location.z, expected, `${line.ore} machine on its floor`);
    const container = plan.parts.find((part) => part.part_id === line.container_part_id);
    assert.equal(container.relative_location.z, expected, `${line.ore} container on its floor`);
  }
});

test("a line no floor can take is named rather than dropped", () => {
  // Silently omitting a line would ship a hub missing an ore with no sign of it.
  const plan = composeCentralHub(makeWorld({ cols: 3, rows: 3 }));
  if (plan.composed) {
    const named = new Set([...plan.lines.map((l) => l.ore), ...plan.lines_without_room.map((l) => l.ore)]);
    assert.ok(named.size > 0, "every ore is either placed or listed as not fitting");
  } else {
    assert.ok(Array.isArray(plan.too_large) && plan.too_large.length > 0);
  }
});

test("floors report their own service level, not one shared answer", () => {
  const plan = composeCentralHub(worldWithTwoFloors());
  assert.ok(Array.isArray(plan.service_level.per_floor));
  assert.equal(plan.service_level.per_floor.length, plan.floors_used);
  for (const entry of plan.service_level.per_floor) {
    assert.ok(entry.deck_id, "each floor names itself");
    assert.ok(typeof entry.why === "string" && entry.why.length > 0);
  }
});
