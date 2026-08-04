/**
 * Splitting one output across several machines.
 *
 * The owner asked for "a miner belted into a smelter belting into the next
 * thing then splitted". The linear part is planBeltedModule; this is the
 * fan-out, which needs a splitter positioned between one producer and several
 * consumers.
 *
 * The rule this file mostly exists to protect: how many outputs a splitter has
 * is measured off one the player owns, and when they own none the plan says the
 * number is assumed rather than stating it as fact.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { planSplitterFanOut } from "../lib/routing.mjs";

const connection = (overrides) => ({
  kind: "factory",
  connected: false,
  connected_component: "",
  ...overrides,
});

const SPLITTER_CLASS = "/Game/FactoryGame/Buildable/Factory/Splitter/Build_ConveyorAttachmentSplitter.Build_ConveyorAttachmentSplitter_C";

const machine = (name, x, y, extra = {}) => ({
  actor_id: name,
  name,
  kind: "buildable",
  location: { x, y, z: 0 },
  rotation: { pitch: 0, yaw: 0, roll: 0 },
  ...extra,
});

const base = {
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [
    machine("Build_SmelterMk1_C_1", 0, 0, {
      connections: [
        connection({ component: "Smelter.Output0", direction: "FCD_OUTPUT", location: { x: 500, y: 0, z: 100 }, normal: { x: 1, y: 0, z: 0 } }),
      ],
    }),
    machine("Build_ConstructorMk1_C_1", 3000, -800, {
      connections: [
        connection({ component: "C1.Input0", direction: "FCD_INPUT", location: { x: 3000, y: -800, z: 100 }, normal: { x: -1, y: 0, z: 0 } }),
      ],
    }),
    machine("Build_ConstructorMk1_C_2", 3000, 800, {
      connections: [
        connection({ component: "C2.Input0", direction: "FCD_INPUT", location: { x: 3000, y: 800, z: 100 }, normal: { x: -1, y: 0, z: 0 } }),
      ],
    }),
    machine("Build_StorageContainer_C_1", 4000, 0, {
      connections: [
        connection({ component: "S1.Input0", direction: "FCD_INPUT", location: { x: 4000, y: 0, z: 100 }, normal: { x: -1, y: 0, z: 0 }, connected: true, connected_component: "Other.Output0" }),
      ],
    }),
  ],
};

const graph = buildGraph(base);

test("places the splitter between the source and the consumers it feeds", () => {
  const plan = planSplitterFanOut(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2"],
  });

  assert.equal(plan.planned, true, JSON.stringify(plan));
  assert.equal(plan.legs.length, 2);
  assert.equal(plan.feed.from_connector, "Smelter.Output0");
  // Consumers sit symmetrically about y=0, so the splitter stays on that axis
  // and ahead of the source output at x=500.
  assert.equal(plan.splitter.location_cm.y, 0);
  assert.ok(plan.splitter.location_cm.x > 500, "splitter must sit beyond the source connector");
  assert.equal(plan.splitters_needed, 1);
});

test("says the output count is assumed when the player owns no splitter", () => {
  const plan = planSplitterFanOut(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2"],
  });
  assert.equal(plan.splitter.outputs_source, "assumed_standard_three");
  assert.ok(plan.notes.some((note) => /could not be measured/.test(note)));
});

test("measures the real output count off a splitter the player already owns", () => {
  const owned = buildGraph({
    ...base,
    actors: [
      ...base.actors,
      {
        ...machine("Build_Splitter_C_9", 9000, 9000),
        class_path: SPLITTER_CLASS,
        connections: [
          connection({ component: "Sp.In0", direction: "FCD_INPUT", location: { x: 8900, y: 9000, z: 0 }, normal: { x: -1, y: 0, z: 0 } }),
          connection({ component: "Sp.Out0", direction: "FCD_OUTPUT", location: { x: 9100, y: 9000, z: 0 }, normal: { x: 1, y: 0, z: 0 } }),
          connection({ component: "Sp.Out1", direction: "FCD_OUTPUT", location: { x: 9000, y: 9100, z: 0 }, normal: { x: 0, y: 1, z: 0 } }),
          connection({ component: "Sp.Out2", direction: "FCD_OUTPUT", location: { x: 9000, y: 8900, z: 0 }, normal: { x: 0, y: -1, z: 0 } }),
        ],
      },
    ],
  });

  const plan = planSplitterFanOut(owned, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2"],
    splitter_class_path: SPLITTER_CLASS,
  });

  assert.equal(plan.splitter.outputs_source, "measured_from_your_own_splitter");
  assert.equal(plan.splitter.outputs_available, 3);
  assert.ok(!plan.notes.some((note) => /could not be measured/.test(note)));
});

test("a consumer that cannot take a belt is named, not silently dropped", () => {
  const plan = planSplitterFanOut(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2", "Build_StorageContainer_C_1"],
  });

  assert.equal(plan.planned, true);
  assert.equal(plan.legs.length, 2, "the occupied storage input is not a leg");
  assert.equal(plan.unusable.length, 1);
  assert.match(plan.unusable[0].reason, /already connected/);
});

test("more consumers than outputs reports the chaining it needs", () => {
  const many = buildGraph({
    ...base,
    actors: [
      ...base.actors,
      ...[1, 2].map((n) =>
        machine(`Build_Extra_C_${n}`, 3000, 1600 + n * 400, {
          connections: [
            connection({ component: `E${n}.Input0`, direction: "FCD_INPUT", location: { x: 3000, y: 1600 + n * 400, z: 100 }, normal: { x: -1, y: 0, z: 0 } }),
          ],
        }),
      ),
    ],
  });

  const plan = planSplitterFanOut(many, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2", "Build_Extra_C_1", "Build_Extra_C_2"],
  });

  assert.equal(plan.legs.length, 4);
  assert.equal(plan.splitters_needed, 2);
  assert.ok(plan.notes.some((note) => /chaining|second splitter/.test(note)));
});

test("refuses the cases where a splitter is the wrong answer", () => {
  assert.match(planSplitterFanOut(graph, {}).reason, /from_actor_id/);
  assert.match(
    planSplitterFanOut(graph, { from_actor_id: "Build_SmelterMk1_C_1", to_actor_ids: ["Build_ConstructorMk1_C_1"] }).reason,
    /one consumer needs a belt, not a splitter/,
  );
  assert.match(
    planSplitterFanOut(graph, { from_actor_id: "Build_Nope", to_actor_ids: ["a", "b"] }).reason,
    /no actor matches/,
  );
});

test("never claims the plan will fit — the game decides that", () => {
  const plan = planSplitterFanOut(graph, {
    from_actor_id: "Build_SmelterMk1_C_1",
    to_actor_ids: ["Build_ConstructorMk1_C_1", "Build_ConstructorMk1_C_2"],
  });
  assert.match(plan.unverified, /hologram/);
});
