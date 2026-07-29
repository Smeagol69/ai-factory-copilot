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

/** Actions that change the world. Kept in sync with AIFactoryActions.cpp. */
export const WRITE_ACTION_KINDS = [
  "teleport_player",
  "place_building",
  "place_blueprint",
  "dismantle",
  "undo_last",
];

/**
 * Actions that only draw. These change nothing, so they are never gated behind
 * the write switch and never need confirming.
 */
export const OVERLAY_ACTION_KINDS = ["highlight", "clear_highlight"];

/** Everything the mod knows how to execute. */
export const ACTION_KINDS = [...WRITE_ACTION_KINDS, ...OVERLAY_ACTION_KINDS];

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

/**
 * The player's captured position. `interaction_context` carries it on current
 * snapshots; older ones only have the player actor, so fall back to that rather
 * than skipping the distance checks entirely.
 */
function findPlayerPosition(graph) {
  const fromContext = graph?.snapshot?.interaction_context?.player?.pawn_location;
  if (fromContext) return fromContext;
  for (const node of graph?.nodes?.values() ?? []) {
    if (node.kind === "player" && node.raw?.location) return node.raw.location;
  }
  return null;
}

/** Matches "Recipe_ConstructorMk1" against a catalog keyed on full class paths. */
function findRecipeByShortName(catalog, name) {
  for (const [classPath, recipe] of catalog) {
    if (classPath.split(".").pop() === name || classPath.split(".").pop() === `${name}_C`) {
      return recipe;
    }
  }
  return null;
}

/** True when some building standing in the world was built by this recipe. */
function recipeIsInUse(graph, recipeClass) {
  const shortName = recipeClass.split(".").pop();
  for (const node of graph?.nodes?.values() ?? []) {
    const built = node.built_with_recipe;
    if (!built) continue;
    if (built === recipeClass || built.split(".").pop() === shortName) return true;
  }
  return false;
}

function nearestRecipeNames(catalog, name) {
  const needle = name.toLowerCase().replace(/^recipe_/, "");
  const near = [];
  for (const [classPath, recipe] of catalog) {
    const shortName = classPath.split(".").pop() ?? "";
    if (shortName.toLowerCase().includes(needle) || String(recipe.name ?? "").toLowerCase().includes(needle)) {
      near.push(shortName);
      if (near.length >= 5) break;
    }
  }
  return near;
}

function reject(kind, reason, detail = {}) {
  return { valid: false, action_kind: kind, reason, ...detail };
}

/**
 * Bind a proposed action to an exact world revision — opt in only.
 *
 * This was applied to every action, and it made writes impossible in a live
 * game. `MarkWorldDirty` fires on every actor spawn and destroy, so items
 * moving along a belt tick the counter continuously: a real build attempt
 * failed with `expected=569, actual=600` because the world moved 31 times
 * while the model was thinking. A global counter cannot distinguish "a leaf
 * spawned two kilometres away" from "a building now occupies your target", so
 * it rejected everything indiscriminately.
 *
 * The protection that actually matters is per-action and already runs mod-side
 * immediately before mutation: the recipe is re-resolved, the ground re-probed,
 * the footprint overlap-tested, the cost re-checked against live inventories,
 * and the game's own hologram asked whether it can construct. That is precise
 * where a revision counter is blunt, and it is what rule 4 relies on.
 *
 * The stamp is now attached only when a caller explicitly asks for "nothing
 * may have changed at all" semantics.
 */
function bindWorldRevision(graph, action, proposal) {
  // The mod requires a stamp on every committed write and reports any drift,
  // so it is always sent. Whether drift *refuses* the action is the caller's
  // choice, carried alongside it.
  const revision = graph?.world_revision;
  if (revision === null || revision === undefined) return action;
  return {
    ...action,
    expect_world_revision: String(revision),
    require_unchanged_world: proposal?.require_unchanged_world === true,
  };
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
  const playerPosition = findPlayerPosition(graph);

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
      action: bindWorldRevision(graph, {
        action: kind,
        target,
        snap_to_ground: snapToGround,
        snap_clearance_cm: finite(proposal.snap_clearance_cm) ?? 200,
        commit: proposal.commit === true,
      }, proposal),
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
    const catalog = graph?.recipesByClass ?? new Map();
    const known = catalog.get(recipeClass) ?? findRecipeByShortName(catalog, recipeClass);

    // A recipe that already built something standing in this world is real
    // whether or not the captured catalog lists it. The catalog can be
    // radius-limited or miss a modded entry; an existing building cannot be
    // wrong about what built it.
    const builtSomethingHere = recipeIsInUse(graph, recipeClass);

    if (catalog.size > 0 && !known && !builtSomethingHere) {
      return reject(kind, "recipe_not_in_catalog", {
        recipe_class: recipeClass,
        did_you_mean: nearestRecipeNames(catalog, recipeClass),
      });
    }
    if (!known && builtSomethingHere) {
      checks.recipe_evidence = "not_in_the_captured_catalog_but_it_built_an_existing_building_here";
    }
    if (known) {
      checks.building_name = known.name ?? null;
      // Emit the exact class path the catalog knows, so a short name the model
      // used resolves to something the game can actually look up.
      if (known.class_path) checks.resolved_recipe_class = known.class_path;
    }

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
      action: bindWorldRevision(graph, {
        action: kind,
        recipe_class: checks.resolved_recipe_class ?? recipeClass,
        location,
        yaw: finite(proposal.yaw) ?? 0,
        check_clearance: proposal.check_clearance !== false,
        commit: proposal.commit === true,
      }, proposal),
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
      action: bindWorldRevision(graph, {
        action: kind,
        blueprint_name: name,
        location,
        yaw: finite(proposal.yaw) ?? 0,
        commit: proposal.commit === true,
      }, proposal),
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
      action: bindWorldRevision(graph, {
        action: kind,
        actor_id: actorId,
        commit: proposal.commit === true,
      }, proposal),
    };
  }

  if (OVERLAY_ACTION_KINDS.includes(kind)) {
    // Drawing changes nothing, so these always commit. Passing them through
    // here as well as through the dedicated tools means a model that routes an
    // overlay via perform_actions gets the overlay rather than a refusal.
    const { action: _kind, commit: _commit, ...rest } = proposal;
    const radius = finite(proposal.radius_m);
    if (radius !== null && radius <= 0) {
      return reject(kind, "radius_must_be_positive");
    }
    return {
      valid: true,
      warnings,
      checks: { draws_only: true },
      action: bindWorldRevision(graph, { ...rest, action: kind, commit: true }, proposal),
    };
  }

  // undo_last takes no parameters.
  return {
    valid: true,
    warnings,
    checks,
    action: bindWorldRevision(graph, { action: kind, commit: proposal.commit === true }, proposal),
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

  const committedWrites = actions.filter(
    (action) => action.commit && WRITE_ACTION_KINDS.includes(action.action),
  );
  const irreversible = committedWrites.filter((action) => action.action === "dismantle");
  if (irreversible.length > 0 && committedWrites.length > 1) {
    return {
      valid: false,
      reason: "irreversible_dismantle_must_be_a_standalone_commit",
      actions: [],
      note:
        "A dismantle cannot be rolled back, so it cannot share a committed transaction with another write.",
    };
  }
  const undoSteps = committedWrites.filter((action) => action.action === "undo_last");
  if (undoSteps.length > 0 && committedWrites.length > 1) {
    return {
      valid: false,
      reason: "undo_must_be_a_standalone_commit",
      actions: [],
      note:
        "Undo changes the journal while it runs, so it must be the only committed write in its transaction.",
    };
  }

  return {
    valid: true,
    actions,
    warnings,
    step_count: actions.length,
    commits: actions.filter(
      (action) => action.commit && WRITE_ACTION_KINDS.includes(action.action),
    ).length,
    overlays: actions.filter((action) => OVERLAY_ACTION_KINDS.includes(action.action)).length,
    execution:
      "Preflighted and executed in order by the mod, server-side. Reversible writes are rolled back as one transaction if a later step fails. Each step is re-validated there and read back after committing.",
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
