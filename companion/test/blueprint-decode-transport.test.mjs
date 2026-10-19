import assert from "node:assert/strict";
import test from "node:test";
import { BlueprintWriter, Parser, SaveComponent, SaveEntity, StructProperty } from "@etothepii/satisfactory-file-parser";

import { decodeBlueprint } from "../lib/blueprint-decode.mjs";
import {
  decodeBlueprintHypertubeTopology,
  decodeBlueprintRailTopology,
} from "../lib/blueprints.mjs";

// Fixture helpers adapted from blueprints.test.mjs. Every blueprint here is
// serialised through the pinned parser and decoded back through the public
// offline decodeBlueprint, so the evidence travels the same path a saved
// reference does.
const OFFLINE_TOPOLOGY_LIMIT = 100000;
const HYPERTUBE_COMPONENT = "/Script/FactoryGame.FGPipeConnectionComponentHyper";
const HYPERTUBE_PIPE = "/Game/FactoryGame/Buildable/Factory/PipeHyper/Build_PipeHyper.Build_PipeHyper_C";
const HYPERTUBE_START =
  "/Game/FactoryGame/Buildable/Factory/PipeHyperStart/Build_PipeHyperStart.Build_PipeHyperStart_C";
const RAIL_TRACK = "/Game/FactoryGame/Buildable/Factory/Train/Track/Build_RailroadTrack.Build_RailroadTrack_C";
const CONVEYOR_COMPONENT = "/Script/FactoryGame.FGFactoryConnectionComponent";
const CONSTRUCTOR =
  "/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C";
const SMELTER = "/Game/FactoryGame/Buildable/Factory/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C";

function entity(typePath, instanceName, translation = { x: 0, y: 0, z: 0 }) {
  const saved = new SaveEntity(typePath, "Persistent_Level", instanceName, "", true);
  saved.flags = 8;
  saved.transform.translation = translation;
  return saved;
}

function objectProperty(name, pathName) {
  return {
    type: "ObjectProperty",
    name,
    propertyTagType: { name: "ObjectProperty", children: [] },
    value: { levelName: "Persistent_Level", pathName },
  };
}

function component(typePath, instanceName, parentEntityName, connectedName = null) {
  const saved = new SaveComponent(typePath, "Persistent_Level", instanceName, parentEntityName);
  if (connectedName) saved.properties.mConnectedComponent = objectProperty("mConnectedComponent", connectedName);
  return saved;
}

function vector(name, value) {
  return {
    type: "StructProperty",
    name,
    propertyTagType: { name: "StructProperty", children: [{ name: "Vector", children: [] }] },
    value,
  };
}

function splineProperty(points) {
  const values = points.map(({ x, y, z, tangent = { x: 0, y: 0, z: 0 } }) => ({
    type: "SplinePointData",
    properties: {
      Location: vector("Location", { x, y, z }),
      ArriveTangent: vector("ArriveTangent", tangent),
      LeaveTangent: vector("LeaveTangent", tangent),
    },
  }));
  // Save version 52 predates complete property tags. The pinned array writer
  // requires an inner structTag, including its serialized payload size. Use
  // the same public serializer to measure it; never guess the vector layout.
  const sizeWriter = new BlueprintWriter();
  sizeWriter.context.saveVersion = { header: 52, level: 52, object: 52 };
  for (const value of values) StructProperty.SerializeValue(sizeWriter, "SplinePointData", value);
  return {
    type: "ArrayProperty",
    name: "mSplineData",
    propertyTagType: {
      name: "ArrayProperty",
      children: [{ name: "StructProperty", children: [{ name: "SplinePointData", children: [] }] }],
    },
    structTag: { propertyName: "mSplineData", propertyType: "StructProperty", subtype: "SplinePointData",
      propertyTagType: { name: "StructProperty", children: [{ name: "SplinePointData", children: [] }] },
      structGuid: [0, 0, 0, 0], binarySize: sizeWriter.getBufferPosition() },
    values,
  };
}

function splineEntity(typePath, instanceName, points, translation) {
  const saved = entity(typePath, instanceName, translation);
  saved.properties.mSplineData = splineProperty(points);
  return saved;
}

function railTrack(instanceName, points, graphId, translation) {
  const saved = splineEntity(RAIL_TRACK, instanceName, points, translation);
  saved.properties.mTrackGraphID = {
    type: "IntProperty",
    name: "mTrackGraphID",
    propertyTagType: { name: "IntProperty", children: [] },
    value: graphId,
  };
  return saved;
}

function serialise(objects, description = "Transport fixture") {
  const blueprint = {
    name: "Transport fixture",
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
      itemCosts: [],
      recipeReferences: [],
    },
    config: { configVersion: 0, description, iconID: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    objects,
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

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function decode(objects) {
  const { sbp, sbpcfg } = serialise(objects);
  return { decoded: decodeBlueprint("Transport fixture", sbp, sbpcfg), sbp, sbpcfg };
}

const TUBE_START = "Persistent_Level:Build_PipeHyperStart_C_1";
const TUBE_PIPE = "Persistent_Level:Build_PipeHyper_C_2";

function hypertubeObjects() {
  return [
    entity(HYPERTUBE_START, TUBE_START, { x: 0, y: 0, z: 0 }),
    splineEntity(
      HYPERTUBE_PIPE,
      TUBE_PIPE,
      [
        { x: 0, y: 0, z: 0, tangent: { x: 100, y: 0, z: 0 } },
        { x: 300, y: 400, z: 0, tangent: { x: 0, y: 100, z: 0 } },
      ],
      { x: 100, y: 200, z: 300 },
    ),
    component(HYPERTUBE_COMPONENT, `${TUBE_START}.Connection`, TUBE_START, `${TUBE_PIPE}.Connection0`),
    component(HYPERTUBE_COMPONENT, `${TUBE_PIPE}.Connection0`, TUBE_PIPE, `${TUBE_START}.Connection`),
    // Open far end: a component with no saved partner.
    component(HYPERTUBE_COMPONENT, `${TUBE_PIPE}.Connection1`, TUBE_PIPE),
  ];
}

test("offline decode keeps exact reciprocal hypertube pair and PipeHyper spline", () => {
  const { decoded } = decode(hypertubeObjects());
  assert.equal(decoded.available, true);
  const tube = decoded.hypertube_topology;
  assert.equal(tube.status, "decoded");
  assert.equal(tube.native_hypertube_connection_component_count, 3);
  assert.equal(tube.reciprocal_connection_pair_count, 1);
  assert.equal(tube.connections.length, 1);
  const [pair] = tube.connections;
  assert.equal(pair.connection_kind, "hypertube");
  const owners = [pair.endpoint_a, pair.endpoint_b].map((endpoint) => endpoint.owner_entity_instance_name).sort();
  assert.deepEqual(owners, [TUBE_START, TUBE_PIPE].sort());
  assert.deepEqual(tube.endpoint_owner_resolution, { both: 1, one: 0, neither: 0 });
  assert.equal(tube.native_hypertube_entity_count, 2);
  assert.equal(tube.hypertube_pipe_entity_count, 1);
  const [record] = tube.pipe_hyper_records;
  assert.equal(record.pipe_instance_name, TUBE_PIPE);
  assert.equal(record.spline_point_count, 2);
  assert.equal(record.spline_data_state, "valid");
  assert.equal(record.chord_length_cm, 500);
  assert.deepEqual(record.blueprint_relative_endpoints_cm, {
    start_cm: { x: 100, y: 200, z: 300 },
    end_cm: { x: 400, y: 600, z: 300 },
  });
  assert.deepEqual(record.spline_points[0].leave_tangent_cm, { x: 100, y: 0, z: 0 });
  assert.equal(tube.pipe_records_truncated, 0);
  assert.equal(tube.connections_truncated, 0);
});

test("hypertube evidence invents no direction, live join or cross-blueprint connection", () => {
  const tube = decode(hypertubeObjects()).decoded.hypertube_topology;
  assert.equal(tube.traversal_direction, "not_inferred_from_component_references_or_spline_order");
  assert.equal(tube.cross_blueprint_joins, "not_proven_from_saved_component_references");
  assert.equal(tube.external_connections, "not_proven_by_the_saved_blueprint");
  assert.equal(tube.speed_and_throughput, "not_inferred_from_saved_hypertube_records");
  // The pair is unordered evidence: no from/to/direction field is invented.
  const [pair] = tube.connections;
  assert.deepEqual(Object.keys(pair).sort(), ["connection_kind", "endpoint_a", "endpoint_b"]);
});

test("offline hypertube_topology equals the proven decoder run on the same parsed objects", () => {
  const { decoded, sbp, sbpcfg } = decode(hypertubeObjects());
  const parsed = Parser.ParseBlueprintFiles(
    "Transport fixture",
    exactArrayBuffer(sbp),
    exactArrayBuffer(sbpcfg),
    { throwErrors: true },
  );
  assert.deepEqual(
    decoded.hypertube_topology,
    decodeBlueprintHypertubeTopology(parsed.objects, {
      maximumConnections: OFFLINE_TOPOLOGY_LIMIT,
      maximumPipes: OFFLINE_TOPOLOGY_LIMIT,
      maximumSplinePoints: OFFLINE_TOPOLOGY_LIMIT,
    }),
  );
  assert.deepEqual(
    decoded.rail_topology,
    decodeBlueprintRailTopology(parsed.objects, {
      maximumRailTracks: OFFLINE_TOPOLOGY_LIMIT,
      maximumRailSplinePoints: OFFLINE_TOPOLOGY_LIMIT,
    }),
  );
});

test("offline decode retains native rail track records with their uncertainty fields", () => {
  const { decoded } = decode([
    railTrack(
      "Persistent_Level:Build_RailroadTrack_C_1",
      [
        { x: 0, y: 0, z: 0, tangent: { x: 100, y: 0, z: 0 } },
        { x: 300, y: 400, z: 0, tangent: { x: 0, y: 100, z: 0 } },
      ],
      7,
      { x: 100, y: 200, z: 300 },
    ),
    railTrack("Persistent_Level:Build_RailroadTrack_C_2", [{ x: -800, y: 0, z: 0 }, { x: -400, y: 0, z: 0 }], 7, {
      x: 0,
      y: 0,
      z: 0,
    }),
  ]);
  const rail = decoded.rail_topology;
  assert.equal(rail.status, "decoded");
  assert.equal(rail.native_rail_track_entity_count, 2);
  assert.equal(rail.rail_track_records_returned, 2);
  assert.equal(rail.rail_track_records_truncated, 0);
  assert.equal(rail.total_spline_point_count, 4);
  assert.deepEqual(rail.track_graph_ids, [7]);
  const first = rail.rail_tracks.find((track) => track.track_instance_name.endsWith("_1"));
  assert.equal(first.chord_length_cm, 500);
  assert.deepEqual(first.blueprint_relative_endpoints_cm, {
    start_cm: { x: 100, y: 200, z: 300 },
    end_cm: { x: 400, y: 600, z: 300 },
  });
  // Uncertainty is carried through verbatim, never upgraded to a live claim.
  assert.equal(rail.rail_connectivity, "not_proven_from_saved_spline_points_or_m_track_graph_id");
  assert.equal(rail.external_connections, "not_proven_by_the_saved_blueprint");
  assert.equal(rail.terrain_clearance_and_destination_fit, "not_proven_by_the_saved_blueprint");
  assert.match(rail.caveat, /does not prove cross-segment joins/);
  assert.equal(rail.certainty, "authoritative_for_saved_native_rail_spline_records");
  assert.equal(decoded.hypertube_topology.native_hypertube_entity_count, 0);
});

test("nonreciprocal, self and unresolved hypertube references stay explicit and unjoined", () => {
  const a = "Persistent_Level:Build_PipeHyperStart_C_A";
  const b = "Persistent_Level:Build_PipeHyperStart_C_B";
  const { decoded } = decode([
    entity(HYPERTUBE_START, a),
    entity(HYPERTUBE_START, b),
    component(HYPERTUBE_COMPONENT, `${a}.Port`, a, `${b}.Port`),
    component(HYPERTUBE_COMPONENT, `${b}.Port`, b),
    component(HYPERTUBE_COMPONENT, `${a}.Self`, a, `${a}.Self`),
    component(HYPERTUBE_COMPONENT, `${b}.Lost`, b, "Persistent_Level:Missing.Port"),
  ]);
  const tube = decoded.hypertube_topology;
  assert.equal(tube.reciprocal_connection_pair_count, 0);
  assert.deepEqual(tube.connections, []);
  assert.equal(tube.nonreciprocal_component_reference_count, 1);
  assert.equal(tube.self_component_reference_count, 1);
  assert.equal(tube.unresolved_component_reference_count, 1);
  assert.equal(tube.certainty, "authoritative_observation_with_inconclusive_hypertube_records");
});

test("a blueprint with no transport reports explicit zero and keeps existing topologies", () => {
  const { decoded } = decode([entity(CONSTRUCTOR, "Persistent_Level:Build_ConstructorMk1_C_1")]);
  assert.equal(decoded.available, true);
  const tube = decoded.hypertube_topology;
  assert.equal(tube.status, "decoded");
  assert.equal(tube.native_hypertube_entity_count, 0);
  assert.equal(tube.native_hypertube_connection_component_count, 0);
  assert.equal(tube.reciprocal_connection_pair_count, 0);
  assert.deepEqual(tube.pipe_hyper_records, []);
  assert.equal(tube.certainty, "authoritative_for_verified_native_hypertube_records");
  const rail = decoded.rail_topology;
  assert.equal(rail.status, "decoded");
  assert.equal(rail.native_rail_track_entity_count, 0);
  assert.deepEqual(rail.rail_tracks, []);
  assert.deepEqual(rail.track_graph_ids, []);
  // Absence of saved records is not a claim about connections outside the file.
  assert.equal(rail.external_connections, "not_proven_by_the_saved_blueprint");
  assert.equal(decoded.connection_topology.status, "decoded");
  assert.equal(decoded.connection_topology.reciprocal_connection_pair_count, 0);
  assert.equal(decoded.power_wire_topology.status, "decoded");
  assert.equal(decoded.power_wire_topology.verified_power_wire_count, 0);
});

test("conveyor connection topology is unchanged beside hypertube and rail evidence", () => {
  const a = "Persistent_Level:Build_ConstructorMk1_C_1";
  const b = "Persistent_Level:Build_SmelterMk1_C_2";
  const { decoded } = decode([
    entity(CONSTRUCTOR, a),
    entity(SMELTER, b),
    component(CONVEYOR_COMPONENT, `${a}.Out`, a, `${b}.In`),
    component(CONVEYOR_COMPONENT, `${b}.In`, b, `${a}.Out`),
    ...hypertubeObjects(),
  ]);
  assert.equal(decoded.connection_topology.reciprocal_connection_pair_count, 1);
  assert.equal(decoded.connection_topology.reciprocal_connection_pairs_by_kind.conveyor, 1);
  assert.equal(decoded.hypertube_topology.reciprocal_connection_pair_count, 1);
  assert.equal(decoded.power_wire_topology.status, "decoded");
});

test("offline decode keeps aggregate counts when the decoder bounds its returned records", () => {
  const tubes = Array.from({ length: 81 }, (_, index) =>
    splineEntity(
      HYPERTUBE_PIPE,
      `Persistent_Level:Build_PipeHyper_C_${index}`,
      [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }],
      { x: index * 100, y: 0, z: 0 },
    ),
  );
  const tube = decode(tubes).decoded.hypertube_topology;
  assert.equal(tube.hypertube_pipe_entity_count, 81);
  assert.equal(tube.total_spline_point_count, 162);
  assert.equal(tube.pipe_records_returned + tube.pipe_records_truncated, 81);
  assert.ok(tube.pipe_records_truncated > 0, "the decoder's own truncation is reported, not hidden");
  assert.equal(
    tube.returned_spline_point_count + tube.spline_points_truncated,
    tube.total_spline_point_count,
  );
});
