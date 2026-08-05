/**
 * Building the belt the planner chose.
 *
 * `plan_belt_route` picks the connector pair and measures the span; this is the
 * action that runs the conveyor between them. Endpoints are connection
 * *components*, not actors, because a machine has several ports and an actor id
 * does not say which one was meant.
 *
 * What is deliberately not validated here: length, bend radius, incline, and
 * clearance. Those belong to `AFGConveyorBeltHologram`, and duplicating them in
 * JavaScript would be a guess that drifts from the game every patch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WRITE_ACTION_KINDS, validatePlan } from "../lib/actions.mjs";
import { buildGraph } from "../lib/graph.mjs";

const graph = buildGraph({
  world_revision: 512,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [],
});

const BELT = "/Game/FactoryGame/Recipes/Buildings/Recipe_ConveyorBeltMk1.Recipe_ConveyorBeltMk1_C";
const FROM = "/Game/Map.Map:PersistentLevel.Build_MinerMk1_C_1.Output0";
const TO = "/Game/Map.Map:PersistentLevel.Build_SmelterMk1_C_1.Input0";

test("place_belt is a write, so it is gated and stamped like the rest", () => {
  assert.ok(WRITE_ACTION_KINDS.includes("place_belt"));

  const plan = validatePlan(graph, [
    { action: "place_belt", recipe_class: BELT, from_component: FROM, to_component: TO, commit: true },
  ]);

  assert.equal(plan.valid, true, JSON.stringify(plan.rejected ?? plan));
  const [action] = plan.actions;
  assert.equal(action.action, "place_belt");
  assert.equal(action.from_component, FROM);
  assert.equal(action.to_component, TO);
  assert.equal(action.commit, true);
  // Without the stamp the mod refuses with committed_write_missing_expect_world_revision.
  assert.equal(action.expect_world_revision, "512");
});

test("refuses the malformed requests rather than belting something arbitrary", () => {
  const cases = [
    [{ from_component: FROM, to_component: TO }, /recipe_class/],
    [{ recipe_class: BELT, to_component: TO }, /each_end_needs_a_component_actor_or_step/],
    [{ recipe_class: BELT, from_component: FROM }, /each_end_needs_a_component_actor_or_step/],
    [{ recipe_class: BELT, from_component: FROM, to_component: FROM }, /two_different_connections/],
  ];
  for (const [proposal, expected] of cases) {
    const plan = validatePlan(graph, [{ action: "place_belt", ...proposal, commit: true }]);
    assert.equal(plan.valid, false, `expected refusal for ${JSON.stringify(proposal)}`);
    assert.match(JSON.stringify(plan.rejected), expected);
  }
});

test("says plainly that the game owns the geometry checks", () => {
  const plan = validatePlan(graph, [
    { action: "place_belt", recipe_class: BELT, from_component: FROM, to_component: TO, commit: true },
  ]);
  assert.ok(
    plan.warnings.some((entry) => /hologram/.test(entry.warning ?? entry)),
    "the caller must know length and clearance are not decided here",
  );
});

test("a dry run stays a dry run", () => {
  const plan = validatePlan(graph, [
    { action: "place_belt", recipe_class: BELT, from_component: FROM, to_component: TO, commit: false },
  ]);
  assert.equal(plan.actions[0].commit, false);
});
