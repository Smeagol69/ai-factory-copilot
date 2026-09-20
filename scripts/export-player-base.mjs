import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWorld, sha256 } from "./lib/world-transfer.mjs";
import { compilePlayerMegaprint, encodeMegaprint, SCIM_REVISION } from "./lib/player-base-transfer.mjs";

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!["--save", "--snapshot", "--scim", "--output"].includes(args[index]) || !args[index + 1]) {
      throw new Error("Usage: --save <source.sav> --snapshot <captured.json> --scim <pinned-SCIM-checkout> --output <new-directory>");
    }
    if (options[args[index]]) throw new Error("Repeated argument");
    options[args[index]] = resolve(args[index + 1]);
  }
  if (Object.keys(options).length !== 4) throw new Error("save, snapshot, scim and output are required");
  const ref = options["--scim"];
  const revision = execFileSync("git", ["-C", ref, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const changes = execFileSync("git", ["-C", ref, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (revision !== SCIM_REVISION || changes) throw new Error("SCIM checkout must be clean at " + SCIM_REVISION);
  const bytes = readFileSync(options["--save"]);
  const originalHash = sha256(bytes);
  const save = parseWorld(bytes);
  const snapshot = JSON.parse(readFileSync(options["--snapshot"], "utf8"));
  // Only adapt the worker message transport. The upstream parser runs unchanged
  // and entirely locally; no save contents are sent to a website.
  globalThis.self = {};
  const { default: Reader } = await import(pathToFileURL(join(ref, "src/SaveParser/Read.js")).href);
  const scim = { objects: {} };
  let ended = false;
  new Reader({ postMessage(message) {
    if (message.command === "transferData") {
      if (message.key === "objects") Object.assign(scim.objects, message.data);
      else Object.assign(scim, message.data);
    } else if (message.command === "endSaveLoading") ended = true;
    else if (["alert", "alertParsing"].includes(message.command)) throw new Error(message.message ?? "SCIM parser refused");
  } }, { language: "en", arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  if (!ended) throw new Error("SCIM parser did not finish");
  const { clipboard, coordinates, report } = compilePlayerMegaprint(save, snapshot, scim);
  const cbp = encodeMegaprint(clipboard);
  const output = options["--output"];
  if (sha256(readFileSync(options["--save"])) !== originalHash) throw new Error("Source changed during export");
  mkdirSync(output); // Never overwrite an existing export directory.
  const files = {};
  const write = (name, content) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    writeFileSync(join(output, name), data, { flag: "wx" });
    if (sha256(readFileSync(join(output, name))) !== sha256(data)) throw new Error("Readback failed: " + name);
    files[name] = { bytes: data.length, sha256: sha256(data) };
  };
  write("chatgpt-player-base.cbp", cbp);
  write("exact-world-transforms.json", JSON.stringify(coordinates, null, 2));
  write("megaprint-decoded.json", JSON.stringify(clipboard, null, 2));
  const classCounts = {};
  for (const row of coordinates) classCounts[row.class_path] = (classCounts[row.class_path] ?? 0) + 1;
  report.class_counts = classCounts;
  report.source_sha256 = originalHash;
  report.snapshot_sha256 = sha256(readFileSync(options["--snapshot"]));
  report.verification.compressed_file_reparsed_and_all_transform_bits_match = true;
  report.files = { ...files };
  write("transfer-report.json", JSON.stringify(report, null, 2));
  write("README.txt", [
    "CHATGPT PLAYER BASE — ORIGINAL WORLD COORDINATES",
    `${report.counts.player_placed_pieces} placed pieces: ${report.counts.buildable_actors} actors and ${report.counts.active_lightweight} lightweight instances.`,
    `${report.counts.excluded_deleted_lightweight_slots} dismantled slots excluded. Map actors, player and global progression excluded.`,
    "Import chatgpt-player-base.cbp as a Megaprint in Satisfactory Calculator Interactive Map.",
    "Load the destination save, import the file, then choose 'Paste megaprint in the original position'.",
    "Do not paste onto a foundation or set an offset/rotation: the coordinates are already absolute.",
    "Download the result under a NEW save filename, keeping the destination original as backup.",
    "Matching mods are required. See transfer-report.json for exact classes, source mod versions and external resource references.",
    "The exported set includes your placed HUB/Designer and their owned pieces. Check destination duplicates before importing.",
    ...report.unresolved_source_references.map((ref) =>
      `Source reference has no serialized object and needs destination/game resolution: ${ref.path_name}`),
    "File contents and transforms were verified with two parsers; loading/spawning in a destination game has NOT been verified.",
    "This is a .cbp Megaprint for save transfer, not a native .sbp for the in-game Blueprint menu.",
    "SCIM source: https://github.com/AnthorNet/SC-InteractiveMap",
    `Pinned revision: ${SCIM_REVISION}`, `Source SHA-256: ${originalHash}`,
  ].join("\r\n") + "\r\n");
  console.log(JSON.stringify({ output, counts: report.counts, external_references: report.external_references,
    verification: report.verification }, null, 2));
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
