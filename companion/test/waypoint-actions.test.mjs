/**
 * Waypoints are writes, not drawings.
 *
 * They were first classified as draw-only, on the reasoning that a waypoint is
 * just a marker on a screen. Two things make that wrong, and Codex caught both
 * in a release audit:
 *
 *   - `FMapMarker` is a `SaveGame` property, so a waypoint survives a reload.
 *     Anything that persists is world state.
 *   - Draw-only actions skip the write gate and always commit, so the clear
 *     path ran on a dry run. "Show me what this would do" deleted things.
 *
 * These tests exist so the classification cannot quietly regress.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_KINDS,
  OVERLAY_ACTION_KINDS,
  WRITE_ACTION_KINDS,
  validatePlan,
} from "../lib/actions.mjs";
import { buildGraph } from "../lib/graph.mjs";

const graph = buildGraph({
  world_revision: 4242,
  world: { scan_center: { x: 0, y: 0, z: 0 } },
  interaction_context: { player: { pawn_available: true, pawn_location: { x: 0, y: 0, z: 0 } } },
  actors: [],
});

test("a waypoint is classified as a write, and only drawings are exempt", () => {
  for (const kind of ["waypoint", "clear_waypoints"]) {
    assert.ok(WRITE_ACTION_KINDS.includes(kind), `${kind} must be a write`);
    assert.ok(!OVERLAY_ACTION_KINDS.includes(kind), `${kind} must not be draw-only`);
    assert.ok(ACTION_KINDS.includes(kind));
  }
  // The rule, not the roster: an overlay action must leave nothing behind once
  // it is gone. Highlights are drawn, and a hologram is a preview that was
  // never built or saved — removing either costs the player nothing. A waypoint
  // is a SaveGame property and survives a reload, which is exactly why it is
  // not on this list.
  assert.deepEqual(
    [...OVERLAY_ACTION_KINDS].sort(),
    ["clear_highlight", "clear_holograms", "highlight"],
  );
  for (const kind of OVERLAY_ACTION_KINDS) {
    assert.ok(!WRITE_ACTION_KINDS.includes(kind), `${kind} cannot be both draw-only and a write`);
  }
});

test("a committed waypoint carries the world revision stamp the mod requires", () => {
  const plan = validatePlan(graph, [
    { action: "waypoint", name: "Best HUB site", location: { x: 100, y: 200, z: 300 }, commit: true },
  ]);

  assert.equal(plan.valid, true, JSON.stringify(plan.rejected ?? plan));
  const [action] = plan.actions;
  assert.equal(action.action, "waypoint");
  assert.equal(action.commit, true);
  assert.deepEqual(action.location, { x: 100, y: 200, z: 300 });
  assert.equal(action.name, "Best HUB site");
  // Without this the mod refuses with committed_write_missing_expect_world_revision.
  assert.equal(action.expect_world_revision, "4242");
});

test("a waypoint without a real position is refused rather than pinned at the origin", () => {
  for (const bad of [undefined, {}, { x: 1, y: 2 }, "here"]) {
    const plan = validatePlan(graph, [{ action: "waypoint", location: bad, commit: true }]);
    assert.equal(plan.valid, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("clearing waypoints warns that undo will not bring them back", () => {
  const plan = validatePlan(graph, [{ action: "clear_waypoints", commit: true }]);
  assert.equal(plan.valid, true);
  assert.ok(
    plan.warnings.some((entry) => /not restored by undo/.test(entry.warning ?? entry)),
    `expected an undo warning, got ${JSON.stringify(plan.warnings)}`,
  );
});

test("an uncommitted waypoint stays uncommitted — it is not forced true like a drawing", () => {
  // The overlay path rewrites commit to true because drawing changes nothing.
  // A waypoint must not inherit that: dry run has to remain a dry run.
  const plan = validatePlan(graph, [
    { action: "waypoint", location: { x: 0, y: 0, z: 0 }, commit: false },
  ]);
  assert.equal(plan.valid, true);
  assert.equal(plan.actions[0].commit, false);

  const clear = validatePlan(graph, [{ action: "clear_waypoints", commit: false }]);
  assert.equal(clear.actions[0].commit, false);
});
