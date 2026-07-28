import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { ACTION_KINDS, summarizePlan, validateAction, validatePlan } from "../lib/actions.mjs";
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
  assert.match(plan.execution, /stopping at the first failure/);
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
