import { createHash } from "node:crypto";

export const ARCHITECT_PREVIEW_SCHEMA = "ai-architect.preview/v1";
export const ARCHITECT_PREVIEW_OVERLAY = "ai-architect";
export const MAX_ARCHITECT_PREVIEW_ELEMENTS = 256;

const SUPPORTED_KINDS = new Set([
  "production_zone",
  "structural_platform",
  "glazed_facade",
  "sloped_roof_intent",
  "support_pylon",
  "skybridge",
  "vertical_landmark",
]);

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function vector(value, { positive = false } = {}) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  const z = finite(value?.z);
  if (x === null || y === null || z === null) return null;
  if (positive && (x <= 0 || y <= 0 || z <= 0)) return null;
  return { x, y, z };
}

function boundedText(value, maximum) {
  const text = String(value ?? "").trim();
  return text.length > 0 && text.length <= maximum ? text : null;
}

function previewIdentity(manifest, elements) {
  const payload = {
    manifest_schema: manifest.schema,
    style: manifest.style,
    design_family_fingerprint: manifest.design_family?.fingerprint ?? null,
    unlock_fingerprint: manifest.unlock_constraints?.availability_fingerprint ?? null,
    captured_world_revision: manifest.unlock_constraints?.captured_world_revision ?? null,
    elements,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

// Sweep only opening boundaries, not every cell of a potentially huge facade.
// Union overlapping openings and merge identical wall spans vertically. The
// result uses the existing box renderer; no new game-side drawing primitive.
function facadeSections(element, geometry, grid) {
  const openings = element.openings;
  const unit = finite(grid?.unit_cm);
  const floor = finite(grid?.floor_height_cm);
  const width = element.size_cells?.x;
  const height = element.size_cells?.z;
  if (!Array.isArray(openings) || openings.length > MAX_ARCHITECT_PREVIEW_ELEMENTS ||
      unit === null || unit <= 0 || floor === null || floor <= 0 ||
      !Number.isSafeInteger(width) || width < 1 ||
      !Number.isSafeInteger(height) || height < 1 ||
      geometry.size_cm.x !== width * unit || geometry.size_cm.z !== height * floor ||
      openings.some((opening) =>
        ![opening?.start_cell, opening?.width_cells, opening?.base_floor, opening?.height_floors]
          .every(Number.isSafeInteger) ||
        opening.start_cell < 0 || opening.width_cells < 1 ||
        opening.base_floor < 0 || opening.height_floors < 1 ||
        opening.start_cell + opening.width_cells > width ||
        opening.base_floor + opening.height_floors > height)) {
    return { compiled: false, reason: "manifest_facade_openings_are_invalid", element_id: element.id };
  }
  if (openings.length === 0) return { compiled: true, elements: [geometry] };
  const levels = [...new Set([0, height, ...openings.flatMap((opening) =>
    [opening.base_floor, opening.base_floor + opening.height_floors])])].sort((a, b) => a - b);
  const sections = [];
  let previous = new Map();
  for (let index = 0; index < levels.length - 1; index += 1) {
    const bottom = levels[index];
    const top = levels[index + 1];
    const blocked = openings.filter((opening) =>
      opening.base_floor <= bottom && opening.base_floor + opening.height_floors >= top)
      .map((opening) => [opening.start_cell, opening.start_cell + opening.width_cells])
      .sort((a, b) => a[0] - b[0]);
    const spans = [];
    let cursor = 0;
    for (const [start, end] of blocked) {
      if (start > cursor) spans.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (cursor < width) spans.push([cursor, width]);
    const current = new Map();
    for (const [start, end] of spans) {
      const key = `${start}:${end}`;
      const section = previous.get(key);
      if (section) section.top = top;
      else sections.push({ start, end, bottom, top });
      current.set(key, section ?? sections.at(-1));
    }
    previous = current;
    if (sections.length > MAX_ARCHITECT_PREVIEW_ELEMENTS) {
      return { compiled: false, reason: "facade_sections_exceed_architect_preview_element_limit", element_id: element.id };
    }
  }
  const radians = geometry.yaw_degrees * Math.PI / 180;
  const rounded = (value) => Math.round(value * 1000) / 1000;
  const prefix = createHash("sha256").update(geometry.id).digest("hex").slice(0, 24);
  return {
    compiled: true,
    elements: sections.map((section, index) => {
      // Native panels are centred at column * unit. Their left edge is a
      // half-cell earlier; the portal's plane is halfway through this volume.
      const dx = (section.start - 0.5) * unit;
      return {
        ...geometry,
        id: `facade-${prefix}-${index + 1}`,
        origin_cm: {
          x: rounded(geometry.origin_cm.x + dx * Math.cos(radians)),
          y: rounded(geometry.origin_cm.y + dx * Math.sin(radians)),
          z: geometry.origin_cm.z + section.bottom * floor,
        },
        size_cm: {
          x: (section.end - section.start) * unit,
          y: geometry.size_cm.y,
          z: (section.top - section.bottom) * floor,
        },
      };
    }),
  };
}

/**
 * Compile a validated megabase manifest into a bounded draw-only action.
 *
 * This is intentionally geometry, not construction. It preserves the exact
 * world transforms already produced by `megabase.design/v1`; neither a model
 * nor this adapter may invent a coordinate, recipe, or missing element.
 */
export function compileArchitectPreview(manifest, options = {}) {
  if (manifest?.schema !== "megabase.design/v1") {
    return { compiled: false, reason: "manifest_schema_must_be_megabase_design_v1" };
  }
  if (manifest?.compiled !== true || manifest?.validation?.valid !== true) {
    return { compiled: false, reason: "manifest_must_be_compiled_and_valid" };
  }
  if (!Array.isArray(manifest.elements) || manifest.elements.length === 0) {
    return { compiled: false, reason: "manifest_has_no_previewable_elements" };
  }
  if (manifest.elements.length > MAX_ARCHITECT_PREVIEW_ELEMENTS) {
    return {
      compiled: false,
      reason: "manifest_exceeds_architect_preview_element_limit",
      element_count: manifest.elements.length,
      maximum_elements: MAX_ARCHITECT_PREVIEW_ELEMENTS,
    };
  }

  const elements = [];
  const sourceIds = new Set();
  for (const element of manifest.elements) {
    const id = boundedText(element?.id, 96);
    const kind = boundedText(element?.kind, 48);
    const origin = vector(element?.world_origin_cm);
    const size = vector(element?.world_size_cm, { positive: true });
    const yaw = finite(element?.world_yaw_degrees);
    if (!id || sourceIds.has(id) || !kind || !SUPPORTED_KINDS.has(kind) || !origin || !size || yaw === null) {
      return {
        compiled: false,
        reason: "manifest_element_is_not_bounded_preview_geometry",
        element_id: element?.id ?? null,
      };
    }
    sourceIds.add(id);
    const geometry = { id, kind, origin_cm: origin, size_cm: size, yaw_degrees: yaw };
    if (element.openings !== undefined) {
      if (kind !== "glazed_facade") {
        return { compiled: false, reason: "manifest_openings_require_a_facade", element_id: id };
      }
      const sections = facadeSections(element, geometry, manifest.grid);
      if (!sections.compiled) return sections;
      elements.push(...sections.elements);
    } else elements.push(geometry);
    if (elements.length > MAX_ARCHITECT_PREVIEW_ELEMENTS) {
      return { compiled: false, reason: "facade_sections_exceed_architect_preview_element_limit",
        maximum_elements: MAX_ARCHITECT_PREVIEW_ELEMENTS };
    }
  }
  if (elements.length === 0) {
    return { compiled: false, reason: "manifest_has_no_retained_preview_geometry" };
  }
  if (new Set(elements.map((element) => element.id)).size !== elements.length ||
      elements.some((element) => !vector(element.origin_cm) || !vector(element.size_cm, { positive: true }))) {
    return { compiled: false, reason: "derived_preview_geometry_is_invalid" };
  }

  const overlay = boundedText(options.overlay ?? ARCHITECT_PREVIEW_OVERLAY, 64);
  if (!overlay) return { compiled: false, reason: "overlay_name_must_be_1_to_64_characters" };
  const lifetime = finite(options.lifetime_seconds ?? 0);
  if (lifetime === null || lifetime < 0 || lifetime > 3600) {
    return { compiled: false, reason: "lifetime_seconds_must_be_from_0_through_3600" };
  }
  const style = boundedText(manifest.style, 64);
  const family = boundedText(manifest.design_family?.fingerprint, 80);
  const unlock = boundedText(manifest.unlock_constraints?.availability_fingerprint, 80);
  const gridUnit = finite(manifest.grid?.unit_cm);
  const floorHeight = finite(manifest.grid?.floor_height_cm);
  if (!style || !family || !unlock || gridUnit === null || gridUnit <= 0 ||
      floorHeight === null || floorHeight <= 0) {
    return { compiled: false, reason: "manifest_provenance_is_incomplete" };
  }

  const manifestFingerprint = previewIdentity(manifest, elements);
  return {
    compiled: true,
    schema: ARCHITECT_PREVIEW_SCHEMA,
    manifest_fingerprint: manifestFingerprint,
    element_count: elements.length,
    action: {
      action: "architect_preview",
      overlay,
      preview_schema: ARCHITECT_PREVIEW_SCHEMA,
      manifest_schema: manifest.schema,
      manifest_fingerprint: manifestFingerprint,
      style,
      design_family_fingerprint: family,
      unlock_fingerprint: unlock,
      captured_world_revision: String(
        manifest.unlock_constraints?.captured_world_revision ?? "unknown",
      ),
      grid_unit_cm: gridUnit,
      floor_height_cm: floorHeight,
      elements,
      lifetime_seconds: lifetime,
      through_walls: options.through_walls !== false,
      commit: true,
    },
  };
}

export function architectPreviewKinds() {
  return [...SUPPORTED_KINDS];
}
