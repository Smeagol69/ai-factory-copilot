/** Resolve an optional shared placement frame into campus-grid coordinates. */
export function elementGridOrigin(element) {
  const local = element?.local;
  if (!local || ![local.x, local.y, local.z].every(Number.isInteger)) return null;
  if (element.placement_frame === undefined) return { ...local };
  const frame = element.placement_frame;
  const pivot = frame?.local_pivot_cells;
  const centre = frame?.campus_pivot_cells;
  const angle = element.yaw_offset_degrees ?? 0;
  if (![pivot?.x, pivot?.y, centre?.x, centre?.y].every((value) =>
    Number.isFinite(value) && Number.isInteger(value * 2)) ||
    !Number.isFinite(angle) || angle < 0 || angle >= 360) return null;
  const radians = angle * Math.PI / 180;
  const dx = local.x - pivot.x;
  const dy = local.y - pivot.y;
  const point = {
    x: centre.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: centre.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    z: local.z,
  };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

/** Geometry of declarative Architect volumes, not native collision meshes. */
export function orientedVolume(origin, size, yawDegrees) {
  if (!origin || !size || ![origin.x, origin.y, origin.z, size.x, size.y, size.z, yawDegrees]
    .every(Number.isFinite) || [size.x, size.y, size.z].some((value) => value <= 0)) return null;
  const angle = yawDegrees * Math.PI / 180;
  const snapZero = (value) => Math.abs(value) < 1e-12 ? 0 : value;
  const cosine = snapZero(Math.cos(angle));
  const sine = snapZero(Math.sin(angle));
  const corners = [[0, 0], [size.x, 0], [size.x, size.y], [0, size.y]].map(([x, y]) => ({
    x: origin.x + x * cosine - y * sine,
    y: origin.y + x * sine + y * cosine,
  }));
  const maxZ = origin.z + size.z;
  if (!Number.isFinite(maxZ) || !corners.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    return null;
  }
  return {
    corners,
    axes: [{ x: cosine, y: sine }, { x: -sine, y: cosine }],
    min_z: origin.z,
    max_z: maxZ,
  };
}

/** Separating-axis test: touching faces are allowed; positive volume overlap is not. */
export function volumesOverlap(left, right) {
  if (!left || !right) return false;
  const epsilon = 1e-6; // cm: numerical noise, far below the manifest's .001 cm rounding.
  if (left.max_z <= right.min_z + epsilon || right.max_z <= left.min_z + epsilon) return false;
  // Project relative to one corner to avoid precision loss at large world coordinates.
  const origin = left.corners[0];
  for (const axis of [...left.axes, ...right.axes]) {
    const project = (point) => (point.x - origin.x) * axis.x + (point.y - origin.y) * axis.y;
    const a = left.corners.map(project);
    const b = right.corners.map(project);
    if (Math.max(...a) <= Math.min(...b) + epsilon || Math.max(...b) <= Math.min(...a) + epsilon) {
      return false;
    }
  }
  return true;
}
