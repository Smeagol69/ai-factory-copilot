/**
 * Belt routing.
 *
 * The fixture mirrors what the scanner actually emits for a factory connection
 * — `kind: "factory"`, an `FCD_*` direction, a world `location`, an outward
 * `normal`, and `connected` — so a passing test here means the same shape works
 * against a live snapshot.
 *
 * Geometry: the miner's output faces +X at x=1000, the smelter sits 20 m along
 * +X with its input facing back at -X. That is the straight case. The
 * constructor after it is deliberately turned the wrong way.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { solveBeltChain, solveBeltRoute } from "../lib/routing.mjs";

const connection = (overrides) => ({
  kind: "factory",
  connected: false,
  connected_component: "",
  inventory_access_index: 0,
  ...overrides,
});

const snapshot = {
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [
    {
      actor_id: "Build_MinerMk1_C_1",
      name: "Build_MinerMk1_C_1",
      kind: "buildable",
      location: { x: 0, y: 0, z: 0 },
      connections: [
        connection({
          component: "Miner.Output0",
          direction: "FCD_OUTPUT",
          location: { x: 1_000, y: 0, z: 100 },
          normal: { x: 1, y: 0, z: 0 },
        }),
      ],
    },
    {
      actor_id: "Build_SmelterMk1_C_1",
      name: "Build_SmelterMk1_C_1",
      kind: "buildable",
      location: { x: 3_000, y: 0, z: 0 },
      connections: [
        connection({
          component: "Smelter.Input0",
          direction: "FCD_INPUT",
          location: { x: 3_000, y: 0, z: 100 },
          normal: { x: -1, y: 0, z: 0 },
        }),
        connection({
          component: "Smelter.Output0",
          direction: "FCD_OUTPUT",
          location: { x: 3_600, y: 0, z: 100 },
          normal: { x: 1, y: 0, z: 0 },
        }),
      ],
    },
    {
      // Turned the wrong way: its input faces +X, away from the smelter.
      actor_id: "Build_ConstructorMk1_C_1",
      name: "Build_ConstructorMk1_C_1",
      kind: "buildable",
      location: { x: 5_000, y: 0, z: 0 },
      connections: [
        connection({
          component: "Constructor.Input0",
          direction: "FCD_INPUT",
          location: { x: 5_000, y: 0, z: 100 },
          normal: { x: 1, y: 0, z: 0 },
        }),
      ],
    },
    {
      actor_id: "Build_StorageContainer_C_1",
      name: "Build_StorageContainer_C_1",
      kind: "buildable",
      location: { x: 8_000, y: 0, z: 0 },
      connections: [
        connection({
          component: "Storage.Input0",
          direction: "FCD_INPUT",
          location: { x: 8_000, y: 0, z: 100 },
          normal: { x: -1, y: 0, z: 0 },
          connected: true,
          connected_component: "SomethingElse.Output0",
        }),
      ],
    },
  ],
};

const graph = buildGraph(snapshot);

test("routes a straight belt between two connectors that face each other", () => {
  const route = solveBeltRoute(graph, {
    from_actor_id: "Build_MinerMk1_C_1",
    to_actor_id: "Build_SmelterMk1_C_1",
  });

  assert.equal(route.routed, true);
  assert.equal(route.from.connector, "Miner.Output0");
  assert.equal(route.to.connector, "Smelter.Input0");
  assert.deepEqual(route.start_cm, { x: 1_000, y: 0, z: 100 });
  assert.deepEqual(route.end_cm, { x: 3_000, y: 0, z: 100 });
  assert.equal(route.length_meters, 20);
  assert.equal(route.straight, true);
  assert.equal(route.alignment.output, 1);
  assert.equal(route.alignment.input, 1);
});

test("never claims a maximum length or a clear path — both are the game's call", () => {
  const route = solveBeltRoute(graph, {
    from_actor_id: "Build_MinerMk1_C_1",
    to_actor_id: "Build_SmelterMk1_C_1",
  });
  assert.match(route.unverified, /hologram/);
  // A hardcoded limit here would go stale the moment a belt tier changes.
  assert.equal(route.max_length_cm, undefined);
});

test("reports a bend rather than pretending the belt is straight", () => {
  const route = solveBeltRoute(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_id: "Build_ConstructorMk1_C_1",
  });

  assert.equal(route.routed, true);
  assert.equal(route.straight, false);
  // The constructor's input faces away, so the belt must come round it.
  assert.ok(route.alignment.input < 0, `expected a negative input alignment, got ${route.alignment.input}`);
  assert.ok(route.notes.some((note) => /bend|loop around/.test(note)));
});

test("an occupied port is a different problem from a missing one, and says so", () => {
  const route = solveBeltRoute(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_id: "Build_StorageContainer_C_1",
  });
  assert.equal(route.routed, false);
  assert.match(route.reason, /already connected/);
  assert.deepEqual(route.occupied_inputs, ["SomethingElse.Output0"]);
});

test("a machine with no conveyor output is refused by name", () => {
  const route = solveBeltRoute(graph, {
    from_actor_id: "Build_ConstructorMk1_C_1",
    to_actor_id: "Build_SmelterMk1_C_1",
  });
  assert.equal(route.routed, false);
  assert.match(route.reason, /no conveyor output/);
});

test("refuses the malformed requests instead of routing something arbitrary", () => {
  assert.match(solveBeltRoute(graph, {}).reason, /from_actor_id and to_actor_id/);
  assert.match(
    solveBeltRoute(graph, { from_actor_id: "Build_MinerMk1_C_1", to_actor_id: "Build_MinerMk1_C_1" }).reason,
    /two different machines/,
  );
  assert.match(
    solveBeltRoute(graph, { from_actor_id: "Build_MinerMk1_C_1", to_actor_id: "Build_Nope_C_9" }).reason,
    /no actor in the snapshot matches/,
  );
});

test("routes a whole chain in flow order and totals it", () => {
  const chain = solveBeltChain(graph, {
    actor_ids: ["Build_MinerMk1_C_1", "Build_SmelterMk1_C_1", "Build_ConstructorMk1_C_1"],
  });

  assert.equal(chain.legs.length, 2);
  assert.equal(chain.routed, true);
  assert.equal(chain.total_length_meters, 34);
});

test("a broken leg does not discard the legs that did route", () => {
  const chain = solveBeltChain(graph, {
    actor_ids: ["Build_MinerMk1_C_1", "Build_SmelterMk1_C_1", "Build_StorageContainer_C_1"],
  });

  assert.equal(chain.routed, false);
  assert.equal(chain.legs[0].routed, true, "the miner->smelter leg still routes");
  assert.deepEqual(chain.failed_legs, [{ leg: 2, reason: chain.legs[1].reason }]);
});

/* ---------------- learning connector positions, and planning a module ---------------- */

import { measureConnectors, planBeltedModule } from "../lib/routing.mjs";

test("learns a building's connector offsets from the player's own machines", () => {
  // The smelter sits at x=3000 with no rotation, its input at x=3000 and its
  // output at x=3600 — so the local offsets are 0 and +600 along X.
  const measured = measureConnectors(graph, undefined);
  assert.equal(measured, null, "an unknown class has no example to learn from");

  const withClass = buildGraph({
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    actors: [
      {
        actor_id: "Build_SmelterMk1_C_9",
        name: "Build_SmelterMk1_C_9",
        kind: "buildable",
        class_path: "/Game/Build_SmelterMk1.Build_SmelterMk1_C",
        location: { x: 1_000, y: 500, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        connections: [
          connection({
            component: "In",
            direction: "FCD_INPUT",
            location: { x: 1_000, y: 500, z: 100 },
            normal: { x: -1, y: 0, z: 0 },
          }),
          connection({
            component: "Out",
            direction: "FCD_OUTPUT",
            location: { x: 1_600, y: 500, z: 100 },
            normal: { x: 1, y: 0, z: 0 },
          }),
        ],
      },
    ],
  });

  const offsets = measureConnectors(withClass, "/Game/Build_SmelterMk1.Build_SmelterMk1_C");
  assert.equal(offsets.measured_from, 1);
  assert.deepEqual(offsets.inputs, [{ x: 0, y: 0, z: 100 }]);
  assert.deepEqual(offsets.outputs, [{ x: 600, y: 0, z: 100 }]);
  // Same rule as footprints: it is measured, not tabulated.
  assert.match(offsets.source, /measured_from_your_own_buildings/);
});

test("a module plan is two-phase, and says why", () => {
  const plan = planBeltedModule(graph, {
    anchor_actor_id: "Build_MinerMk1_C_1",
    chain: ["/Game/Build_MinerMk1.Build_MinerMk1_C", "/Game/Build_SmelterMk1.Build_SmelterMk1_C"],
  });

  assert.equal(plan.planned, true);
  assert.equal(plan.steps.length, 2);
  // The first machine sits on the node itself; a miner has to.
  assert.equal(plan.steps[0].on_the_node, true);
  assert.equal(plan.belt_legs.length, 1);
  assert.equal(plan.belt_legs[0].route_after_placement, true);
  assert.match(plan.how_to_build, /connector only exists once its machine does/);
});

test("a module plan names the buildings it has never seen rather than guessing their spacing", () => {
  const plan = planBeltedModule(graph, {
    anchor_actor_id: "Build_MinerMk1_C_1",
    chain: ["/Game/Never_Seen.Never_Seen_C"],
  });
  assert.deepEqual(plan.unmeasured_buildings, ["/Game/Never_Seen.Never_Seen_C"]);
  assert.match(plan.unverified, /connector positions are unknown/);
  assert.equal(plan.steps[0].connectors_known, false);
});

test("a module refuses a hand-mined deposit, which cannot host a miner", () => {
  const depositGraph = buildGraph({
    world: { scan_center: { x: 0, y: 0, z: 0 } },
    actors: [
      {
        actor_id: "BP_ResourceDeposit9",
        name: "BP_ResourceDeposit9",
        kind: "resource_node",
        node_type: "Deposit",
        location: { x: 0, y: 0, z: 0 },
      },
    ],
  });
  const plan = planBeltedModule(depositGraph, {
    anchor_actor_id: "BP_ResourceDeposit9",
    chain: ["/Game/Build_MinerMk1.Build_MinerMk1_C"],
  });
  assert.equal(plan.planned, false);
  assert.match(plan.reason, /hand-mined deposit/);
});

test("a module needs an anchor and a chain, and says which is missing", () => {
  assert.match(planBeltedModule(graph, { chain: ["x"] }).reason, /anchor_actor_id/);
  assert.match(planBeltedModule(graph, { anchor_actor_id: "Build_MinerMk1_C_1" }).reason, /chain of buildings/);
});
