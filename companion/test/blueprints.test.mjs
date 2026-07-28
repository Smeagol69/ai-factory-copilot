import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  costAgainstInventory,
  scanBlueprintReferences,
  parseBlueprintConfig,
  parseBlueprintHeader,
  readBlueprint,
} from "../lib/blueprints.mjs";
import { solveBlueprintLibrary } from "../lib/solvers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

/**
 * Builds a .sbp in the real on-disk layout, verified against two blueprints
 * authored on different game builds.
 */
function makeSbp({ version = 2, changelist = 495413, dimensions = [4, 4, 4], cost = [], tail = 0 }) {
  const head = Buffer.alloc(32);
  head.writeUInt32LE(version, 0);
  head.writeUInt32LE(60, 4);
  head.writeUInt32LE(changelist, 8);
  head.writeUInt32LE(dimensions[0], 12);
  head.writeUInt32LE(dimensions[1], 16);
  head.writeUInt32LE(dimensions[2], 20);
  head.writeUInt32LE(cost.length, 24);
  head.writeUInt32LE(0, 28);

  const parts = [head];
  for (const [itemClass, amount] of cost) {
    const text = Buffer.from(`${itemClass}\0`, "utf8");
    const lengthField = Buffer.alloc(4);
    lengthField.writeUInt32LE(text.length, 0);
    const amountField = Buffer.alloc(8);
    amountField.writeUInt32LE(amount, 0);
    parts.push(lengthField, text, amountField);
  }
  if (tail > 0) parts.push(Buffer.alloc(tail, 7));
  return Buffer.concat(parts);
}

function makeSbpcfg(description) {
  const text = Buffer.from(`${description}\0`, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0, 0);
  head.writeUInt32LE(text.length, 4);
  return Buffer.concat([head, text]);
}

const IRON_PLATE = "/Game/FactoryGame/Resource/Parts/IronPlate/Desc_IronPlate.Desc_IronPlate_C";
const CABLE = "/Game/FactoryGame/Resource/Parts/Cable/Desc_Cable.Desc_Cable_C";

/* ---------------- header ---------------- */

test("decodes version, changelist, and designer dimensions", () => {
  const header = parseBlueprintHeader(
    makeSbp({ changelist: 491125, dimensions: [6, 6, 6], cost: [[IRON_PLATE, 36]] }),
  );
  assert.equal(header.save_version, 2);
  assert.equal(header.game_changelist, 491125);
  assert.deepEqual(header.designer_dimensions, { x: 6, y: 6, z: 6 });
  assert.equal(header.supported, true);
});

test("reads the full build cost with readable item names", () => {
  const header = parseBlueprintHeader(
    makeSbp({ cost: [[IRON_PLATE, 36], [CABLE, 16]] }),
  );
  assert.equal(header.cost_entries_read, 2);
  assert.equal(header.cost_list_truncated, false);
  assert.deepEqual(header.build_cost[0], {
    item_class: IRON_PLATE,
    item_name: "IronPlate",
    amount: 36,
  });
  assert.equal(header.build_cost[1].item_name, "Cable");
});

test("reports the undecoded object graph rather than implying it read one", () => {
  const header = parseBlueprintHeader(makeSbp({ cost: [[IRON_PLATE, 1]], tail: 8216 }));
  assert.equal(header.object_graph_bytes, 8216);
  assert.equal(header.object_graph_decoded, false);
  assert.match(header.object_graph_note, /satisfactory-file-parser/);
});

test("a blueprint with no cost entries is still readable", () => {
  const header = parseBlueprintHeader(makeSbp({ cost: [] }));
  assert.deepEqual(header.build_cost, []);
  assert.equal(header.cost_list_truncated, false);
});

test("a truncated cost list is flagged instead of silently short", () => {
  const full = makeSbp({ cost: [[IRON_PLATE, 36], [CABLE, 16]] });
  const header = parseBlueprintHeader(full.subarray(0, full.length - 40));
  assert.equal(header.cost_entry_count_declared, 2);
  assert.ok(header.cost_entries_read < 2);
  assert.equal(header.cost_list_truncated, true);
  assert.equal(header.certainty, "partial");
});

test("an unknown save version is reported, not assumed compatible", () => {
  assert.equal(parseBlueprintHeader(makeSbp({ version: 99 })).supported, false);
});

test("rejects a file too short to be a blueprint", () => {
  assert.throws(() => parseBlueprintHeader(Buffer.alloc(8)), /too short/);
});

test("rejects an implausible cost entry count instead of allocating on it", () => {
  const bogus = makeSbp({ cost: [] });
  bogus.writeUInt32LE(9_999_999, 24);
  assert.throws(() => parseBlueprintHeader(bogus), /not plausible/);
});

/* ---------------- config ---------------- */

test("decodes the description from the config file", () => {
  const config = parseBlueprintConfig(makeSbpcfg("Belt Balancer with 4 inputs"));
  assert.equal(config.description, "Belt Balancer with 4 inputs");
  assert.equal(config.certainty, "authoritative");
});

test("a missing or unreadable config yields no description, not a crash", () => {
  assert.equal(parseBlueprintConfig(Buffer.alloc(0)).description, null);
  assert.equal(parseBlueprintConfig(Buffer.alloc(4)).description, null);
});

test("pairs the sbp and sbpcfg into one blueprint", () => {
  const blueprint = readBlueprint(
    "Clean 4 to 4 Belt Balancer",
    makeSbp({ dimensions: [6, 6, 6], cost: [[IRON_PLATE, 36]] }),
    makeSbpcfg("4 in, 4 out"),
  );
  assert.equal(blueprint.name, "Clean 4 to 4 Belt Balancer");
  assert.equal(blueprint.description, "4 in, 4 out");
  assert.equal(blueprint.has_config, true);
  assert.deepEqual(blueprint.designer_dimensions, { x: 6, y: 6, z: 6 });
});

/* ---------------- pricing ---------------- */

test("prices a blueprint against what the player is carrying", () => {
  const blueprint = parseBlueprintHeader(makeSbp({ cost: [[IRON_PLATE, 36], [CABLE, 16]] }));
  const held = new Map([["Desc_IronPlate_C", 50]]);
  const priced = costAgainstInventory(blueprint, held);

  assert.equal(priced.ingredients[0].held_in_player_inventories, 50);
  assert.equal(priced.ingredients[0].shortfall, 0);
  assert.equal(priced.ingredients[1].shortfall, 16);
  assert.equal(priced.affordable_from_captured_player_inventories, false);
});

/* ---------------- solver ---------------- */

test("reports the library as unavailable rather than empty when unconfigured", () => {
  const result = solveBlueprintLibrary(buildGraph(buildFactorySnapshot()), {});
  assert.equal(result.available, false);
  assert.equal(result.reason, "blueprint_directory_not_configured");
  assert.match(result.note, /AIFACTORY_BLUEPRINT_DIR/);
  assert.deepEqual(result.blueprints, []);
});

test("lists blueprints and prices them from captured inventories", () => {
  const listBlueprints = () => [
    readBlueprint("Rod Bank", makeSbp({ cost: [["Desc_IronRod_C", 4]] }), makeSbpcfg("rods")),
    readBlueprint("Plate Bank", makeSbp({ cost: [["Desc_IronPlate_C", 999]] }), null),
  ];
  const result = solveBlueprintLibrary(
    buildGraph(buildFactorySnapshot()),
    {},
    { listBlueprints },
  );

  assert.equal(result.available, true);
  assert.equal(result.blueprint_count, 2);
  // The fixture player carries 5 Iron Rod and 20 Iron Plate.
  assert.equal(result.blueprints[0].affordable_from_captured_player_inventories, true);
  assert.equal(result.blueprints[1].affordable_from_captured_player_inventories, false);
  assert.equal(result.blueprints[1].ingredients[0].shortfall, 979);
});

test("flags a blueprint authored on a different game build", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.world.game_changelist = 495413;
  const listBlueprints = () => [
    readBlueprint("Old", makeSbp({ changelist: 463028, cost: [] }), null),
    readBlueprint("Current", makeSbp({ changelist: 495413, cost: [] }), null),
  ];
  const result = solveBlueprintLibrary(buildGraph(snapshot), {}, { listBlueprints });

  assert.equal(result.blueprints[0].authored_on_a_different_build, true);
  assert.equal(result.blueprints[1].authored_on_a_different_build, false);
});

test("filters by name and surfaces unreadable files separately", () => {
  const listBlueprints = () => [
    readBlueprint("Belt Balancer", makeSbp({ cost: [] }), null),
    readBlueprint("Smelter Bank", makeSbp({ cost: [] }), null),
    { name: "Corrupt", error: "Blueprint file is too short to contain a header." },
  ];
  const result = solveBlueprintLibrary(
    buildGraph(buildFactorySnapshot()),
    { name_contains: "balancer" },
    { listBlueprints },
  );

  assert.equal(result.blueprint_count, 1);
  assert.equal(result.blueprints[0].name, "Belt Balancer");
  assert.equal(result.unreadable_files.length, 1);
  assert.equal(result.unreadable_files[0].name, "Corrupt");
});

test("states that per-building layout is not known", () => {
  const listBlueprints = () => [readBlueprint("X", makeSbp({ cost: [] }), null)];
  const result = solveBlueprintLibrary(buildGraph(buildFactorySnapshot()), {}, { listBlueprints });
  assert.match(result.what_is_not_known, /Positions, rotations, and wiring/i);
  assert.match(result.what_is_known, /build cost/i);
});

/* ---------------- object graph reference scan ---------------- */

/** Appends a length-prefixed, null-terminated UE string. */
function uePath(text) {
  const body = Buffer.from(`${text}\0`, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length, 0);
  return Buffer.concat([length, body]);
}

const SPLITTER = "/Game/FactoryGame/Recipes/Buildings/Recipe_ConveyorAttachmentSplitter.Recipe_ConveyorAttachmentSplitter_C";
const BELT_MK4 = "/Game/FactoryGame/Recipes/Buildings/Recipe_ConveyorBeltMk4.Recipe_ConveyorBeltMk4_C";

test("recovers referenced class paths from the object graph", () => {
  const graph = Buffer.concat([
    Buffer.alloc(16),
    uePath(SPLITTER),
    uePath(BELT_MK4),
    uePath(BELT_MK4),
    Buffer.alloc(24, 3),
  ]);
  const found = scanBlueprintReferences(graph, 0);

  assert.equal(found.distinct_recipes, 2);
  assert.equal(found.recipes[0].class_path, BELT_MK4);
  assert.equal(found.recipes[0].occurrences, 2);
  assert.equal(found.recipes[0].name, "ConveyorBeltMk4");
});

test("ignores bytes that only look like a length prefix", () => {
  const noise = Buffer.alloc(400, 0xab);
  const found = scanBlueprintReferences(noise, 0);
  assert.deepEqual(found.recipes, []);
  assert.deepEqual(found.buildings, []);
});

test("is explicit that counts are indicative and transforms are not decoded", () => {
  const found = scanBlueprintReferences(Buffer.concat([uePath(SPLITTER)]), 0);
  assert.equal(found.transforms, "not_decoded");
  assert.match(found.counts_caveat, /not necessarily the number/);
  assert.match(found.transforms_note, /satisfactory-file-parser/);
});

test("resolves referenced build recipes to the buildings they place", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.content.recipes.push({
    class_path: "Recipe_SmelterMk1",
    name: "Smelter",
    duration_seconds: 1,
    ingredients: [],
    products: [{ item_class: "Desc_SmelterMk1", item_name: "Smelter", amount: 1 }],
    produced_in: ["BP_BuildGun_C"],
  });

  const listBlueprints = () => [
    {
      ...parseBlueprintHeader(makeSbp({ cost: [] })),
      name: "Smelter Bank",
      description: null,
      contents: {
        recipes: [{ class_path: "Recipe_SmelterMk1", name: "SmelterMk1", occurrences: 4 }],
        counts_caveat: "indicative",
        transforms: "not_decoded",
      },
    },
  ];

  const result = solveBlueprintLibrary(buildGraph(snapshot), {}, { listBlueprints });
  const entry = result.blueprints[0];
  assert.equal(entry.contains[0].building, "Smelter");
  assert.equal(entry.contains[0].resolved_from_catalog, true);
  assert.equal(entry.contains[0].occurrences, 4);
  assert.equal(entry.contains_resolved_from_catalog, 1);
  assert.equal(entry.transforms, "not_decoded");
});

test("an unresolvable reference keeps its raw name rather than vanishing", () => {
  const listBlueprints = () => [
    {
      ...parseBlueprintHeader(makeSbp({ cost: [] })),
      name: "Modded",
      description: null,
      contents: {
        recipes: [{ class_path: "/Game/Mod/Recipe_Mystery.Recipe_Mystery_C", name: "Mystery", occurrences: 1 }],
      },
    },
  ];
  const entry = solveBlueprintLibrary(buildGraph(buildFactorySnapshot()), {}, { listBlueprints })
    .blueprints[0];
  assert.equal(entry.contains[0].building, "Mystery");
  assert.equal(entry.contains[0].resolved_from_catalog, false);
});
