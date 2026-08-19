/**
 * Where did the height actually come from?
 *
 * `read-placement-drift.mjs` says how far each placement missed. This says
 * *why*, which decides whether `exact_z` can fix it at all:
 *
 *   If the hologram ends up level with `build_surface_point` — the thing the
 *   downward trace hit — then the hit point is the whole story and overriding
 *   its Z is sufficient.
 *
 *   If it ends up somewhere else, and `snap_accepted` is true, then
 *   `TrySnapToActor` moved it after the hit was handed over, and overriding
 *   the hit's height will not be enough on its own.
 *
 * The distinction matters because the fix keeps the traced *actor* on purpose,
 * and that actor turns out to be a previously-placed foundation rather than
 * ground.
 */

import fs from "node:fs";
import path from "node:path";

const OUTCOMES = path.join(
  process.env.LOCALAPPDATA ?? "",
  "FactoryGame/Saved/AIFactoryCopilot/Diagnostics/action-outcomes.jsonl",
);

/** Concatenated pretty-printed JSON values, same as the reader. */
function readRecords(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  const BACKSLASH = String.fromCharCode(92);

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === BACKSLASH) escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, index + 1))); } catch { /* truncated */ }
        start = -1;
      }
    }
  }
  return out;
}

function* placements(value) {
  if (Array.isArray(value)) {
    for (const entry of value) yield* placements(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.action === "string" && value.action.startsWith("place")) yield value;
  for (const entry of Object.values(value)) yield* placements(entry);
}

const file = process.argv[2] ?? OUTCOMES;
const rows = [];
for (const record of readRecords(fs.readFileSync(file, "utf8"))) {
  for (const placement of placements(record)) {
    const predicted = placement.predicted ?? {};
    const asked = predicted.transform?.location?.z;
    const landed = predicted.hologram_transform?.location?.z;
    const surface = predicted.build_surface_point?.z;
    if (asked === undefined || landed === undefined) continue;
    rows.push({
      name: String(predicted.building_name ?? "?"),
      asked,
      landed,
      surface,
      snap: predicted.snap_accepted,
      actor: String(predicted.build_surface_actor ?? "").split(".").pop(),
    });
  }
}

const round = (value) => (value === undefined ? "?" : String(Math.round(value * 10) / 10));
console.log(
  "building".padEnd(18) + "asked".padStart(9) + "surface".padStart(10) +
  "landed".padStart(10) + "land-surf".padStart(11) + "  snap   hit actor",
);
for (const row of rows) {
  console.log(
    row.name.padEnd(18) + round(row.asked).padStart(9) + round(row.surface).padStart(10) +
    round(row.landed).padStart(10) +
    round(row.surface === undefined ? undefined : row.landed - row.surface).padStart(11) +
    String(row.snap).padStart(7) + "   " + row.actor.slice(0, 44),
  );
}

const snapped = rows.filter((row) => row.snap === true);
const offsets = rows
  .filter((row) => row.surface !== undefined)
  .map((row) => Math.round((row.landed - row.surface) * 10) / 10);
console.log(`\n${rows.length} placements. snap_accepted true on ${snapped.length}.`);
if (offsets.length > 0) {
  const distinct = [...new Set(offsets)].sort((a, b) => a - b);
  console.log(`landed-minus-surface values: ${distinct.join(", ")}`);
  console.log(
    snapped.length === 0
      ? "\nNothing snapped. The height came from the traced hit point, so overriding\n" +
        "that point's Z is sufficient and exact_z addresses this directly."
      : "\nSome placements snapped. Check whether those are the ones that drifted:\n" +
        "if so, TrySnapToActor is moving the hologram after the hit is handed over.",
  );
}
