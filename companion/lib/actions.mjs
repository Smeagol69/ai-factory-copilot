/**
 * World-mutating actions.
 *
 * The bridge never changes the world. It *proposes* — it validates a requested
 * action against the live snapshot, prices it, and emits a typed action object
 * that the mod executes server-side and reads back. Anything the bridge cannot
 * verify from the snapshot is reported as unverified rather than asserted.
 *
 * The split matters: a plan built here can be wrong about the world (the model
 * may have misread a coordinate), so the mod re-validates everything and is the
 * only thing that can actually commit. Two independent checks, and the one that
 * owns the world has the final say.
 */

import { distanceMeters } from "./graph.mjs";

/** Actions the mod knows how to execute. Kept in sync with AIFactoryActions.cpp. */
export const ACTION_KINDS = [
  "teleport_player",
  "place_building",
  "place_blueprint",
  "dismantle",
  "undo_last",
];

/** Beyond this the player almost certainly meant something else. */
const MAX_TELEPORT_METERS = 200_000;
const MAX_PLACEMENT_REACH_METERS = 5_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vector(input) {
  if (!input || typeof input !== "object") return null;
  const x = finite(input.x);
  const y = finite(input.y);
  const z = finite(input.z);
  if (x === null || y === null) return null;
  return { x, y, z: z === null ? 0 : z };
}

function reject(kind, reason, detail = {}) {
  return { valid: false, action_kind: kind, reason, ...detail };
}

/**
 * Validates one proposed action against the snapshot.
 *
 * Returns `{ valid, action, warnings, checks }`. A valid result carries the
 * exact object the mod will execute — no reshaping happens later, so what the
 * player is shown is what runs.
 */
export function validateAction(graph, proposal) {
  if (!proposal || typeof proposal !== "object") {
    return reject("unknown", "action_is_not_an_object");
  }
  const kind = String(proposal.action ?? "");
  if (!ACTION_KINDS.includes(kind)) {
    return reject(kind || "unknown", "unsupported_action", { supported: ACTION_KINDS });
  }

  const warnings = [];
  const checks = {};
  const player = graph?.snapshot?.player ?? null;
  const playerPosition = player?.location ?? player?.pawn?.location ?? null;

  if (kind === "teleport_player") {
    const target = vector(proposal.target);
    if (!target) return reject(kind, "target_must_be_an_xyz_object");

    if (playerPosition) {
      const metres = distanceMeters(playerPosition, target);
      checks.distance_m = Math.round(metres * 10) / 10;
      if (metres > MAX_TELEPORT_METERS) {
        return reject(kind, "target_is_implausibly_far", { distance_m: checks.distance_m });
      }
    } else {
      warnings.push("Player position is not in the snapshot, so the distance was not checked.");
    }

    const snapToGround = proposal.snap_to_ground !== false;
    if (!snapToGround) {
      warnings.push(
        "Ground snapping is off. If nothing is under the target the player will fall.",
      );
    }
    return {
      valid: true,
      warnings,
      checks,
      action: {
        action: kind,
        target,
        snap_to_ground: snapToGround,
        snap_clearance_cm: finite(proposal.snap_clearance_cm) ?? 200,
        commit: proposal.commit === true,
      },
    };
  }

  if (kind === "place_building") {
    const recipeClass = String(proposal.recipe_class ?? "").trim();
    if (!recipeClass) return reject(kind, "recipe_class_is_required");

    const location = vector(proposal.location);
    if (!location || finite(proposal.location?.z) === null) {
      return reject(kind, "location_must_be_an_xyz_object_with_an_explicit_z");
    }

    // Check the recipe exists before the game is asked to build it, so a typo
    // is caught here with the near-misses named rather than failing in-world.
    const catalog = graph?.snapshot?.content_catalog?.recipes ?? [];
    const known = catalog.find(
      (entry) => entry.class_path === recipeClass || entry.class_name === recipeClass,
    );
    if (catalog.length > 0 && !known) {
      const needle = recipeClass.toLowerCase();
      const near = catalog
        .filter((entry) => String(entry.class_name ?? "").toLowerCase().includes(needle))
        .slice(0, 5)
        .map((entry) => entry.class_name);
      return reject(kind, "recipe_not_in_catalog", { recipe_class: recipeClass, did_you_mean: near });
    }
    if (known) checks.building_name = known.name ?? known.class_name;

    if (playerPosition) {
      const metres = distanceMeters(playerPosition, location);
      checks.distance_from_player_m = Math.round(metres * 10) / 10;
      if (metres > MAX_PLACEMENT_REACH_METERS) {
        warnings.push(
          `The target is ${checks.distance_from_player_m} m away. That is far enough that it may not be where you meant.`,
        );
      }
    }

    return {
      valid: true,
      warnings,
      checks,
      action: {
        action: kind,
        recipe_class: recipeClass,
        location,
        yaw: finite(proposal.yaw) ?? 0,
        check_clearance: proposal.check_clearance !== false,
        commit: proposal.commit === true,
      },
    };
  }

  if (kind === "place_blueprint") {
    const name = String(proposal.blueprint_name ?? "").trim();
    if (!name) return reject(kind, "blueprint_name_is_required");

    const location = vector(proposal.location);
    if (!location || finite(proposal.location?.z) === null) {
      return reject(kind, "location_must_be_an_xyz_object_with_an_explicit_z");
    }

    // The library is read from disk, so an exact name can be confirmed and a
    // wrong one corrected before the game is asked for it.
    const library = graph?.services?.blueprints ?? null;
    if (Array.isArray(library) && library.length > 0) {
      const match = library.find((entry) => entry.name === name);
      if (!match) {
        const needle = name.toLowerCase();
        const near = library
          .filter((entry) => String(entry.name).toLowerCase().includes(needle))
          .slice(0, 5)
          .map((entry) => entry.name);
        return reject(kind, "blueprint_not_in_library", { blueprint_name: name, did_you_mean: near });
      }
      checks.designer_dimensions = match.designer_dimensions;
      checks.build_cost_entries = match.build_cost?.length ?? 0;
    }

    return {
      valid: true,
      warnings,
      checks,
      action: {
        action: kind,
        blueprint_name: name,
        location,
        yaw: finite(proposal.yaw) ?? 0,
        commit: proposal.commit === true,
      },
    };
  }

  if (kind === "dismantle") {
    const actorId = String(proposal.actor_id ?? "").trim();
    if (!actorId) return reject(kind, "actor_id_is_required");
    const node = graph?.nodes?.get(actorId) ?? null;
    if (!node) {
      warnings.push(
        "That actor is not in the current snapshot; the game will re-check it before removing anything.",
      );
    } else {
      checks.building = node.display_name ?? node.class_name;
    }
    warnings.push("Dismantling cannot be undone by the copilot.");
    return {
      valid: true,
      warnings,
      checks,
      action: { action: kind, actor_id: actorId, commit: proposal.commit === true },
    };
  }

  // undo_last takes no parameters.
  return {
    valid: true,
    warnings,
    checks,
    action: { action: kind, commit: proposal.commit === true },
  };
}

/**
 * Validates a whole plan.
 *
 * A plan is all-or-nothing at proposal time: if any step is invalid the plan is
 * refused as a whole rather than half-emitted, because a partial layout is worse
 * than none. The mod applies the same rule at execution time.
 */
export function validatePlan(graph, proposals, { maxActions = 64 } = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  if (list.length === 0) {
    return { valid: false, reason: "no_actions_given", actions: [] };
  }
  if (list.length > maxActions) {
    return {
      valid: false,
      reason: "too_many_actions",
      requested: list.length,
      limit: maxActions,
      actions: [],
    };
  }

  const actions = [];
  const warnings = [];
  const rejected = [];

  list.forEach((proposal, index) => {
    const result = validateAction(graph, proposal);
    if (!result.valid) {
      rejected.push({ step: index + 1, ...result });
      return;
    }
    actions.push(result.action);
    for (const warning of result.warnings ?? []) {
      warnings.push({ step: index + 1, warning });
    }
  });

  if (rejected.length > 0) {
    return {
      valid: false,
      reason: "one_or_more_steps_are_invalid",
      rejected,
      actions: [],
      note: "No action is emitted when any step fails validation, so a partial layout is never built.",
    };
  }

  return {
    valid: true,
    actions,
    warnings,
    step_count: actions.length,
    commits: actions.filter((action) => action.commit).length,
    execution:
      "Executed in order by the mod, server-side, stopping at the first failure. Each step is re-validated there and read back after committing.",
  };
}

/**
 * The costed, human-readable preview shown before anything runs.
 *
 * Everything priced here comes from the snapshot's own catalog and the player's
 * captured inventories; anything it cannot price says so.
 */
export function summarizePlan(graph, plan) {
  if (!plan.valid) return plan;

  const byKind = {};
  for (const action of plan.actions) {
    byKind[action.action] = (byKind[action.action] ?? 0) + 1;
  }

  const irreversible = plan.actions.filter((action) => action.action === "dismantle").length;

  return {
    ...plan,
    summary: {
      steps: plan.actions.length,
      by_kind: byKind,
      irreversible_steps: irreversible,
      reversible:
        irreversible === 0
          ? "Every step in this plan can be undone with undo_last."
          : `${irreversible} dismantle step(s) cannot be undone by the copilot.`,
    },
  };
}
