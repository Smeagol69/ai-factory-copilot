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
