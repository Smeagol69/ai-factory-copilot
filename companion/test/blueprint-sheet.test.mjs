import assert from "node:assert/strict";
import test from "node:test";
import { renderBlueprintSheet } from "../lib/blueprint-sheet.mjs";
import { decodeBlueprintHypertubeTopology, decodeBlueprintRailTopology } from "../lib/blueprints.mjs";

function fixture() {
  return {
    available: true, name: "Transport study",
    header: { designer_dimensions: { x: 4, y: 4, z: 4 }, build_cost: [] },
    totals: { buildings: 0, distinct_classes: 0 }, buildings: [], machine_groups: [],
    throughput_check: { status: "not_attempted", reason: "no declared output" },
    connection_topology: { reciprocal_connection_pair_count: 0 },
    power_wire_topology: { verified_power_wire_count: 2 },
    coordinate_note: "Saved local pivots only.",
    hypertube_topology: {
      status: "decoded", scope: "reciprocal_native_hypertube_component_references_and_saved_pipe_hyper_splines",
      reciprocal_connection_pair_count: 2, native_hypertube_entity_count: 3,
      hypertube_pipe_entity_count: 1, total_spline_point_count: 2,
      connections: [
        { endpoint_a: { component_instance_name: "Entrance.HyperOut" }, endpoint_b: { component_instance_name: "Pipe.Hyper0" } },
        { endpoint_a: { component_instance_name: "Pipe.Hyper1" }, endpoint_b: { component_instance_name: "Exit.HyperIn" } },
      ],
      connections_truncated: 0, pipe_records_truncated: 0, spline_points_truncated: 0,
      malformed_spline_point_count: 0, missing_spline_data_count: 0, malformed_spline_data_count: 0,
      pipe_hyper_records: [{ pipe_instance_name: "Pipe", spline_data_state: "valid", spline_point_count: 2,
        malformed_spline_point_count: 0,
        blueprint_relative_endpoints_cm: { start_cm: { x: 100, y: 200, z: 300 }, end_cm: { x: 400, y: 600, z: 300 } },
        chord_length_cm: 500 }],
      caveat: "Saved reciprocal links do not prove traversal direction, speed, throughput, destination fit or external hookups.",
    },
    rail_topology: {
      status: "decoded", scope: "saved_native_railroad_track_spline_records",
      native_rail_track_entity_count: 1, total_spline_point_count: 2,
      rail_track_records_truncated: 0, spline_points_truncated: 0,
      malformed_spline_point_count: 0, missing_spline_data_count: 0, malformed_spline_data_count: 0,
      rail_tracks: [{ track_instance_name: "Track", track_graph_id: 17, track_graph_id_state: "valid",
        spline_data_state: "valid", spline_point_count: 2, malformed_spline_point_count: 0,
        blueprint_relative_endpoints_cm: { start_cm: { x: -100, y: 0, z: 50 }, end_cm: { x: 200, y: 400, z: 50 } },
        chord_length_cm: 500 }],
      caveat: "Chord length is a lower bound; saved graph IDs do not prove track joins, signals, power or destination fit.",
    },
  };
}

// Dropping a transport field, confusing a component link with a spline, or
// treating chord length/graph identity as operational proof must fail here.
test("sheet preserves saved hypertube links and rail geometry with their evidence limits", () => {
  const text = renderBlueprintSheet(fixture());
  assert.match(text, /\*\*2\*\* reciprocal native hypertube pairs/);
  assert.match(text, /\*\*3\*\* native hypertube entities/);
  assert.match(text, /\*\*1\*\* saved PipeHyper spline records/);
  assert.match(text, /\| Entrance\.HyperOut \| Pipe\.Hyper0 \|/);
  assert.match(text, /\| Pipe\.Hyper1 \| Exit\.HyperIn \|/);
  assert.match(text, /\| Pipe \| 2 \| \(100, 200, 300\) \| \(400, 600, 300\) \| 500 \|/);
  assert.match(text, /\*\*1\*\* native railroad track records/);
  assert.match(text, /\| Track \| 17 \| 2 \| \(-100, 0, 50\) \| \(200, 400, 50\) \| 500 \|/);
  assert.match(text, /lower bound/i);
  assert.match(text, /do not prove traversal direction, speed, throughput, destination fit or external hookups/);
  assert.match(text, /do not prove track joins, signals, power or destination fit/);
  assert.match(text, /\*\*0\*\* reciprocal conveyor\/pipe pairs, \*\*2\*\* verified power wires/);
  assert.match(text, /## Every building/);
});

// Old artifacts and future/unsupported topology formats must not silently turn
// a missing observation into an authoritative zero or render foreign counts.
test("sheet labels absent or unsupported transport topology unknown", () => {
  const decode = fixture();
  delete decode.hypertube_topology;
  decode.rail_topology = { status: "decoded", scope: "future_transport_shape", native_rail_track_entity_count: 99 };
  const text = renderBlueprintSheet(decode);
  assert.match(text, /### Hypertubes\n\nUnknown/i);
  assert.match(text, /### Railroad tracks\n\nUnknown/i);
  assert.doesNotMatch(text, /\*\*(?:0|99)\*\* native railroad track records/);
  assert.doesNotMatch(text, /\*\*0\*\* reciprocal native hypertube pairs/);

  decode.hypertube_topology = { status: "not_available", reason: "World export has no saved component records." };
  assert.match(renderBlueprintSheet(decode), /World export has no saved component records/);
});

test("sheet retains unknown transport measurements without guessing zero or rendering invalid numbers", () => {
  const decode = fixture();
  decode.hypertube_topology.reciprocal_connection_pair_count = null;
  decode.hypertube_topology.pipe_hyper_records[0] = { pipe_instance_name: "Unreadable pipe",
    spline_data_state: "missing", spline_point_count: null,
    blueprint_relative_endpoints_cm: null, chord_length_cm: null };
  decode.rail_topology.rail_tracks[0].track_graph_id = null;
  decode.rail_topology.rail_tracks[0].track_graph_id_state = "missing";
  decode.rail_topology.rail_tracks[0].chord_length_cm = NaN;
  const text = renderBlueprintSheet(decode);
  assert.match(text, /\*\*unknown\*\* reciprocal native hypertube pairs/);
  assert.match(text, /\| Unreadable pipe \| unknown \| unknown \| unknown \| unknown \|/);
  assert.match(text, /\| Track \| unknown \| 2 \|/);
  assert.doesNotMatch(text, /NaN|undefined|\| null \|/);
});

// A large offline artifact must keep aggregate counts while the readable sheet
// reports both decoder omissions and its own bounded list of detail rows.
test("sheet bounds transport details and reports decoder truncation separately", () => {
  const decode = fixture();
  decode.hypertube_topology.connections = Array.from({ length: 43 }, (_, i) => ({
    endpoint_a: { component_instance_name: `A${i}.Port` }, endpoint_b: { component_instance_name: `B${i}.Port` },
  }));
  decode.hypertube_topology.reciprocal_connection_pair_count = 51;
  decode.hypertube_topology.connections_truncated = 8;
  decode.hypertube_topology.pipe_hyper_records = Array.from({ length: 42 }, (_, i) => ({
    ...decode.hypertube_topology.pipe_hyper_records[0], pipe_instance_name: `Pipe${i}`,
  }));
  decode.hypertube_topology.hypertube_pipe_entity_count = 50;
  decode.hypertube_topology.pipe_records_truncated = 8;
  decode.hypertube_topology.spline_points_truncated = 23;
  decode.rail_topology.rail_tracks = Array.from({ length: 42 }, (_, i) => ({
    ...decode.rail_topology.rail_tracks[0], track_instance_name: `Track${i}`,
  }));
  decode.rail_topology.native_rail_track_entity_count = 50;
  decode.rail_topology.rail_track_records_truncated = 8;
  decode.rail_topology.spline_points_truncated = 17;
  const text = renderBlueprintSheet(decode, { jsonPath: "study.json" });
  assert.match(text, /\*\*51\*\* reciprocal native hypertube pairs/);
  assert.match(text, /\*\*50\*\* native railroad track records/);
  assert.match(text, /\| A39\.Port \| B39\.Port \|/);
  assert.doesNotMatch(text, /A40\.Port|\| Pipe40 \||\| Track40 \|/);
  assert.match(text, /3 further hypertube links.*not shown.*JSON/i);
  assert.match(text, /2 further PipeHyper records.*not shown.*JSON/i);
  assert.match(text, /2 further rail records.*not shown.*JSON/i);
  assert.match(text, /Decoder bounded omissions: 8 hypertube links, 8 PipeHyper records, 23 spline points/);
  assert.match(text, /Decoder bounded omissions: 8 rail records, 17 spline points/);
  assert.match(text, /Complete machine-readable decode: `study\.json`/);
});

// The native decoders retain surviving points when one declared point is
// malformed. Those filtered endpoints must not become the spline's true ends,
// nor may the invalid point be described as a bounded omission.
test("malformed spline points remain distinct from bounded omissions and cannot supply endpoints", () => {
  const vector = (name, x) => ({ type: "StructProperty", name, value: { x, y: 0, z: 0 } });
  const values = [0, 100, 200].map(x => ({ type: "SplinePointData", properties: {
    Location: vector("Location", x), ArriveTangent: vector("ArriveTangent", 1), LeaveTangent: vector("LeaveTangent", 1),
  } }));
  delete values[0].properties.ArriveTangent;
  const saved = (typePath, instanceName) => ({ type: "SaveEntity", typePath, instanceName,
    transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } },
    properties: {
      mSplineData: { type: "ArrayProperty", name: "mSplineData", propertyTagType: { name: "ArrayProperty",
        children: [{ name: "StructProperty", children: [{ name: "SplinePointData", children: [] }] }] }, values },
      mTrackGraphID: { type: "IntProperty", name: "mTrackGraphID", propertyTagType: { name: "IntProperty", children: [] }, value: 7 },
    } });
  for (const { cap, boundedOmissions } of [{ cap: 1000, boundedOmissions: 0 }, { cap: 1, boundedOmissions: 1 }]) {
    const decode = fixture();
    decode.hypertube_topology = decodeBlueprintHypertubeTopology([saved(
      "/Game/FactoryGame/Buildable/Factory/PipeHyper/Build_PipeHyper.Build_PipeHyper_C", "Malformed pipe")],
    { maximumSplinePoints: cap });
    decode.rail_topology = decodeBlueprintRailTopology([saved(
      "/Game/FactoryGame/Buildable/Factory/Train/Track/Build_RailroadTrack.Build_RailroadTrack_C", "Malformed track")],
    { maximumRailSplinePoints: cap });
    assert.equal(decode.hypertube_topology.pipe_hyper_records[0].blueprint_relative_endpoints_cm.start_cm.x, 100,
      "the fixture exposes the decoder's surviving-point endpoint");
    const text = renderBlueprintSheet(decode);
    assert.match(text, /\| Malformed pipe \| 3 \| unknown \| unknown \| unknown \| malformed_points \| 1 \|/);
    assert.match(text, /\| Malformed track \| 7 \| 3 \| unknown \| unknown \| unknown \| malformed_points \| 1 \|/);
    assert.doesNotMatch(text, /\(100, 0, 0\)|\(200, 0, 0\)/);
    assert.equal((text.match(/Malformed spline points: 1/g) ?? []).length, 2);
    assert.match(text, new RegExp(`Decoder bounded omissions: 0 hypertube links, 0 PipeHyper records, ${boundedOmissions} spline points`));
    assert.match(text, new RegExp(`Decoder bounded omissions: 0 rail records, ${boundedOmissions} spline points`));
  }
});
