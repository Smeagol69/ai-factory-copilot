/**
 * Picking a region to export, and showing it before anything is written.
 *
 * The owner built something enormous and does not want to click every piece
 * with the dismantle tool: "maybe how SMART! shows you a preview, we can set
 * xyz and a slider, and it shows a preview of what's going to be saved".
 *
 * So: a box you set, drawn in the world before you commit to it. The overlay
 * accepts explicit actor ids and bypasses its own radius filter, which means
 * the highlight can show *exactly* the set that would be serialised — not an
 * approximation of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE THING CODEX REFUSED
 *
 * `actions.mjs` rejects any export whose source is not the game's dismantle
 * multi-select, with the reasoning: "Do not accept a model-proposed box,
 * radius, or arbitrary actor list." That is right, and it stays right.
 *
 * The distinction is who chose the region. A model guessing a factory boundary
 * from a phrase is exactly the failure that rule prevents. A box the *player*
 * sized, saw highlighted in their own world, and then confirmed is not a guess
 * — the preview is the consent. So a box selection may only be exported after
 * it has been previewed, and the ids exported are the ones that were shown.
 * Nothing is ever serialised that the player has not literally seen lit up.
 */

/** Half-extents in centimetres. Metres are what people say; cm is what the game uses. */
const METRES = 100;

/** A box has to have volume, and a megabase-sized one is still a real request. */
const MINIMUM_HALF_EXTENT_CM = 1 * METRES;
const MAXIMUM_HALF_EXTENT_CM = 2_000 * METRES;

const clampExtent = (value) =>
  Math.min(MAXIMUM_HALF_EXTENT_CM, Math.max(MINIMUM_HALF_EXTENT_CM, Math.round(Number(value))));

/**
 * A selection box centred on a point.
 *
 * Half-extents, so "100 wide" means 100 m across rather than 100 m in each
 * direction — which is what someone setting a slider to 100 expects to see.
 */
export function makeSelectionBox({ centre, width_m: width = 60, depth_m: depth = null, height_m: height = null }) {
  if (!centre || ![centre.x, centre.y, centre.z].every((v) => Number.isFinite(Number(v)))) {
    return null;
  }
  const acrossX = clampExtent((Number(width) * METRES) / 2);
  const acrossY = clampExtent(((Number(depth ?? width)) * METRES) / 2);
  // Height defaults generously: a factory is usually wider than it is tall, and
  // clipping the top off a build is a worse surprise than including headroom.
  const acrossZ = clampExtent(((Number(height ?? Math.max(Number(width), 40))) * METRES) / 2);
  return {
    centre: { x: Number(centre.x), y: Number(centre.y), z: Number(centre.z) },
    half_cm: { x: acrossX, y: acrossY, z: acrossZ },
    size_m: {
      width: Math.round((acrossX * 2) / METRES),
      depth: Math.round((acrossY * 2) / METRES),
      height: Math.round((acrossZ * 2) / METRES),
    },
  };
}

const inside = (box, location) =>
  Math.abs(location.x - box.centre.x) <= box.half_cm.x &&
  Math.abs(location.y - box.centre.y) <= box.half_cm.y &&
  Math.abs(location.z - box.centre.z) <= box.half_cm.z;

/**
 * Everything inside the box that could actually be exported.
 *
 * Resource nodes, the player, and anything that is not a buildable are left
 * out: a blueprint is made of buildings. Links are kept in the count but
 * flagged, because a belt inside the box does travel with a native blueprint
 * even though a saved design cannot replay one.
 */
export function selectionContents(graph, box) {
  const buildings = [];
  const skipped = [];

  for (const node of graph?.nodes?.values() ?? []) {
    const raw = node?.raw;
    if (!raw || raw.kind !== "buildable" || !raw.location) continue;
    if (!inside(box, raw.location)) continue;

    // A Blueprint Designer inside the box would be exported into its own
    // blueprint, which is nonsense, and the designer is also the thing doing
    // the serialising.
    if (/BlueprintDesigner/i.test(String(raw.class_path))) {
      skipped.push({ actor_id: raw.actor_id, why: "a Blueprint Designer cannot be inside its own blueprint" });
      continue;
    }
    buildings.push({
      actor_id: String(raw.actor_id),
      name: raw.name ?? null,
      class_path: raw.class_path ?? null,
      location: raw.location,
    });
  }

  return { buildings, skipped };
}

const shortName = (classPath) =>
  String(classPath ?? "")
    .split(".")
    .pop()
    .replace(/^Build_/, "")
    .replace(/_C$/, "");

/** "180 × Foundation · 12 × Smelter · +6 more" — what the box actually holds. */
export function describeSelection(buildings) {
  const counts = new Map();
  for (const entry of buildings) {
    const name = shortName(entry.class_path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 6).map(([name, count]) => `${count} × ${name}`);
  if (sorted.length > shown.length) shown.push(`+${sorted.length - shown.length} more kinds`);
  return shown.join(" · ");
}

/** The measured bounds of what was caught, which is usually smaller than the box. */
export function selectionBounds(buildings) {
  if (buildings.length === 0) return null;
  const axis = (key) => buildings.map((entry) => entry.location[key]);
  const [xs, ys, zs] = [axis("x"), axis("y"), axis("z")];
  return {
    minimum: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    maximum: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
    span_m: {
      x: Math.round((Math.max(...xs) - Math.min(...xs)) / METRES),
      y: Math.round((Math.max(...ys) - Math.min(...ys)) / METRES),
      z: Math.round((Math.max(...zs) - Math.min(...zs)) / METRES),
    },
    units: "unreal_centimeters",
  };
}

/**
 * The box the player is currently looking at.
 *
 * Module-scoped and deliberately short-lived: it is set by a preview and read
 * by the export that follows it. Not persisted, because a selection that
 * outlived the session would be a region nobody had looked at recently — which
 * is the thing the preview requirement exists to prevent.
 */
let previewed = null;

export function rememberPreview(box, buildings, worldRevision) {
  previewed = {
    box,
    actor_ids: buildings.map((entry) => entry.actor_id),
    world_revision: worldRevision ?? null,
    at: Date.now(),
  };
  return previewed;
}

export function lastPreview() {
  return previewed;
}

export function clearPreview() {
  previewed = null;
}
