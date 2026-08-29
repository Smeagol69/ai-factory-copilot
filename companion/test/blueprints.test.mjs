import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Parser, SaveComponent, SaveEntity } from "@etothepii/satisfactory-file-parser";
import { buildGraph } from "../lib/graph.mjs";
import {
  costAgainstInventory,
  compareBlueprintStructures,
  decodeBlueprintConnectionTopology,
  decodeBlueprintHypertubeTopology,
  decodeBlueprintPowerWireTopology,
  decodeBlueprintRailTopology,
  inspectBlueprintStructure,
  parseBlueprintConfig,
  parseBlueprintHeader,
  readBlueprint,
} from "../lib/blueprints.mjs";
import { solveBlueprintComparison, solveBlueprintLayout, solveBlueprintLibrary } from "../lib/solvers.mjs";
import { makeBlueprintReader } from "../server.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const IRON_PLATE = "/Game/FactoryGame/Resource/Parts/IronPlate/Desc_IronPlate.Desc_IronPlate_C";
const CABLE = "/Game/FactoryGame/Resource/Parts/Cable/Desc_Cable.Desc_Cable_C";
const SMELTER_RECIPE = "/Game/FactoryGame/Recipes/Buildings/Recipe_SmelterMk1.Recipe_SmelterMk1_C";
const POWER_CONNECTION_COMPONENT = "/Script/FactoryGame.FGPowerConnectionComponent";
const POWER_LINE_CLASS = "/Game/FactoryGame/Buildable/Factory/PowerLine/Build_PowerLine.Build_PowerLine_C";
const HYPERTUBE_CONNECTION_COMPONENT = "/Script/FactoryGame.FGPipeConnectionComponentHyper";
const HYPERTUBE_PIPE_CLASS = "/Game/FactoryGame/Buildable/Factory/PipeHyper/Build_PipeHyper.Build_PipeHyper_C";
const RAIL_TRACK_CLASS = "/Game/FactoryGame/Buildable/Factory/Train/Track/Build_RailroadTrack.Build_RailroadTrack_C";

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

function savedPowerWire(instanceName) {
  return {
    type: "SaveEntity",
    typePath: POWER_LINE_CLASS,
    instanceName,
  };
}

function savedPowerConnection(instanceName, parentEntityName, wireNames, property = null) {
  return {
    type: "SaveComponent",
    typePath: POWER_CONNECTION_COMPONENT,
    instanceName,
    parentEntityName,
    properties: {
      mWires: property ?? {
        type: "ArrayProperty",
        name: "mWires",
        propertyTagType: {
          name: "ArrayProperty",
          children: [{ name: "ObjectProperty", children: [] }],
        },
        values: wireNames.map((pathName) => ({ levelName: "Persistent_Level", pathName })),
      },
    },
  };
}

function savedRailTrack(instanceName, points, graphId = 1, overrides = {}) {
  return {
    type: "SaveEntity",
    typePath: RAIL_TRACK_CLASS,
    instanceName,
    transform: {
      translation: { x: 100, y: 200, z: 300 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale3d: { x: 1, y: 1, z: 1 },
    },
    properties: {
      mTrackGraphID: {
        type: "IntProperty",
        name: "mTrackGraphID",
        propertyTagType: { name: "IntProperty", children: [] },
        value: graphId,
      },
      mSplineData: {
        type: "ArrayProperty",
        name: "mSplineData",
        propertyTagType: {
          name: "ArrayProperty",
          children: [{ name: "StructProperty", children: [{ name: "SplinePointData", children: [] }] }],
        },
        values: points.map(({ x, y, z, tangent = { x: 0, y: 0, z: 0 } }) => ({
          type: "SplinePointData",
          properties: {
            Location: { type: "StructProperty", name: "Location", value: { x, y, z } },
            ArriveTangent: { type: "StructProperty", name: "ArriveTangent", value: tangent },
            LeaveTangent: { type: "StructProperty", name: "LeaveTangent", value: tangent },
          },
        })),
      },
    },
    ...overrides,
  };
}

function savedHypertubePipe(instanceName, points, overrides = {}) {
  return {
    type: "SaveEntity",
    typePath: HYPERTUBE_PIPE_CLASS,
    instanceName,
    transform: {
      translation: { x: 100, y: 200, z: 300 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale3d: { x: 1, y: 1, z: 1 },
    },
    properties: {
      mSplineData: {
        type: "ArrayProperty",
        name: "mSplineData",
        propertyTagType: {
          name: "ArrayProperty",
          children: [{ name: "StructProperty", children: [{ name: "SplinePointData", children: [] }] }],
        },
        values: points.map(({ x, y, z, tangent = { x: 0, y: 0, z: 0 } }) => ({
          type: "SplinePointData",
          properties: {
            Location: { type: "StructProperty", name: "Location", value: { x, y, z } },
            ArriveTangent: { type: "StructProperty", name: "ArriveTangent", value: tangent },
            LeaveTangent: { type: "StructProperty", name: "LeaveTangent", value: tangent },
          },
        })),
      },
      mSnappedPassthroughs: {
        type: "ArrayProperty",
        name: "mSnappedPassthroughs",
        values: [{ levelName: "", pathName: "" }, { levelName: "", pathName: "" }],
      },
    },
    ...overrides,
  };
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
  assert.equal(result.power_wire_topology.status, "decoded");
  assert.equal(result.power_wire_topology.verified_power_wire_count, 0);
  assert.equal(result.rail_topology.status, "decoded");
  assert.equal(result.rail_topology.native_rail_track_entity_count, 0);
  assert.equal(result.hypertube_topology.status, "decoded");
  assert.equal(result.hypertube_topology.native_hypertube_connection_component_count, 0);
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

test("decodes exact native hypertube links and bounded PipeHyper spline records", () => {
  const start = "Persistent_Level:PipeHyperStart";
  const pipe = "Persistent_Level:PipeHyper";
  const passthrough = "Persistent_Level:HypertubePassthrough";
  const startConnection = `${start}.PipeHyperStartConnection`;
  const pipeConnection0 = `${pipe}.PipeHyperConnection0`;
  const pipeConnection1 = `${pipe}.PipeHyperConnection1`;
  const passthroughConnection = `${passthrough}.Connection0`;
  const topology = decodeBlueprintHypertubeTopology([
    { type: "SaveEntity", typePath: "/Game/Test/Build_Start.Build_Start_C", instanceName: start },
    savedHypertubePipe(pipe, [
      { x: 0, y: 0, z: 0, tangent: { x: 100, y: 0, z: 0 } },
      { x: 300, y: 400, z: 0, tangent: { x: 0, y: 100, z: 0 } },
    ]),
    { type: "SaveEntity", typePath: "/Game/Test/Build_Passthrough.Build_Passthrough_C", instanceName: passthrough },
    nativeConnectionComponent(HYPERTUBE_CONNECTION_COMPONENT, startConnection, start, pipeConnection0),
    nativeConnectionComponent(HYPERTUBE_CONNECTION_COMPONENT, pipeConnection0, pipe, startConnection),
    nativeConnectionComponent(HYPERTUBE_CONNECTION_COMPONENT, pipeConnection1, pipe, passthroughConnection),
    nativeConnectionComponent(HYPERTUBE_CONNECTION_COMPONENT, passthroughConnection, passthrough, pipeConnection1),
  ], { maximumConnections: 1, maximumPipes: 1, maximumSplinePoints: 1 });

  assert.equal(topology.status, "decoded");
  assert.equal(topology.native_hypertube_connection_component_count, 4);
  assert.equal(topology.supported_connection_reference_record_count, 4);
  assert.equal(topology.reciprocal_connection_reference_count, 4);
  assert.equal(topology.reciprocal_connection_pair_count, 2);
  assert.deepEqual(topology.endpoint_owner_resolution, { both: 2, one: 0, neither: 0 });
  assert.equal(topology.connections_returned, 1);
  assert.equal(topology.connections_truncated, 1);
  assert.equal(topology.hypertube_pipe_entity_count, 1);
  assert.equal(topology.pipe_records_returned, 1);
  assert.equal(topology.total_spline_point_count, 2);
  assert.equal(topology.pipe_hyper_records[0].spline_points_returned, 1);
  assert.equal(topology.pipe_hyper_records[0].spline_points_truncated, 1);
  assert.deepEqual(topology.pipe_hyper_records[0].blueprint_relative_endpoints_cm, {
    start_cm: { x: 100, y: 200, z: 300 },
    end_cm: { x: 400, y: 600, z: 300 },
  });
  assert.equal(topology.pipe_hyper_records[0].chord_length_cm, 500);
  assert.equal(topology.pipe_hyper_records[0].snapped_passthroughs.blank_reference_count, 2);
  assert.equal(topology.traversal_direction, "not_inferred_from_component_references_or_spline_order");
  assert.equal(topology.cross_blueprint_joins, "not_proven_from_saved_component_references");
  assert.equal(topology.certainty, "authoritative_for_verified_native_hypertube_records");
});

test("hypertube topology keeps malformed and nonreciprocal records explicit", () => {
  const topology = decodeBlueprintHypertubeTopology([
    { type: "SaveEntity", typePath: "/Game/Test/Build_A.Build_A_C", instanceName: "A" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_B.Build_B_C", instanceName: "B" },
    {
      type: "SaveComponent",
      typePath: HYPERTUBE_CONNECTION_COMPONENT,
      instanceName: "A.Port",
      parentEntityName: "A",
      properties: { mConnectedComponent: { value: { pathName: "B.Port" } } },
    },
    {
      type: "SaveComponent",
      typePath: HYPERTUBE_CONNECTION_COMPONENT,
      instanceName: "B.Port",
      parentEntityName: "B",
      properties: {},
    },
    {
      type: "SaveComponent",
      typePath: HYPERTUBE_CONNECTION_COMPONENT,
      instanceName: "Self.Port",
      parentEntityName: "A",
      properties: { mConnectedComponent: { value: { pathName: "Self.Port" } } },
    },
  ]);
  assert.equal(topology.reciprocal_connection_pair_count, 0);
  assert.equal(topology.nonreciprocal_component_reference_count, 1);
  assert.equal(topology.self_component_reference_count, 1);
  assert.equal(topology.certainty, "authoritative_observation_with_inconclusive_hypertube_records");
});

test("power-wire topology inverts exact native mWires membership into bounded physical edges", () => {
  const wireA = "Persistent_Level:Wire_A";
  const wireB = "Persistent_Level:Wire_B";
  const topology = decodeBlueprintPowerWireTopology([
    { type: "SaveEntity", typePath: "/Game/Test/Build_A.Build_A_C", instanceName: "A" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_B.Build_B_C", instanceName: "B" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_C.Build_C_C", instanceName: "C" },
    savedPowerWire(wireA),
    savedPowerWire(wireB),
    savedPowerConnection("A.Power", "A", [wireA, wireB]),
    savedPowerConnection("B.Power", "B", [wireA]),
    savedPowerConnection("C.Power", "C", [wireB]),
  ], { maximumPowerWires: 1 });

  assert.equal(topology.native_power_connection_component_count, 3);
  assert.equal(topology.power_wire_entity_count, 2);
  assert.equal(topology.saved_power_wire_reference_count, 4);
  assert.equal(topology.verified_power_wire_count, 2);
  assert.deepEqual(topology.endpoint_owner_resolution, { both: 2, one: 0, neither: 0 });
  assert.equal(topology.power_wires_returned, 1);
  assert.equal(topology.power_wires_truncated, 1);
  assert.equal(topology.power_wires[0].power_wire_instance_name, wireA);
  assert.equal(topology.power_wires[0].endpoint_a.owner_entity_instance_name, "A");
  assert.equal(topology.power_wires[0].endpoint_b.owner_entity_instance_name, "B");
  assert.equal(topology.electricity_direction, "not_inferred_from_saved_power_wire_edges");
  assert.equal(topology.voltage_load_and_capacity, "not_inferred_from_saved_power_wire_edges");
  assert.equal(topology.certainty, "authoritative_for_verified_native_power_wire_edges");
});

test("power-wire topology keeps malformed, unresolved, unsupported, duplicate, and invalid-edge records explicit", () => {
  const complete = "Persistent_Level:Wire_Complete";
  const incomplete = "Persistent_Level:Wire_Incomplete";
  const overconnected = "Persistent_Level:Wire_Overconnected";
  const duplicate = "Persistent_Level:Wire_Duplicate";
  const unresolved = "Persistent_Level:Wire_Missing";
  const unsupported = "Persistent_Level:Not_A_Power_Wire";
  const malformedProperty = {
    type: "ArrayProperty",
    name: "mWires",
    propertyTagType: { name: "ArrayProperty", children: [] },
    values: [],
  };
  const topology = decodeBlueprintPowerWireTopology([
    { type: "SaveEntity", typePath: "/Game/Test/Build_A.Build_A_C", instanceName: "A" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_B.Build_B_C", instanceName: "B" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_C.Build_C_C", instanceName: "C" },
    savedPowerWire(complete),
    savedPowerWire(incomplete),
    savedPowerWire(overconnected),
    savedPowerWire(duplicate),
    savedPowerWire("Persistent_Level:Wire_Unreferenced"),
    { type: "SaveEntity", typePath: POWER_LINE_CLASS, instanceName: "" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_NotWire.Build_NotWire_C", instanceName: unsupported },
    { type: "SaveEntity", typePath: POWER_LINE_CLASS, instanceName: "Persistent_Level:Wire_Ambiguous" },
    { type: "SaveEntity", typePath: POWER_LINE_CLASS, instanceName: "Persistent_Level:Wire_Ambiguous" },
    savedPowerConnection("A.Power", "A", [complete, incomplete, overconnected, duplicate, duplicate, unresolved, unsupported, "Persistent_Level:Wire_Ambiguous"]),
    savedPowerConnection("B.Power", "B", [complete, overconnected, duplicate]),
    savedPowerConnection("C.Power", "C", [overconnected]),
    savedPowerConnection("Malformed.Power", "A", [], malformedProperty),
  ]);

  assert.equal(topology.verified_power_wire_count, 1);
  assert.equal(topology.malformed_power_wire_entity_record_count, 1);
  assert.equal(topology.malformed_m_wires_property_count, 1);
  assert.equal(topology.duplicate_m_wires_reference_count, 1);
  assert.equal(topology.unresolved_power_wire_reference_count, 1);
  assert.equal(topology.unsupported_power_wire_target_count, 1);
  assert.equal(topology.ambiguous_power_wire_reference_count, 1);
  assert.equal(topology.duplicate_power_wire_endpoint_reference_count, 1);
  assert.equal(topology.incomplete_power_wire_endpoint_count, 1);
  assert.equal(topology.overconnected_power_wire_endpoint_count, 1);
  assert.equal(topology.unreferenced_power_wire_entity_count, 1);
  assert.equal(topology.certainty, "authoritative_observation_with_inconclusive_power_wire_references");
});

test("power-wire topology downgrades malformed component identity and missing endpoint ownership", () => {
  const ownerless = "Persistent_Level:Wire_Ownerless";
  const malformedComponent = "Persistent_Level:Wire_MalformedComponent";
  const topology = decodeBlueprintPowerWireTopology([
    { type: "SaveEntity", typePath: "/Game/Test/Build_A.Build_A_C", instanceName: "A" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_B.Build_B_C", instanceName: "B" },
    { type: "SaveEntity", typePath: "/Game/Test/Build_C.Build_C_C", instanceName: "C" },
    savedPowerWire(ownerless),
    savedPowerWire(malformedComponent),
    savedPowerConnection("A.Power", " ", [ownerless]),
    savedPowerConnection("B.Power", "B", [ownerless]),
    savedPowerConnection(" ", "A", [malformedComponent]),
    savedPowerConnection("C.Power", "C", [malformedComponent]),
  ]);

  assert.equal(topology.verified_power_wire_count, 1);
  assert.equal(topology.unresolved_power_wire_endpoint_owner_count, 1);
  assert.equal(topology.malformed_power_connection_component_record_count, 1);
  assert.equal(topology.incomplete_power_wire_endpoint_count, 1);
  assert.equal(topology.certainty, "authoritative_observation_with_inconclusive_power_wire_references");
});

test("rail topology decodes exact saved spline points and bounded track metadata", () => {
  const topology = decodeBlueprintRailTopology([
    savedRailTrack("Persistent_Level:Rail_A", [
      { x: 0, y: 0, z: 0, tangent: { x: 100, y: 0, z: 0 } },
      { x: 300, y: 400, z: 0, tangent: { x: 0, y: 100, z: 0 } },
    ], 7),
    savedRailTrack("Persistent_Level:Rail_B", [
      { x: -800, y: 0, z: 0 },
      { x: -400, y: 0, z: 0 },
    ], 7),
  ], { maximumRailTracks: 1, maximumRailSplinePoints: 1 });

  assert.equal(topology.status, "decoded");
  assert.equal(topology.native_rail_track_entity_count, 2);
  assert.equal(topology.rail_track_records_returned, 1);
  assert.equal(topology.rail_track_records_truncated, 1);
  assert.equal(topology.total_spline_point_count, 4);
  assert.deepEqual(topology.track_graph_ids, [7]);
  assert.equal(topology.rail_tracks[0].spline_point_count, 2);
  assert.equal(topology.rail_tracks[0].spline_points_returned, 1);
  assert.equal(topology.rail_tracks[0].spline_points_truncated, 1);
  assert.deepEqual(topology.rail_tracks[0].spline_points[0].location_cm, { x: 0, y: 0, z: 0 });
  assert.deepEqual(topology.rail_tracks[0].local_bounds_cm.span_cm, { x: 300, y: 400, z: 0 });
  assert.deepEqual(topology.rail_tracks[0].blueprint_relative_endpoints_cm, {
    start_cm: { x: 100, y: 200, z: 300 },
    end_cm: { x: 400, y: 600, z: 300 },
  });
  assert.equal(topology.rail_tracks[0].chord_length_cm, 500);
  assert.equal(topology.rail_connectivity, "not_proven_from_saved_spline_points_or_m_track_graph_id");
  assert.equal(topology.certainty, "authoritative_for_saved_native_rail_spline_records");
});

test("rail topology keeps missing and malformed saved rail fields explicit", () => {
  const topology = decodeBlueprintRailTopology([
    savedRailTrack("Persistent_Level:Rail_Missing", [], 1, { properties: {} }),
    savedRailTrack("Persistent_Level:Rail_BadPoint", [
      { x: 0, y: 0, z: 0 },
    ], 1, {
      properties: {
        mTrackGraphID: {
          type: "IntProperty",
          name: "mTrackGraphID",
          propertyTagType: { name: "IntProperty", children: [] },
          value: "not-an-id",
        },
        mSplineData: {
          type: "ArrayProperty",
          name: "mSplineData",
          propertyTagType: { name: "ArrayProperty", children: [] },
          values: [{}],
        },
      },
    }),
    { type: "SaveEntity", typePath: RAIL_TRACK_CLASS, instanceName: "" },
  ]);
  assert.equal(topology.native_rail_track_entity_count, 3);
  assert.equal(topology.malformed_rail_track_entity_record_count, 1);
  assert.equal(topology.missing_spline_data_count, 2);
  assert.equal(topology.malformed_track_graph_id_count, 1);
  assert.equal(topology.malformed_spline_data_count, 1);
  assert.equal(topology.certainty, "authoritative_observation_with_inconclusive_rail_records");
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
  let receivedOptions = null;
  const result = solveBlueprintLayout(
    graph,
    { blueprint_name: "Native test", maximum_buildables: 1, maximum_power_wires: 3 },
    {
      inspectBlueprint: (name, options) => {
        receivedOptions = options;
        return inspectBlueprintStructure(name, sbp, sbpcfg, options);
      },
    },
  );
  assert.equal(result.solver, "blueprint_layout");
  assert.equal(result.available, true);
  assert.equal(result.buildables_returned, 1);
  assert.equal(result.ingredients[0].item_name, "IronPlate");
  assert.equal(result.ingredients[0].shortfall, 0);
  assert.equal(receivedOptions.maximumPowerWires, 3);
  assert.equal(receivedOptions.maximumRailTracks, 40);
  assert.equal(receivedOptions.maximumRailSplinePoints, 200);
  assert.equal(receivedOptions.maximumHypertubeConnections, 80);
  assert.equal(receivedOptions.maximumHypertubePipes, 40);
  assert.equal(receivedOptions.maximumHypertubeSplinePoints, 200);
});

function comparisonInspection(name, {
  classes = [],
  recipes = [],
  costs = [],
  truncated = 0,
  topology = {},
  gameChangelist = 502094,
} = {}) {
  return {
    available: true,
    blueprint_name: name,
    blueprint_reference: `${name}.sbp`,
    header: {
      blueprint_header_version: 2,
      factory_save_custom_version: 58,
      game_changelist: gameChangelist,
      designer_dimensions: { x: 4, y: 4, z: 2 },
      recipe_references: recipes.map((recipe_class) => ({ recipe_class })),
      build_cost: costs.map(([item_class, amount]) => ({ item_class, amount })),
    },
    decoded: {
      object_count: 10,
      entity_count: 8,
      component_count: 2,
      buildable_count: 8,
      buildables_with_finite_transform: 8,
    },
    buildable_classes: classes.map(([class_path, count]) => ({ class_path, count })),
    buildable_classes_truncated: truncated,
    pivot_bounds_cm: { span_cm: { x: 3200, y: 3200, z: 1600 } },
    connection_topology: {
      status: "decoded",
      reciprocal_connection_pair_count: topology.conveyor_pipe_pairs ?? 0,
      reciprocal_connection_pairs_by_kind: {
        conveyor: topology.conveyor_pairs ?? 0,
        pipe: topology.pipe_pairs ?? 0,
        mixed: topology.mixed_pairs ?? 0,
      },
    },
    power_wire_topology: { status: "decoded", verified_power_wire_count: topology.power_wire_edges ?? 0 },
    rail_topology: {
      status: "decoded",
      native_rail_track_entity_count: topology.rail_tracks ?? 0,
      total_spline_point_count: topology.rail_spline_points ?? 0,
    },
    hypertube_topology: {
      status: "decoded",
      reciprocal_connection_pair_count: topology.hypertube_pairs ?? 0,
      hypertube_pipe_entity_count: topology.hypertube_pipes ?? 0,
      total_spline_point_count: topology.hypertube_spline_points ?? 0,
    },
    certainty: "authoritative_for_decoded_entities",
    source: "decoded_from_saved_native_blueprint",
  };
}

test("compares exact Blueprint structure evidence without inferring style or joins", () => {
  const left = comparisonInspection("Lower", {
    classes: [["/Game/Build/Foundation", 4], ["/Game/Build/Smelter", 2]],
    recipes: ["/Game/Recipe/Foundation", "/Game/Recipe/Smelter"],
    costs: [[IRON_PLATE, 5]],
    topology: { conveyor_pipe_pairs: 2, conveyor_pairs: 2, power_wire_edges: 1, hypertube_pairs: 4 },
  });
  const right = comparisonInspection("Main", {
    classes: [["/Game/Build/Foundation", 4], ["/Game/Build/Smelter", 3], ["/Game/Build/Wall", 8]],
    recipes: ["/Game/Recipe/Foundation", "/Game/Recipe/Wall"],
    costs: [[IRON_PLATE, 8], [CABLE, 2]],
    topology: { conveyor_pipe_pairs: 1, conveyor_pairs: 1, power_wire_edges: 3, hypertube_pipes: 2 },
  });
  const result = compareBlueprintStructures(left, right);
  assert.equal(result.available, true);
  assert.equal(result.comparison.shared_buildable_class_count, 2);
  assert.deepEqual(result.comparison.class_differences, [
    { class_path: "/Game/Build/Wall", left: 0, right: 8, delta: 8 },
    { class_path: "/Game/Build/Smelter", left: 2, right: 3, delta: 1 },
  ]);
  assert.deepEqual(result.comparison.recipe_differences, [
    { recipe_class: "/Game/Recipe/Smelter", left: 1, right: 0, delta: -1 },
    { recipe_class: "/Game/Recipe/Wall", left: 0, right: 1, delta: 1 },
  ]);
  assert.deepEqual(result.comparison.cost_differences, [
    { item_class: IRON_PLATE, left: 5, right: 8, delta: 3 },
    { item_class: CABLE, left: 0, right: 2, delta: 2 },
  ]);
  assert.equal(result.comparison.topology_delta.power_wire_edges.delta, 2);
  assert.equal(result.comparison.topology_delta.hypertube_pairs.delta, -4);
  assert.match(result.caveat, /serialized native Blueprint/i);
  assert.ok(result.claims_not_made.some((claim) => /snap compatibility/i.test(claim)));
});

test("keeps Blueprint comparison unavailable when one exact inspection fails", () => {
  const result = compareBlueprintStructures(
    comparisonInspection("Good"),
    { available: false, blueprint_name: "Missing", reason: "blueprint_not_found", certainty: "unknown" },
  );
  assert.equal(result.available, false);
  assert.equal(result.reason, "one_or_both_blueprint_inspections_unavailable");
  assert.equal(result.right.reason, "blueprint_not_found");
});

test("marks changed class evidence inconclusive when an inspection truncated its class list", () => {
  const result = compareBlueprintStructures(
    comparisonInspection("Left", { truncated: 1 }),
    comparisonInspection("Right"),
  );
  assert.equal(result.available, true);
  assert.equal(result.comparison.class_differences_complete, false);
  assert.match(result.comparison.class_differences_reason, /truncated/i);
  assert.equal(result.certainty, "authoritative_with_inconclusive_or_truncated_comparison_fields");
});

test("the comparison solver bounds both read-only inspections and preserves world revision", () => {
  const graph = buildGraph(buildFactorySnapshot());
  const calls = [];
  const result = solveBlueprintComparison(
    graph,
    {
      left_blueprint_name: "Left",
      right_blueprint_name: "Right",
      maximum_class_differences: 2,
      maximum_recipe_differences: 3,
      maximum_cost_differences: 4,
    },
    {
      inspectBlueprint: (name, options) => {
        calls.push({ name, options });
        return comparisonInspection(name);
      },
    },
  );
  assert.equal(result.solver, "blueprint_comparison");
  assert.equal(result.world_revision, graph.world_revision);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, {
    maximumBuildables: 1,
    maximumConnections: 1,
    maximumPowerWires: 1,
    maximumRailTracks: 1,
    maximumRailSplinePoints: 1,
    maximumHypertubeConnections: 1,
    maximumHypertubePipes: 1,
    maximumHypertubeSplinePoints: 1,
  });
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
