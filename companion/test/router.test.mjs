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
  parseAimedFactoryRequest,
  parseBlueprintLayoutRequest,
  parseBlueprintListRequest,
  parseBlueprintPreviewRequest,
  parseShowRequest,
  parseStructureRequest,
  routeQuestion,
} from "../lib/router.mjs";
import { buildFactorySnapshot, MINER, SMELTER } from "./fixtures/factory.mjs";

const graphOf = (blueprintNames = []) => {
  const graph = buildGraph(buildFactorySnapshot());
  graph.snapshot.blueprint_library = {
    available: true,
    complete: true,
    registered_descriptor_count: blueprintNames.length,
    registered_blueprint_names: blueprintNames,
  };
  return graph;
};

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

test("an explicit aimed Mk.1 factory can leave its belts to the player", () => {
  const question = "build a wire factory using all mk1 parts on this node without belts";
  const parsed = parseAimedMk1FactoryRequest(question);
  assert.equal(parsed?.item, "wire");
  assert.equal(parsed?.skip_belts, true);
  assert.equal(parsed?.raw_text, question);
  assert.equal(parseAimedFactoryRequest(question), null, "the strict route owns tiered no-belt requests");
});

test("an explicit native Build Gun preview is not mistaken for placement or listing", () => {
  assert.deepEqual(
    parseBlueprintPreviewRequest("preview the Coal power plant 2700MW v1.1 blueprint"),
    { name: "Coal power plant 2700MW v1.1" },
  );
  assert.deepEqual(
    parseBlueprintPreviewRequest("arm my Steel Works in my build gun"),
    { name: "Steel Works" },
  );
  assert.equal(parseBlueprintPreviewRequest("list my blueprints"), null);
  assert.equal(parseBlueprintPreviewRequest("place the Coal power plant blueprint here"), null);
});

test("previewing a saved blueprint emits only a client Build Gun handoff", () => {
  const emitted = [];
  const answer = answerLocally("preview the Coal power plant blueprint", graphOf(["Coal power plant"]), {
    listBlueprints: () => [{
      name: "Coal power plant",
      designer_dimensions: { x: 12, y: 12, z: 6 },
      build_cost: [],
    }],
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.ok(answer);
  assert.equal(answer.local.solver, "blueprint_preview");
  assert.match(answer.reply, /Nothing is being placed or charged/i);
  assert.deepEqual(emitted, [{
    action: "preview_blueprint",
    blueprint_name: "Coal power plant",
    commit: true,
  }]);
});

test("a disk blueprint outside the current save is never promised to the Build Gun", () => {
  const emitted = [];
  const graph = graphOf(["Playthrough Starter"]);
  graph.snapshot.world.session_name = "Playthrough";
  const answer = answerLocally("preview the Coal power plant blueprint", graph, {
    listBlueprints: () => [{
      name: "Coal power plant",
      relative_path: "BP test/Coal power plant.sbp",
      blueprint_reference: "BP test/Coal power plant.sbp",
      designer_dimensions: { x: 12, y: 12, z: 6 },
      build_cost: [],
    }],
    actions: { emit: (actions) => emitted.push(...actions) },
  });

  assert.ok(answer);
  assert.equal(answer.local.solver, "blueprint_preview_refused");
  assert.match(answer.reply, /not registered.*Playthrough/i);
  assert.match(answer.reply, /nothing was placed or charged/i);
  assert.deepEqual(emitted, []);
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

test("an explicit native-blueprint inspection stays local and read-only", () => {
  for (const question of [
    "inspect blueprint Coal power plant 2700MW v1.1",
    "show the layout of blueprint Coal power plant 2700MW v1.1",
    "what is inside blueprint Coal power plant 2700MW v1.1",
  ]) {
    assert.equal(
      parseBlueprintLayoutRequest(question)?.blueprint_name,
      "Coal power plant 2700MW v1.1",
      question,
    );
  }
  assert.equal(parseBlueprintLayoutRequest("inspect blueprint C:/not-a-blueprint"), null);
  assert.equal(parseBlueprintLayoutRequest("place blueprint Coal power plant here"), null);

  const answer = answerLocally("inspect blueprint Coal power plant 2700MW v1.1", graphOf(), {
    inspectBlueprint: () => ({
      available: true,
      blueprint_name: "Coal power plant 2700MW v1.1",
      decoded: { buildable_count: 36, component_count: 10 },
      buildable_classes: [{ class_name: "GeneratorCoal", count: 36 }],
      pivot_bounds_cm: { span_cm: { x: 7200, y: 7100, z: 2950 } },
      buildables_returned: 36,
      buildables_truncated: 0,
      header: { build_cost: [] },
      source: "decoded_from_saved_native_blueprint",
      certainty: "authoritative_for_decoded_entities",
    }),
  });
  assert.equal(answer?.local?.solver, "inspect_blueprint_layout");
  assert.match(answer.reply, /36 Build_\* entities/i);
  assert.match(answer.reply, /not proof.*clear terrain/i);
});

test("a listed blueprint reference disambiguates safely, but never accepts traversal", () => {
  assert.deepEqual(
    parseBlueprintLayoutRequest("inspect blueprint ai 2.0/Coal power plant 2700MW v1.1.sbp"),
    { blueprint_name: "ai 2.0/Coal power plant 2700MW v1.1.sbp" },
  );
  assert.equal(parseBlueprintLayoutRequest("inspect blueprint ../Coal power plant"), null);
  assert.equal(parseBlueprintLayoutRequest("inspect blueprint C:\\outside.sbp"), null);
});

test("blueprint lists display a safe reference only when names collide", () => {
  const blueprint = (reference) => ({
    name: "Coal plant",
    relative_path: reference,
    blueprint_reference: reference,
    designer_dimensions: { x: 8, y: 8, z: 4 },
    build_cost: [],
    contents: { recipes: [] },
    game_changelist: 502094,
  });
  const answer = answerLocally("list blueprints", graphOf(), {
    listBlueprints: () => [blueprint("ai 2.0/Coal plant.sbp"), blueprint("BP test/Coal plant.sbp")],
  });
  assert.match(answer.reply, /reference `ai 2\.0\/Coal plant\.sbp`/i);
  assert.match(answer.reply, /reference `BP test\/Coal plant\.sbp`/i);
});

/* ---------------- a factory from the aimed node, phrased naturally ---------------- */

// The anchored route requires "using mk1 parts on this node". The owner types
// "build me a wire factory from this node", which matched nothing and reached a
// model. The strict form is untouched; this is a second door onto the same
// planner, and the reply still names the Mk.1 tier it built.
test("a factory request routes without the tier spelled out", () => {
  for (const question of [
    "build me a wire factory from this node",
    "build a wire factory on this node",
    "buld me a copper sheet factory from this node",
    "set up a wire plant off this node",
  ]) {
    const parsed = parseAimedFactoryRequest(question);
    assert.ok(parsed, `should route: ${question}`);
    assert.ok(parsed.item.length >= 2);
    assert.equal(parsed.tier_was_stated, false);
  }
  assert.equal(parseAimedFactoryRequest("build me a wire factory from this node").item, "wire");
});

test("the anchored tier route keeps its own phrasing", () => {
  // Both must not fire on the same sentence, or the request is planned twice.
  const explicit = "build a wire factory using all mk1 parts on this node";
  assert.ok(parseAimedMk1FactoryRequest(explicit));
  assert.equal(parseAimedFactoryRequest(explicit), null);
});

test("neighbouring routes are not swallowed by the wider pattern", () => {
  for (const question of [
    "build a 4x3 modular base here",
    "build me a storage hub here",
    "coal power from this node",
    "what is a wire factory",
  ]) {
    assert.equal(parseAimedFactoryRequest(question), null, `should not build a factory: ${question}`);
  }
});

test("a refused plan names the building, the scale, and the near misses", async () => {
  const { describePlanRejection } = await import("../lib/router.mjs");

  // The case this was written for: a 389-building design saved on a save that
  // had a mod loaded, replayed on one that does not. "step 214" alone is not
  // something a player can act on, and the rejection was already carrying the
  // class path and the suggestions.
  const missingMod = describePlanRejection({
    reason: "one_or_more_steps_are_invalid",
    rejected: [
      {
        step: 214,
        reason: "recipe_not_in_catalog",
        recipe_class: "/Game/CC/Recipe_CCWall8x8.Recipe_CCWall8x8_C",
        did_you_mean: ["Wall 8x8", "Wall 8x4", "Wall Window"],
      },
      { step: 215, reason: "recipe_not_in_catalog" },
      { step: 216, reason: "recipe_not_in_catalog" },
    ],
  });
  assert.match(missingMod, /Recipe_CCWall8x8/);
  assert.match(missingMod, /step 214/);
  assert.match(missingMod, /3 of the steps/);
  assert.match(missingMod, /Wall 8x8/);

  // A readable name beats a class path when the catalogue knows one.
  assert.match(
    describePlanRejection({
      reason: "one_or_more_steps_are_invalid",
      rejected: [{ step: 3, reason: "build_recipe_is_not_unlocked", building_name: "Coal Generator" }],
    }),
    /on Coal Generator \(step 3\)\.$/,
  );

  // Nothing invented when there is nothing to say.
  assert.match(
    describePlanRejection({
      reason: "one_or_more_steps_are_invalid",
      rejected: [{ step: 1, reason: "location_must_be_an_xyz_object_with_an_explicit_z" }],
    }),
    /^The plan was refused: location_must_be_an_xyz_object_with_an_explicit_z \(step 1\)\.$/,
  );
  assert.equal(describePlanRejection({ reason: "one_or_more_steps_are_invalid", rejected: [] }), null);
});

test("a design can be asked for turned, in degrees or in quarters", async () => {
  const { parseDesignPlaceRequest } = await import("../lib/router.mjs");

  // The turn is stripped before the place pattern runs, so the name still
  // comes out clean and the phrase still has to end the way it always did.
  assert.deepEqual(parseDesignPlaceRequest("place mk1 copper on this node rotated 90"), {
    name: "mk1 copper",
    rotation_degrees: 90,
    omit: null,
  });

  // A turn and an omission in one phrase, both stripped before the name is read.
  assert.deepEqual(
    parseDesignPlaceRequest("place mk1 copper on this node rotated 90 without the foundations"),
    { name: "mk1 copper", rotation_degrees: 90, omit: "foundation" },
  );
  assert.equal(parseDesignPlaceRequest("stamp mk2 down turned left").rotation_degrees, 270);
  assert.equal(parseDesignPlaceRequest("place mk1 copper here half turn").rotation_degrees, 180);
  assert.equal(parseDesignPlaceRequest("build smelter bank here rotated -90").rotation_degrees, -90);

  // Asking for no turn is still asking for no turn.
  assert.equal(parseDesignPlaceRequest("place mk1 copper on this node").rotation_degrees, 0);
  assert.equal(parseDesignPlaceRequest("what is a smelter"), null);
});
