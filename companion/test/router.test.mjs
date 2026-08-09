import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  answerLocally,
  describePlanRejection,
  parseAimedMk1FactoryRequest,
  parseClearRequest,
  parseExactBeltSolverRequest,
  parseBlueprintListRequest,
  parseShowRequest,
  parseStructureRequest,
  routeQuestion,
} from "../lib/router.mjs";
import { buildFactorySnapshot, MINER, SMELTER } from "./fixtures/factory.mjs";

const graphOf = () => buildGraph(buildFactorySnapshot());

test("parses only an explicit aimed Mk.1 factory write", () => {
  for (const question of [
    "build a wire factory using all mk1 parts on this node",
    "please construct me a Wire factory using Mk.1 parts from this node",
  ]) {
    assert.equal(parseAimedMk1FactoryRequest(question)?.item.toLowerCase(), "wire", question);
  }
  for (const question of [
    "build a wire factory on this node",
    "build a wire factory using mk2 parts on this node",
    "design a wire factory using mk1 parts on this node",
    "build a wire factory using mk1 parts here",
    "build a wire factory using mk1 parts on this node and dismantle that miner",
  ]) {
    assert.equal(parseAimedMk1FactoryRequest(question), null, question);
  }
});

test("oversized plan refusals report the requested count", () => {
  const reply = describePlanRejection({ reason: "too_many_actions", requested: 513, limit: 512 });
  assert.match(reply, /513 actions/);
  assert.doesNotMatch(reply, /undefined/);
});

/* ---------------- what routes locally ---------------- */

test("siting questions are answered by the solver, not the model", () => {
  for (const question of [
    "where should I build my hub",
    "where's the best place to build a base?",
    "best spot to build a factory",
    "where do I put the smelter",
  ]) {
    assert.equal(routeQuestion(question)?.name, "find_best_site", question);
  }
});

test("each single-solver question reaches its own solver", () => {
  const expected = {
    "what is in this factory": "get_factory_summary",
    "give me a factory overview": "get_factory_summary",
    "what's my power situation": "get_power_circuits",
    "anything stopped?": "diagnose_bottlenecks",
    "what am I short of": "get_item_balance",
    "what tier am I": "get_unlock_status",
    "what blueprints do I have": "list_blueprints",
  };
  for (const [question, solver] of Object.entries(expected)) {
    assert.equal(routeQuestion(question)?.name, solver, question);
  }
});

test("factory census is exact, local, and explicit about capture scope", () => {
  const snapshot = buildFactorySnapshot();
  snapshot.world.scan_radius_meters = 250;
  const answer = answerLocally("what is in this factory", buildGraph(snapshot), sink());

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "get_factory_summary");
  assert.match(answer.reply, /10 actors/);
  assert.match(answer.reply, /8 buildables/);
  assert.match(answer.reply, /within 250 metres/);
});

test("bottleneck answers format the solver's reports instead of falsely declaring every machine healthy", () => {
  const answer = answerLocally("anything stopped?", graphOf(), sink());

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "diagnose_bottlenecks");
  assert.match(answer.reply, /4 captured production machines have findings/);
  assert.match(answer.reply, /power capacity deficit 2/);
  assert.match(answer.reply, /input starved 1/);
  assert.match(answer.reply, /Root cause actor/);
  assert.match(answer.reply, /\[fault\]/);
  assert.doesNotMatch(answer.reply, /\[invalid\]/);
  assert.match(answer.reply, /\[unknown\] cause means/);
  assert.doesNotMatch(answer.reply, /every captured machine is running/);
});

test("an empty bottleneck result stays scoped to captured evidence", () => {
  const answer = answerLocally("anything stopped?", buildGraph({ world_revision: 1, actors: [] }), sink());

  assert.match(answer.reply, /No captured production machine has a deterministic bottleneck finding/);
  assert.doesNotMatch(answer.reply, /every captured machine is running/);
});

test("the observed tier-and-recipe-count phrase stays free without swallowing a recipe-list request", () => {
  const question = "what tech tier am I and how many recipes are available";
  assert.equal(routeQuestion(question)?.name, "get_unlock_status");

  const answer = answerLocally(question, graphOf(), sink());
  assert.equal(answer.local.solver, "get_unlock_status");
  assert.match(answer.reply, /Tech tier \*\*5\*\*/);
  assert.match(answer.reply, /5 recipes available/);

  // The summary solver knows the count, not a complete recipe listing.
  assert.equal(routeQuestion("which recipes are available"), null);
});

/* ---------------- what must not ---------------- */

test("a compound question goes to the model rather than getting half an answer", () => {
  // Answering only the siting half locally would be answering it wrong.
  assert.equal(routeQuestion("where should I build the hub and what should I make there"), null);
  assert.equal(routeQuestion("what's my power situation and what is stopped"), null);
  assert.equal(routeQuestion("give me a factory overview and tell me what to fix first"), null);
});

test("anything needing judgement or outside knowledge goes to the model", () => {
  for (const question of [
    "where should I build compared to what reddit recommends",
    "why did we start next to coal",
    "design me a 300/min iron rod line",
    "teleport me to the nearest slug",
    "is this a good base layout",
  ]) {
    assert.equal(routeQuestion(question), null, question);
  }
});

/* ---------------- overlays parse, they do not reason ---------------- */

test("a show request yields a target and radius", () => {
  assert.deepEqual(parseShowRequest("show me every mercer sphere within 150 m"), {
    target: "mercer sphere",
    radius: 150,
  });
  assert.deepEqual(parseShowRequest("highlight all beryl nuts within 100m"), {
    target: "beryl nut",
    radius: 100,
  });
});

test("a show request without a radius leaves it unset rather than inventing one", () => {
  assert.deepEqual(parseShowRequest("mark the blue power slugs"), {
    target: "blue power slug",
    radius: null,
  });
});

test("the radius never leaks into the item name", () => {
  // The original single-regex parser let the target swallow "within 150 m",
  // which then failed the length check and silently fell through to the model.
  const parsed = parseShowRequest("show me every mercer sphere within 150 m");
  assert.equal(parsed.target.includes("within"), false);
  assert.equal(parsed.target.includes("150"), false);
});

test("a question dressed as a show request is not one", () => {
  assert.equal(parseShowRequest("show me where to build"), null);
  assert.equal(parseShowRequest("show me why my factory is slow"), null);
  assert.equal(parseShowRequest("show me every slug and tell me which is closest"), null);
});

test("clear requests are recognised, and questions about overlays are not", () => {
  for (const question of ["clear all overlays", "remove highlights", "hide the markers"]) {
    assert.deepEqual(parseClearRequest(question), { all: true }, question);
  }
  assert.equal(parseClearRequest("what is an overlay"), null);
});

/* ---------------- the local answer ---------------- */

function sink() {
  const emitted = [];
  return { emitted, actions: { emit: (actions) => emitted.push(...actions) } };
}

function exactBeltGraph(distanceCm) {
  const snapshot = buildFactorySnapshot();
  const miner = snapshot.actors.find((actor) => actor.actor_id === MINER);
  const smelter = snapshot.actors.find((actor) => actor.actor_id === SMELTER);
  const output = miner.connections.find((connection) => connection.direction === "FCD_OUTPUT");
  const input = smelter.connections.find((connection) => connection.direction === "FCD_INPUT");
  Object.assign(output, {
    connected: false,
    connected_component: "",
    location: { x: 1_000, y: 0, z: 100 },
    normal: { x: 1, y: 0, z: 0 },
  });
  Object.assign(input, {
    connected: false,
    connected_component: "",
    location: { x: 1_000 + distanceCm, y: 0, z: 100 },
    normal: { x: -1, y: 0, z: 0 },
  });
  return buildGraph(snapshot);
}

test("an exact named belt solver request bypasses the model", () => {
  const graph = exactBeltGraph(2_000);
  const question =
    "Using plan_belt_route only, check Build_MinerMk1_C_1 to Build_SmelterMk1_C_1. " +
    "Do not build or change anything.";
  assert.deepEqual(parseExactBeltSolverRequest(question, graph), {
    from_actor_id: MINER,
    to_actor_id: SMELTER,
  });

  const services = sink();
  const answer = answerLocally(question, graph, services);
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "plan_belt_route");
  assert.match(answer.reply, /20 m straight belt proposal/);
  assert.deepEqual(services.emitted, []);
});

test("direct belt dispatch preserves a solver refusal instead of narrating it away", () => {
  const graph = exactBeltGraph(0.03);
  const services = sink();
  const answer = answerLocally(
    "Using plan_belt_route only, check Build_MinerMk1_C_1 to Build_SmelterMk1_C_1.",
    graph,
    services,
  );

  assert.equal(answer.local.solver, "plan_belt_route");
  assert.match(answer.reply, /did not find a usable belt span/);
  assert.match(answer.reply, /already touching/);
  assert.match(answer.reply, /No game action was emitted/);
  assert.doesNotMatch(answer.reply, /valid and direct/);
  assert.deepEqual(services.emitted, []);
});

test("a show request emits the overlay action without any model call", () => {
  const services = sink();
  const answer = answerLocally("show me every mercer sphere within 150 m", graphOf(), services);

  assert.equal(answer.provider, "solvers");
  assert.equal(services.emitted[0].action, "highlight");
  assert.equal(services.emitted[0].item_name_contains, "mercer sphere");
  assert.equal(services.emitted[0].radius_m, 150);
  assert.equal(services.emitted[0].commit, true);
});

test("a locally routed placement is normalized and revision-stamped", () => {
  const services = sink();
  const answer = answerLocally("place a smelter here facing north", graphOf(), services);

  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "place_building");
  assert.deepEqual(services.emitted, [{
    action: "place_building",
    recipe_class: "Recipe_SmelterMk1",
    location: { x: 0, y: 0, z: 0 },
    yaw: 0,
    check_clearance: true,
    commit: true,
    expect_world_revision: "41",
    require_unchanged_world: false,
  }]);
  assert.equal("target" in services.emitted[0], false);
  assert.equal("rotation" in services.emitted[0], false);
});

test("a local answer is marked as free and refuses to guess a count", () => {
  const answer = answerLocally("show me every paleberry", graphOf(), sink());
  // The cost footer is appended by the server so every answer carries the same
  // one; the router's job is the content.
  assert.equal(answer.provider, "solvers");
  assert.match(answer.reply, /not guessing a count/);
});

test("an unroutable question returns null so the caller falls through to the model", () => {
  assert.equal(answerLocally("why did we start next to coal", graphOf(), sink()), null);
});

test("a siting answer leads with why it won, not just the score", () => {
  const answer = answerLocally("where should I build my hub", graphOf(), sink());
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "find_best_site");
  assert.ok(answer.local.elapsed_ms < 500, "a local answer should be effectively instant");
});

/* ---------------- guard against the bug that caused all this ---------------- */

test("no source file carries a stray control character", () => {
  // A `\b` written through a shell heredoc became a literal backspace (0x08)
  // inside a regex, which then matched nothing. It printed identically to the
  // correct pattern, so it was invisible in every diff and log. Cheap to guard.
  const roots = ["lib", "test", "."];
  const seen = new Set();
  const offenders = [];

  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const file = path.join(root, entry.name);
      if (seen.has(file)) continue;
      seen.add(file);

      // Split on either ending — these files are CRLF on Windows, and a
      // carriage return is not the kind of stray character this guards against.
      const text = fs.readFileSync(file, "utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        for (const character of line) {
          const code = character.codePointAt(0);
          if (code < 32 && character !== "\t") {
            offenders.push(`${file}:${index + 1} contains U+${code.toString(16).padStart(4, "0")}`);
          }
        }
      }
    }
  }

  assert.deepEqual(offenders, []);
});

/* ---------------- building where the player is aiming ---------------- */

// The request that produced the bug: the model answered "Let me build this for
// you." and emitted nothing. Every phrasing here is one a player would type,
// including the typo that was actually in the log.
test("a structure request routes on the phrasing players really use", () => {
  const routes = [
    "buld me a storage hub same level as this foundation im looking at",
    "build a storage hub where im looking",
    "build a storage hub where i'm looking",
    "build a storage hub where i am aiming",
    "build me a platform at what im looking at",
    "build a shed at my crosshair",
    "build me a storage hub here",
    "biuld a 5x5 storage hub on this foundation",
  ];
  for (const question of routes) {
    assert.ok(
      parseStructureRequest(question),
      `should route locally: ${question}`,
    );
  }
});

test("asking about a structure is not asking for one", () => {
  // A question needs an answer, and a request without a place to put the
  // building belongs to the production planner, not the shell builder.
  for (const question of [
    "what is a storage hub",
    "how do i build a storage hub",
    "build a storage hub in the desert",
  ]) {
    assert.equal(
      parseStructureRequest(question),
      null,
      `should not build: ${question}`,
    );
  }
});

test("an explicit size is carried through, and its absence stays unknown", () => {
  assert.partialDeepStrictEqual(parseStructureRequest("biuld a 5x5 storage hub here"), {
    width_cells: 5,
    depth_cells: 5,
    fills_with: "storage",
    at_aim: true,
  });
  const unsized = parseStructureRequest("build me a storage hub here");
  assert.equal(unsized.width_cells, null);
  assert.equal(unsized.depth_cells, null);
});

// The whole route, not just the parser: a real structural kit, an aim point
// below the player, and the actions that come back. Nothing covered this, and
// two wiring faults hid inside it -- a refusal that returned bare null and fell
// through to a model, and the aim/player mix-up this test exists to pin.
const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const structuralPiece = (recipe, descriptor, name) => ({
  class_path: `/Game/Recipes/${recipe}.${recipe}_C`,
  name,
  owner_mod: "FactoryGame",
  available: true,
  produced_in: [BUILD_GUN],
  products: [
    { item_class: `/Game/Desc/${descriptor}.${descriptor}_C`, item_name: name, amount: 1 },
  ],
});

const AIM_Z = 6857;
const PLAYER_Z = 7900;

const structureWorld = (recipes) => ({
  world_revision: 3,
  world: { scan_center: { x: 12_000, y: 4_000, z: AIM_Z } },
  interaction_context: {
    player: { pawn_available: true, pawn_location: { x: 12_000, y: 4_000, z: PLAYER_Z } },
    preferred_target: {
      available: true,
      selected_from: "aim_trace",
      hit_location: { x: 12_000, y: 4_000, z: AIM_Z },
    },
  },
  actors: [],
  content: { items: [], recipes },
});

const FULL_KIT = [
  structuralPiece("Recipe_Foundation_8x1_01", "Desc_Foundation_8x1_01", "Foundation (1 m)"),
  structuralPiece("Recipe_Wall_8x4_01", "Desc_Wall_8x4_01", "Basic Wall (4 m)"),
  structuralPiece("Recipe_Roof_Orange_01", "Desc_Roof_Orange_01", "Flat Roof"),
  structuralPiece("Recipe_StorageContainerMk1", "Desc_StorageContainerMk1", "Storage Container"),
];

const askToBuild = (recipes, question) => {
  let emitted = [];
  const answer = answerLocally(question, buildGraph(structureWorld(recipes)), {
    actions: { emit: (actions) => { emitted = actions; } },
  });
  return { answer, emitted };
};

test("a storage hub is built level with the aim point, not the player", () => {
  const { answer, emitted } = askToBuild(
    FULL_KIT,
    "buld me a storage hub same level as this foundation im looking at",
  );
  assert.ok(answer, "should route locally");
  assert.ok(emitted.length > 0, "should emit actions, not just describe them");

  // The floor sits where the player was looking. If it used the pawn instead,
  // the hub would hover a storey above the deck it was meant to join.
  const floorZs = emitted
    .filter((action) => String(action.recipe_class).includes("Foundation"))
    .map((action) => action.location.z);
  assert.ok(floorZs.length > 0);
  for (const z of floorZs) assert.equal(z, AIM_Z);
  assert.ok(!emitted.some((action) => action.location?.z === PLAYER_Z));

  // Filled, and with a container resolved from the catalog rather than named.
  assert.ok(
    emitted.some((action) => String(action.recipe_class).includes("StorageContainer")),
    "the hub should contain storage",
  );
});

test("a hub with nothing to build it from says so instead of asking a model", () => {
  // The failure that started this: falling through here sent the request to a
  // model, which cannot build either and answered "Let me build this for you."
  const { answer, emitted } = askToBuild(
    [structuralPiece("Recipe_StorageContainerMk1", "Desc_StorageContainerMk1", "Storage Container")],
    "build me a storage hub here",
  );
  assert.ok(answer, "a known refusal must be answered, not passed on");
  assert.match(answer.reply, /can't build that here/i);
  assert.equal(emitted.length, 0);
});

/* ---------------- listing blueprints ---------------- */

// Asked "list blueprints" with 55 on disk, the local model answered "the player
// has not saved any blueprints yet" and explained how to save one. No route
// matched, so a model that cannot read files answered from nothing. The solver
// already worked; only the route was missing, which is the worst version of
// this failure -- the right answer was one call away and the player was told
// the opposite.
test("asking about blueprints reads the folder instead of asking a model", () => {
  for (const question of [
    "list blueprints",
    "what blueprints do i have",
    "show my blueprints",
    "do i have any blueprints",
    "list my blue prints",
  ]) {
    assert.ok(parseBlueprintListRequest(question), `should route: ${question}`);
  }
});

test("a named filter is carried through", () => {
  assert.equal(parseBlueprintListRequest("blueprints with coal in the name").name_contains, "coal");
  assert.equal(parseBlueprintListRequest("blueprints named coal").name_contains, "coal");
  assert.equal(parseBlueprintListRequest("list blueprints").name_contains, null);
});

test("placing, pricing or saving a blueprint is not listing them", () => {
  for (const question of [
    "place the coal power plant blueprint here",
    "how much does that blueprint cost",
    "save this as a blueprint",
    "build a blueprint designer",
  ]) {
    assert.equal(parseBlueprintListRequest(question), null, `should not list: ${question}`);
  }
});

test("an empty library says so plainly rather than inventing a count", () => {
  const answer = answerLocally("list blueprints", buildGraph(buildFactorySnapshot()), {
    listBlueprints: () => [],
  });
  assert.ok(answer);
  assert.match(answer.reply, /no saved blueprints/i);
});

test("a library the bridge cannot read is reported, not guessed at", () => {
  // No reader configured is a different answer from an empty folder, and
  // collapsing the two would tell the player to go build something they
  // already have.
  const answer = answerLocally("list blueprints", buildGraph(buildFactorySnapshot()), {});
  assert.ok(answer);
  assert.match(answer.reply, /can't read your blueprint folder/i);
});
