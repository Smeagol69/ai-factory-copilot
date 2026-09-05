/**
 * Turn blueprint files into evidence both agents can read.
 *
 * Drop a `.sbp` + `.sbpcfg` pair (or a `.cbp` world export) into
 * `reference/blueprints/sources/` and run this. It produces three things:
 *
 *   reference/blueprints/decoded/<id>.json  - the complete decode, every
 *                                             building, transform, recipe and
 *                                             clock. Nothing truncated.
 *   reference/blueprints/decoded/<id>.md    - the same decode as a readable
 *                                             sheet with a plan view.
 *   companion/lib/blueprint-reference-catalog.mjs - the aggregate catalog the
 *                                             running bridge queries.
 *
 * The decodes are committed. That is the point: Claude and Codex then read
 * identical evidence about a supplied design instead of each re-deriving it,
 * and neither needs the binary to reason about the build.
 *
 *   node scripts/ingest-blueprint-reference.mjs
 *   node scripts/ingest-blueprint-reference.mjs --check   (fail if stale)
 *
 * Files present in `sources/` but absent from `sources.json` are still ingested,
 * with metadata left unknown - a supplied blueprint should never be ignored just
 * because nobody wrote a manifest entry for it yet. Manifest entries whose files
 * are missing are reported and skipped, never silently dropped.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { inspectBlueprintStructure } from "../companion/lib/blueprints.mjs";
import {
  buildReferenceCatalog,
  summarizeReference,
  summarizeWorldExport,
} from "../companion/lib/blueprint-reference.mjs";
import { decodeBlueprint, decodeWorldExport } from "../companion/lib/blueprint-decode.mjs";
import { renderBlueprintSheet } from "../companion/lib/blueprint-sheet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REFERENCE_DIR = path.join(ROOT, "reference", "blueprints");
const SOURCE_DIR = path.join(REFERENCE_DIR, "sources");
const DECODED_DIR = path.join(REFERENCE_DIR, "decoded");
const MANIFEST_PATH = path.join(REFERENCE_DIR, "sources.json");

// The installer ships `companion/lib/*.mjs` and nothing else, so the catalog is
// emitted as a module rather than as JSON beside the sources. That also means
// the runtime imports it statically: no filesystem read, no path resolution, and
// no way for it to be missing at a customer install.
const CATALOG_PATH = path.join(ROOT, "companion", "lib", "blueprint-reference-catalog.mjs");

// Every buildable, not the interactive default: the catalog records aggregate
// class counts, and a truncated read would understate the vocabulary.
const MAXIMUM_BUILDABLES = 200;

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`missing manifest: ${MANIFEST_PATH}`);
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "blueprint";
}

/**
 * Manifest entries first, then anything else sitting in `sources/`.
 */
function discoverEntries(manifest) {
  const entries = [...(manifest.entries ?? [])];
  const claimed = new Set();
  for (const entry of entries) {
    for (const file of Object.values(entry.files ?? {})) claimed.add(file);
  }
  if (!fs.existsSync(SOURCE_DIR)) return entries;

  for (const file of fs.readdirSync(SOURCE_DIR).sort()) {
    if (claimed.has(file)) continue;
    if (file.endsWith(".sbp")) {
      const config = `${file.slice(0, -".sbp".length)}.sbpcfg`;
      if (!fs.existsSync(path.join(SOURCE_DIR, config))) continue;
      entries.push({
        id: slugify(path.basename(file, ".sbp")),
        kind: "unclassified",
        author: null,
        notes: "Discovered in sources/ without a manifest entry.",
        files: { sbp: file, sbpcfg: config },
        discovered: true,
      });
    } else if (file.endsWith(".cbp")) {
      entries.push({
        id: slugify(path.basename(file, ".cbp")),
        kind: "base_build",
        author: null,
        notes: "Discovered in sources/ without a manifest entry.",
        files: { cbp: file },
        discovered: true,
      });
    }
  }
  return entries;
}

function ingestBlueprint(entry) {
  const sbp = path.join(SOURCE_DIR, entry.files.sbp);
  const sbpcfg = path.join(SOURCE_DIR, entry.files.sbpcfg);
  if (!fs.existsSync(sbp) || !fs.existsSync(sbpcfg)) return null;
  const sbpBuffer = fs.readFileSync(sbp);
  const sbpcfgBuffer = fs.readFileSync(sbpcfg);
  const displayName = path.basename(entry.files.sbp, ".sbp");

  const inspection = inspectBlueprintStructure(displayName, sbpBuffer, sbpcfgBuffer, {
    maximumBuildables: MAXIMUM_BUILDABLES,
  });
  return {
    summary: summarizeReference(inspection, {
      id: entry.id,
      kind: entry.kind,
      author: entry.author ?? null,
      notes: entry.notes ?? null,
    }),
    decode: decodeBlueprint(displayName, sbpBuffer, sbpcfgBuffer),
  };
}

function ingestWorldExport(entry) {
  const cbp = path.join(SOURCE_DIR, entry.files.cbp);
  if (!fs.existsSync(cbp)) return null;
  // Interactive-map exports are a single raw zlib stream wrapping JSON.
  const document = JSON.parse(zlib.inflateSync(fs.readFileSync(cbp)).toString("utf8"));
  const displayName = path.basename(entry.files.cbp, ".cbp");
  return {
    summary: summarizeWorldExport(document.data, {
      id: entry.id,
      name: displayName,
      kind: entry.kind,
      author: entry.author ?? null,
      notes: entry.notes ?? null,
      saveVersion: document.saveVersion ?? null,
      buildVersion: document.buildVersion ?? null,
    }),
    decode: decodeWorldExport(displayName, document),
  };
}

// A designer blueprint is the thing the owner actually hands us to understand
// and rebuild, so its decode is committed whole. A whole-base world export is
// reference material and can run to thousands of walls; its committed building
// list is capped, with every machine kept and the truncation stated in the file.
// The Markdown sheet is always rendered from the complete decode, so the plan
// view and every count stay exact either way.
const WORLD_EXPORT_BUILDING_CAP = 1500;

function decodeForStorage(decode) {
  if (!decode.available) return decode;
  if (decode.source !== "decoded_from_interactive_map_world_export") return decode;
  if (decode.buildings.length <= WORLD_EXPORT_BUILDING_CAP) return decode;

  const machines = decode.buildings.filter(
    (building) => building.role === "production" || building.role === "utility",
  );
  const keptIndexes = new Set(machines.map((building) => building.index));
  const rest = decode.buildings.filter((building) => !keptIndexes.has(building.index));
  const kept = [...machines, ...rest.slice(0, Math.max(WORLD_EXPORT_BUILDING_CAP - machines.length, 0))];
  kept.sort((a, b) => a.class_name?.localeCompare(b.class_name ?? "") || a.index - b.index);

  return {
    ...decode,
    buildings: kept,
    buildings_returned: kept.length,
    buildings_truncated: decode.buildings.length - kept.length,
    truncation_note: `This world export contains ${decode.buildings.length} buildings; the committed list keeps every production and utility building plus the first ${WORLD_EXPORT_BUILDING_CAP - machines.length} of the rest. Every aggregate above (totals, machine_groups, pivot_extent) is computed from the complete set, and the Markdown sheet's plan view draws all of them. Re-run the ingest against the source for the untruncated list.`,
  };
}

function serializeCatalog(catalog) {
  return [
    "// Generated by scripts/ingest-blueprint-reference.mjs. Do not edit by hand.",
    "//",
    "// Regenerate with the reference sources present in reference/blueprints/sources/:",
    "//   node scripts/ingest-blueprint-reference.mjs",
    "",
    `export const BLUEPRINT_REFERENCE_CATALOG = Object.freeze(${JSON.stringify(catalog, null, 2)});`,
    "",
    "export default BLUEPRINT_REFERENCE_CATALOG;",
    "",
  ].join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const manifest = readManifest();
  const entries = discoverEntries(manifest);

  const references = [];
  const skipped = [];
  const artifacts = new Map();

  for (const entry of entries) {
    const ingested = entry.files?.cbp ? ingestWorldExport(entry) : ingestBlueprint(entry);
    if (!ingested) {
      skipped.push(entry.id);
      continue;
    }
    references.push(ingested.summary);
    const jsonRelative = path.posix.join("reference/blueprints/decoded", `${entry.id}.json`);
    artifacts.set(
      path.join(DECODED_DIR, `${entry.id}.json`),
      `${JSON.stringify(decodeForStorage(ingested.decode), null, 2)}\n`,
    );
    artifacts.set(
      path.join(DECODED_DIR, `${entry.id}.md`),
      renderBlueprintSheet(ingested.decode, { jsonPath: jsonRelative }),
    );
  }

  const catalog = buildReferenceCatalog(references, {
    generated_from: "reference/blueprints/sources.json",
  });
  artifacts.set(CATALOG_PATH, serializeCatalog(catalog));

  if (check) {
    const stale = [...artifacts.entries()].filter(([file, content]) => {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return existing !== content;
    });
    if (stale.length) {
      console.error("stale, run: node scripts/ingest-blueprint-reference.mjs");
      for (const [file] of stale) console.error(`  ${path.relative(ROOT, file)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`current: ${catalog.reference_count} references, ${artifacts.size} artifacts`);
    return;
  }

  fs.mkdirSync(DECODED_DIR, { recursive: true });
  for (const [file, content] of artifacts) fs.writeFileSync(file, content);

  console.log(`${catalog.reference_count} references, ${artifacts.size} artifacts written`);
  const { counts, total_buildables } = catalog.role_census;
  console.log(`  ${total_buildables} buildables across the library`);
  for (const [role, count] of Object.entries(counts)) {
    if (count > 0) {
      const share = ((count / total_buildables) * 100).toFixed(1);
      console.log(`    ${role.padEnd(13)} ${String(count).padStart(6)}  ${share.padStart(5)}%`);
    }
  }
  if (skipped.length) {
    console.log(`  skipped (sources not present locally): ${skipped.join(", ")}`);
  }
}

main();
