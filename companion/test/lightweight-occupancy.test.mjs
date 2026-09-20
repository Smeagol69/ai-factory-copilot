import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const designer = read("../lib/designer.mjs");
const solvers = read("../lib/solvers.mjs");
const megabase = read("../lib/megabase.mjs");

test("the collision test has a Z term at all", () => {
  // It did not. occupiedBoxes built XY-only boxes from every node with bounds,
  // foundations included, so a deck was a solid obstruction in plan view and
  // every machine placed ON it came back blocked by it. Building on your own
  // foundation is the ordinary case, and the planner refused it.
  assert.match(designer, /minZ: hasZ \? oz - ez : null,/);
  assert.match(designer, /maxZ: hasZ \? oz \+ ez : null,/);
  assert.match(designer, /function overlapsVertically\(box, z, heightCm\)/);
  assert.match(designer, /overlapsVertically\(box, finite\(originZ\), row\.footprint\.height_cm\)/);
});

test("a surface below the build plane does not block; a wall through it does", () => {
  // The single rule that removes the false positive without inventing a
  // deck-versus-obstruction taxonomy.
  assert.match(designer, /if \(box\.maxZ <= z \+ tolerance\) return false;/);
  assert.match(designer, /if \(box\.minZ >= machineTop - tolerance\) return false;/);
  // Coincident surfaces are the normal case: a machine sits on the deck.
  assert.match(designer, /const tolerance = 1;/);
});

test("Z carries no pad, or every deck would block again", () => {
  // The 200 cm XY pad is about walking room. Applying it vertically would
  // re-create exactly the bug being fixed.
  assert.match(designer, /No pad on Z\./);
  const boxBlock = designer.slice(designer.indexOf("function occupiedBoxes"), designer.indexOf("function overlapsVertically"));
  assert.doesNotMatch(boxBlock, /minZ:.*padCm/);
  assert.doesNotMatch(boxBlock, /maxZ:.*padCm/);
});

test("unknown height still blocks, which is the safe direction", () => {
  // A record without Z keeps the old always-block behaviour rather than
  // silently becoming placeable.
  assert.match(designer, /if \(box\.minZ === null \|\| box\.maxZ === null \|\| z === null\) return true;/);
});

test("all three readers now agree that lightweight geometry is real", () => {
  // Three consumers of one dataset previously gave three answers: the layout
  // designer blocked on foundations, while site selection and the Architect's
  // site check skipped them and reported clear ground on top of an existing
  // base.
  assert.match(
    solvers,
    /if \(node\.kind !== "buildable" && node\.kind !== "lightweight_buildable"\) continue;/,
  );
  assert.match(
    megabase,
    /if \(node\.kind !== "buildable" && node\.kind !== "lightweight_buildable"\) continue;/,
  );
  // And the layout designer never filtered by kind, which was the correct half.
  const occupied = designer.slice(designer.indexOf("function occupiedBoxes"), designer.indexOf("function overlapsVertically"));
  assert.doesNotMatch(occupied, /node\.kind !== "buildable"/);
});

test("the Architect site check keeps its real 3D overlap", () => {
  // Including lightweight pieces is only safe because that check already tests
  // Z; if it were XY-only this change would block every design over a deck.
  assert.match(megabase, /origin\.z, extent\.x, extent\.y, extent\.z\]\.every\(Number\.isFinite\)/);
});
