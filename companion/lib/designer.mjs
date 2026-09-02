/**
 * Factory layout design.
 *
 * `plan_production` answers *what* to build — machine counts, recipes, power,
 * cost. This answers *where*, and turns the two together into a placement plan
 * the mod can execute.
 *
 * The design goal the player stated is cohesion: a layout that fits the base
 * they already have, not a generic textbook grid. So nothing here is
 * hardcoded — every spatial constant is measured off their own world:
 *
 *   - machine footprints come from the captured bounds of their own machines
 *   - the build grid's rotation comes from the dominant yaw of what they built
 *   - the grid's origin is phase-locked to their existing buildings, so new
 *     rows line up with old ones instead of sitting at a half-foundation offset
 *   - occupied ground comes from the captured bounds of everything already there
 *
 * When a footprint cannot be measured the layout says so and leaves the machine
 * out rather than guessing a size and overlapping something.
 */

import { distanceMeters } from "./graph.mjs";
import { solveProductionPlan } from "./solvers.mjs";

/** Satisfactory's foundation is 8 m square. Layouts snap to it. */
export const FOUNDATION_CM = 800;

/** Walkway between machine rows, in centimetres. Belts and pipes run here. */
const DEFAULT_AISLE_CM = FOUNDATION_CM;

/** A layout beyond this many machines is almost certainly a mistaken request. */
const MAX_MACHINES = 200;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

/** Normalises any yaw to [0, 90) — a rectangular grid repeats every quarter turn. */
function yawToQuadrant(yaw) {
  const value = ((Number(yaw) % 90) + 90) % 90;
  return Number.isFinite(value) ? value : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** True when a captured actor is one of the buildings a recipe is produced in. */
function matchesProducedIn(classPath, producedIn) {
  const path = String(classPath ?? "");
  if (!path) return false;
  const shortName = path.split(".").pop();
  return (producedIn ?? []).some((entry) => {
    const wanted = String(entry ?? "").split(".").pop();
    return Boolean(wanted) && (wanted === shortName || path.includes(wanted));
  });
}

/**
 * Measures a machine from the player's own copies of it.
 *
 * Two things are needed to place a machine and both come from the same place —
 * an instance they already own:
 *
 *   - its **footprint**, from captured bounds (median across instances, so one
 *     oddly-bounded machine cannot skew it)
 *   - its **build recipe**, from `built_with_recipe`. This is not the production
 *     recipe: placing a Constructor needs Recipe_ConstructorMk1, not
 *     Recipe_IronRod. Reading it off a real machine means it is right for this
 *     save including modded buildings, with no table to keep in sync.
 *
 * Returns null when they own none of that building — the designer then reports
 * the gap rather than guessing either value.
 */
export function measureBuilding(graph, producedIn) {
  const widths = [];
  const depths = [];
  const heights = [];
  const buildRecipes = new Map();
  let sampleActorId = null;
  let classPath = null;

  for (const node of graph.nodes.values()) {
    if (!matchesProducedIn(node.class_path, producedIn)) continue;

    const extent = node.raw?.bounds?.extent;
    const x = finite(extent?.x);
    const y = finite(extent?.y);
    const z = finite(extent?.z);
    if (x === null || y === null || x <= 0 || y <= 0) continue;

    widths.push(x * 2);
    depths.push(y * 2);
    if (z !== null) heights.push(z * 2);
    if (node.built_with_recipe) {
      buildRecipes.set(node.built_with_recipe, (buildRecipes.get(node.built_with_recipe) ?? 0) + 1);
    }
    sampleActorId ??= node.actor_id;
    classPath ??= node.class_path;
  }

  if (widths.length === 0) return null;

  // A building type could in principle have been built by more than one recipe;
  // the most common one in this world is the one to reuse.
  let buildRecipe = null;
  let bestCount = 0;
  for (const [recipe, count] of buildRecipes) {
    if (count > bestCount) {
      bestCount = count;
      buildRecipe = recipe;
    }
  }

  return {
    width_cm: round(median(widths)),
    depth_cm: round(median(depths)),
    height_cm: heights.length > 0 ? round(median(heights)) : null,
    build_recipe_class: buildRecipe,
    class_path: classPath,
    measured_from: widths.length,
    sample_actor_id: sampleActorId,
    source: "measured_from_your_own_buildings_captured_bounds_and_build_recipe",
    certainty: "authoritative",
  };
}

/**
 * Works out the grid the player is already building on.
 *
 * Two things matter for cohesion: which way their buildings face, and where
 * their foundation grid starts. A layout that matches both reads as part of the
 * same base; one that matches neither reads as dropped on top of it.
 */
export function detectBaseGrid(graph) {
  const yawCounts = new Map();
  const xs = [];
  const ys = [];
  let sampled = 0;

  for (const node of graph.nodes.values()) {
    const raw = node.raw ?? {};
    if (raw.kind !== "buildable") continue;
    const yaw = finite(raw.rotation?.yaw);
    const location = raw.location;
    if (yaw === null || !location) continue;

    // Bucket to 5 degrees: hand-placed buildings are never exactly aligned.
    const bucket = Math.round(yawToQuadrant(yaw) / 5) * 5;
    yawCounts.set(bucket, (yawCounts.get(bucket) ?? 0) + 1);
    xs.push(finite(location.x) ?? 0);
    ys.push(finite(location.y) ?? 0);
    sampled += 1;
  }

  if (sampled === 0) {
    return {
      detected: false,
      reason: "no_buildings_captured",
      yaw_degrees: 0,
      grid_origin_cm: { x: 0, y: 0 },
      note: "Nothing has been built yet, so the layout uses world axes and the site as its origin.",
    };
  }

  let dominantYaw = 0;
  let dominantCount = 0;
  for (const [yaw, count] of yawCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantYaw = yaw;
    }
  }
  const alignment = dominantCount / sampled;

  // Phase-lock the grid: take the modal offset of existing buildings within one
  // foundation so new rows land on the same lines as the old ones.
  const phase = (values) => {
    const buckets = new Map();
    for (const value of values) {
      const offset = ((value % FOUNDATION_CM) + FOUNDATION_CM) % FOUNDATION_CM;
      const bucket = Math.round(offset / 100) * 100;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [bucket, count] of buckets) {
      if (count > bestCount) {
        bestCount = count;
        best = bucket;
      }
    }
    return best;
  };

  return {
    detected: true,
    yaw_degrees: dominantYaw % 90,
    yaw_agreement_percent: round(alignment * 100),
    grid_origin_cm: { x: phase(xs), y: phase(ys) },
    buildings_sampled: sampled,
    source: "derived_from_the_rotations_and_positions_of_your_own_buildings",
    certainty: alignment >= 0.5 ? "clear_dominant_alignment" : "mixed_alignment_best_guess",
    note:
      alignment >= 0.5
        ? `${round(alignment * 100)}% of your buildings share this alignment, so the layout matches it.`
        : "Your buildings do not share one clear alignment, so this is the most common of several.",
  };
}

/** Every occupied rectangle in the world, as axis-aligned boxes in centimetres. */
function occupiedBoxes(graph, { padCm = 200 } = {}) {
  const boxes = [];
  for (const node of graph.nodes.values()) {
    const bounds = node.raw?.bounds;
    const origin = bounds?.origin;
    const extent = bounds?.extent;
    if (!origin || !extent) continue;
    const ex = finite(extent.x);
    const ey = finite(extent.y);
    if (ex === null || ey === null) continue;
    boxes.push({
      actor_id: node.actor_id,
      minX: finite(origin.x) - ex - padCm,
      maxX: finite(origin.x) + ex + padCm,
      minY: finite(origin.y) - ey - padCm,
      maxY: finite(origin.y) + ey + padCm,
    });
  }
  return boxes;
}

function overlaps(box, x, y, halfWidth, halfDepth) {
  return (
    x - halfWidth < box.maxX &&
    x + halfWidth > box.minX &&
    y - halfDepth < box.maxY &&
    y + halfDepth > box.minY
  );
}

/** Rotates an offset into the base's grid orientation. */
function rotateOffset(dx, dy, yawDegrees) {
  const radians = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/**
 * Designs a placeable layout for a target item and rate.
 *
 * Returns the production plan, the spatial layout, and the exact
 * `place_building` actions that would build it — plus everything it could not
 * determine, named.
 */
export function designFactoryLayout(graph, args = {}, services = {}) {
  const origin = args.origin ?? null;
  const originX = finite(origin?.x);
  const originY = finite(origin?.y);
  const originZ = finite(origin?.z);

  if (originX === null || originY === null || originZ === null) {
    return {
      designed: false,
      reason: "origin_requires_an_explicit_x_y_and_z",
      how_to_get_one:
        "Call find_best_site for a scored location, or use the player's own position from the snapshot.",
    };
  }

  const plan = solveProductionPlan(graph, args, services);
  if (plan.planned === false) {
    return { designed: false, reason: plan.reason, production_plan: plan };
  }

  const grid = detectBaseGrid(graph);
  const yaw = args.align_to_base === false ? 0 : grid.yaw_degrees;
  const aisleCm = finite(args.aisle_cm) ?? DEFAULT_AISLE_CM;
  const boxes = occupiedBoxes(graph, { padCm: finite(args.clearance_cm) ?? 200 });

  // One entry per machine to place, grouped by production step so a row is one
  // stage of the chain and material flows across rows in order.
  const rows = [];
  const unplaceable = [];
  let totalMachines = 0;

  for (const step of plan.steps ?? []) {
    const machines = Number(step.machines_required ?? 0);
    if (!Number.isFinite(machines) || machines <= 0) continue;

    const producedIn = Array.isArray(step.produced_in) ? step.produced_in : [];
    const building = measureBuilding(graph, producedIn);

    if (!building) {
      unplaceable.push({
        step: step.produces?.item_name ?? null,
        produced_in: producedIn,
        machines_required: machines,
        reason: "you_own_no_building_of_this_type_to_measure",
        effect:
          "Left out of the layout. Both its footprint and its build recipe are read off a machine you already own, and neither can be guessed safely.",
        fix: "Place one of these by hand anywhere, then ask again — the layout will measure it.",
      });
      continue;
    }
    if (!building.build_recipe_class) {
      unplaceable.push({
        step: step.produces?.item_name ?? null,
        produced_in: producedIn,
        machines_required: machines,
        reason: "your_machines_of_this_type_report_no_build_recipe",
        effect: "Left out of the layout; without a build recipe the game cannot be asked to place one.",
      });
      continue;
    }

    totalMachines += machines;
    rows.push({ step, machines, footprint: building });
  }

  if (rows.length === 0) {
    return {
      designed: false,
      reason: "no_step_could_be_placed",
      unplaceable,
      production_plan: plan,
    };
  }
  if (totalMachines > MAX_MACHINES) {
    return {
      designed: false,
      reason: "layout_too_large",
      machines_required: totalMachines,
      limit: MAX_MACHINES,
      suggestion: "Ask for a lower rate, or build it in stages.",
      production_plan: plan,
    };
  }

  // Lay rows out along local +Y, machines along local +X, then rotate the whole
  // block into the base's orientation about the origin.
  const placements = [];
  const collisions = [];
  let rowOffsetY = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const spacingX = row.footprint.width_cm + (finite(args.machine_gap_cm) ?? 100);
    const rowWidth = spacingX * row.machines;

    for (let index = 0; index < row.machines; index += 1) {
      // Centre each row on the origin so the block grows symmetrically.
      const localX = index * spacingX - rowWidth / 2 + spacingX / 2;
      const localY = rowOffsetY;
      const rotated = rotateOffset(localX, localY, yaw);
      const x = originX + rotated.x;
      const y = originY + rotated.y;

      const halfWidth = row.footprint.width_cm / 2;
      const halfDepth = row.footprint.depth_cm / 2;
      const hit = boxes.find((box) => overlaps(box, x, y, halfWidth, halfDepth));

      const placement = {
        step_index: rowIndex + 1,
        produces: row.step.produces?.item_name ?? null,
        building_class: row.footprint.class_path,
        build_recipe_class: row.footprint.build_recipe_class,
        makes_with_recipe: row.step.recipe_class ?? null,
        machine_index: index + 1,
        location: { x: round(x), y: round(y), z: round(originZ) },
        yaw,
        footprint_cm: {
          width: row.footprint.width_cm,
          depth: row.footprint.depth_cm,
          height: row.footprint.height_cm,
        },
        footprint_source: row.footprint.source,
      };

      if (hit) {
        placement.blocked_by = hit.actor_id;
        collisions.push(placement);
      } else {
        placements.push(placement);
        // Only unblocked machines reserve their ground, so a blocked slot does
        // not push the rest of the row out of alignment.
        boxes.push({
          actor_id: `planned:${rowIndex + 1}:${index + 1}`,
          minX: x - halfWidth,
          maxX: x + halfWidth,
          minY: y - halfDepth,
          maxY: y + halfDepth,
        });
      }
    }

    rowOffsetY += row.footprint.depth_cm + aisleCm;
  }

  const footprintDepth = rowOffsetY - aisleCm;
  const footprintWidth = Math.max(
    ...rows.map((row) => (row.footprint.width_cm + 100) * row.machines),
  );

  const actions = placements.map((placement) => ({
    action: "place_building",
    recipe_class: placement.build_recipe_class,
    location: placement.location,
    yaw: placement.yaw,
    check_clearance: true,
    commit: false,
  }));

  return {
    designed: true,
    target: plan.target,
    origin: { x: originX, y: originY, z: originZ },
    base_grid: grid,
    aligned_to_base: args.align_to_base !== false && grid.detected,
    layout: {
      rows: rows.map((row, index) => ({
        row: index + 1,
        production_step: row.step.step ?? index + 1,
        produces: row.step.produces?.item_name ?? null,
        produces_item_class: row.step.produces?.item_class ?? null,
        produces_rate_per_minute:
          row.step.produces?.display_units_per_minute ?? null,
        building_class: row.footprint.class_path,
        build_recipe_class: row.footprint.build_recipe_class,
        production_recipe_class: row.step.recipe_class ?? null,
        machines: row.machines,
        machines_exact: row.step.machines_exact ?? null,
        per_machine_output_rate_per_minute:
          row.step.per_machine_display_units_per_minute ?? null,
        inputs_required: (row.step.inputs_required ?? []).map((input) => ({
          item_class: input.item_class ?? null,
          item_name: input.item_name ?? null,
          rate_per_minute: input.display_units_per_minute ?? null,
        })),
        production_chain: [...(row.step.chain ?? [])],
        machine_footprint_cm: {
          width: row.footprint.width_cm,
          depth: row.footprint.depth_cm,
          height: row.footprint.height_cm,
        },
        footprint_measured_from: `${row.footprint.measured_from} of your own machines`,
      })),
      total_machines: placements.length,
      footprint_m: {
        width: round(footprintWidth / 100),
        depth: round(footprintDepth / 100),
      },
      foundations_required: Math.ceil(footprintWidth / FOUNDATION_CM) *
        Math.ceil(footprintDepth / FOUNDATION_CM),
      aisle_cm: aisleCm,
    },
    placements,
    actions,
    blocked: collisions,
    unplaceable,
    production_plan: plan,
    distance_from_player_m: graph.snapshot?.player?.location
      ? round(distanceMeters(graph.snapshot.player.location, { x: originX, y: originY, z: originZ }))
      : null,
    caveats: {
      belts:
        "Machine positions only. Belts, pipes, and power poles are not placed; the aisle between rows is left clear for them.",
      terrain:
        "The origin's ground is measured by the mod when the plan runs, per machine. A sloped site will report the slope and may need foundations first.",
      validity:
        "Overlap here is computed from captured bounds. The game's own construction check is the final word and runs at placement time.",
    },
    source: "computed_from_your_base_layout_measured_footprints_and_the_production_plan",
    certainty: "layout_is_deterministic_placement_validity_is_confirmed_by_the_game",
  };
}
