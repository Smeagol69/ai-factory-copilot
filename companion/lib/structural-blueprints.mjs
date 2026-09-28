/** Architectural shells without a production target. Native serialization and
 * destination placement remain game operations, not promises from this planner. */
import { parsePieceDimensions } from "./architecture.mjs";
import { compileGeneratedBlueprint, generatedBlueprintAction } from "./generated-blueprints.mjs";
import { validatePlan } from "./actions.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const near = (a, b) => Math.abs(a - b) <= 1;

// Recover local axis-aligned geometry only from an upright, unit-scale observed
// actor. Inverting a rotated world AABB is singular at 45 degrees; skip those
// samples. Zero bounds from pooled lightweight proxies are never measurements.
function measuredPiece(graph, item, dimensions, kind) {
  for (const actor of graph.snapshot?.actors ?? []) {
    if (actor.class_path !== item.building?.class_path) continue;
    const { location: p, rotation: r, scale, bounds } = actor;
    const e = bounds?.extent, o = bounds?.origin;
    if (![p?.x, p?.y, p?.z, r?.yaw, r?.pitch, r?.roll,
      scale?.x, scale?.y, scale?.z, e?.x, e?.y, e?.z, o?.x, o?.y, o?.z].every(finite) ||
      Math.abs(r.pitch) > 0.001 || Math.abs(r.roll) > 0.001 ||
      [scale.x, scale.y, scale.z].some(v => Math.abs(v - 1) > 0.000001) ||
      [e.x, e.y, e.z].some(v => v <= 0)) continue;
    const angle = r.yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const ac = Math.abs(c), as = Math.abs(s), det = ac * ac - as * as;
    if (Math.abs(det) < 0.15) continue;
    const x = 2 * (ac * e.x - as * e.y) / det;
    const y = 2 * (ac * e.y - as * e.x) / det;
    const dx = o.x - p.x, dy = o.y - p.y;
    if (!near(dx * c + dy * s, 0) || !near(-dx * s + dy * c, 0) ||
      !near(e.z * 2, dimensions.height_cm) || x <= 0 || y <= 0) continue;
    if (kind === "floor" && (!near(x, dimensions.width_cm) || !near(y, dimensions.width_cm))) continue;
    if (kind === "wall" && (!near(Math.max(x, y), dimensions.width_cm) ||
      Math.min(x, y) >= dimensions.width_cm / 4)) continue;
    return { actor_id: actor.actor_id, local_size_cm: { x, y, z: e.z * 2 },
      local_min_z_cm: o.z - p.z - e.z, wall_long_axis: x > y ? "x" : "y",
      source: "captured_upright_unit_scale_actor_bounds_inverse_yaw" };
  }
  return null;
}

function resolvePiece(graph, requested, kind) {
  const items = graph.itemsByClass ?? new Map();
  const candidates = (graph.snapshot?.content?.recipes ?? []).flatMap(recipe => {
    if (requested && requested !== recipe.class_path) return [];
    if (recipe.available !== true || !(recipe.produced_in ?? []).some(p => /BuildGun/.test(p))) return [];
    const item = items.get(recipe.products?.[0]?.item_class);
    const path = item?.building?.class_path ?? "";
    // Only native flat rectangular pieces have a supported shape adapter here.
    // Curved/tilted/modded meshes and props are not rectangular just because
    // their descriptor contains dimensions. They stay available in the catalog.
    const supported = kind === "floor"
      ? /^\/Game\/FactoryGame\/Buildable\/Building\/Foundation\/.*\/Build_Foundation_(?:Concrete_|Asphalt_)?\d+x\d+(?:_\d+)?\.Build_/.test(path)
      : /^\/Game\/FactoryGame\/Buildable\/Building\/Wall\/.*\/Build_Wall_(?:Concrete_|Metal_)?\d+x\d+(?:_\d+)?\.Build_/.test(path);
    const descriptor = String(item?.class_path ?? "").split(".").pop()?.replace(/_C$/, "");
    const dimensions = parsePieceDimensions(descriptor);
    if (!supported || !dimensions || dimensions.height_cm <= 0 || dimensions.width_cm <= 0) return [];
    const measurement = measuredPiece(graph, item, dimensions, kind);
    return measurement ? [{ recipe_class: recipe.class_path, name: recipe.name,
      item_class: item.class_path, buildable_class: path, dimensions, measurement }] : [];
  });
  candidates.sort((a, b) => Number(!a.buildable_class.includes("Concrete")) - Number(!b.buildable_class.includes("Concrete")) ||
    (kind === "floor" ? a.dimensions.height_cm - b.dimensions.height_cm : b.dimensions.height_cm - a.dimensions.height_cm) ||
    a.recipe_class.localeCompare(b.recipe_class));
  return candidates[0] ?? null;
}

export function compileStructuralBlueprint(graph, args = {}) {
  const fail = (reason, extra = {}) => ({ solver: "structural_blueprint", compiled: false,
    reason, source: "captured_catalog_and_actor_geometry", certainty: "unknown", ...extra });
  const { width_cells: width = 2, depth_cells: depth = 1, wall_courses: courses = 2,
    open_ends: ends = "both", commit = false } = args;
  if (![width, depth, courses].every(v => Number.isInteger(v) && v >= 1 && v <= 6)) {
    return fail("shell_dimensions_must_be_whole_cells_or_courses_from_1_to_6");
  }
  if (!["both", "front"].includes(ends)) return fail("shell_open_ends_must_be_both_or_front");
  if (typeof commit !== "boolean") return fail("shell_commit_must_be_boolean");
  for (const key of ["foundation_recipe_class", "wall_recipe_class"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].trim())) {
      return fail("shell_explicit_recipe_must_be_a_nonempty_class_path", { field: key });
    }
  }
  if (graph.snapshot?.content?.availability_known !== true) return fail("shell_requires_current_recipe_availability_capture");
  const floor = resolvePiece(graph, args.foundation_recipe_class, "floor");
  const wall = resolvePiece(graph, args.wall_recipe_class, "wall");
  if (!floor || !wall) return fail("shell_requires_supported_unlocked_flat_foundation_and_wall_with_measured_pivots", {
    missing: [...(!floor ? ["foundation"] : []), ...(!wall ? ["wall"] : [])],
    note: "The catalog may contain the piece even when current recipe or upright unit-scale mesh evidence is missing. Place/capture a supported flat piece; do not infer its pivot from the name.",
  });
  const cell = floor.dimensions.width_cm;
  if (wall.dimensions.width_cm !== cell) return fail("shell_wall_width_must_match_foundation_grid");
  const floorHeight = floor.measurement.local_size_cm.z;
  const wallHeight = wall.dimensions.height_cm;
  const roofBottom = floorHeight + courses * wallHeight;
  const actions = [];
  const add = (piece, role, x, y, bottom, yaw = 0) => actions.push({ action: "place_building",
    recipe_class: piece.recipe_class, generated_role: role, exact_z: true, commit: false,
    location: { x, y, z: bottom - piece.measurement.local_min_z_cm }, yaw });
  for (let x = 0; x < width; x++) for (let y = 0; y < depth; y++) {
    add(floor, "floor", (x + 0.5) * cell, (y + 0.5) * cell, 0);
    add(floor, "roof", (x + 0.5) * cell, (y + 0.5) * cell, roofBottom);
  }
  const sideYaw = wall.measurement.wall_long_axis === "y" ? 0 : 90;
  for (let level = 0; level < courses; level++) {
    const z = floorHeight + level * wallHeight;
    for (let y = 0; y < depth; y++) {
      add(wall, "wall", 0, (y + 0.5) * cell, z, sideYaw);
      add(wall, "wall", width * cell, (y + 0.5) * cell, z, (sideYaw + 180) % 360);
    }
    if (ends === "front") for (let x = 0; x < width; x++) {
      add(wall, "wall", (x + 0.5) * cell, depth * cell, z, (sideYaw + 90) % 360);
    }
  }
  const compiled = compileGeneratedBlueprint({ blueprint_name: args.blueprint_name, actions,
    origin_cm: { x: 0, y: 0, z: 0 }, schema: "aifactory.generated-blueprint/v1",
    description: `AI Architect rectangular shell; ${width} x ${depth} foundation cells, ${courses} wall courses; ${ends} end(s) open. No props or excavation.` });
  if (!compiled.compiled) return fail(compiled.reason);
  const action = generatedBlueprintAction(compiled, { commit });
  const checked = validatePlan(graph, [action]);
  if (!checked.valid) return fail("shell_native_action_preflight_refused", { validation: checked });
  return { solver: "structural_blueprint", compiled: true, world_revision: graph.world_revision,
    source: "captured_recipes_descriptor_dimensions_and_measured_actor_pivots",
    certainty: "deterministic_shell_pending_native_serialization_and_readback",
    blueprint_name: compiled.blueprint_name, pieces: { floor, wall },
    dimensions: { width_cells: width, depth_cells: depth, wall_courses: courses, open_ends: ends,
      wall_centerline_width_cm: width * cell, grid_length_cm: depth * cell,
      nominal_internal_height_cm: courses * wallHeight, floor_thickness_cm: floorHeight },
    part_count: actions.length, buildables: compiled.buildables, action: checked.actions[0],
    limitations: ["rectangular_shell_only_no_decorations_or_connections", "native_bounds_and_blueprint_save_readback_pending",
      "world_placement_and_cave_clearance_not_checked", "does_not_excavate_terrain", "does_not_modify_existing_construction"],
  };
}
