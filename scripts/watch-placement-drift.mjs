/**
 * Waits for the next placement and reports whether the height held.
 *
 * The test for `exact_z` needs one thing that cannot be automated from here: a
 * loaded save and a placement. This watches the outcomes file so that the
 * moment one happens, the answer is produced without anyone reading a log.
 *
 * Exits 0 the first time it sees a placement made with `exact_z` asked for,
 * printing the drift table. Exits 0 quietly on timeout.
 *
 *   node scripts/watch-placement-drift.mjs [minutes]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUTCOMES = path.join(
  process.env.LOCALAPPDATA ?? "",
  "FactoryGame/Saved/AIFactoryCopilot/Diagnostics/action-outcomes.jsonl",
);
const READER = new URL("read-placement-drift.mjs", import.meta.url).pathname.slice(1);
const deadline = Date.now() + Number(process.argv[2] ?? 90) * 60_000;

const sizeOf = () => (fs.existsSync(OUTCOMES) ? fs.statSync(OUTCOMES).size : 0);
let seen = sizeOf();

console.log(`watching ${OUTCOMES}`);
console.log(`starting size ${seen} bytes; waiting for a placement`);

const report = () => execFileSync(process.execPath, [READER], { encoding: "utf8" });

// The interesting transition is a placement that *asked* for its Z, because
// that is the one the fix changed. Anything else is the old behaviour and
// worth printing too, but it does not answer the question.
const asksForZ = (text) => /"requested_z_honoured"\s*:\s*true/.test(text);

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const size = sizeOf();
  if (size === seen) continue;
  seen = size;

  const text = fs.readFileSync(OUTCOMES, "utf8");
  console.log(`\n--- outcomes file grew to ${size} bytes ---`);
  console.log(report());

  if (asksForZ(text)) {
    const reached = /"requested_z_reached"\s*:\s*false/.test(text);
    console.log(
      reached
        ? "\nA placement asked for an exact Z and DID NOT reach it. Read `snapped_building` " +
          "on that action: if it names a foundation from the same design, the snap is " +
          "overriding the height and the fix needs to skip TrySnapToActor when exact_z is set."
        : "\nA placement asked for an exact Z and reached it. The fix is holding.",
    );
    process.exit(0);
  }
  console.log("\n(no placement has asked for an exact Z yet — still the old path)");
}
console.log("timed out without a placement");
