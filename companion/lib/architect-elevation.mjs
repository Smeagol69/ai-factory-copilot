/** Apply the user's vertical design intent once, before any geometry is compiled. */
export function resolveArchitectElevation(request) {
  if (request.elevation_offset_cm === undefined) {
    return { resolved: true, origin: request.origin };
  }
  const offset = request.elevation_offset_cm;
  if (!Number.isFinite(offset)) {
    return { resolved: false, reason: "elevation_offset_cm_must_be_a_finite_number" };
  }
  const origin = request.origin;
  if (![origin?.x, origin?.y, origin?.z].every(Number.isFinite)) {
    return { resolved: false, reason: "elevation_offset_requires_explicit_finite_origin_xyz" };
  }
  const z = origin.z + offset;
  if (!Number.isFinite(z)) {
    return { resolved: false, reason: "elevation_offset_produces_nonfinite_height" };
  }
  return { resolved: true, origin: { ...origin, z } };
}

// Response metadata, never inserted into the immutable manifest: old revisions
// must keep recompiling to their original fingerprints. An offset is relative
// to the supplied reference, not proof of depth below terrain or a cave floor.
export function architectElevationReport(request, manifest) {
  const offset = request?.elevation_offset_cm ?? 0;
  return {
    source: "explicit_design_origin_and_vertical_offset",
    certainty: "exact_design_coordinates_only",
    reference_origin_cm: { ...request.origin },
    elevation_offset_cm: offset,
    resolved_anchor_cm: { ...manifest.anchor_cm },
    ground_snapping: false,
    terrain_excavation: false,
    underground_fit: "unknown",
    game_validation_pending: true,
    unverified: [
      "terrain_and_cave_volume_at_design_height",
      "ceiling_clearance_for_the_complete_design",
      "walkable_entrance_and_exit",
      "world_bounds_and_native_placement",
    ],
    note: "Height is relative to the supplied origin, not measured burial depth. A surface terrain probe does not prove underground fit. This preview neither excavates terrain nor moves the player or an existing base.",
  };
}
