import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { inspectParsedWorld, transformEvidence } from "./world-transfer.mjs";

export const SCIM_REVISION = "dfafafa5090e091c9db4253c56f38a48f72e4db1";
const PROXY = "/Script/FactoryGame.FGBlueprintProxy";
const CIRCUIT = "/Script/FactoryGame.FGPowerCircuit";
const clone = (object) => structuredClone(object);
const property = (object, name) => object.properties?.find((entry) => entry.name === name)?.value;

function transformKey(type, transform) {
  return type + ":" + JSON.stringify(transformEvidence(transform).transform_float64_le_hex);
}
function scimTransform(object) {
  const t = object.transform;
  return {
    translation: Object.fromEntries(["x", "y", "z"].map((axis, i) => [axis, t?.translation?.[i]])),
    rotation: Object.fromEntries(["x", "y", "z", "w"].map((axis, i) => [axis, t?.rotation?.[i]])),
    scale3d: Object.fromEntries(["x", "y", "z"].map((axis, i) => [axis, t?.scale3d?.[i] ?? 1])),
  };
}

/** Build identity comes from captured building classes/recipes and ownership,
 * never a radius or a class-name substring. Map-placed actors are excluded.
 */
export function selectPlayerBase(save, snapshot, { excludeHub = false } = {}) {
  const scan = inspectParsedWorld(save);
  const knownClasses = new Set((snapshot?.content?.items ?? [])
    .map((item) => item.building?.class_path).filter(Boolean));
  if (!knownClasses.size) throw new Error("A captured building-class catalog is required");
  const entities = scan.records.filter((record) => record.record_type === "SaveEntity");
  const selected = new Set(entities.filter(({ raw_record: object }) =>
    object.wasPlacedInLevel === false &&
    (knownClasses.has(object.typePath) || Boolean(object.properties?.mBuiltWithRecipe?.value?.pathName)))
    .map((record) => record.instance_name));
  // Observed saved ownership, not a name-prefix heuristic: this N-gon parent
  // explicitly stores all twelve generated pieces in its construction array.
  for (const record of entities.filter((entry) => selected.has(entry.instance_name))) {
    if (record.class_path !== "/NgonFoundations/Buildables/Build_DodNFWhole4m.Build_DodNFWhole4m_C") continue;
    const refs = record.raw_record.properties?.DodNumToBuild4?.values ??
      record.raw_record.properties?.DodNumToBuild4?.value?.values;
    if (refs === undefined) continue;
    if (!Array.isArray(refs)) throw new Error("Unknown N-gon assembly ownership");
    for (const ref of refs) {
      const child = entities.find((entry) => entry.instance_name === ref.pathName);
      if (!child || child.class_path !== "/NgonFoundations/Buildables/Build_DodNFPiece4m.Build_DodNFPiece4m_C") {
        throw new Error("Missing N-gon assembly piece: " + ref.pathName);
      }
      selected.add(child.instance_name);
    }
  }
  // HUB and other buildables can own actor-based parts with no build recipe.
  let changed;
  do {
    changed = false;
    for (const record of entities) {
      if (record.raw_record.wasPlacedInLevel === false &&
          selected.has(record.raw_record.parentObject?.pathName) && !selected.has(record.instance_name)) {
        selected.add(record.instance_name); changed = true;
      }
    }
  } while (changed);
  const actors = entities.filter((record) => selected.has(record.instance_name));
  const unresolved = entities.filter((record) => record.raw_record.needTransform &&
    !selected.has(record.instance_name) && record.class_path !== PROXY &&
    !["/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C",
      "/Script/FactoryGame.FGItemPickup_Spawnable"].includes(record.class_path));
  if (unresolved.length) throw new Error("Unclassified dynamic actors: " + unresolved.map((r) => r.class_path).join(", "));
  const active = [];
  const deleted = [];
  for (const record of scan.lightweight) {
    const recipe = record.raw_instance.usedRecipe?.pathName;
    const swatch = record.raw_instance.usedSwatchSlot?.pathName;
    if (!recipe && !swatch) deleted.push(record);
    else if (!recipe || !swatch) throw new Error("Ambiguous lightweight validity: " + record.record_index);
    else active.push(record);
  }
  const names = new Set();
  for (const record of scan.records) {
    if (names.has(record.instance_name)) throw new Error("Duplicate source object identity: " + record.instance_name);
    names.add(record.instance_name);
  }
  const omitted = new Set();
  if (excludeHub) {
    // Exact vanilla HUB class and saved ownership fields, as declared in
    // FGBuildableTradingPost.h. Never remove nearby or similarly named objects.
    for (const hub of actors.filter(row => row.class_path === "/Game/FactoryGame/Buildable/Factory/TradingPost/Build_TradingPost.Build_TradingPost_C")) {
      omitted.add(hub.instance_name);
      for (const key of ["mGenerators", "mStorage", "mHubTerminal", "mWorkBench", "mLocker", "mPioneerPotty"]) {
        const field = hub.raw_record.properties?.[key];
        for (const ref of field?.values ?? [field?.value]) if (ref?.pathName) omitted.add(ref.pathName);
      }
    }
    do {
      changed = false;
      for (const row of scan.records) if (!omitted.has(row.instance_name) &&
          (omitted.has(row.parent_entity_name) || omitted.has(row.raw_record.parentObject?.pathName))) {
        omitted.add(row.instance_name); changed = true;
      }
    } while (changed);
    const audit = (value, owner) => {
      if (!value || typeof value !== "object") return;
      if (omitted.has(value.pathName)) throw new Error("Retained base references excluded HUB assembly: " + owner + " -> " + value.pathName);
      Object.values(value).forEach(child => audit(child, owner));
    };
    for (const row of scan.records) if (!omitted.has(row.instance_name) &&
        (selected.has(row.instance_name) || selected.has(row.parent_entity_name))) audit(row.raw_record, row.instance_name);
    active.forEach(row => audit(row.raw_instance, "lightweight:" + row.record_index));
  }
  return { actors: actors.filter(row => !omitted.has(row.instance_name)), lightweight: active,
    deleted_lightweight: deleted, scan,
    excluded_hub_actors: actors.filter(row => omitted.has(row.instance_name)).map(row => row.instance_name) };
}

/** SCIM's reader supplies its own object/property representation. Independently
 * match every included transform against the pinned native-file parser before
 * emitting its zlib-compressed clipboard format (Selection/Copy, Spawn/Megaprint).
 */
export function compilePlayerMegaprint(save, snapshot, scim) {
  if (save.header.saveVersion !== scim.header?.saveVersion ||
      save.header.buildVersion !== scim.header?.buildVersion) throw new Error("Parser headers disagree");
  const selection = selectPlayerBase(save, snapshot);
  const all = scim.objects;
  const parents = new Map();
  const coordinates = [];
  const retain = (source, object, category) => {
    if (!object || object.className !== source.class_path) throw new Error("SCIM is missing selected object: " + source.instance_name);
    const sourceKey = transformKey(source.class_path, source.transform);
    if (transformKey(object.className, scimTransform(object)) !== sourceKey) {
      throw new Error("Independent parsers disagree on transform: " + object.pathName);
    }
    if (parents.has(object.pathName)) throw new Error("Duplicate transfer object: " + object.pathName);
    parents.set(object.pathName, clone(object));
    coordinates.push({ category, source_identity: source.instance_name ?? {
      subsystem: source.subsystem_name, group: source.group_index, instance: source.instance_index },
      transfer_identity: object.pathName, class_path: source.class_path,
      ...transformEvidence(source.transform) });
  };
  for (const actor of selection.actors) retain(actor, all[actor.instance_name], "buildable_actor");
  const lightweightByTransform = new Map();
  for (const object of Object.values(all)) {
    if (!object.pathName.startsWith("LB_")) continue;
    const key = transformKey(object.className, scimTransform(object));
    const bucket = lightweightByTransform.get(key) ?? [];
    bucket.push(object); lightweightByTransform.set(key, bucket);
  }
  for (const instance of selection.lightweight) {
    const key = transformKey(instance.class_path, instance.transform);
    retain(instance, lightweightByTransform.get(key)?.shift(), "lightweight_buildable");
  }
  if ([...lightweightByTransform.values()].some((bucket) => bucket.length)) throw new Error("SCIM lightweight census differs");

  // Keep proxy grouping metadata, but never copy world/player subsystems.
  for (const object of [...parents.values()]) {
    const proxy = property(object, "mBlueprintProxy");
    if (proxy?.pathName && !parents.has(proxy.pathName)) {
      const source = all[proxy.pathName];
      if (source?.className !== PROXY) throw new Error("Missing Blueprint proxy: " + proxy.pathName);
      const saved = selection.scan.records.find((record) => record.instance_name === proxy.pathName);
      if (!saved || transformKey(PROXY, saved.transform) !== transformKey(PROXY, scimTransform(source))) {
        throw new Error("Blueprint proxy transform differs between parsers: " + proxy.pathName);
      }
      parents.set(source.pathName, clone(source));
    }
  }
  const clipboard = { saveVersion: save.header.saveVersion, buildVersion: save.header.buildVersion,
    data: [], pipes: {}, powerCircuits: {}, hiddenConnections: {},
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const included = new Set(parents.keys());
  for (const parent of parents.values()) {
    const children = [];
    for (const ref of parent.children ?? []) {
      const child = all[ref.pathName];
      if (!child || child.outerPathName !== parent.pathName) throw new Error("Missing or misowned component: " + ref.pathName);
      if (included.has(child.pathName)) throw new Error("Duplicate component: " + child.pathName);
      included.add(child.pathName); children.push(clone(child));
    }
    clipboard.data.push({ parent, children });
    if (parent.transform) {
      clipboard.minX = Math.min(clipboard.minX, parent.transform.translation[0]);
      clipboard.maxX = Math.max(clipboard.maxX, parent.transform.translation[0]);
      clipboard.minY = Math.min(clipboard.minY, parent.transform.translation[1]);
      clipboard.maxY = Math.max(clipboard.maxY, parent.transform.translation[1]);
    }
  }
  // Only circuits whose entire membership belongs to the selected build set.
  // Splitting a world circuit without explicit reconciliation would lose state.
  for (const object of Object.values(all).filter((o) => o.className === CIRCUIT)) {
    const members = property(object, "mComponents")?.values;
    if (!Array.isArray(members)) throw new Error("Unknown circuit membership: " + object.pathName);
    if (!members.some((ref) => included.has(ref.pathName))) continue;
    if (!members.every((ref) => included.has(ref.pathName))) throw new Error("Circuit extends outside selected base");
    clipboard.powerCircuits[object.pathName] = clone(object);
    included.add(object.pathName);
  }
  // Audit all unresolved object references; asset references are dependencies,
  // map resource nodes are retained external identities, never copied actors.
  const external = new Map();
  function references(value, owner, trail = []) {
    if (!value || typeof value !== "object") return;
    if (typeof value.pathName === "string" && value.pathName &&
        !value.pathName.startsWith("/") && !included.has(value.pathName)) {
      if (trail.at(-1) !== "parent" && trail.at(-1) !== "children") {
        const record = external.get(value.pathName) ?? { path_name: value.pathName,
          source_record_present: Boolean(all[value.pathName]),
          source_class: all[value.pathName]?.className ?? null, used_by: [] };
        if (!record.used_by.includes(owner)) record.used_by.push(owner);
        external.set(value.pathName, record);
      }
    }
    for (const [key, child] of Object.entries(value)) references(child, owner, [...trail, key]);
  }
  for (const entry of clipboard.data) {
    references(entry.parent, entry.parent.pathName);
    for (const child of entry.children) references(child, entry.parent.pathName);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(coordinates.map((r) =>
    [r.class_path, r.transform_float64_le_hex]))).digest("hex");
  const report = {
    schema: "aifactory.player-base-transfer/v1", format: "SCIM_Megaprint_cbp",
    source_session: save.header.sessionName, save_version: save.header.saveVersion,
    build_version: save.header.buildVersion, scim_revision: SCIM_REVISION,
    counts: { buildable_actors: selection.actors.length, active_lightweight: selection.lightweight.length,
      excluded_deleted_lightweight_slots: selection.deleted_lightweight.length,
      player_placed_pieces: coordinates.length, blueprint_proxies: parents.size - coordinates.length,
      components: clipboard.data.reduce((sum, entry) => sum + entry.children.length, 0),
      power_circuits: Object.keys(clipboard.powerCircuits).length },
    exact_transform_fingerprint: fingerprint,
    status: "exported_pending_destination_validation",
    source_mod_metadata: save.header.modMetadata,
    external_references: [...external.values()],
    unresolved_source_references: [...external.values()].filter((ref) => !ref.source_record_present),
    placement: "Paste megaprint in the original position; zero translation and zero rotation",
    verification: { all_selected_transforms_match_two_independent_parsers: true,
      source_save_modified: false, destination_save_modified: false, in_game_spawn_verified: false },
    limitations: ["Destination must provide matching mod classes and map resource identities.",
      "Destination overlaps and singleton HUB/Designer behavior need checking before import.",
      "This is an offline Megaprint, not a native Build Gun SBP or a proven in-game restore."],
  };
  return { clipboard, coordinates, report, selection };
}

export function encodeMegaprint(clipboard) {
  // JSON permits numeric -0; preserve it without changing numbers into strings.
  // A collision-free temporary token also works on the project's Node 20 floor.
  const ordinary = JSON.stringify(clipboard);
  let marker = "__aifactory_negative_zero__";
  while (ordinary.includes(JSON.stringify(marker))) marker += "_";
  const json = JSON.stringify(clipboard, (_key, value) => Object.is(value, -0) ? marker : value)
    .replaceAll(JSON.stringify(marker), "-0");
  const compressed = deflateSync(json);
  const reparsed = JSON.parse(inflateSync(compressed).toString("utf8"));
  if (reparsed.data.length !== clipboard.data.length) throw new Error("Megaprint readback count differs");
  for (let index = 0; index < clipboard.data.length; index++) {
    const before = clipboard.data[index].parent;
    const after = reparsed.data[index].parent;
    if (before.transform && transformKey(before.className, scimTransform(before)) !==
        transformKey(after.className, scimTransform(after))) throw new Error("Megaprint changed a transform");
  }
  return compressed;
}
