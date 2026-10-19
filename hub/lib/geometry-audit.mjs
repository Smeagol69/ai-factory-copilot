// A draft diagnostic for supported measured rectangular pieces. This is not a
// mesh collision test or the game's destination hologram clearance decision.
const TOLERANCE_CM = 1; // Matches native generator's MeaningfulPenetrationCm.
const finite = values => values.every(Number.isFinite);
const dot = (a, b) => a.x * b.x + a.y * b.y;

function box(element, pieces) {
  if (!['floor', 'roof', 'wall'].includes(element?.role)) return null;
  const measurement = pieces?.[element.role === 'wall' ? 'wall' : 'floor']?.measurement;
  const size = measurement?.local_size_cm, p = element.relative_location;
  if (!size || !p || !finite([size.x, size.y, size.z, measurement.local_min_z_cm, p.x, p.y, p.z, element.yaw]) ||
      Math.min(size.x, size.y, size.z) <= 0 || Math.max(size.x, size.y, size.z, Math.abs(measurement.local_min_z_cm)) > 100000 ||
      Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) > 1e9) return null;
  const angle = (element.yaw % 360) * Math.PI / 180;
  return { id: element.part_id, center: p, axes: [{ x: Math.cos(angle), y: Math.sin(angle) }, { x: -Math.sin(angle), y: Math.cos(angle) }],
    half: [size.x / 2, size.y / 2], zmin: p.z + measurement.local_min_z_cm, zmax: p.z + measurement.local_min_z_cm + size.z };
}
function penetration(a, b) {
  let depth = Math.min(a.zmax, b.zmax) - Math.max(a.zmin, b.zmin);
  if (depth <= TOLERANCE_CM) return null;
  const delta = { x: b.center.x - a.center.x, y: b.center.y - a.center.y };
  for (const axis of [...a.axes, ...b.axes]) {
    const radius = q => q.half.reduce((sum, half, i) => sum + half * Math.abs(dot(q.axes[i], axis)), 0);
    const overlap = radius(a) + radius(b) - Math.abs(dot(delta, axis));
    if (overlap <= TOLERANCE_CM) return null;
    depth = Math.min(depth, overlap);
  }
  return depth;
}

export function auditStructuralGeometry(manifest) {
  const base = { schema: 'copilot.structural-geometry-audit/v1', status: 'unknown', toleranceCm: TOLERANCE_CM,
    basis: 'captured_rectangular_piece_bounds_and_local_transforms', gamePlacementVerified: false,
    testedPairs: 0, overlaps: [], limitations: ['measured_rectangular_bounds_not_exact_render_or_collision_meshes',
      'local_xy_pivots_follow_the_supported_structural_compiler_contract',
      'destination_terrain_existing_buildings_and_walkways_not_checked', 'native_hologram_and_world_readback_required'] };
  if (manifest?.schema !== 'architect.structure/v1' || !Array.isArray(manifest.elements) ||
      manifest.elements.length < 1 || manifest.elements.length > 512) return { ...base, reason: 'supported_structural_manifest_required' };
  const boxes = [], ids = new Set();
  for (const element of manifest.elements) {
    if (typeof element?.part_id !== 'string' || !element.part_id || ids.has(element.part_id)) return { ...base, reason: 'unique_part_ids_required' };
    const measured = box(element, manifest.pieces);
    if (!measured) return { ...base, reason: 'complete_supported_piece_measurement_and_finite_transform_required', part: element.part_id };
    ids.add(element.part_id); boxes.push(measured);
  }
  const overlaps = []; let testedPairs = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    testedPairs++;
    const depth = penetration(boxes[i], boxes[j]);
    if (depth !== null) overlaps.push({ parts: [boxes[i].id, boxes[j].id], minimumPenetrationCm: depth });
  }
  return { ...base, status: overlaps.length ? 'measured_box_penetration' : 'no_measured_box_penetration', testedPairs, overlaps };
}
