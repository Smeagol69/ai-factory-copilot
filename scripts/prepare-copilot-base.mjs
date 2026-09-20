import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parseWorld, sha256 } from "./lib/world-transfer.mjs";
import { selectPlayerBase } from "./lib/player-base-transfer.mjs";
import { createBaseTransfer, validateBaseTransfer } from "../companion/lib/base-transfer.mjs";

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--save", "--snapshot", "--output"].includes(args[i]) || !args[i+1] || options[args[i]]) {
    throw new Error("Usage: --save <source.sav> --snapshot <captured.json> --output <new-directory>");
  }
  options[args[i]] = resolve(args[i+1]);
}
if (Object.keys(options).length !== 3) throw new Error("save, snapshot and output are required");
const bytes = readFileSync(options["--save"]), saveHash = sha256(bytes);
const snapshotBytes = readFileSync(options["--snapshot"]);
const save = parseWorld(bytes), selection = selectPlayerBase(save, JSON.parse(snapshotBytes));
const pieces = [
  ...selection.actors.map(row => ({ id: row.instance_name, kind: "actor", class_path: row.class_path,
    transform: row.transform, source_record_index: row.record_index })),
  ...selection.lightweight.map(row => ({ id: `lightweight:${row.group_index}:${row.instance_index}`,
    kind: "lightweight", class_path: row.class_path, transform: row.transform,
    source_record_index: row.record_index })),
];
const manifest = createBaseTransfer({ save_file: basename(options["--save"]), save_sha256: saveHash,
  snapshot_sha256: sha256(snapshotBytes), session_name: save.header.sessionName,
  map_name: save.header.mapName, save_version: save.header.saveVersion,
  build_version: save.header.buildVersion }, pieces);
// Retain decoded state for the native adapter, independently of a movable sbp.
// Only build-owned records and explicitly referenced proxy/circuit metadata;
// no player, map actors, progression or lightweight tombstones.
const actorIds = new Set(selection.actors.map(row => row.instance_name));
const components = selection.scan.records.filter(row => row.record_type === "SaveComponent" && actorIds.has(row.parent_entity_name));
const selectedRecords = [...selection.actors.map(row => row.raw_record), ...components.map(row => row.raw_record)];
const refs = new Set();
const visit = value => {
  if (!value || typeof value !== "object") return;
  if (typeof value.pathName === "string") refs.add(value.pathName);
  for (const child of Object.values(value)) visit(child);
};
selectedRecords.forEach(visit);
selection.lightweight.forEach(row => visit(row.raw_instance));
const metadata = selection.scan.records.filter(row => refs.has(row.instance_name) &&
  ["/Script/FactoryGame.FGBlueprintProxy", "/Script/FactoryGame.FGPowerCircuit"].includes(row.class_path));
const included = new Set([...actorIds, ...components.map(row => row.instance_name), ...metadata.map(row => row.instance_name)]);
for (const row of selection.scan.records.filter(row => row.class_path === "/Script/FactoryGame.FGPowerCircuit")) {
  const members = row.raw_record.properties?.mComponents?.values;
  if (!Array.isArray(members)) throw new Error("Unknown circuit membership: " + row.instance_name);
  if (!members.some(ref => included.has(ref.pathName))) continue;
  if (!members.every(ref => included.has(ref.pathName))) throw new Error("Circuit crosses the selected base boundary");
  if (!included.has(row.instance_name)) metadata.push(row);
  included.add(row.instance_name);
}
metadata.forEach(row => visit(row.raw_record));
const allRecords = new Map(selection.scan.records.map(row => [row.instance_name, row]));
const externalReferences = [...refs].filter(path => path && !path.startsWith("/") && !included.has(path))
  .sort().map(path => ({ path_name: path, source_record_present: allRecords.has(path),
    class_path: allRecords.get(path)?.class_path ?? null }));
const records = { actors: selection.actors, components, lightweight: selection.lightweight, metadata };
let marker = "__base_negative_zero__";
const ordinary = JSON.stringify(records);
while (ordinary.includes(JSON.stringify(marker))) marker += "_";
const stateBytes = Buffer.from(JSON.stringify(records, (_key, value) => Object.is(value, -0) ? marker : value)
  .replaceAll(JSON.stringify(marker), "-0"));
manifest.saved_state = { file: "saved-build-state.json", sha256: sha256(stateBytes) };
manifest.external_references = externalReferences;
manifest.source_mod_metadata = save.header.modMetadata;
manifest.counts = { actors: selection.actors.length, lightweight: selection.lightweight.length,
  owned_components: components.length, proxy_records: metadata.filter(row => row.class_path.endsWith(".FGBlueprintProxy")).length,
  power_circuits: metadata.filter(row => row.class_path.endsWith(".FGPowerCircuit")).length,
  excluded_deleted_lightweight_slots: selection.deleted_lightweight.length };
manifest.readiness = { can_spawn: false, blockers: [
  "native_absolute_restore_adapter_not_implemented",
  "native_blueprint_collection_excludes_saved_blueprint_designer",
  "complete_game_readback_of_all_pieces_and_connections_required",
  ...externalReferences.filter(ref => !ref.source_record_present).map(ref => "unresolved_source_reference:" + ref.path_name),
] };
if (sha256(readFileSync(options["--save"])) !== saveHash) throw new Error("Source save changed during scan");
const output = options["--output"];
mkdirSync(output); // Refuse replacement of an existing package.
writeFileSync(join(output, "saved-build-state.json"), stateBytes, { flag: "wx" });
writeFileSync(join(output, "source-manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
validateBaseTransfer(JSON.parse(readFileSync(join(output, "source-manifest.json"))));
if (sha256(readFileSync(join(output, "saved-build-state.json"))) !== manifest.saved_state.sha256) throw new Error("Saved-state readback mismatch");
console.log(JSON.stringify({ output, pieces: manifest.piece_count, actors: selection.actors.length,
  lightweight: selection.lightweight.length, components: components.length,
  excluded_deleted: selection.deleted_lightweight.length, transform_sha256: manifest.transform_sha256,
  can_spawn: false }, null, 2));
