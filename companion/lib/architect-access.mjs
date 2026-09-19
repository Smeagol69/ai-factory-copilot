/** Declared facade apertures in the native adapter's coordinate convention.
 * This is design geometry, never a measurement of traversable game space.
 * Keep it outside the immutable manifest so old revisions retain their identity.
 */
import { validateMegabaseManifest } from "./megabase.mjs";

export function compileArchitectAccess(manifest) {
  const base = {
    schema: "ai-architect.access/v1",
    source: "validated_manifest_facade_openings",
    certainty: "deterministic_design_geometry_not_game_readback",
    compiled: false,
    portals: [],
    circulation: {
      status: "not_routed",
      reachable: null,
      missing: ["portal_to_walkway_connections", "ground_and_floor_access",
        "native_collision_and_traversal_readback"],
    },
    caveat: "Dimensions describe omitted facade modules, not measured clearances. Existing semantic bridges do not prove access; floor surfaces, stairs, obstructions and vehicle fit remain unverified.",
  };
  let validation;
  try {
    validation = validateMegabaseManifest(manifest);
  } catch {
    return { ...base, issues: ["invalid_manifest_shape"] };
  }
  const issues = [...validation.issues];
  const unit = manifest?.grid?.unit_cm;
  const floor = manifest?.grid?.floor_height_cm;
  if (![unit, floor].every((value) => Number.isFinite(value) && value > 0)) {
    issues.push("access_requires_positive_grid_dimensions");
  }
  if (!Array.isArray(manifest?.elements)) issues.push("access_requires_elements_array");
  for (const face of manifest?.elements ?? []) {
    if (face?.kind !== "glazed_facade") continue;
    if (![face.world_origin_cm?.x, face.world_origin_cm?.y, face.world_origin_cm?.z,
      face.world_yaw_degrees].every(Number.isFinite)) {
      issues.push(`access_requires_finite_face_transform:${face.id}`);
    }
  }
  if (issues.length) return { ...base, issues: [...new Set(issues)] };

  const portals = [];
  for (const face of manifest.elements) {
    if (face.kind !== "glazed_facade") continue;
    const radians = face.world_yaw_degrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    // Native facade panel centres are column * unit, unit / 2. Aperture
    // edges therefore sit half a module before/after the omitted centres.
    // Match native placement's 0.001 cm rounding, without using rounded normals.
    const rounded = (value) => Math.round(value * 1000) / 1000;
    const point = (x, z) => ({
      x: rounded(face.world_origin_cm.x + x * cosine - unit / 2 * sine),
      y: rounded(face.world_origin_cm.y + x * sine + unit / 2 * cosine),
      z: face.world_origin_cm.z + z,
    });
    for (const [index, opening] of (face.openings ?? []).entries()) {
      const left = (opening.start_cell - 0.5) * unit;
      const right = (opening.start_cell + opening.width_cells - 0.5) * unit;
      const bottom = opening.base_floor * floor;
      const top = bottom + opening.height_floors * floor;
      portals.push({
        id: `${face.id}:opening:${index + 1}`,
        element_id: face.id,
        opening_index: index,
        width_cm: opening.width_cells * unit,
        height_cm: opening.height_floors * floor,
        lower_edge_center_cm: point((left + right) / 2, bottom),
        corners_cm: [point(left, bottom), point(right, bottom),
          point(right, top), point(left, top)],
        outward_normal: {
          x: Math.abs(sine) < 1e-12 ? 0 : sine,
          y: Math.abs(cosine) < 1e-12 ? 0 : -cosine,
          z: 0,
        },
        world_yaw_degrees: face.world_yaw_degrees,
      });
    }
  }
  if (portals.some((portal) => ![portal.width_cm, portal.height_cm,
    ...portal.corners_cm.flatMap((point) => [point.x, point.y, point.z])].every(Number.isFinite))) {
    return { ...base, issues: ["access_geometry_exceeds_finite_range"] };
  }
  return { ...base, compiled: true, portals, issues: [] };
}
