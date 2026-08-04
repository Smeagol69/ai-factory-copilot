/**
 * "belt the smelter to the constructor".
 *
 * The planner and the write action both existed and nothing joined them: the
 * only way to actually build a belt was to ask a model, which is the least
 * reliable path in the system and the one that fails when credit runs out.
 *
 * Every part is deterministic — resolve two machines, let solveBeltRoute pick
 * the connector pair, resolve the recipe from the game's own catalog, emit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { answerLocally, parseBeltRequest } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";

const connection = (overrides) => ({ kind: "factory", connected: false, connected_component: "", ...overrides });

const graph = buildGraph({
  world_revision: 31,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  content: {
    items: [],
    recipes: [
      {
        class_path: "/Game/Recipes/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C",
        name: "Conveyor Belt Mk.1",
        available: true,
        produced_in: ["/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C"],
        products: [{ item_class: "/Game/Desc_ConveyorBeltMk1.Desc_ConveyorBeltMk1_C", item_name: "Conveyor Belt Mk.1", amount: 1 }],
      },
    ],
  },
  actors: [
    {
      actor_id: "Build_SmelterMk1_C_1",
      name: "Build_SmelterMk1_C_1",
      kind: "buildable",
      location: { x: 0, y: 0, z: 0 },
      connections: [
        connection({ component: "Sm.Output0", direction: "FCD_OUTPUT", location: { x: 500, y: 0, z: 100 }, normal: { x: 1, y: 0, z: 0 } }),
      ],
    },
    {
      actor_id: "Build_ConstructorMk1_C_1",
      name: "Build_ConstructorMk1_C_1",
      kind: "buildable",
      location: { x: 2_000, y: 0, z: 0 },
      connections: [
        connection({ component: "Co.Input0", direction: "FCD_INPUT", location: { x: 2_000, y: 0, z: 100 }, normal: { x: -1, y: 0, z: 0 } }),
      ],
    },
    {
      actor_id: "Build_Full_C_1",
      name: "Build_Full_C_1",
      kind: "buildable",
      location: { x: 5_000, y: 0, z: 0 },
      connections: [
        connection({ component: "Fu.Input0", direction: "FCD_INPUT", location: { x: 5_000, y: 0, z: 100 }, normal: { x: -1, y: 0, z: 0 }, connected: true, connected_component: "Other.Out" }),
      ],
    },
  ],
});

test("parses the phrasings, and refuses a chain it would have to guess at", () => {
  assert.equal(parseBeltRequest("belt the smelter to the constructor").from.name_contains, "smelter");
  assert.equal(parseBeltRequest("connect A_1 to B_2 with a mk2 belt").belt_name, "mk2 belt");
  // Three endpoints is a chain, a different request with different failures.
  assert.equal(parseBeltRequest("belt a to b and c"), null);
  assert.equal(parseBeltRequest("teleport me to the hub"), null);
});

test("builds the belt locally, with both endpoints resolved from captured data", () => {
  const emitted = [];
  const answer = answerLocally("belt Build_SmelterMk1_C_1 to Build_ConstructorMk1_C_1", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.provider, "solvers", "must not need a model");
  assert.equal(answer.local.solver, "place_belt");
  assert.equal(emitted.length, 1);
  const [action] = emitted;
  assert.equal(action.action, "place_belt");
  assert.equal(action.from_component, "Sm.Output0");
  assert.equal(action.to_component, "Co.Input0");
  assert.equal(action.commit, true);
  assert.equal(action.expect_world_revision, "31");
});

test("never claims the belt will fit — that is the hologram's call", () => {
  const answer = answerLocally("belt Build_SmelterMk1_C_1 to Build_ConstructorMk1_C_1", graph, {
    actions: { emit: () => {} },
  });
  assert.match(answer.reply, /hologram decides length, bend radius and clearance/);
});

test("an occupied port is refused locally, with the reason, instead of being built", () => {
  const emitted = [];
  const answer = answerLocally("belt Build_SmelterMk1_C_1 to Build_Full_C_1", graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.local.solver, "place_belt_refused");
  assert.match(answer.reply, /already connected/);
  assert.equal(emitted.length, 0, "a refused route must not emit a build");
});
