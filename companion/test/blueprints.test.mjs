import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Parser, SaveComponent, SaveEntity } from "@etothepii/satisfactory-file-parser";
import { buildGraph } from "../lib/graph.mjs";
import {
  costAgainstInventory,
  decodeBlueprintConnectionTopology,
  inspectBlueprintStructure,
  parseBlueprintConfig,
  parseBlueprintHeader,
  readBlueprint,
} from "../lib/blueprints.mjs";
import { solveBlueprintLayout, solveBlueprintLibrary } from "../lib/solvers.mjs";
import { makeBlueprintReader } from "../server.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const IRON_PLATE = "/Game/FactoryGame/Resource/Parts/IronPlate/Desc_IronPlate.Desc_IronPlate_C";
const CABLE = "/Game/FactoryGame/Resource/Parts/Cable/Desc_Cable.Desc_Cable_C";
const SMELTER_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_SmelterMk1.Recipe_SmelterMk1_C";

function int32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value, 0);
  return bytes;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}

function fString(value, { utf16 = false } = {}) {
  if (!value) return int32(0);
  if (!utf16) {
    const bytes = Buffer.from(`${value}\0`, "utf8");
    return Buffer.concat([int32(bytes.length), bytes]);
  }
  const bytes = Buffer.from(`${value}\0`, "utf16le");
  return Buffer.concat([int32(-(bytes.length / 2)), bytes]);
}

function objectReference(pathName, levelName = "") {
  return Buffer.concat([fString(levelName), fString(pathName)]);
}

function objectVersionData() {
  return Buffer.concat([
    uint32(1), int32(522), int32(1000), int32(0),
    uint16(5), uint16(6), uint16(1), uint32(502094),
    fString("++FactoryGame+rel-1.2"), int32(1),
    uint32(0x01234567), uint32(0x89abcdef), uint32(0x11111111), uint32(0x22222222), int32(7),
  ]);
}

/** Builds just enough exact FBlueprintHeader data for unit tests. */
function makeSbp({
  headerVersion = 2,
  factorySaveVersion = 52,
  changelist = 495413,
  dimensions = [4, 4, 4],
  cost = [],
  recipes = [],
  tail = 0,
} = {}) {
  const parts = [
    int32(headerVersion), int32(factorySaveVersion), int32(changelist),
    int32(dimensions[0]), int32(dimensions[1]), int32(dimensions[2]), int32(cost.length),
  ];
  for (const [itemClass, amount, levelName = ""] of cost) {
    parts.push(objectReference(itemClass, levelName), int32(amount));
  }
  parts.push(int32(recipes.length));
  for (const [recipeClass, levelName = ""] of recipes) {
    parts.push(objectReference(recipeClass, levelName));
  }
  if (factorySaveVersion >= 53) parts.push(objectVersionData());
  if (tail > 0) parts.push(Buffer.alloc(tail, 7));
  return Buffer.concat(parts);
}

function makeSbpcfg(description, { utf16 = false } = {}) {
  return Buffer.concat([int32(0), fString(description, { utf16 })]);
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function nativeEntity(typePath, instanceName, translation, recipe) {
  const entity = new SaveEntity(typePath, "Persistent_Level", instanceName, "", true);
  entity.flags = 8;
  entity.transform.translation = translation;
  entity.properties.mBuiltWithRecipe = {
    type: "ObjectProperty",
    name: "mBuiltWithRecipe",
    propertyTagType: { name: "ObjectProperty", children: [] },
    value: { levelName: "", pathName: recipe },
  };
  return entity;
}

function nativeConnectionComponent(typePath, instanceName, parentEntityName, connectedComponentName) {
  const component = new SaveComponent(typePath, "Persistent_Level", instanceName, parentEntityName);
  component.properties.mConnectedComponent = {
    type: "ObjectProperty",
    name: "mConnectedComponent",
    propertyTagType: { name: "ObjectProperty", children: [] },
    value: { levelName: "Persistent_Level", pathName: connectedComponentName },
  };
  return component;
}

/** Creates a real compressed .sbp through the same pinned parser we read with. */
function makeNativeBlueprint({ connected = false } = {}) {
  const constructor = nativeEntity(
    "/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C",
    "Persistent_Level:PersistentLevel.Build_ConstructorMk1_C_1",
    { x: 100, y: -200, z: 300 },
    "/Game/FactoryGame/Recipes/Buildings/Recipe_ConstructorMk1.Recipe_ConstructorMk1_C",
  );
  const smelter = nativeEntity(
    "/Game/FactoryGame/Buildable/Factory/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C",
    "Persistent_Level:PersistentLevel.Build_SmelterMk1_C_2",
    { x: 900, y: 600, z: 300 },
    SMELTER_RECIPE,
  );
  const blueprint = {
    name: "Native test",
    compressionInfo: {
      packageFileTag: 2653586369,
      chunkHeaderVersion: 0x22222222,
      maxUncompressedChunkContentSize: 131072,
      compressionAlgorithm: 3,
    },
    header: {
      headerVersion: 2,
      saveVersion: 52,
      buildVersion: 502094,
      designerDimension: { x: 4, y: 4, z: 4 },
      itemCosts: [[{ levelName: "", pathName: IRON_PLATE }, 12]],
      recipeReferences: [{ levelName: "", pathName: SMELTER_RECIPE }],
    },
    config: {
      configVersion: 0,
      description: "Two-machine native fixture",
      iconID: 0,
      color: { r: 0, g: 0, b: 0, a: 1 },
    },
    objects: connected
      ? [
        constructor,
        smelter,
        nativeConnectionComponent(
          "/Script/FactoryGame.FGFactoryConnectionComponent",
          `${constructor.instanceName}.Conveyor0`,
          constructor.instanceName,
          `${smelter.instanceName}.Conveyor0`,
        ),
        nativeConnectionComponent(
          "/Script/FactoryGame.FGFactoryConnectionComponent",
          `${smelter.instanceName}.Conveyor0`,
          smelter.instanceName,
          `${constructor.instanceName}.Conveyor0`,
        ),
      ]
      : [constructor, smelter],
  };
  let header = null;
  const chunks = [];
  const output = Parser.WriteBlueprintFiles(
    blueprint,
    (value) => { header = value; },
    (value) => chunks.push(value),
  );
  return {
    sbp: Buffer.concat([Buffer.from(header), ...chunks.map((chunk) => Buffer.from(chunk))]),
    sbpcfg: Buffer.from(output.configFileBinary),
  };
}

/* ---------------- exact header ---------------- */

test("decodes the exact FBlueprintHeader field meanings", () => {
  const header = parseBlueprintHeader(makeSbp({
    factorySaveVersion: 60,
    changelist: 502094,
    dimensions: [6, 6, 8],
    cost: [[IRON_PLATE, 36]],
    recipes: [[SMELTER_RECIPE]],
    tail: 64,
  }));
  assert.equal(header.blueprint_header_version, 2);
  assert.equal(header.factory_save_custom_version, 60);
  assert.equal(header.game_changelist, 502094);
  assert.deepEqual(header.designer_dimensions, { x: 6, y: 6, z: 8 });
  assert.equal(header.recipe_reference_count_declared, 1);
  assert.equal(header.recipe_references[0].recipe_class, SMELTER_RECIPE);
  assert.equal(header.object_version_data.engine_version.changelist, 502094);
  assert.equal(header.compressed_body.bytes, 64);
  assert.equal(header.object_graph_decoded, false);
});

test("preserves FObjectReference level names and signed FString encodings", () => {
  const header = parseBlueprintHeader(makeSbp({
    cost: [[IRON_PLATE, 36, "Persistent_Level"]],
    recipes: [[SMELTER_RECIPE, "Persistent_Level"]],
  }));
  assert.deepEqual(header.build_cost[0], {
    item_class: IRON_PLATE,
    item_level_name: "Persistent_Level",
    item_name: "IronPlate",
    amount: 36,
  });
  assert.equal(header.recipe_references[0].recipe_level_name, "Persistent_Level");
  assert.equal(parseBlueprintConfig(makeSbpcfg("Café", { utf16: true })).description, "Café");
});

test("reports a compressed body as opaque rather than scanning it as object data", () => {
  const sbp = makeSbp({ cost: [[IRON_PLATE, 1]], recipes: [[SMELTER_RECIPE]], tail: 8216 });
  const header = parseBlueprintHeader(sbp);
  assert.equal(header.compressed_body.bytes, 8216);
  assert.equal(header.object_graph_decoded, false);
  assert.match(header.object_graph_note, /compressed/i);
  assert.equal(header.header_bytes + header.compressed_body.bytes, sbp.length);
});

test("fails closed for an unsupported or truncated header", () => {
  assert.throws(() => parseBlueprintHeader(makeSbp({ headerVersion: 99 })), /Unsupported blueprint header version/);
  const complete = makeSbp({ cost: [[IRON_PLATE, 36], [CABLE, 16]] });
  assert.throws(() => parseBlueprintHeader(complete.subarray(0, complete.length - 6)), /truncated/i);
});

test("pairs an exact header with its menu description", () => {
  const blueprint = readBlueprint(
    "Clean 4 to 4 Belt Balancer",
    makeSbp({ dimensions: [6, 6, 6], cost: [[IRON_PLATE, 36]], recipes: [[SMELTER_RECIPE]] }),
    makeSbpcfg("4 in, 4 out"),
  );
  assert.equal(blueprint.description, "4 in, 4 out");
  assert.equal(blueprint.has_config, true);
  assert.deepEqual(blueprint.designer_dimensions, { x: 6, y: 6, z: 6 });
  assert.equal(blueprint.contents.recipes[0].class_path, SMELTER_RECIPE);
  assert.equal(blueprint.contents.recipes[0].occurrences, null);
  assert.match(blueprint.contents.counts_caveat, /do not encode how many/i);
});

/* ---------------- structural parser ---------------- */

test("reads exact native buildable transforms through the pinned read-only parser", () => {
  const { sbp, sbpcfg } = makeNativeBlueprint();
  const result = inspectBlueprintStructure("Native test", sbp, sbpcfg, { maximumBuildables: 1 });
  assert.equal(result.available, true);
  assert.equal(result.parser.package, "@etothepii/satisfactory-file-parser");
  assert.equal(result.parser.mode, "read_only");
  assert.equal(result.decoded.object_count, 2);
  assert.equal(result.decoded.buildable_count, 2);
  assert.match(result.decoded.buildable_identification_caveat, /modded/i);
  assert.equal(result.decoded.buildables_with_finite_transform, 2);
  assert.equal(result.buildables_returned, 1);
  assert.equal(result.buildables_truncated, 1);
  assert.deepEqual(result.pivot_bounds_cm.minimum_cm, { x: 100, y: -200, z: 300 });
  assert.deepEqual(result.pivot_bounds_cm.maximum_cm, { x: 900, y: 600, z: 300 });
  assert.equal(result.buildables[0].transform.translation_cm.x, 100);
  assert.match(result.buildables[0].built_with_recipe.recipe_class, /Recipe_ConstructorMk1/);
  assert.equal(result.connection_topology.status, "decoded");
  assert.equal(result.connection_topology.reciprocal_connection_pair_count, 0);
  assert.match(result.transform_coverage_caveat, /hologram validity/i);
});

test("decodes reciprocal native conveyor component links through the structural parser", () => {
  const { sbp, sbpcfg } = makeNativeBlueprint({ connected: true });
  const result = inspectBlueprintStructure("Native connected test", sbp, sbpcfg, {
    maximumConnections: 1,
  });
  assert.equal(result.available, true);
  assert.equal(result.decoded.component_count, 2);
  assert.equal(result.connection_topology.status, "decoded");
  assert.equal(result.connection_topology.supported_connection_reference_record_count, 2);
  assert.equal(result.connection_topology.reciprocal_connection_reference_count, 2);
  assert.equal(result.connection_topology.reciprocal_connection_pair_count, 1);
  assert.deepEqual(result.connection_topology.reciprocal_connection_pairs_by_kind, {
    conveyor: 1,
    pipe: 0,
    mixed: 0,
  });
  assert.equal(result.connection_topology.connections_returned, 1);
  assert.equal(result.connection_topology.connections_truncated, 0);
  assert.equal(result.connection_topology.connections[0].endpoint_a.owner_entity_resolved, true);
  assert.equal(result.connection_topology.connections[0].endpoint_b.owner_entity_resolved, true);
  assert.match(result.connection_topology.caveat, /flow direction/i);
});

test("connection topology fails closed for one-way, unresolved, and ambiguous component references", () => {
  const component = (instanceName, target) => ({
    type: "SaveComponent",
    typePath: "/Script/FactoryGame.FGFactoryConnectionComponent",
    instanceName,
    parentEntityName: `Persistent_Level:${instanceName.split(".")[0]}`,
    properties: target === null ? {} : {
      mConnectedComponent: {
        value: { pathName: target },
      },
    },
  });
  const topology = decodeBlueprintConnectionTopology([
    {
      type: "SaveEntity",
      typePath: "/Game/Test/Build_A.Build_A_C",
      instanceName: "A",
    },
    component("A.Port", "B.Port"),
    component("B.Port", "Missing.Port"),
    component("Caller.Port", "Duplicate.Port"),
    component("Duplicate.Port", null),
    component("Duplicate.Port", null),
  ]);
  assert.equal(topology.reciprocal_connection_pair_count, 0);
  assert.equal(topology.nonreciprocal_component_reference_count, 1);
  assert.equal(topology.unresolved_component_reference_count, 1);
  assert.equal(topology.ambiguous_component_reference_count, 1);
  assert.equal(topology.certainty, "authoritative_observation_with_inconclusive_component_references");
});

test("connection topology caps returned pairs while preserving every aggregate count", () => {
  const objects = [];
  for (let index = 0; index < 3; index += 1) {
    const left = `A${index}.Port`;
    const right = `B${index}.Port`;
    objects.push(
      { type: "SaveEntity", typePath: "/Game/Test/Build_A.Build_A_C", instanceName: `A${index}` },
      { type: "SaveEntity", typePath: "/Game/Test/Build_B.Build_B_C", instanceName: `B${index}` },
      {
        type: "SaveComponent",
        typePath: "/Script/FactoryGame.FGPipeConnectionFactory",
        instanceName: left,
        parentEntityName: `A${index}`,
        properties: { mConnectedComponent: { value: { pathName: right } } },
      },
      {
        type: "SaveComponent",
        typePath: "/Script/FactoryGame.FGPipeConnectionComponent",
        instanceName: right,
        parentEntityName: `B${index}`,
        properties: { mConnectedComponent: { value: { pathName: left } } },
      },
    );
  }
  const topology = decodeBlueprintConnectionTopology(objects, { maximumConnections: 1 });
  assert.equal(topology.reciprocal_connection_pair_count, 3);
  assert.equal(topology.reciprocal_connection_pairs_by_kind.pipe, 3);
  assert.equal(topology.connections_returned, 1);
  assert.equal(topology.connections_truncated, 2);
});

test("structural inspection preserves an unreadable file as unknown", () => {
  const result = inspectBlueprintStructure("Broken", Buffer.alloc(8), Buffer.alloc(8));
  assert.equal(result.available, false);
  assert.equal(result.reason, "blueprint_header_unreadable");
  assert.equal(result.certainty, "unknown");
});

test("structural inspection requires the matching config file", () => {
  const { sbp } = makeNativeBlueprint();
  const result = inspectBlueprintStructure("No config", sbp);
  assert.equal(result.available, false);
  assert.equal(result.reason, "blueprint_config_missing");
});

test("the structural solver prices a bounded native layout against the live inventory", () => {
  const { sbp, sbpcfg } = makeNativeBlueprint();
  const graph = buildGraph(buildFactorySnapshot());
  const result = solveBlueprintLayout(
    graph,
    { blueprint_name: "Native test", maximum_buildables: 1 },
    {
      inspectBlueprint: (name, options) => inspectBlueprintStructure(name, sbp, sbpcfg, options),
    },
  );
  assert.equal(result.solver, "blueprint_layout");
  assert.equal(result.available, true);
  assert.equal(result.buildables_returned, 1);
  assert.equal(result.ingredients[0].item_name, "IronPlate");
  assert.equal(result.ingredients[0].shortfall, 0);
});

test("the configured reader stays inside its library and resolves one exact native blueprint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-blueprints-"));
  try {
    const nested = path.join(root, "Style");
    const duplicate = path.join(root, "Other");
    fs.mkdirSync(nested);
    fs.mkdirSync(duplicate);
    const { sbp, sbpcfg } = makeNativeBlueprint();
    fs.writeFileSync(path.join(nested, "Native test.sbp"), sbp);
    fs.writeFileSync(path.join(nested, "Native test.sbpcfg"), sbpcfg);
    fs.writeFileSync(path.join(duplicate, "Native test.sbp"), sbp);
    fs.writeFileSync(path.join(duplicate, "Native test.sbpcfg"), sbpcfg);

    const reader = makeBlueprintReader({ AIFACTORY_BLUEPRINT_DIR: root });
    assert.equal(typeof reader, "function");
    assert.deepEqual(reader().map(({ name, relative_path }) => ({ name, relative_path })), [
      { name: "Native test", relative_path: "Other/Native test.sbp" },
      { name: "Native test", relative_path: "Style/Native test.sbp" },
    ]);
    const ambiguous = reader.inspect("native TEST");
    assert.equal(ambiguous.available, false);
    assert.equal(ambiguous.reason, "blueprint_name_ambiguous");
    const inspected = reader.inspect("Style/Native test.sbp", { maximumBuildables: 1 });
    assert.equal(inspected.available, true);
    assert.equal(inspected.relative_path, "Style/Native test.sbp");
    assert.equal(inspected.blueprint_reference, "Style/Native test.sbp");
    assert.equal(inspected.buildables_returned, 1);

    // The model has no path parameter. Even a direct adapter call cannot turn
    // a relative traversal string into a file read.
    const refused = reader.inspect("../Native test");
    assert.equal(refused.available, false);
    assert.equal(refused.reason, "blueprint_not_found");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- pricing and library ---------------- */

test("prices a blueprint against what the player is carrying", () => {
  const blueprint = parseBlueprintHeader(makeSbp({ cost: [[IRON_PLATE, 36], [CABLE, 16]] }));
  const held = new Map([["Desc_IronPlate_C", 50]]);
  const priced = costAgainstInventory(blueprint, held);
  assert.equal(priced.ingredients[0].held_in_player_inventories, 50);
  assert.equal(priced.ingredients[0].shortfall, 0);
  assert.equal(priced.ingredients[1].shortfall, 16);
  assert.equal(priced.affordable_from_captured_player_inventories, false);
});

test("reports the library as unavailable rather than empty when unconfigured", () => {
  const result = solveBlueprintLibrary(buildGraph(buildFactorySnapshot()), {});
  assert.equal(result.available, false);
  assert.equal(result.reason, "blueprint_directory_not_configured");
  assert.match(result.note, /AIFACTORY_BLUEPRINT_DIR/);
  assert.deepEqual(result.blueprints, []);
});

test("lists blueprints, prices them, and keeps recipe presence distinct from counts", () => {
  const listBlueprints = () => [
    {
      ...readBlueprint("Rod Bank", makeSbp({ cost: [["Desc_IronRod_C", 4]] }), makeSbpcfg("rods")),
      relative_path: "Style/Rod Bank.sbp",
      blueprint_reference: "Style/Rod Bank.sbp",
    },
    readBlueprint("Plate Bank", makeSbp({ cost: [["Desc_IronPlate_C", 999]] }), null),
  ];
  const result = solveBlueprintLibrary(buildGraph(buildFactorySnapshot()), {}, { listBlueprints });
  assert.equal(result.available, true);
  assert.equal(result.blueprint_count, 2);
  assert.equal(result.blueprints[0].affordable_from_captured_player_inventories, true);
  assert.equal(result.blueprints[1].affordable_from_captured_player_inventories, false);
  assert.equal(result.blueprints[1].ingredients[0].shortfall, 979);
  assert.equal(result.blueprints[0].blueprint_reference, "Style/Rod Bank.sbp");
  assert.match(result.what_is_not_known, /inspect_blueprint_layout/i);
});

test("flags a blueprint authored on a different game build", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.world.game_changelist = 495413;
  const listBlueprints = () => [
    readBlueprint("Old", makeSbp({ changelist: 463028 }), null),
    readBlueprint("Current", makeSbp({ changelist: 495413 }), null),
  ];
  const result = solveBlueprintLibrary(buildGraph(snapshot), {}, { listBlueprints });
  assert.equal(result.blueprints[0].authored_on_a_different_build, true);
  assert.equal(result.blueprints[1].authored_on_a_different_build, false);
});

test("filters by name and surfaces unreadable files separately", () => {
  const listBlueprints = () => [
    readBlueprint("Belt Balancer", makeSbp(), null),
    readBlueprint("Smelter Bank", makeSbp(), null),
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

test("resolves exact header recipe references through the captured catalog", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.content.recipes.push({
    class_path: SMELTER_RECIPE,
    name: "Smelter",
    duration_seconds: 1,
    ingredients: [],
    products: [{ item_class: "Desc_SmelterMk1", item_name: "Smelter", amount: 1 }],
    produced_in: ["BP_BuildGun_C"],
  });
  const listBlueprints = () => [
    readBlueprint("Smelter Bank", makeSbp({ recipes: [[SMELTER_RECIPE]] }), null),
  ];
  const entry = solveBlueprintLibrary(buildGraph(snapshot), {}, { listBlueprints }).blueprints[0];
  assert.equal(entry.contains[0].building, "Smelter");
  assert.equal(entry.contains[0].resolved_from_catalog, true);
  assert.equal(entry.contains[0].occurrences, null);
  assert.equal(entry.transforms, "not_decoded");
});

test("the generated test blueprint is valid input to the upstream parser", () => {
  const { sbp, sbpcfg } = makeNativeBlueprint();
  const parsed = Parser.ParseBlueprintFiles("Native test", exactArrayBuffer(sbp), exactArrayBuffer(sbpcfg), {
    throwErrors: true,
  });
  assert.equal(parsed.objects.length, 2);
});
