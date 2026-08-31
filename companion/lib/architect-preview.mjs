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
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  for (const element of manifest.elements) {
    const id = boundedText(element?.id, 96);
    const kind = boundedText(element?.kind, 48);
    const origin = vector(element?.world_origin_cm);
    const size = vector(element?.world_size_cm, { positive: true });
    const yaw = finite(element?.world_yaw_degrees);
    if (!id || !kind || !SUPPORTED_KINDS.has(kind) || !origin || !size || yaw === null) {
      return {
        compiled: false,
        reason: "manifest_element_is_not_bounded_preview_geometry",
        element_id: element?.id ?? null,
      };
    }
    elements.push({ id, kind, origin_cm: origin, size_cm: size, yaw_degrees: yaw });
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
