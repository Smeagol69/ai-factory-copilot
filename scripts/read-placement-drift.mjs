/**
 * What the game actually did with the heights it was given.
 *
 * `action-outcomes.jsonl` is the only record of where a placement really
 * landed. It is not line-delimited despite the name — the mod pretty-prints
 * each record — so it is read as a stream of concatenated JSON values.
 *
 * The question this answers is the one the whole exact_z change exists for:
 * for every building placed, how far is the placed transform from the Z that
 * was asked for? Before the fix a Smelter asked for 8054 landed at 9028. After
 * it, the mod reports `requested_z_drift_cm` itself, and this prints both --
 * the mod's own number where it exists, and the difference measured
 * independently from the requested and observed transforms where it does not.
 *
 *   node scripts/read-placement-drift.mjs [path-to-action-outcomes.jsonl]
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT = path.join(
  process.env.LOCALAPPDATA ?? "",
  "FactoryGame/Saved/AIFactoryCopilot/Diagnostics/action-outcomes.jsonl",
);

/** Concatenated JSON values, pretty-printed, with no separator between them. */
function readRecords(file) {
  const text = fs.readFileSync(file, "utf8");
  const records = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
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
        try {
          records.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // A record cut off by a crash is not a record. Skipping it beats
          // refusing to read the ones that are whole.
        }
        start = -1;
      }
    }
  }
  return records;
}

/** Every placement result anywhere in a record, however it is nested. */
function* placements(value) {
  if (Array.isArray(value)) {
    for (const entry of value) yield* placements(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.action === "string" && value.action.startsWith("place")) yield value;
  for (const entry of Object.values(value)) yield* placements(entry);
}

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

const file = process.argv[2] ?? DEFAULT;
if (!fs.existsSync(file)) {
  console.error(`No outcomes file at ${file}`);
  process.exit(1);
}

const rows = [];
for (const record of readRecords(file)) {
  for (const placement of placements(record)) {
    const predicted = placement.predicted ?? {};
    const observed = placement.observed ?? {};

    // Field paths read off a real record rather than assumed. `transform` is
    // what was asked for; `hologram_transform` is where the hologram actually
    // sat once the engine had positioned it, which is the number that matters.
    // The first draft of this script guessed `requested_location` and
    // `observed.transform`, found neither, and reported "nothing to compare"
    // on a file full of exactly the evidence being looked for.
    const reportedDrift = number(predicted.requested_z_drift_cm);
    const requestedZ = number(predicted.transform?.location?.z);
    const placedZ = number(
      predicted.hologram_transform?.location?.z ??
        observed.transform?.location?.z ??
        observed.location?.z,
    );
    const measured =
      requestedZ !== null && placedZ !== null ? Math.round((placedZ - requestedZ) * 10) / 10 : null;

    if (reportedDrift === null && measured === null) continue;
    rows.push({
      // The name lives on `predicted`, not on the result. Reading it off the
      // result gave a column of "place_building" forty times over.
      recipe: String(
        predicted.building_name ?? predicted.recipe_class ?? placement.action,
      ).split(/[./]/).pop().replace(/_C$/, ""),
      status: placement.status ?? (placement.accepted ? "accepted" : "unknown"),
      asked: requestedZ,
      landed: placedZ,
      reported: reportedDrift,
      measured,
      honoured: predicted.requested_z_honoured === true,
      reached: predicted.requested_z_reached,
    });
  }
}

if (rows.length === 0) {
  console.log(
    "No placement carries a height to compare yet.\n\n" +
      "That is expected until a design is placed with the current build: the drift\n" +
      "readout only exists on placements made since exact_z shipped. Place one and\n" +
      "run this again.",
  );
  process.exit(0);
}

const width = Math.max(...rows.map((row) => row.recipe.length), 14);
console.log(
  `${"building".padEnd(width)}  ${"asked".padStart(9)}  ${"landed".padStart(9)}  ${"drift".padStart(8)}  exact_z`,
);
for (const row of rows.slice(-40)) {
  const drift = row.reported ?? row.measured;
  const round1 = (v) => (v === null || v === undefined ? "?" : String(Math.round(Number(v) * 10) / 10));
  console.log(
    `${row.recipe.padEnd(width)}  ${round1(row.asked).padStart(9)}  ` +
      `${round1(row.landed).padStart(9)}  ${round1(drift).padStart(8)}  ` +
      `${row.honoured ? (row.reached === false ? "asked, NOT reached" : "honoured") : "not asked"}`,
  );
}

const drifts = rows.map((row) => row.reported ?? row.measured).filter((value) => value !== null);
if (drifts.length > 0) {
  const worst = Math.max(...drifts.map(Math.abs));
  console.log(
    `\n${drifts.length} placement(s) with a height. Worst drift ${worst} cm.` +
      (worst <= 1 ? "  <- the fix is holding" : "  <- still drifting; read the rows above"),
  );
}
const ignored = rows.filter((row) => row.honoured && row.reached === false);
if (ignored.length > 0) {
  console.log(
    `\n${ignored.length} placement(s) asked for an exact Z and did not get it. ` +
      "That is a hologram class resolving its own height -- the case the readback exists to expose.",
  );
}
