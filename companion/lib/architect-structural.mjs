/** No-production structural design adapter for immutable Architect revisions.
 * Pure: reuses the measured compileStructuralBlueprint and its native action;
 * emits nothing and writes nothing. Deliberately imports no revision store. */
import { createHash } from "node:crypto";
import { compileStructuralBlueprint } from "./structural-blueprints.mjs";

export const ARCHITECT_STRUCTURAL_SCHEMA = "architect.structure/v1";
export const ARCHITECT_STRUCTURAL_REQUEST_SCHEMA = "architect.structure-request/v1";

const PARAM_KEYS = ["blueprint_name", "width_cells", "depth_cells", "wall_courses", "open_ends",
  "foundation_recipe_class", "wall_recipe_class"];
const fail = (reason, extra = {}) => ({ solver: "architect_structural", compiled: false, reason,
  source: "captured_catalog_and_actor_geometry", certainty: "unknown", ...extra });
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const hash = value => `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;

function cleanName(value) {
  const name = String(value ?? "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return typeof value === "string" && name && name.length <= 240 ? name : null;
}

// Validate normalized parameters; returns {parameters} or {error}.
function checkParameters(p, { requireRecipes }) {
  const name = cleanName(p.blueprint_name);
  if (!name) return { error: "structural_blueprint_name_must_be_1_to_240_printable_characters" };
  for (const k of ["width_cells", "depth_cells", "wall_courses"]) {
    if (!Number.isInteger(p[k]) || p[k] < 1 || p[k] > 6) {
      return { error: "structural_dimensions_must_be_whole_cells_or_courses_from_1_to_6", field: k };
    }
  }
  if (!["both", "front"].includes(p.open_ends)) return { error: "structural_open_ends_must_be_both_or_front" };
  for (const k of ["foundation_recipe_class", "wall_recipe_class"]) {
    if (p[k] === undefined && !requireRecipes) continue;
    if (typeof p[k] !== "string" || !p[k].trim()) {
      return { error: "structural_exact_recipe_class_is_required", field: k };
    }
  }
  return { parameters: { ...p, blueprint_name: name } };
}

export function compileArchitectStructuralRequest(graph, args = {}) {
  if (!isObj(graph)) return fail("structural_request_requires_a_current_graph");
  if (!isObj(args)) return fail("structural_request_arguments_must_be_an_object");
  if (args.brief !== undefined && (typeof args.brief !== "string" || args.brief.length > 2000)) {
    return fail("structural_brief_must_be_text_up_to_2000_characters");
  }
  const checked = checkParameters({
    blueprint_name: args.blueprint_name ?? "AI Architect structural shell",
    width_cells: args.width_cells ?? 2, depth_cells: args.depth_cells ?? 1,
    wall_courses: args.wall_courses ?? 2, open_ends: args.open_ends ?? "both",
    foundation_recipe_class: args.foundation_recipe_class,
    wall_recipe_class: args.wall_recipe_class,
  }, { requireRecipes: false });
  if (checked.error) return fail(checked.error, checked.field ? { field: checked.field } : {});
  // Resolve once, then pin the exact recipes and recompile so the stored request
  // reproduces precisely what the manifest describes.
  const probe = compileStructuralBlueprint(graph, { ...checked.parameters, commit: false });
  if (!probe.compiled) return probe;
  const parameters = { ...checked.parameters,
    foundation_recipe_class: probe.pieces.floor.recipe_class, wall_recipe_class: probe.pieces.wall.recipe_class };
  const layout = compileStructuralBlueprint(graph, { ...parameters, commit: false });
  if (!layout.compiled) return layout;
  const pieceFor = role => (role === "wall" ? layout.pieces.wall : layout.pieces.floor);
  const elements = layout.buildables.map(b => ({ part_id: b.part_id, role: b.role,
    recipe_class: b.recipe_class, buildable_class: pieceFor(b.role).buildable_class,
    relative_location: { ...b.relative_location }, yaw: b.yaw }));
  const piece = p => ({ recipe_class: p.recipe_class, item_class: p.item_class,
    buildable_class: p.buildable_class, dimensions: p.dimensions,
    measurement: { local_size_cm: p.measurement.local_size_cm, local_min_z_cm: p.measurement.local_min_z_cm,
      wall_long_axis: p.measurement.wall_long_axis, source: p.measurement.source,
      sample_actor_id: p.measurement.actor_id } });
  const pieces = { floor: piece(layout.pieces.floor), wall: piece(layout.pieces.wall) };
  // Sample actor ids are provenance, not geometry.
  const geometry = p => ({ recipe_class: p.recipe_class, buildable_class: p.buildable_class,
    dimensions: p.dimensions, local_size_cm: p.measurement.local_size_cm,
    local_min_z_cm: p.measurement.local_min_z_cm, wall_long_axis: p.measurement.wall_long_axis });
  const recipes = graph.snapshot?.content?.recipes ?? [];
  const unlockEvidence = Object.values(pieces).map(p => {
    const r = recipes.find(x => x.class_path === p.recipe_class) ?? {};
    return { recipe_class: p.recipe_class, available: r.available === true,
      produced_in: [...(r.produced_in ?? [])].sort(), product: r.products?.[0]?.item_class ?? null,
      name: r.name ?? null };
  });
  const shell = { ...layout.dimensions };
  const identity = { schema: ARCHITECT_STRUCTURAL_SCHEMA, style: "structural", parameters,
    shell, pieces: { floor: geometry(pieces.floor), wall: geometry(pieces.wall) }, elements };
  const manifest = {
    schema: ARCHITECT_STRUCTURAL_SCHEMA, compiled: true, validation: { valid: true }, style: "structural",
    parameters, shell, pieces, elements, part_count: layout.part_count,
    semantic_fingerprint: hash(identity),
    design_family: { fingerprint: hash({ style: "structural",
      pieces: { floor: geometry(pieces.floor), wall: geometry(pieces.wall) } }) },
    unlock_constraints: { availability_fingerprint: hash({ availability_known: true, recipes: unlockEvidence }),
      captured_world_revision: graph.world_revision,
      captured_at_utc: graph.snapshot?.captured_at_utc ?? null },
    limitations: [...layout.limitations, "no_item_or_rate_goal_applies_to_entrances_or_tunnels",
      "native_v1_path_has_narrower_evidence_than_this_manifest"],
    ...(args.brief?.trim() ? { brief: args.brief.trim() } : {}),
  };
  return { compiled: true, manifest, design_request: { schema: ARCHITECT_STRUCTURAL_REQUEST_SCHEMA,
    type: "structure", parameters }, layout };
}

export function compileArchitectStructuralPromotion(graph, designRequest, { commit = false } = {}) {
  if (!isObj(designRequest)) return fail("structural_design_request_must_be_an_object");
  if (Object.keys(designRequest).sort().join() !== "parameters,schema,type") {
    return fail("structural_design_request_has_unsupported_fields");
  }
  if (designRequest.schema !== ARCHITECT_STRUCTURAL_REQUEST_SCHEMA) return fail("structural_design_request_schema_unsupported");
  if (designRequest.type !== "structure") return fail("structural_design_request_type_unsupported");
  const p = designRequest.parameters;
  if (!isObj(p) || Object.keys(p).sort().join() !== [...PARAM_KEYS].sort().join()) {
    return fail("structural_design_request_parameters_must_be_exactly_the_pinned_fields");
  }
  if (typeof commit !== "boolean") return fail("structural_commit_must_be_boolean");
  if (!isObj(graph)) return fail("structural_promotion_requires_a_current_graph");
  const checked = checkParameters(p, { requireRecipes: true });
  if (checked.error) return fail(checked.error, checked.field ? { field: checked.field } : {});
  return compileStructuralBlueprint(graph, { ...checked.parameters, commit });
}
