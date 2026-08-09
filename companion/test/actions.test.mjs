import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import {
  ACTION_KINDS,
  describeUnkeptPromise,
  summarizePlan,
  validateAction,
  validatePlan,
} from "../lib/actions.mjs";
import { runSolverTool } from "../lib/tools.mjs";
import { CONSTRUCTOR, buildFactorySnapshot } from "./fixtures/factory.mjs";

const graphOf = () => buildGraph(buildFactorySnapshot());
const HERE = { x: 1000, y: 2000, z: 300 };

/* ---------------- validation refuses before the game is asked ---------------- */

test("refuses an action the mod cannot execute", () => {
  const result = validateAction(graphOf(), { action: "nuke_the_map" });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "unsupported_action");
  assert.deepEqual(result.supported, ACTION_KINDS);
});

test("a placement without an explicit z is refused, not defaulted to zero", () => {
  const result = validateAction(graphOf(), {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    location: { x: 100, y: 200 },
  });
  // Defaulting z would bury the building underground or float it.
  assert.equal(result.valid, false);
  assert.equal(result.reason, "location_must_be_an_xyz_object_with_an_explicit_z");
});

test("a mistyped recipe is caught here with the near misses named", () => {
  const result = validateAction(graphOf(), {
    action: "place_building",
    recipe_class: "Recipe_Constructer",
    location: HERE,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "recipe_not_in_catalog");
  assert.ok(Array.isArray(result.did_you_mean));
});

test("an implausibly distant teleport is refused", () => {
  const result = validateAction(graphOf(), {
    action: "teleport_player",
    target: { x: 9e12, y: 9e12, z: 0 },
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "target_is_implausibly_far");
});

test("teleport snaps to ground by default and warns when told not to", () => {
  const graph = graphOf();
  const snapped = validateAction(graph, { action: "teleport_player", target: HERE });
  assert.equal(snapped.action.snap_to_ground, true);
  assert.equal(snapped.warnings.length, 0);

  const unsnapped = validateAction(graph, {
    action: "teleport_player",
    target: HERE,
    snap_to_ground: false,
  });
  assert.equal(unsnapped.action.snap_to_ground, false);
  assert.match(unsnapped.warnings[0], /will fall/);
});

test("dismantle always warns that it cannot be undone", () => {
  const result = validateAction(graphOf(), { action: "dismantle", actor_id: CONSTRUCTOR });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => /cannot be undone/.test(warning)));
});

/* ---------------- nothing commits unless it was asked for ---------------- */

test("commit is false unless the proposal set it", () => {
  const graph = graphOf();
  const preview = validateAction(graph, { action: "teleport_player", target: HERE });
  const asked = validateAction(graph, { action: "teleport_player", target: HERE, commit: true });
  assert.equal(preview.action.commit, false);
  assert.equal(asked.action.commit, true);
});

test("every action carries the revision stamp the mod requires", () => {
  // The mod refuses a committed write with no stamp, so it is always sent.
  // What the stamp *does* is the separate question below.
  const graph = graphOf();
  const result = validateAction(graph, {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    location: HERE,
  });
  assert.equal(result.valid, true);
  assert.equal(result.action.expect_world_revision, String(graph.world_revision));
});

test("drift is reported but does not refuse, unless asked", () => {
  // Refusing on any drift made writes impossible in a live game: the revision
  // ticks on every actor spawn, so a real build failed with expected=569
  // actual=600 purely because belts were moving while the model thought.
  const graph = graphOf();
  const relaxed = validateAction(graph, {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    location: HERE,
  });
  assert.equal(relaxed.action.require_unchanged_world, false);

  const strict = validateAction(graph, {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    location: HERE,
    require_unchanged_world: true,
  });
  assert.equal(strict.action.require_unchanged_world, true);
  assert.equal(strict.action.expect_world_revision, String(graph.world_revision));
});

/* ---------------- a plan is all-or-nothing ---------------- */

test("one invalid step voids the whole plan rather than half-building it", () => {
  const plan = validatePlan(graphOf(), [
    { action: "teleport_player", target: HERE, commit: true },
    { action: "place_building", recipe_class: "Recipe_Nonsense", location: HERE, commit: true },
  ]);
  assert.equal(plan.valid, false);
  assert.equal(plan.reason, "one_or_more_steps_are_invalid");
  // The valid first step is not emitted either.
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.rejected[0].step, 2);
});

test("an oversized plan is refused with the limit named", () => {
  const many = Array.from({ length: 100 }, () => ({ action: "teleport_player", target: HERE }));
  const plan = validatePlan(graphOf(), many, { maxActions: 64 });
  assert.equal(plan.valid, false);
  assert.equal(plan.reason, "too_many_actions");
  assert.equal(plan.limit, 64);
});

test("an empty plan is refused rather than reported as a success", () => {
  const plan = validatePlan(graphOf(), []);
  assert.equal(plan.valid, false);
  assert.equal(plan.reason, "no_actions_given");
});

test("a valid plan counts its commits and says how it will run", () => {
  const plan = validatePlan(graphOf(), [
    { action: "teleport_player", target: HERE, commit: true },
    { action: "undo_last" },
  ]);
  assert.equal(plan.valid, true);
  assert.equal(plan.step_count, 2);
  assert.equal(plan.commits, 1);
  assert.match(plan.execution, /rolled back as one transaction/);
});

test("a production recipe is normalized into the same building placement", () => {
  const result = validateAction(graphOf(), {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    production_recipe_class: "Recipe_IronRod",
    location: HERE,
    commit: true,
  });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.action.production_recipe_class, "Recipe_IronRod");
  assert.equal(result.checks.production_recipe_name, "Iron Rod");
});

test("a missing or locked production recipe refuses the whole placement", () => {
  const missing = validateAction(graphOf(), {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    production_recipe_class: "Recipe_WireTypo",
    location: HERE,
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, "production_recipe_not_in_catalog");

  const snapshot = buildFactorySnapshot();
  snapshot.content.recipes.push({
    class_path: "Recipe_LockedWire",
    name: "Wire",
    available: false,
    products: [{ item_class: "Desc_Wire", item_name: "Wire", amount: 2 }],
    produced_in: ["Build_ConstructorMk1_C"],
  });
  const locked = validateAction(buildGraph(snapshot), {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    production_recipe_class: "Recipe_LockedWire",
    location: HERE,
  });
  assert.equal(locked.valid, false);
  assert.equal(locked.reason, "production_recipe_is_not_unlocked");
});

test("belt step endpoints are unambiguous and point to earlier actor creators", () => {
  const graph = graphOf();
  const recipe = "Recipe_ConveyorBeltMk1";
  const building = {
    action: "place_building",
    recipe_class: "Recipe_ConstructorMk1",
    location: HERE,
    commit: true,
  };

  const ambiguous = validateAction(graph, {
    action: "place_belt",
    recipe_class: recipe,
    from_component: "FactoryGame.Persistent_Level:Build_A.ConveyorAny0",
    from_step: 1,
    to_actor_id: "FactoryGame.Persistent_Level:Build_B",
  });
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.reason, "each_end_must_use_exactly_one_component_actor_or_step");

  const future = validatePlan(graph, [
    building,
    { action: "place_belt", recipe_class: recipe, from_step: 1, to_step: 3, commit: true },
    { ...building, location: { x: 2000, y: 2000, z: 300 } },
  ]);
  assert.equal(future.valid, false);
  assert.equal(future.rejected[0].reason, "to_step_must_refer_to_an_earlier_step");

  const nonCreator = validatePlan(graph, [
    { action: "teleport_player", target: HERE, commit: true },
    building,
    { action: "place_belt", recipe_class: recipe, from_step: 1, to_step: 2, commit: true },
  ]);
  assert.equal(nonCreator.valid, false);
  assert.equal(nonCreator.rejected[0].reason, "from_step_must_refer_to_an_actor_creating_step");

  const previewDependency = validatePlan(graph, [
    { ...building, commit: false },
    building,
    { action: "place_belt", recipe_class: recipe, from_step: 1, to_step: 2, commit: true },
  ]);
  assert.equal(previewDependency.valid, false);
  assert.equal(previewDependency.rejected[0].reason, "from_step_cannot_commit_from_a_preview_step");
});

test("a committed dismantle cannot be mixed into a reversible transaction", () => {
  const plan = validatePlan(graphOf(), [
    { action: "teleport_player", target: HERE, commit: true },
    { action: "dismantle", actor_id: CONSTRUCTOR, commit: true },
  ]);
  assert.equal(plan.valid, false);
  assert.equal(plan.reason, "irreversible_dismantle_must_be_a_standalone_commit");
  assert.deepEqual(plan.actions, []);
});

test("undo cannot mutate the journal in the middle of another committed transaction", () => {
  const plan = validatePlan(graphOf(), [
    { action: "teleport_player", target: HERE, commit: true },
    { action: "undo_last", commit: true },
  ]);
  assert.equal(plan.valid, false);
  assert.equal(plan.reason, "undo_must_be_a_standalone_commit");
  assert.deepEqual(plan.actions, []);
});

test("the summary flags irreversible steps separately", () => {
  const graph = graphOf();
  const safe = summarizePlan(graph, validatePlan(graph, [{ action: "teleport_player", target: HERE }]));
  assert.equal(safe.summary.irreversible_steps, 0);
  assert.match(safe.summary.reversible, /can be undone/);

  const risky = summarizePlan(
    graph,
    validatePlan(graph, [{ action: "dismantle", actor_id: CONSTRUCTOR, commit: true }]),
  );
  assert.equal(risky.summary.irreversible_steps, 1);
  assert.match(risky.summary.reversible, /cannot be undone/);
});

/* ---------------- the tool layer reaches the mod ---------------- */

function sinkServices() {
  const emitted = [];
  return { emitted, actions: { emit: (actions) => emitted.push(...actions) } };
}

test("perform_actions puts validated actions in the sink for the mod", () => {
  const services = sinkServices();
  runSolverTool(
    graphOf(),
    "perform_actions",
    { actions: [{ action: "teleport_player", target: HERE, commit: true }] },
    { services },
  );
  assert.equal(services.emitted.length, 1);
  assert.equal(services.emitted[0].action, "teleport_player");
  assert.equal(services.emitted[0].commit, true);
});

test("an invalid plan reaches the sink as nothing at all", () => {
  const services = sinkServices();
  const result = JSON.parse(
    runSolverTool(
      graphOf(),
      "perform_actions",
      { actions: [{ action: "place_building", recipe_class: "Recipe_Nope", location: HERE }] },
      { services },
    ).serialized,
  );
  assert.equal(result.valid, false);
  assert.equal(services.emitted.length, 0);
});

test("highlight always commits because drawing changes nothing", () => {
  const services = sinkServices();
  runSolverTool(
    graphOf(),
    "highlight",
    { overlay: "beryl", item_name_contains: "Beryl Nut", radius_m: 100 },
    { services },
  );
  assert.equal(services.emitted.length, 1);
  assert.equal(services.emitted[0].action, "highlight");
  assert.equal(services.emitted[0].commit, true);
  assert.equal(services.emitted[0].item_name_contains, "Beryl Nut");
});

test("highlight refuses to report a count the mod has not produced yet", () => {
  const services = sinkServices();
  const result = JSON.parse(
    runSolverTool(graphOf(), "highlight", { item_name_contains: "Paleberry" }, { services })
      .serialized,
  );
  assert.equal(result.queued, true);
  assert.match(result.note, /do not state a number/);
});

test("clear_highlight can target one overlay or all of them", () => {
  const services = sinkServices();
  runSolverTool(graphOf(), "clear_highlight", { overlay: "beryl" }, { services });
  runSolverTool(graphOf(), "clear_highlight", { all: true }, { services });
  assert.equal(services.emitted[0].overlay, "beryl");
  assert.equal(services.emitted[1].all, true);
});

test("design_factory_layout previews by default and emits nothing committed", () => {
  const services = sinkServices();
  const snapshot = buildFactorySnapshot();
  for (const actor of snapshot.actors) {
    if (actor.kind !== "buildable") continue;
    actor.bounds = { origin: { ...actor.location }, extent: { x: 400, y: 300, z: 400 } };
    actor.rotation = { pitch: 0, yaw: 0, roll: 0 };
    if (actor.factory) actor.factory.production_cycle_seconds = 0;
    delete actor.extractor;
  }

  const result = JSON.parse(
    runSolverTool(
      buildGraph(snapshot),
      "design_factory_layout",
      {
        item_name: "Iron Rod",
        target_rate_per_minute: 60,
        use_existing_surplus: false,
        origin: { x: 100_000, y: 100_000, z: 500 },
      },
      { services },
    ).serialized,
  );

  assert.equal(result.designed, true);
  assert.equal(result.will_build, false);
  assert.match(result.next_step, /Nothing was placed/);
  assert.ok(services.emitted.length > 0, "the preview is still sent so the mod can validate it");
  assert.ok(
    services.emitted.every((action) => action.commit === false),
    "a preview must not commit anything",
  );
});

/* ---------------- overlays route through either path ---------------- */

test("an overlay sent through perform_actions is accepted, not refused", () => {
  const services = sinkServices();
  const result = JSON.parse(
    runSolverTool(
      graphOf(),
      "perform_actions",
      { actions: [{ action: "highlight", overlay: "slugs", item_name_contains: "Power Slug" }] },
      { services },
    ).serialized,
  );
  assert.equal(result.valid, true);
  assert.equal(services.emitted[0].action, "highlight");
  assert.equal(services.emitted[0].item_name_contains, "Power Slug");
});

test("overlays always commit and never count as world changes", () => {
  const graph = graphOf();
  const plan = summarizePlan(
    graph,
    validatePlan(graph, [
      { action: "highlight", overlay: "a" },
      { action: "teleport_player", target: HERE, commit: true },
    ]),
  );
  // Drawing something is not a change to undo or confirm.
  assert.equal(plan.commits, 1);
  assert.equal(plan.overlays, 1);
  assert.equal(plan.summary.irreversible_steps, 0);
  assert.equal(plan.actions[0].commit, true);
});

test("a nonsensical overlay radius is refused", () => {
  const result = validateAction(graphOf(), { action: "highlight", radius_m: -5 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "radius_must_be_positive");
});

/* ---------------- a reply that promised more than it sent ---------------- */

// The real one: asked for a storage hub, the local model said "Let me build
// this for you." and emitted zero actions. Nothing was built, and the reply
// still read like success.
test("a model that promises to build and sends nothing is called out", () => {
  const note = describeUnkeptPromise({
    reply: "Let me build this for you.",
    actionCount: 0,
    answeredBy: "model",
  });
  assert.ok(note);
  assert.match(note, /Nothing was actually built/);
});

test("a promise that was kept says nothing", () => {
  assert.equal(
    describeUnkeptPromise({
      reply: "Let me build this for you.",
      actionCount: 51,
      answeredBy: "model",
    }),
    null,
  );
});

test("advice is not a promise", () => {
  // If describing a design tripped the guard, every layout discussion would
  // carry a false warning, and the player would learn to skip past the real one.
  for (const reply of [
    "You could build a storage hub here.",
    "That would place 16 foundations and 4 containers.",
    "The design places 16 foundations.",
    "Building this by hand would take a while.",
  ]) {
    assert.equal(
      describeUnkeptPromise({ reply, actionCount: 0, answeredBy: "model" }),
      null,
      `should not warn: ${reply}`,
    );
  }
});

test("a solver that emits no actions has already explained itself", () => {
  assert.equal(
    describeUnkeptPromise({
      reply: "Let me build this for you.",
      actionCount: 0,
      answeredBy: "local_solver",
    }),
    null,
  );
});
