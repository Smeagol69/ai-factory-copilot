import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import {
  answerLocally,
  parseNearestCompatibleBeltRequest,
} from "../lib/router.mjs";
import { solveNearestCompatibleBeltRoute } from "../lib/routing.mjs";

const BELT =
  "/Game/FactoryGame/Recipes/Buildings/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C";

function connection(component, direction, location, normal) {
  return {
    component,
    kind: "factory",
    direction,
    location,
    normal,
    connected: false,
    connected_component: "",
  };
}

function graphOf({ availabilityKnown = true, beltAvailable = true } = {}) {
  return buildGraph({
    data_policy: "authoritative_or_explicitly_unknown",
    world_revision: 73,
    interaction_context: {
      player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } },
    },
    content: {
      availability_known: availabilityKnown,
      items: [
        { class_path: "Desc_IronIngot", name: "Iron Ingot" },
        { class_path: "Desc_CopperIngot", name: "Copper Ingot" },
      ],
      recipes: [
        {
          class_path: BELT,
          name: "Conveyor Belt Mk.1",
          available: beltAvailable,
          ingredients: [],
          products: [],
        },
        {
          class_path: "Recipe_SourceIron",
          name: "Iron source",
          available: true,
          ingredients: [],
          products: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 1 }],
        },
        {
          class_path: "Recipe_TargetIron",
          name: "Iron target",
          available: true,
          ingredients: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 1 }],
          products: [],
        },
        {
          class_path: "Recipe_TargetCopper",
          name: "Copper target",
          available: true,
          ingredients: [{ item_class: "Desc_CopperIngot", item_name: "Copper Ingot", amount: 1 }],
          products: [],
        },
      ],
    },
    actors: [
      {
        actor_id: "Source",
        name: "Iron Source",
        kind: "buildable",
        location: { x: 1_000, y: 0, z: 0 },
        manufacturer: { recipe_class: "Recipe_SourceIron", recipe_name: "Iron source" },
        connections: [
          connection("Source.Output0", "FCD_OUTPUT", { x: 1_100, y: 0, z: 100 }, { x: 1, y: 0, z: 0 }),
        ],
      },
      {
        // Closer, but accepting Copper makes it incompatible with Source.
        actor_id: "WrongTarget",
        name: "Copper Target",
        kind: "buildable",
        location: { x: 1_500, y: 0, z: 0 },
        manufacturer: { recipe_class: "Recipe_TargetCopper", recipe_name: "Copper target" },
        connections: [
          connection("WrongTarget.Input0", "FCD_INPUT", { x: 1_400, y: 0, z: 100 }, { x: -1, y: 0, z: 0 }),
        ],
      },
      {
        actor_id: "RightTarget",
        name: "Iron Target",
        kind: "buildable",
        location: { x: 2_000, y: 0, z: 0 },
        manufacturer: { recipe_class: "Recipe_TargetIron", recipe_name: "Iron target" },
        connections: [
          connection("RightTarget.Input0", "FCD_INPUT", { x: 1_900, y: 0, z: 100 }, { x: -1, y: 0, z: 0 }),
        ],
      },
    ],
  });
}

test("the nearest belt route requires recipe compatibility, not merely adjacent ports", () => {
  const route = solveNearestCompatibleBeltRoute(graphOf(), { radius_m: 100 });

  assert.equal(route.routed, true);
  assert.equal(route.from.actor_id, "Source");
  assert.equal(route.to.actor_id, "RightTarget");
  assert.deepEqual(route.compatible_item_classes, ["Desc_IronIngot"]);
  assert.deepEqual(route.compatible_items, ["Iron Ingot"]);
  assert.equal(route.from.connector, "Source.Output0");
  assert.equal(route.to.connector, "RightTarget.Input0");
});

test("the local phrase is strict about compatibility and the requested belt tier", () => {
  assert.deepEqual(
    parseNearestCompatibleBeltRequest(
      "connect the nearest compatible unconnected production machines near me with a mk1 belt",
    ),
    { radius_m: 100 },
  );
  assert.deepEqual(
    parseNearestCompatibleBeltRequest(
      "connect the closest recipe-compatible machine pair within 250m using a Mk. 1 conveyor belt",
    ),
    { radius_m: 250 },
  );
  assert.equal(
    parseNearestCompatibleBeltRequest("connect the nearest machines with a belt"),
    null,
    "an unspecified compatibility rule or tier belongs to the model",
  );
});

test("the free local route emits exact component paths and a revision-stamped write", () => {
  const emitted = [];
  const answer = answerLocally(
    "connect the nearest compatible unconnected production machines near me with a mk1 belt",
    graphOf(),
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "place_belt");
  assert.deepEqual(emitted, [
    {
      action: "place_belt",
      recipe_class: BELT,
      from_component: "Source.Output0",
      to_component: "RightTarget.Input0",
      commit: true,
      expect_world_revision: "73",
      require_unchanged_world: false,
    },
  ]);
  assert.match(answer.reply, /Iron Ingot/);
  assert.match(answer.reply, /game hologram/i);
});

test("an unproven belt unlock refuses locally and emits nothing", () => {
  const emitted = [];
  const answer = answerLocally(
    "connect the nearest compatible unconnected production machines near me with a mk1 belt",
    graphOf({ availabilityKnown: false }),
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "place_belt");
  assert.match(answer.reply, /did not place/i);
  assert.deepEqual(emitted, []);
});

test("no compatible free pair is a deterministic refusal, not a model guess", () => {
  const graph = graphOf();
  graph.nodes.get("RightTarget").raw.connections[0].connected = true;
  graph.nodes.get("RightTarget").raw.connections[0].connected_component = "Existing.Output";
  const emitted = [];
  const answer = answerLocally(
    "connect the nearest compatible unconnected production machines near me with a mk1 belt",
    graph,
    { actions: { emit: (actions) => emitted.push(...actions) } },
  );

  assert.match(answer.reply, /did not place/i);
  assert.match(answer.reply, /No endpoint or item compatibility was guessed/);
  assert.deepEqual(emitted, []);
});
