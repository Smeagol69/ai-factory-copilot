#!/usr/bin/env node
/**
 * Recentre a saved blueprint that was captured before the pivot fix.
 *
 * Captures written by the mod before 2026-09-14 were serialised against the
 * Blueprint Designer's own origin rather than their own, because
 * `AFGBuildableBlueprintDesigner::SaveBlueprint` offers no origin parameter.
 * Buildings adopted where they already stood were therefore recorded at their
 * true world offset from a designer that could be a kilometre away. Placing one
 * puts the pivot under the crosshair and every piece that same distance out.
 *
 * The exporter now passes an explicit origin to
 * `AFGBlueprintSubsystem::WriteBlueprintToArchive`, so new captures are correct.
 * A file already on disk cannot be reached by that fix; this repairs those.
 *
 * The origin rule matches ComputeCaptureOrigin in AIFactoryBlueprintExport.cpp
 * exactly, so a repaired blueprint and a freshly captured one sit the same way:
 * X and Y snapped to the 8 m grid, Z at the floor of the contents, no rotation.
 *
 * Nothing is overwritten without --apply, and --apply always writes a .bak
 * pair first and refuses if the rewritten file does not decode back to the
 * same buildings.
 *
 * Usage:
 *   node scripts/repair-blueprint-pivot.mjs                  # report only
 *   node scripts/repair-blueprint-pivot.mjs --apply          # repair in place
 *   node scripts/repair-blueprint-pivot.mjs --dir "<path>"   # a different library
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "companion", "package.json"));
const { Parser } = require("@etothepii/satisfactory-file-parser");

/** One 8 m build grid cell, in centimetres. Matches AIFactoryGridCellCm. */
const GRID_CELL_CM = 800;

const DEFAULT_DIR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "FactoryGame",
  "Saved",
  "SaveGames",
  "blueprints",
);

function parseArgs(argv) {
  const args = { apply: false, dir: DEFAULT_DIR, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
  }
  return args;
}

const toArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

function listBlueprints(dir) {
  const found = new Map();
  const seenDirs = new Set();

  const walk = (current) => {
    // Blueprint libraries really do contain junctions: one observed library had
    // a folder that was a Windows junction onto a sibling, so every blueprint
    // in it was reachable by two paths. Resolving to the real path and
    // remembering it means a file is considered once, however many links point
    // at it -- subtracting an origin twice would move a blueprint further out
    // than it started.
    let real;
    try {
      real = fs.realpathSync.native(current);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(real, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(full);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".sbp")) continue;
      try {
        found.set(fs.realpathSync.native(full), full);
      } catch {
        found.set(full, full);
      }
    }
  };

  walk(dir);
  return [...found.values()].sort();
}

function readBlueprint(sbpPath) {
  const cfgPath = sbpPath.replace(/\.sbp$/i, ".sbpcfg");
  if (!fs.existsSync(cfgPath)) return null;
  const name = path.basename(sbpPath, path.extname(sbpPath));
  return {
    name,
    sbpPath,
    cfgPath,
    parsed: Parser.ParseBlueprintFiles(
      name,
      toArrayBuffer(fs.readFileSync(sbpPath)),
      toArrayBuffer(fs.readFileSync(cfgPath)),
      { throwErrors: true },
    ),
  };
}

/** Every object that carries a translation of its own. */
const placedObjects = (parsed) =>
  (parsed.objects ?? []).filter((object) => object?.transform?.translation);

/**
 * The origin the contents should have been written against.
 *
 * Deliberately identical to ComputeCaptureOrigin: the midpoint of the recorded
 * translations, snapped to the grid in X and Y so an aligned build stays
 * aligned, and the lowest Z so the result sits on its own floor.
 */
function computeOrigin(objects) {
  const xs = objects.map((o) => o.transform.translation.x);
  const ys = objects.map((o) => o.transform.translation.y);
  const zs = objects.map((o) => o.transform.translation.z);
  if (!xs.length || [...xs, ...ys, ...zs].some((v) => !Number.isFinite(v))) return null;
  const centre = (values) => (Math.min(...values) + Math.max(...values)) / 2;
  return {
    x: Math.round(centre(xs) / GRID_CELL_CM) * GRID_CELL_CM,
    y: Math.round(centre(ys) / GRID_CELL_CM) * GRID_CELL_CM,
    z: Math.min(...zs),
  };
}

const furthest = (objects) =>
  objects.reduce((worst, o) => {
    const t = o.transform.translation;
    return Math.max(worst, Math.hypot(t.x, t.y, t.z));
  }, 0);

/** The exporter stamps this into every capture it writes. */
const COPILOT_DESCRIPTION = /AI Factory Copilot/i;

/**
 * Is this file one of ours, and actually mis-pivoted?
 *
 * Both halves matter. The first dry run over the owner's library showed this
 * tool recentring hand-built and downloaded designs that were already fine -
 * `3X Constructor` moved 13.8 m to 13.8 m, a tunnel corner 33.8 m to 33.6 m.
 * Rewriting somebody else's blueprint to change nothing is pure risk, so a file
 * is repaired only when the exporter's own description is on it and its
 * contents genuinely fall outside the box it declares.
 *
 * The box test uses the declared designer dimensions in 8 m tiles. A blueprint
 * legitimately fills its designer, so the furthest piece can sit at the far
 * corner; the half-diagonal of the declared box is that limit, and anything
 * past it could never have been built inside the designer it claims.
 */
function needsRepair(parsed, objects) {
  const description = String(parsed.config?.description ?? "");
  if (!COPILOT_DESCRIPTION.test(description)) {
    return { repair: false, why: "not written by this mod" };
  }
  const dim = parsed.header?.designerDimension ?? { x: 0, y: 0, z: 0 };
  const halfDiagonalCm =
    (Math.hypot(Number(dim.x) || 0, Number(dim.y) || 0, Number(dim.z) || 0) * GRID_CELL_CM) / 2;
  if (!(halfDiagonalCm > 0)) {
    return { repair: false, why: "no declared designer box to judge against" };
  }
  const worst = furthest(objects);
  if (worst <= halfDiagonalCm) {
    return { repair: false, why: `already inside its ${(halfDiagonalCm / 100).toFixed(1)} m box` };
  }
  return { repair: true, why: null };
}

/** Serialise a parsed blueprint back to a .sbp / .sbpcfg buffer pair. */
function serialize(parsed) {
  const chunks = [];
  let headerChunk = null;
  const configChunks = [];
  Parser.WriteBlueprintFiles(
    parsed,
    (header) => {
      headerChunk = Buffer.from(header);
    },
    (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
    {
      onBlueprintConfigHeader: (header) => configChunks.push(Buffer.from(header)),
      onBlueprintConfigChunk: (chunk) => configChunks.push(Buffer.from(chunk)),
    },
  );
  return {
    sbp: Buffer.concat([headerChunk ?? Buffer.alloc(0), ...chunks]),
    cfg: configChunks.length ? Buffer.concat(configChunks) : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    console.error(`No blueprint library at ${args.dir}`);
    process.exit(2);
  }

  const files = listBlueprints(args.dir).filter(
    (f) => !args.only || path.basename(f, ".sbp").toLowerCase().includes(args.only.toLowerCase()),
  );
  console.log(`Scanning ${files.length} blueprint(s) under ${args.dir}`);
  console.log(args.apply ? "MODE: apply (backups written)\n" : "MODE: report only\n");

  let repaired = 0;
  let skipped = 0;

  for (const file of files) {
    const label = path.relative(args.dir, file);
    let entry;
    try {
      entry = readBlueprint(file);
    } catch (error) {
      console.log(`  SKIP  ${label} — unreadable: ${error.message}`);
      skipped += 1;
      continue;
    }
    if (!entry) {
      console.log(`  SKIP  ${label} — no .sbpcfg beside it`);
      skipped += 1;
      continue;
    }

    const objects = placedObjects(entry.parsed);
    if (!objects.length) {
      console.log(`  SKIP  ${label} — nothing placed`);
      skipped += 1;
      continue;
    }

    const before = furthest(objects);
    const verdict = needsRepair(entry.parsed, objects);
    if (!verdict.repair) {
      console.log(
        `  LEAVE ${label} — ${verdict.why} (${(before / 100).toFixed(1)} m from pivot)`,
      );
      skipped += 1;
      continue;
    }

    const origin = computeOrigin(objects);
    if (!origin) {
      console.log(`  SKIP  ${label} — non-finite transform`);
      skipped += 1;
      continue;
    }
    if (origin.x === 0 && origin.y === 0 && origin.z === 0) {
      console.log(`  OK    ${label} — already centred (${(before / 100).toFixed(1)} m)`);
      continue;
    }

    for (const object of objects) {
      object.transform.translation.x -= origin.x;
      object.transform.translation.y -= origin.y;
      object.transform.translation.z -= origin.z;
    }
    const after = furthest(objects);

    console.log(
      `  FIX   ${label} — ${objects.length} pieces, ` +
        `${(before / 100).toFixed(1)} m -> ${(after / 100).toFixed(1)} m from pivot`,
    );

    if (!args.apply) continue;

    let written;
    try {
      written = serialize(entry.parsed);
    } catch (error) {
      console.log(`        REFUSED — could not serialise: ${error.message}`);
      skipped += 1;
      continue;
    }

    // Prove the rewrite reads back as the same blueprint before replacing the
    // original. A file that no longer parses is worse than one that places in
    // the wrong spot.
    try {
      const check = Parser.ParseBlueprintFiles(
        entry.name,
        toArrayBuffer(written.sbp),
        toArrayBuffer(written.cfg ?? fs.readFileSync(entry.cfgPath)),
        { throwErrors: true },
      );
      const checkObjects = placedObjects(check);
      if (checkObjects.length !== objects.length) {
        throw new Error(`piece count changed: ${objects.length} -> ${checkObjects.length}`);
      }
      const drift = furthest(checkObjects);
      if (Math.abs(drift - after) > 1) {
        throw new Error(`pivot drifted on round trip: ${after} vs ${drift}`);
      }
    } catch (error) {
      console.log(`        REFUSED — round trip failed: ${error.message}`);
      skipped += 1;
      continue;
    }

    fs.copyFileSync(entry.sbpPath, entry.sbpPath + ".bak");
    fs.copyFileSync(entry.cfgPath, entry.cfgPath + ".bak");
    fs.writeFileSync(entry.sbpPath, written.sbp);
    if (written.cfg) fs.writeFileSync(entry.cfgPath, written.cfg);
    console.log(`        applied (backup: ${path.basename(entry.sbpPath)}.bak)`);
    repaired += 1;
  }

  console.log();
  console.log(
    args.apply
      ? `Repaired ${repaired}, skipped ${skipped}.`
      : `Would repair ${files.length - skipped}. Re-run with --apply to write.`,
  );
}

main();
