import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const repair = fs
  .readFileSync(new URL("../../scripts/repair-blueprint-pivot.mjs", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

test("the repair only touches blueprints this mod wrote", () => {
  // The first dry run over the owner's real library would have rewritten
  // hand-built and downloaded designs that were already correct - a tunnel
  // corner moving 33.8 m to 33.6 m, a constructor 13.8 m to 13.8 m. Rewriting
  // somebody else's blueprint to change nothing is pure risk.
  assert.match(repair, /const COPILOT_DESCRIPTION = \/AI Factory Copilot\/i;/);
  assert.match(repair, /if \(!COPILOT_DESCRIPTION\.test\(description\)\)/);
  assert.match(repair, /repair: false, why: "not written by this mod"/);
});

test("a blueprint already inside its declared box is left alone", () => {
  // Being far from the pivot is not itself a fault: a blueprint may legitimately
  // fill its designer, so the limit is the half-diagonal of the box it declares.
  assert.match(repair, /halfDiagonalCm/);
  assert.match(repair, /if \(worst <= halfDiagonalCm\)/);
  assert.match(repair, /already inside its/);
});

test("the origin rule matches the exporter's, so repaired and new captures agree", () => {
  // If these two drifted apart, a repaired blueprint and a freshly captured one
  // would sit differently under the crosshair for no reason a player could see.
  const exporter = fs
    .readFileSync(
      new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp", import.meta.url),
      "utf8",
    )
    .replace(/\r\n/g, "\n");

  assert.match(repair, /const GRID_CELL_CM = 800;/);
  assert.match(exporter, /constexpr double AIFactoryGridCellCm = 800\.0;/);

  // Both snap X and Y to the grid and take the floor in Z.
  assert.match(repair, /Math\.round\(centre\(xs\) \/ GRID_CELL_CM\) \* GRID_CELL_CM/);
  assert.match(repair, /Math\.round\(centre\(ys\) \/ GRID_CELL_CM\) \* GRID_CELL_CM/);
  assert.match(repair, /z: Math\.min\(\.\.\.zs\)/);
  assert.match(exporter, /FMath::RoundToDouble\(Centre\.X \/ AIFactoryGridCellCm\)/);
  assert.match(exporter, /Bounds\.Min\.Z\);/);
});

test("nothing is overwritten without a backup and a proven round trip", () => {
  // A file that no longer parses is worse than one that places in the wrong
  // spot, so the rewrite must read back as the same blueprint before it lands.
  assert.match(repair, /if \(!args\.apply\) continue;/);
  assert.match(repair, /piece count changed/);
  assert.match(repair, /pivot drifted on round trip/);
  assert.match(repair, /REFUSED — round trip failed/);
  // Backups are written before either file is replaced.
  const applyBlock = repair.slice(repair.indexOf("fs.copyFileSync(entry.sbpPath"));
  assert.match(applyBlock, /^fs\.copyFileSync\(entry\.sbpPath, entry\.sbpPath \+ "\.bak"\);/);
  assert.ok(
    applyBlock.indexOf('entry.cfgPath + ".bak"') < applyBlock.indexOf("fs.writeFileSync"),
    "both backups must be written before the first overwrite",
  );
});

test("report-only is the default", () => {
  // Running the tool with no arguments must never modify a library.
  assert.match(repair, /const args = \{ apply: false, dir: DEFAULT_DIR, only: null \};/);
});
