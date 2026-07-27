import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraph,
  normalizeConnectionDirection,
  normalizeProductionStatus,
  traceDownstream,
  traceUpstream,
} from "../lib/graph.mjs";
import {
  BELT_INGOT,
  BELT_ORE,
  CONSTRUCTOR,
  MINER,
  ORE_NODE,
  PIPELINE,
  PLAYER,
  REFINERY,
  SMELTER,
  buildFactorySnapshot,
} from "./fixtures/factory.mjs";

test("normalizes engine connection and status enum names", () => {
  assert.equal(normalizeConnectionDirection("factory", "FCD_OUTPUT"), "output");
  assert.equal(normalizeConnectionDirection("factory", "FCD_INPUT"), "input");
  assert.equal(normalizeConnectionDirection("factory", "FCD_SNAP_ONLY"), "snap_only");
  assert.equal(normalizeConnectionDirection("pipe", "PCT_PRODUCER"), "output");
  assert.equal(normalizeConnectionDirection("pipe", "PCT_CONSUMER"), "input");
  assert.equal(normalizeConnectionDirection("factory", undefined), "unknown");
  assert.equal(normalizeProductionStatus("IS_PRODUCING"), "producing");
  assert.equal(normalizeProductionStatus("IS_STANDBY"), "standby");
  assert.equal(normalizeProductionStatus("IS_ERROR"), "error");
  assert.equal(normalizeProductionStatus(null), "unknown");
});

test("assigns a role to every captured actor", () => {
  const graph = buildGraph(buildFactorySnapshot());
  assert.equal(graph.nodes.size, 10);
  assert.equal(graph.nodes.get(MINER).role, "factory");
  assert.equal(graph.nodes.get(SMELTER).role, "manufacturer");
  assert.equal(graph.nodes.get(BELT_ORE).role, "conveyor");
  assert.equal(graph.nodes.get(PIPELINE).role, "pipeline");
  assert.equal(graph.nodes.get(PLAYER).role, "player");
  assert.equal(graph.nodes.get(ORE_NODE).role, "resource_node");
});

test("resolves every connected component to its owning actor", () => {
  const graph = buildGraph(buildFactorySnapshot());
  assert.deepEqual(graph.unresolvedConnections, []);
  assert.equal(graph.nodes.get(MINER).item_outputs[0].peer_actor_id, BELT_ORE);
  assert.equal(graph.nodes.get(SMELTER).item_inputs[0].peer_actor_id, BELT_ORE);
  assert.equal(graph.nodes.get(SMELTER).item_outputs[0].peer_actor_id, BELT_INGOT);
  assert.equal(graph.nodes.get(REFINERY).fluid_inputs[0].peer_actor_id, PIPELINE);
});

test("counts unconnected ports instead of assuming they are wired", () => {
  const graph = buildGraph(buildFactorySnapshot());
  assert.equal(graph.nodes.get(CONSTRUCTOR).unconnected_item_outputs, 1);
  assert.equal(graph.nodes.get(CONSTRUCTOR).unconnected_item_inputs, 0);
  assert.equal(graph.nodes.get(SMELTER).unconnected_item_outputs, 0);
});

test("falls back to path trimming when the peer component was not emitted", () => {
  const snapshot = buildFactorySnapshot();
  const miner = snapshot.actors.find((actor) => actor.actor_id === MINER);
  miner.connections[0].connected_component = `${BELT_ORE}.SomeComponentNotEmitted`;
  const graph = buildGraph(snapshot);
  assert.deepEqual(graph.unresolvedConnections, []);
  assert.equal(graph.nodes.get(MINER).item_outputs[0].peer_actor_id, BELT_ORE);
});

test("records a peer outside the snapshot as unresolved rather than guessing", () => {
  const snapshot = buildFactorySnapshot();
  const miner = snapshot.actors.find((actor) => actor.actor_id === MINER);
  miner.connections[0].connected_component = "/Game/FactoryMap.FactoryMap:PersistentLevel.Build_Absent_C_9.Input0";
  const graph = buildGraph(snapshot);
  assert.equal(graph.unresolvedConnections.length, 1);
  assert.equal(graph.unresolvedConnections[0].reason, "peer_actor_not_present_in_snapshot");
  assert.equal(graph.nodes.get(MINER).item_outputs.length, 0);
});

test("converts conveyor speed to items per minute and reports the raw value", () => {
  const graph = buildGraph(buildFactorySnapshot());
  const belt = graph.nodes.get(BELT_ORE).conveyor;
  assert.equal(belt.reported_speed, 120);
  assert.equal(belt.items_per_minute, 60);
  assert.equal(belt.certainty, "calculated_from_convention");
  assert.equal(graph.nodes.get(BELT_INGOT).conveyor.items_per_minute, 20);
});

test("honours a configured conveyor speed divisor", () => {
  const graph = buildGraph(buildFactorySnapshot(), { conveyorSpeedDivisor: 4 });
  assert.equal(graph.nodes.get(BELT_ORE).conveyor.items_per_minute, 30);
});

test("converts pipeline flow limit to cubic metres per minute", () => {
  const graph = buildGraph(buildFactorySnapshot());
  const pipe = graph.nodes.get(PIPELINE).pipeline;
  assert.equal(pipe.reported_flow_limit_cubic_meters_per_second, 5);
  assert.equal(pipe.cubic_meters_per_minute, 300);
});

test("indexes power circuits with their members", () => {
  const graph = buildGraph(buildFactorySnapshot());
  assert.equal(graph.circuits.size, 2);
  assert.deepEqual(graph.circuits.get(2).member_actor_ids.sort(), [MINER, REFINERY, SMELTER].sort());
  assert.equal(graph.nodes.get(CONSTRUCTOR).power_circuit_id, 1);
});

test("traces through conveyor chains to the machine at each end", () => {
  const graph = buildGraph(buildFactorySnapshot());

  const upstream = traceUpstream(graph, SMELTER, "item");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].endpoint_actor_id, MINER);
  assert.deepEqual(upstream[0].via_transport_actor_ids, [BELT_ORE]);
  assert.equal(upstream[0].limiting_items_per_minute, 60);

  const downstream = traceDownstream(graph, SMELTER, "item");
  assert.equal(downstream.length, 1);
  assert.equal(downstream[0].endpoint_actor_id, CONSTRUCTOR);
  assert.equal(downstream[0].limiting_items_per_minute, 20);
});

test("reports the narrowest segment across a multi-belt path", () => {
  const snapshot = buildFactorySnapshot();
  const extraBelt = `/Game/FactoryMap.FactoryMap:PersistentLevel.Build_ConveyorBeltMk1_C_3`;
  const beltIngot = snapshot.actors.find((actor) => actor.actor_id === BELT_INGOT);
  beltIngot.connections[1].connected_component = `${extraBelt}.ConnectionAny0`;
  snapshot.actors.push({
    actor_id: extraBelt,
    name: "Build_ConveyorBeltMk1_C_3",
    class_path: "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
    owner_mod: "FactoryGame",
    kind: "buildable",
    location: { x: 1400, y: 0, z: 0 },
    connections: [
      {
        kind: "factory",
        component: `${extraBelt}.ConnectionAny0`,
        direction: "FCD_INPUT",
        connected: true,
        connected_component: `${BELT_INGOT}.ConnectionAny1`,
      },
      {
        kind: "factory",
        component: `${extraBelt}.ConnectionAny1`,
        direction: "FCD_OUTPUT",
        connected: true,
        connected_component: `${CONSTRUCTOR}.InputConnection0`,
      },
    ],
    inventories: [],
    transport: { kind: "conveyor", reported_speed: 600, reported_length: 300, available_space: 8, items_on_segment: 1 },
  });

  const graph = buildGraph(snapshot);
  const downstream = traceDownstream(graph, SMELTER, "item");
  assert.equal(downstream[0].endpoint_actor_id, CONSTRUCTOR);
  assert.deepEqual(downstream[0].via_transport_actor_ids, [BELT_INGOT, extraBelt]);
  assert.equal(downstream[0].limiting_items_per_minute, 20);
});

test("terminates traversal on a cyclic belt loop", () => {
  const snapshot = buildFactorySnapshot();
  const beltOre = snapshot.actors.find((actor) => actor.actor_id === BELT_ORE);
  const beltIngot = snapshot.actors.find((actor) => actor.actor_id === BELT_INGOT);
  beltOre.connections[1].connected_component = `${BELT_INGOT}.ConnectionAny0`;
  beltIngot.connections[1].connected_component = `${BELT_ORE}.ConnectionAny0`;

  const graph = buildGraph(snapshot);
  const downstream = traceDownstream(graph, MINER, "item");
  assert.ok(downstream.some((hop) => hop.terminated === "transport_cycle_detected"));
  assert.ok(downstream.every((hop) => hop.terminated !== undefined));
});

test("handles an empty snapshot without throwing", () => {
  const graph = buildGraph({});
  assert.equal(graph.nodes.size, 0);
  assert.equal(graph.circuits.size, 0);
  assert.deepEqual(traceDownstream(graph, "missing", "item"), []);
});
