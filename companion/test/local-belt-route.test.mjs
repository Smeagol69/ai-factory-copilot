import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import {
  answerLocally,
  parseBeltCandidateListRequest,
  parseNearestCompatibleBeltRequest,
  parseTemporaryFreeBeltTestRequest,
} from "../lib/router.mjs";
import {
  solveCompatibleBeltCandidates,
  solveNearestCompatibleBeltRoute,
  solveTemporaryFreeBeltRoute,
} from "../lib/routing.mjs";

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

test("lists every proven compatible free pair without including a closer incompatible target", () => {
  const result = solveCompatibleBeltCandidates(graphOf(), { limit: 100 });

  assert.equal(result.candidate_count, 1);
  assert.equal(result.returned_candidate_count, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.candidates[0].from.actor_id, "Source");
  assert.equal(result.candidates[0].to.actor_id, "RightTarget");
  assert.deepEqual(result.candidates[0].compatible_items, ["Iron Ingot"]);
  assert.match(result.unverified, /game's conveyor hologram/);
});

test("the observed candidate-list request is answered locally and never emits an action", () => {
  const question =
    "Using plan_belt_route and the live snapshot only, list every pair of my existing machines whose conveyor connectors are free and could be belted together. Do not build or change anything.";
  assert.deepEqual(parseBeltCandidateListRequest(question), {
    radius_m: null,
    limit: 100,
    compatibility: "any",
  });

  const emitted = [];
  const answer = answerLocally(question, graphOf(), {
    actions: { emit: (actions) => emitted.push(...actions) },
  });
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "find_belt_candidates");
  assert.match(answer.reply, /2 geometrically routable free belt pair/);
  assert.match(answer.reply, /proven 1, incompatible 1, unknown 0/);
  assert.match(answer.reply, /compatibility \*\*proven\*\*/);
  assert.match(answer.reply, /compatibility \*\*incompatible\*\*/);
  assert.match(answer.reply, /Source\.Output0/);
  assert.match(answer.reply, /RightTarget\.Input0/);
  assert.deepEqual(emitted, []);
});

test("a compatible-pair census keeps the safe proven-only default", () => {
  assert.deepEqual(
    parseBeltCandidateListRequest("list all recipe-compatible pairs with free conveyor ports"),
    { radius_m: null, limit: 100, compatibility: "proven" },
  );
  const result = solveCompatibleBeltCandidates(graphOf(), { compatibility: "proven" });
  assert.deepEqual(result.candidates.map((candidate) => candidate.compatibility), ["proven"]);
});

test("the physical census labels missing recipe evidence unknown instead of compatible", () => {
  const graph = graphOf();
  graph.nodes.get("RightTarget").recipe_class = null;
  graph.nodes.get("RightTarget").raw.manufacturer.recipe_class = "";

  const result = solveCompatibleBeltCandidates(graph, { compatibility: "any" });
  const unknown = result.candidates.find((candidate) => candidate.to.actor_id === "RightTarget");
  assert.equal(unknown.compatibility, "unknown");
  assert.deepEqual(unknown.missing_compatibility_evidence, ["target_current_recipe"]);
});

test("candidate listing reports limit truncation instead of hiding omitted pairs", () => {
  const graph = graphOf();
  const secondTarget = structuredClone(graph.nodes.get("RightTarget").raw);
  secondTarget.actor_id = "SecondTarget";
  secondTarget.name = "Second Iron Target";
  secondTarget.location = { x: 3_000, y: 0, z: 0 };
  secondTarget.connections[0].component = "SecondTarget.Input0";
  secondTarget.connections[0].location = { x: 2_900, y: 0, z: 100 };
  graph.nodes.set("SecondTarget", buildGraph({ actors: [secondTarget] }).nodes.get("SecondTarget"));

  const result = solveCompatibleBeltCandidates(graph, { limit: 1 });
  assert.equal(result.candidate_count, 2);
  assert.equal(result.returned_candidate_count, 1);
  assert.equal(result.truncated, true);
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

test("the temporary test route permits unknown compatibility but never proven incompatibility", () => {
  const graph = graphOf();
  graph.nodes.get("RightTarget").recipe_class = null;
  graph.nodes.get("RightTarget").raw.manufacturer.recipe_class = "";

  const route = solveTemporaryFreeBeltRoute(graph, { radius_m: 5_000 });
  assert.equal(route.routed, true);
  assert.equal(route.from.actor_id, "Source");
  assert.equal(route.to.actor_id, "RightTarget");
  assert.equal(route.compatibility, "unknown");
  assert.deepEqual(route.missing_compatibility_evidence, ["target_current_recipe"]);

  graph.nodes.delete("RightTarget");
  const refused = solveTemporaryFreeBeltRoute(graph, { radius_m: 5_000 });
  assert.equal(refused.routed, false);
  assert.ok(refused.proven_incompatible_pairs_refused > 0);
});

test("only an explicit temporary live-test phrase can use unknown compatibility", () => {
  const phrase =
    "temporarily connect the nearest free output to the nearest free input within 5000m using a mk1 belt for a live belt test";
  assert.deepEqual(parseTemporaryFreeBeltTestRequest(phrase), { radius_m: 5_000 });
  assert.equal(
    parseTemporaryFreeBeltTestRequest(
      "connect the nearest free output to the nearest free input using a mk1 belt",
    ),
    null,
  );

  const graph = graphOf();
  graph.nodes.get("RightTarget").recipe_class = null;
  graph.nodes.get("RightTarget").raw.manufacturer.recipe_class = "";
  const emitted = [];
  const answer = answerLocally(phrase, graph, {
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.equal(answer.local.solver, "place_belt_live_test");
  assert.match(answer.reply, /compatibility is \*\*unknown\*\*/i);
  assert.match(answer.reply, /say "undo"/i);
  assert.equal(emitted[0].action, "place_belt");
  assert.equal(emitted[0].from_component, "Source.Output0");
  assert.equal(emitted[0].to_component, "RightTarget.Input0");
  assert.equal(emitted[0].expect_world_revision, "73");
});
