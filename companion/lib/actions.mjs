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
import { lastPreview } from "./selection.mjs";

/**
 * How many actions one reply may carry.
 *
 * 64 was fine while a plan meant a handful of machines. A building is not: a
 * housed factory on the live save is 205 pieces — floors, pillars, walls, roof
 * and the machines inside — and the cap silently refused the whole thing, so
 * the route fell through to a model and the player got nothing.
 *
 * The limit still exists to stop a runaway plan, but it has to be large enough
 * for the real work. It is deliberately not unbounded, and the mod enforces its
 * own cap independently — two limits, and the one that owns the world decides.
 */
export const DEFAULT_MAX_ACTIONS = 512;

/** Actions that change the world. Kept in sync with AIFactoryActions.cpp. */
export const WRITE_ACTION_KINDS = [
  "teleport_player",
  "place_building",
  "place_blueprint",
  // Exports the exact set the player marked with the game's dismantle tool as
  // a native .sbp. This writes a durable file, so it is a write even though it
  // does not place or remove anything in the world.
  "export_native_blueprint",
  // Runs a conveyor between two existing connection components. `plan_belt_route`
  // chooses and measures the pair; this builds it. Addressed by connection
  // component rather than by actor, because an actor id does not say which of a
  // machine's ports was meant.
  "place_belt",
  "dismantle",
  "undo_last",
  // Puts items straight into the player's inventory. Creative by nature, which
  // is exactly what was asked for — but it is still a write: gated, stamped,
  // dry-runnable, and reversible by taking back only what actually landed.
  "give_item",
  // The game's own map markers, used instead of reimplementing the compass
  // distance readout the resource scanner already shows.
  //
  // These look like drawings and were briefly classified as such, which was
  // wrong twice over: `FMapMarker` is a `SaveGame` property, so a waypoint
  // survives a reload, and the clear path then ran on a dry run — a "show me
  // what this would do" that deleted things. Persistent state is a write, and
  // a write is gated, stamped, and honours a dry run.
  "waypoint",
  "clear_waypoints",
];

/**
 * Actions that only draw. These change nothing, so they are never gated behind
 * the write switch and never need confirming.
 */
// Removing a hologram costs nothing: it is a preview, never built and never
// saved. So it is not write-gated and needs no confirmation.
export const OVERLAY_ACTION_KINDS = ["highlight", "clear_highlight", "clear_holograms"];

/** Everything the mod knows how to execute. */

/**
 * Actions that affect only the requesting player's local controls.
 *
 * `preview_blueprint` deliberately constructs nothing. The server verifies
 * the saved blueprint, then sends the owning client a small RCO message and
 * that client selects the Blueprint recipe in its own Build Gun. The
 * hologram, snapping, rotation, affordability and eventual construction all
 * stay Satisfactory's, which is the entire point -- it is the vanilla
 * placement experience, reached from here.
 */
export const CLIENT_ACTION_KINDS = ["preview_blueprint"];
export const ACTION_KINDS = [
  ...WRITE_ACTION_KINDS,
  ...OVERLAY_ACTION_KINDS,
  ...CLIENT_ACTION_KINDS,
];

/** Beyond this the player almost certainly meant something else. */
const MAX_TELEPORT_METERS = 200_000;
const MAX_PLACEMENT_REACH_METERS = 5_000;
/**
 * A cap on one give, not on generosity.
 *
 * The point is to catch a slipped decimal — "500000 iron plate" is a typo, not
 * a request — while leaving any amount a player would actually want. Ask twice
 * if you genuinely want more.
 */
const MAX_ITEMS_PER_GIVE = 50_000;

/** Finds an item by class path, class name, or display name, in that order. */
function findItemInCatalog(graph, requested) {
  const items = graph?.snapshot?.content?.items ?? [];
  const needle = requested.toLowerCase();
  const shortOf = (path) => String(path ?? "").split(".").pop()?.toLowerCase() ?? "";

  return (
    items.find((item) => item.class_path === requested) ??
    items.find((item) => shortOf(item.class_path) === needle) ??
    items.find((item) => shortOf(item.class_path) === `${needle}_c`) ??
    items.find((item) => String(item.name ?? "").toLowerCase() === needle) ??
    // Last resort: a unique substring match. Ambiguity is treated as no match,
    // because handing over the wrong item is worse than asking again.
    (() => {
      const partial = items.filter((item) =>
        String(item.name ?? "").toLowerCase().includes(needle),
      );
      return partial.length === 1 ? partial[0] : null;
    })() ??
    null
  );
}

function nearestItemNames(graph, requested) {
  const needle = requested.toLowerCase();
  // Match on any word of the request, so "iron plates" still suggests "Iron
  // Plate". The reverse test — item name inside the request — was tried and
  // removed: it matched "Tan" inside "unobtanium" and suggested nonsense.
  const words = needle.split(/\s+/).filter((word) => word.length >= 3);
  const matches = [];
  for (const item of graph?.snapshot?.content?.items ?? []) {
    const name = String(item.name ?? "").trim();
    if (!name) continue;
    const lowered = name.toLowerCase();
    if (lowered.includes(needle) || words.some((word) => lowered.includes(word))) {
      matches.push(item);
    }
  }

  // A live modded catalog put unavailable RF_INVALID decoration descriptors
  // before the real unlocked item. Keep every kind of match eligible, but make
  // the first example the player is invited to type the most actionable one.
  matches.sort((a, b) => {
    const available = Number(b.available === true) - Number(a.available === true);
    if (available !== 0) return available;
    const validForm = Number(String(a.form ?? "").toUpperCase() === "RF_INVALID") -
      Number(String(b.form ?? "").toUpperCase() === "RF_INVALID");
    if (validForm !== 0) return validForm;
    const aName = String(a.name ?? "").trim();
    const bName = String(b.name ?? "").trim();
    return aName.length - bName.length || aName.localeCompare(bName);
  });

  const names = [];
  const seen = new Set();
  for (const item of matches) {
    const name = String(item.name ?? "").trim();
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= 5) break;
  }
  return names;
}

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

/** A bounds vector has three dimensions; silently making its Z zero corrupts a blueprint envelope. */
function explicitVector(input) {
  const result = vector(input);
  return result && finite(input?.z) !== null ? result : null;
}

/**
 * The bridge does not get to make up a factory region. The only v1 export
 * source is the exact set the player has marked in Satisfactory's dismantle
 * state. It is deliberately a selection rather than a radius: a radius would
 * sweep in neighbouring factories, power lines, or scenery that the player
 * did not ask to package.
 *
 * The emitted envelope is a capture witness, not an instruction for the game.
 * The native executor must re-resolve every actor and recompute these bounds
 * immediately before calling the BlueprintSubsystem; the bridge cannot know
 * about a proxy, lightweight instance, or resource anchor that changed after
 * this capture.
 */
function resolveNativeBlueprintExportSelection(graph, proposedIds) {
  const selection = graph?.snapshot?.interaction_context?.dismantle_selection;
  if (selection?.available !== true) {
    return { ok: false, reason: "dismantle_selection_is_not_available" };
  }

  if (!Array.isArray(proposedIds) || proposedIds.length === 0) {
    return { ok: false, reason: "selected_actor_ids_are_required" };
  }

  const markedIds = Array.isArray(selection.actor_ids)
    ? selection.actor_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  if (markedIds.length === 0) {
    return { ok: false, reason: "dismantle_selection_is_empty" };
  }
  if (new Set(markedIds).size !== markedIds.length) {
    return { ok: false, reason: "dismantle_selection_has_duplicate_actor_ids" };
  }

  const selectionCount = finite(selection.count);
  if (selectionCount !== null && (!Number.isInteger(selectionCount) || selectionCount !== markedIds.length)) {
    return {
      ok: false,
      reason: "dismantle_selection_count_does_not_match_actor_ids",
      selection_count: selection.count,
      actor_id_count: markedIds.length,
    };
  }

  const requestedIds = proposedIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (requestedIds.length !== proposedIds.length || new Set(requestedIds).size !== requestedIds.length) {
    return { ok: false, reason: "selected_actor_ids_must_be_unique_nonempty_strings" };
  }
  const markedSet = new Set(markedIds);
  if (requestedIds.length !== markedIds.length || requestedIds.some((id) => !markedSet.has(id))) {
    return {
      ok: false,
      reason: "selected_actor_ids_must_exactly_match_dismantle_selection",
      marked_actor_count: markedIds.length,
      requested_actor_count: requestedIds.length,
    };
  }

  const minimum = { x: Infinity, y: Infinity, z: Infinity };
  const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
  const missingActors = [];
  const nonBuildables = [];
  const missingBounds = [];

  for (const actorId of markedIds) {
    const raw = graph?.nodes?.get(actorId)?.raw;
    if (!raw) {
      missingActors.push(actorId);
      continue;
    }
    if (raw.kind !== "buildable") {
      nonBuildables.push(actorId);
      continue;
    }
    const origin = explicitVector(raw.bounds?.origin);
    const extent = explicitVector(raw.bounds?.extent);
    if (!origin || !extent || extent.x < 0 || extent.y < 0 || extent.z < 0) {
      missingBounds.push(actorId);
      continue;
    }
    for (const axis of ["x", "y", "z"]) {
      minimum[axis] = Math.min(minimum[axis], origin[axis] - extent[axis]);
      maximum[axis] = Math.max(maximum[axis], origin[axis] + extent[axis]);
    }
  }

  if (missingActors.length > 0) {
    return { ok: false, reason: "selected_actor_is_not_in_the_captured_world", actor_ids: missingActors };
  }
  if (nonBuildables.length > 0) {
    return { ok: false, reason: "native_blueprint_selection_contains_non_buildables", actor_ids: nonBuildables };
  }
  if (missingBounds.length > 0) {
    return { ok: false, reason: "selected_actor_bounds_are_not_captured", actor_ids: missingBounds };
  }

  return {
    ok: true,
    actorIds: markedIds,
    bounds: { minimum, maximum, units: "unreal_centimeters" },
  };
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
    const availabilityKnown = graph?.snapshot?.content?.availability_known === true;
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
      if (known.available === false || (availabilityKnown && known.available !== true)) {
        return reject(kind, known.available === false
          ? "build_recipe_is_not_unlocked"
          : "build_recipe_unlock_is_not_proven", {
          recipe_class: known.class_path ?? recipeClass,
          building_name: known.name ?? null,
        });
      }
      checks.build_recipe_availability =
        typeof known.available === "boolean" ? known.available : "game_rechecks";
    }

    // Keep recipe assignment inside placement. A newly constructed
    // manufacturer is the one moment the game can prove compatibility while
    // both inventories are guaranteed to be empty, and rollback can still
    // dismantle the configured machine as part of the same transaction.
    const requestedProductionRecipe = String(
      proposal.production_recipe_class ?? "",
    ).trim();
    let resolvedProductionRecipe = null;
    if (requestedProductionRecipe) {
      resolvedProductionRecipe =
        catalog.get(requestedProductionRecipe) ??
        findRecipeByShortName(catalog, requestedProductionRecipe);
      if (catalog.size > 0 && !resolvedProductionRecipe) {
        return reject(kind, "production_recipe_not_in_catalog", {
          production_recipe_class: requestedProductionRecipe,
          did_you_mean: nearestRecipeNames(catalog, requestedProductionRecipe),
        });
      }
      if (
        resolvedProductionRecipe &&
        (resolvedProductionRecipe.available === false ||
          (availabilityKnown && resolvedProductionRecipe.available !== true))
      ) {
        return reject(kind, resolvedProductionRecipe.available === false
          ? "production_recipe_is_not_unlocked"
          : "production_recipe_unlock_is_not_proven", {
          production_recipe_class:
            resolvedProductionRecipe.class_path ?? requestedProductionRecipe,
        });
      }
      checks.production_recipe_name = resolvedProductionRecipe?.name ?? null;
      checks.production_recipe_availability =
        typeof resolvedProductionRecipe?.available === "boolean"
          ? resolvedProductionRecipe.available
          : "game_rechecks";
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

    // What the building goes *on*, when the caller knows.
    //
    // A miner placed on BP_ResourceNode213 was refused with
    // hologram_disqualified:FGCDInitializing. The mod traces downward to find a
    // build surface, and the trace struck StaticMeshActor_8276 -- the terrain
    // mesh beside the node. The hologram was positioned correctly and attached
    // to a rock, so it never bound to the node and never finished initialising.
    // A trace finds a surface; it does not find a target.
    const targetActorId = String(proposal.target_actor_id ?? "").trim();
    const hasTargetStep = proposal.target_step !== undefined && proposal.target_step !== null;
    const targetStepValue = finite(proposal.target_step);
    if (targetActorId && hasTargetStep) {
      return reject(kind, "placement_target_must_use_actor_or_step_not_both");
    }
    if (
      hasTargetStep &&
      (targetStepValue === null || !Number.isInteger(targetStepValue) || targetStepValue < 1)
    ) {
      return reject(kind, "target_step_must_be_a_positive_whole_step_number");
    }
    if (targetActorId) checks.placement_target_actor_id = targetActorId;
    if (targetStepValue !== null) checks.placement_target_step = targetStepValue;

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
        // Waives overlap objections only, and only when asked. A design built
        // with clearance off has foundations intersecting machines by intent.
        ...(proposal.ignore_clearance === true ? { ignore_clearance: true } : {}),
        // Place at the Z given rather than on traced ground. A saved design
        // means its heights literally; a single building usually does not.
        ...(proposal.exact_z === true ? { exact_z: true } : {}),
        ...(targetActorId ? { target_actor_id: targetActorId } : {}),
        ...(targetStepValue !== null ? { target_step: targetStepValue } : {}),
        ...(requestedProductionRecipe
          ? {
              production_recipe_class:
                resolvedProductionRecipe?.class_path ?? requestedProductionRecipe,
            }
          : {}),
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

  if (kind === "preview_blueprint") {
    const name = String(proposal.blueprint_name ?? "").trim();
    if (!name) return reject(kind, "blueprint_name_is_required");

    // This is a client-only selection, not a server construction request. The
    // bridge normally has the library service and can catch spelling mistakes
    // here; the game repeats the descriptor lookup immediately before it sends
    // the owning client's RCO message.
    const library = graph?.services?.blueprints ?? null;
    if (Array.isArray(library) && library.length > 0) {
      const match = library.find((entry) => entry.name === name);
      if (!match) {
        const needle = name.toLowerCase();
        const near = library
          .filter((entry) => String(entry.name).toLowerCase().includes(needle))
          .slice(0, 5)
          .map((entry) => entry.name);
        return reject(kind, "blueprint_not_in_library", {
          blueprint_name: name,
          did_you_mean: near,
        });
      }
      checks.designer_dimensions = match.designer_dimensions;
      checks.build_cost_entries = match.build_cost?.length ?? 0;
    }

    return {
      valid: true,
      warnings,
      checks: { ...checks, client_only: true, world_write: false },
      // This is intentionally always dispatched. It is equivalent to opening
      // the Build Gun's native blueprint picker, and never performs a world
      // write, spends items, changes the undo stack, or needs a revision stamp.
      action: { action: kind, blueprint_name: name, commit: true },
    };
  }

  if (kind === "export_native_blueprint") {
    const name = String(proposal.blueprint_name ?? "").trim();
    if (!name) return reject(kind, "blueprint_name_is_required");

    // Do not accept a model-proposed box, radius, or arbitrary actor list.
    // The player made this selection in the game's own multi-select tool, and
    // its captured membership is the only source this action serialises.
    // Two sources, both player-made. The dismantle tool is the game's own
    // multi-select. A box selection is one the player sized and saw lit up in
    // their world before confirming -- the preview is the consent, and it is
    // verified here against what was actually shown rather than trusted from
    // the proposal. A model still cannot invent a region: ids that were never
    // previewed are refused exactly as an arbitrary list always was.
    if (proposal.selection_source === "box_selection") {
      const preview = lastPreview();
      if (!preview || preview.actor_ids.length === 0) {
        return reject(kind, "box_selection_requires_a_preview_first");
      }
      const shown = new Set(preview.actor_ids);
      const asked = Array.isArray(proposal.selected_actor_ids) ? proposal.selected_actor_ids : [];
      const unseen = asked.filter((id) => !shown.has(String(id)));
      if (asked.length === 0 || unseen.length > 0) {
        return reject(kind, "box_selection_must_match_what_was_previewed", {
          previewed: preview.actor_ids.length,
          requested: asked.length,
          not_previewed: unseen.length,
        });
      }
    } else if (proposal.selection_source !== "dismantle_selection") {
      return reject(kind, "native_blueprint_export_requires_a_player_made_selection");
    }
    // Each source resolves its own way. The dismantle resolver checks the
    // proposal against the capture's live multi-select, which a previewed box
    // does not have and never will -- running it here refused every box
    // export with `dismantle_selection_is_not_available`.
    let selection;
    if (proposal.selection_source === "box_selection") {
      const previewed = lastPreview();
      selection = {
        ok: true,
        actorIds: proposal.selected_actor_ids.map((id) => String(id)),
        bounds: previewed?.box ?? null,
      };
    } else {
      selection = resolveNativeBlueprintExportSelection(graph, proposal.selected_actor_ids);
      if (!selection.ok) return reject(kind, selection.reason, selection);
    }

    warnings.push(
      "This is a request to the native game-side exporter, not proof that an .sbp was written. " +
        "The game re-checks every selected actor, proxy group, lightweight instance, resource anchor, " +
        "and archive write before reporting an outcome.",
    );
    return {
      valid: true,
      warnings,
      checks: {
        ...checks,
        selection_source: proposal.selection_source,
        selected_actor_count: selection.actorIds.length,
        captured_selection_bounds_cm: selection.bounds,
        bounds_are_capture_evidence_only: true,
        arbitrary_export_size_cap: "none",
      },
      action: bindWorldRevision(
        graph,
        {
          action: kind,
          blueprint_name: name,
          selection_source: proposal.selection_source,
          selected_actor_ids: selection.actorIds,
          selected_actor_count: selection.actorIds.length,
          // The executor must recompute this from the live actors. Carrying the
          // capture's bounds makes a stale or unexpectedly expanded selection
          // diagnosable without treating bridge geometry as authority.
          captured_selection_bounds_cm: selection.bounds,
          commit: proposal.commit === true,
        },
        proposal,
      ),
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

  if (kind === "place_belt") {
    const recipeClass = String(proposal.recipe_class ?? "").trim();
    const fromComponent = String(proposal.from_component ?? "").trim();
    const toComponent = String(proposal.to_component ?? "").trim();

    // An endpoint can be named three ways, in descending order of certainty:
    // a connection component (exact), an actor (the executor picks a free
    // port), or an earlier step in this same plan (the executor resolves it
    // from what that step built).
    //
    // The third exists because a belt in a whole-base plan cannot name
    // components for machines that do not exist when the plan is written. That
    // is the only thing standing between "here is a factory design" and "here
    // is a factory", so it is a first-class way to address an endpoint rather
    // than a special case.
    const fromActor = String(proposal.from_actor_id ?? "").trim();
    const toActor = String(proposal.to_actor_id ?? "").trim();
    const fromStep = finite(proposal.from_step);
    const toStep = finite(proposal.to_step);

    const fromSelectorCount = [fromComponent, fromActor, fromStep].filter(
      (value) => value !== "" && value !== null,
    ).length;
    const toSelectorCount = [toComponent, toActor, toStep].filter(
      (value) => value !== "" && value !== null,
    ).length;
    if (fromSelectorCount > 1 || toSelectorCount > 1) {
      return reject(
        kind,
        "each_end_must_use_exactly_one_component_actor_or_step",
        { from_selectors: fromSelectorCount, to_selectors: toSelectorCount },
      );
    }

    const hasFrom = Boolean(fromComponent || fromActor) || fromStep !== null;
    const hasTo = Boolean(toComponent || toActor) || toStep !== null;

    if (!recipeClass) return reject(kind, "recipe_class_is_required");

    const catalog = graph?.recipesByClass ?? new Map();
    const availabilityKnown = graph?.snapshot?.content?.availability_known === true;
    const known = catalog.get(recipeClass) ?? findRecipeByShortName(catalog, recipeClass);
    const builtSomethingHere = recipeIsInUse(graph, recipeClass);
    if (catalog.size > 0 && !known && !builtSomethingHere) {
      return reject(kind, "belt_recipe_not_in_catalog", {
        recipe_class: recipeClass,
        did_you_mean: nearestRecipeNames(catalog, recipeClass),
      });
    }
    if (
      known &&
      (known.available === false || (availabilityKnown && known.available !== true))
    ) {
      return reject(kind, known.available === false
        ? "belt_recipe_is_not_unlocked"
        : "belt_recipe_unlock_is_not_proven", {
        recipe_class: known.class_path ?? recipeClass,
        recipe_name: known.name ?? null,
      });
    }
    const resolvedRecipeClass = known?.class_path ?? recipeClass;
    checks.belt_recipe_availability = known?.available === true
      ? true
      : "game_rechecks";
    if (known?.name) checks.belt_recipe_name = known.name;

    if (!hasFrom || !hasTo) {
      return reject(kind, "each_end_needs_a_component_actor_or_step");
    }
    if (fromComponent && fromComponent === toComponent) {
      return reject(kind, "a_belt_needs_two_different_connections");
    }
    if (fromStep !== null && fromStep === toStep) {
      return reject(kind, "a_belt_needs_two_different_steps");
    }
    // Steps are 1-based and can only refer backwards: a belt cannot be built
    // from something later in the plan than itself.
    for (const [label, step] of [["from_step", fromStep], ["to_step", toStep]]) {
      if (step !== null && (!Number.isInteger(step) || step < 1)) {
        return reject(kind, `${label}_must_be_a_positive_whole_step_number`);
      }
    }

    // The route planner already knows whether these ports exist, face each
    // other, and are free. Re-deriving that here would be a second opinion on
    // data the mod is about to re-check anyway against the *live* world, which
    // is the only check that counts — a port can be belted by the player
    // between the snapshot and the write.
    return {
      valid: true,
      warnings: [
        ...warnings,
        "Belt length, bend radius, incline and clearance are decided by the game's " +
          "conveyor hologram; anything it refuses is reported as refused.",
      ],
      checks: {
        ...checks,
        endpoints_rechecked_by: "the mod, against the live world",
      },
      action: bindWorldRevision(
        graph,
        {
          action: kind,
          recipe_class: resolvedRecipeClass,
          // Only the endpoint forms that were actually given travel onward, so
          // the executor is never handed an empty string to resolve.
          ...(fromComponent ? { from_component: fromComponent } : {}),
          ...(toComponent ? { to_component: toComponent } : {}),
          ...(fromActor ? { from_actor_id: fromActor } : {}),
          ...(toActor ? { to_actor_id: toActor } : {}),
          ...(fromStep !== null ? { from_step: fromStep } : {}),
          ...(toStep !== null ? { to_step: toStep } : {}),
          commit: proposal.commit === true,
        },
        proposal,
      ),
    };
  }

  if (kind === "give_item") {
    const requested = String(proposal.item_class ?? proposal.item_name ?? "").trim();
    if (!requested) return reject(kind, "item_class_or_item_name_is_required");

    const count = finite(proposal.count) ?? 1;
    if (!Number.isInteger(count) || count <= 0) {
      return reject(kind, "count_must_be_a_positive_whole_number");
    }
    if (count > MAX_ITEMS_PER_GIVE) {
      return reject(kind, "count_is_implausibly_large", { limit: MAX_ITEMS_PER_GIVE });
    }

    // Resolve against the catalog the game actually reported, so a misspelled
    // or modded-away item is refused here with suggestions rather than
    // bouncing off the mod with a bare class-not-found.
    const resolved = findItemInCatalog(graph, requested);
    if (!resolved) {
      return reject(kind, "no_such_item", { closest: nearestItemNames(graph, requested) });
    }

    return {
      valid: true,
      warnings,
      checks: {
        ...checks,
        item_name: resolved.name,
        // The mod adds partially and reports what landed; the bridge cannot see
        // free inventory slots, so it does not pretend to.
        inventory_space: "unknown until the mod adds them",
      },
      action: bindWorldRevision(
        graph,
        { action: kind, item_class: resolved.class_path, count, commit: proposal.commit === true },
        proposal,
      ),
    };
  }

  if (kind === "waypoint") {
    // A waypoint without a position is a pin silently dropped at the world
    // origin — a wrong answer that looks like a success, which is worse than
    // an error the player can see.
    const location = vector(proposal.location);
    if (!location || finite(proposal.location?.z) === null) {
      return reject(kind, "location_must_be_an_xyz_object_with_an_explicit_z");
    }
    const name = String(proposal.name ?? "").trim().slice(0, 120);
    return {
      valid: true,
      warnings,
      checks: { ...checks, persists_in_the_save: true },
      action: bindWorldRevision(
        graph,
        {
          action: kind,
          location,
          ...(name ? { name } : {}),
          commit: proposal.commit === true,
        },
        proposal,
      ),
    };
  }

  if (kind === "clear_waypoints") {
    const nameFilter = String(proposal.name_contains ?? "").trim().slice(0, 120);
    return {
      valid: true,
      warnings: [
        ...warnings,
        "Removed map markers are not restored by undo.",
      ],
      checks: { ...checks, removes_only_copilot_markers: true },
      action: bindWorldRevision(
        graph,
        {
          action: kind,
          ...(nameFilter ? { name_contains: nameFilter } : { all: true }),
          commit: proposal.commit === true,
        },
        proposal,
      ),
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
export function validatePlan(graph, proposals, { maxActions = DEFAULT_MAX_ACTIONS } = {}) {
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

    // A step endpoint is meaningful only inside this plan. Validate the graph
    // here, where the referenced proposals are still available, rather than
    // letting the game mutate earlier steps and discover a forward/non-creator
    // reference only when it reaches the belt. The game repeats these checks.
    if (result.action.action === "place_belt") {
      for (const field of ["from_step", "to_step"]) {
        const referencedStep = result.action[field];
        if (referencedStep === undefined) continue;

        if (referencedStep >= index + 1) {
          rejected.push({
            step: index + 1,
            ...reject("place_belt", `${field}_must_refer_to_an_earlier_step`, {
              referenced_step: referencedStep,
            }),
          });
          return;
        }

        const referencedProposal = list[referencedStep - 1];
        if (!["place_building", "place_blueprint"].includes(referencedProposal?.action)) {
          rejected.push({
            step: index + 1,
            ...reject("place_belt", `${field}_must_refer_to_an_actor_creating_step`, {
              referenced_step: referencedStep,
              referenced_action: referencedProposal?.action ?? null,
            }),
          });
          return;
        }

        if (result.action.commit && referencedProposal.commit !== true) {
          rejected.push({
            step: index + 1,
            ...reject("place_belt", `${field}_cannot_commit_from_a_preview_step`, {
              referenced_step: referencedStep,
            }),
          });
          return;
        }
      }
    }
    if (result.action.action === "place_building" && result.action.target_step !== undefined) {
      const referencedStep = result.action.target_step;
      if (referencedStep >= index + 1) {
        rejected.push({
          step: index + 1,
          ...reject("place_building", "target_step_must_refer_to_an_earlier_step", {
            referenced_step: referencedStep,
          }),
        });
        return;
      }
      const referencedProposal = list[referencedStep - 1];
      if (referencedProposal?.action !== "place_building") {
        rejected.push({
          step: index + 1,
          ...reject("place_building", "target_step_must_refer_to_a_building_placement", {
            referenced_step: referencedStep,
            referenced_action: referencedProposal?.action ?? null,
          }),
        });
        return;
      }
      if (result.action.commit && referencedProposal.commit !== true) {
        rejected.push({
          step: index + 1,
          ...reject("place_building", "target_step_cannot_commit_from_a_preview_step", {
            referenced_step: referencedStep,
          }),
        });
        return;
      }
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
  // A native export writes a durable `.sbp` / `.sbpcfg`, not an undo-journal
  // entry. Keep it single-step so an archive failure or name collision cannot
  // be mistaken for a reversible construction transaction.
  const nativeExports = committedWrites.filter(
    (action) => action.action === "export_native_blueprint",
  );
  if (nativeExports.length > 0 && committedWrites.length > 1) {
    return {
      valid: false,
      reason: "native_blueprint_export_must_be_a_standalone_commit",
      actions: [],
      note:
        "A native blueprint export writes a file and cannot be reversed by undo_last, so it must be the only committed write in its transaction.",
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
  const nativeExports = plan.actions.filter(
    (action) => action.action === "export_native_blueprint",
  ).length;

  return {
    ...plan,
    summary: {
      steps: plan.actions.length,
      by_kind: byKind,
      irreversible_steps: irreversible,
      reversible:
        irreversible === 0 && nativeExports === 0
          ? "Every step in this plan can be undone with undo_last."
          : [
              ...(irreversible > 0
                ? [`${irreversible} dismantle step(s) cannot be undone by the copilot.`]
                : []),
              ...(nativeExports > 0
                ? [`${nativeExports} native blueprint export step(s) write files and cannot be undone with undo_last.`]
                : []),
            ].join(" "),
    },
  };
}

/**
 * Phrases in which a reply commits to changing the world.
 *
 * Deliberately narrow: first-person commitments only. "You could build a
 * storage hub here" and "that would place 16 foundations" are advice, and a
 * pattern loose enough to catch them puts a false warning under every design
 * discussion — which teaches the player to ignore the real ones.
 */
export const UNKEPT_PROMISE_PATTERN =
  /\b(?:let me (?:build|place|put|spawn|make|do)|i'll (?:build|place|put|spawn|make|start)|i am (?:now )?(?:building|placing|spawning)|building (?:it|this) (?:for you|now)|placing (?:it|this) now)\b/i;

/**
 * A note to append when a reply promised an action it never sent, or null.
 *
 * Asked for a storage hub, the local model answered "Let me build this for
 * you." and emitted zero actions. Nothing was built, but the reply read like
 * success, so the only way to find out was to go and look at the factory.
 *
 * The grounding gate already refuses unsupported claims about how the world
 * *is*. This covers the other direction: an unsupported promise about what the
 * reply is *about to do*. Solver output is exempt because a solver that emits
 * no actions has already said why.
 */
export function describeUnkeptPromise({ reply, actionCount, answeredBy }) {
  if (answeredBy !== "model") return null;
  if (Number(actionCount) > 0) return null;
  if (!UNKEPT_PROMISE_PATTERN.test(String(reply ?? ""))) return null;
  return (
    "**Nothing was actually built.** That reply promised an action but no " +
    "action was sent to the game, so your world is unchanged. Try phrasing " +
    'it as a direct instruction — for example "build me a storage hub here" ' +
    "— which is handled without a model."
  );
}
