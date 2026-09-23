import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateBaseTransfer, readExactBaseTransform } from "../../companion/lib/base-transfer.mjs";
const require = createRequire(new URL("../../companion/package.json", import.meta.url));
const { Parser } = require("@etothepii/satisfactory-file-parser");
const digest = bytes => createHash("md5").update(bytes).digest("hex");
const clone = structuredClone;
// Preparation persists decoded state as JSON, which omits undefined object
// fields. The parser recreates optional metadata such as ByteProperty's
// value.type as undefined. Compare their persisted meaning without changing
// any defined value (including -0), array entry, or binary payload.
const persistedShape = value => {
  if (Array.isArray(value)) return value.map(persistedShape);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, persistedShape(child)]));
  }
  return value;
};

/** An engine-loadable actor stream, never a recipe reconstruction. Lightweight
 * data stays in its native instance format and is restored by the subsystem.
 * Unique archive names prevent collision with source-like names in a new save.
 */
export function compileNativeBaseArchive(manifest, state, save) {
  validateBaseTransfer(manifest);
  if (save.header.saveVersion !== 60 || save.header.buildVersion !== manifest.source.build_version) {
    throw new Error("Unsupported native save version");
  }
  if (state.actors.length !== manifest.pieces.filter(piece => piece.kind === "actor").length) throw new Error("Actor state count mismatch");
  const levels = [...new Set([...state.actors, ...state.components].map(row => row.level_key))].map(key => save.levels[key]);
  const versionData = levels.map(level => level?.objectVersionData ?? save.objectVersionData);
  const versions = versionData.map(data => JSON.stringify(data));
  if (!versions.length || new Set(versions).size !== 1 || !versionData[0]) {
    throw new Error("Mixed/missing object versions cannot be loaded as one native archive");
  }
  const actors = manifest.pieces.filter(piece => piece.kind === "actor");
  const expected = new Map(actors.map(piece => [piece.id, piece]));
  if (state.actors.length !== actors.length) throw new Error("Actor state count mismatch");
  const prefix = `Persistent_Level:PersistentLevel.AIFactoryBase_${manifest.source.save_sha256.slice(0, 16)}_`;
  const renames = new Map(state.actors.map((row, index) => [row.instance_name, prefix + index]));
  for (const row of state.components) {
    const parent = renames.get(row.parent_entity_name);
    if (!parent || !row.instance_name.startsWith(row.parent_entity_name + ".")) throw new Error("Unowned component");
    renames.set(row.instance_name, parent + row.instance_name.slice(row.parent_entity_name.length));
  }
  const adaptations = [];
  const objects = [...state.actors, ...state.components].map(row => {
    const object = clone(row.raw_record);
    if (object.type === "SaveEntity") {
      const piece = expected.get(row.instance_name);
      if (!piece || piece.class_path !== object.typePath || !object.needTransform) throw new Error("Actor identity/transform flag mismatch");
      object.transform = readExactBaseTransform(piece);
      // This is a new Blueprint transaction, with a new destination grouping.
      delete object.properties.mBlueprintProxy;
      if (object.properties.mLocker?.value?.pathName &&
          manifest.external_references?.some(ref => ref.path_name === object.properties.mLocker.value.pathName && !ref.source_record_present)) {
        adaptations.push({ source_id: row.instance_name, field: "mLocker", reason: "absent_source_object_use_native_initialization" });
        delete object.properties.mLocker;
      }
    }
    if (["/Script/FactoryGame.FGPowerConnectionComponent", "/Script/FactoryGame.FGCircuitConnectionComponent"].includes(object.typePath)) {
      // Numeric circuit IDs are allocated per destination world, unlike wire
      // references. The loader rebuilds circuits from the saved wire graph.
      delete object.properties.mCircuitID;
    }
    const redirect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && ["pathName", "instanceName", "parentEntityName"].includes(key) && renames.has(child)) value[key] = renames.get(child);
        else redirect(child);
      }
    };
    redirect(object);
    return object;
  });
  const recipeReferences = [...new Map(objects.map(o => o.properties?.mBuiltWithRecipe?.value).filter(r => r?.pathName).map(r => [r.pathName, r])).values()];
  const blueprint = { name: "AIFactoryBase", compressionInfo: save.compressionInfo,
    header: { headerVersion: 2, saveVersion: 60, buildVersion: save.header.buildVersion,
      designerDimension: { x: 4, y: 4, z: 4 }, itemCosts: [], recipeReferences,
      objectVersionData: clone(versionData[0]) },
    config: { configVersion: 0, description: "Copilot absolute base transfer: use /ai base restore, not Build Gun placement.",
      color: { r: 0, g: 0, b: 0, a: 1 }, iconID: 0 }, objects };
  const chunks = [];
  const result = Parser.WriteBlueprintFiles(blueprint, bytes => chunks.push(Buffer.from(bytes)), bytes => chunks.push(Buffer.from(bytes)));
  const sbp = Buffer.concat(chunks), config = Buffer.from(result.configFileBinary);
  const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = Parser.ParseBlueprintFiles("AIFactoryBase", arrayBuffer(sbp), arrayBuffer(config), { throwErrors: true });
  if (parsed.objects.length !== objects.length) throw new Error("Native archive lost objects");
  for (let i = 0; i < objects.length; i++) {
    const before = objects[i], after = parsed.objects[i];
    if (before.instanceName !== after.instanceName || before.typePath !== after.typePath ||
        !isDeepStrictEqual(persistedShape(before.properties), persistedShape(after.properties)) ||
        !isDeepStrictEqual(persistedShape(before.specialProperties), persistedShape(after.specialProperties)) ||
        !isDeepStrictEqual(before.trailingData, after.trailingData)) {
      throw new Error("Native saved-state readback differs: " + before.instanceName, { cause: { before, after } });
    }
  }
  const keys = new Set();
  const nativeActors = actors.map(piece => {
    const object = parsed.objects.find(object => object.instanceName === renames.get(piece.id));
    if (!object || object.typePath !== piece.class_path) throw new Error("Native archive lost an actor");
    const t = readExactBaseTransform(piece);
    for (const group of ["translation", "rotation", "scale3d"]) for (const axis of Object.keys(t[group])) {
      if (object.transform[group][axis] !== Math.fround(t[group][axis])) throw new Error("Unexpected native transform encoding");
    }
    const loadPosition = object.transform.translation;
    const key = JSON.stringify([piece.class_path, object.transform]);
    // Callback identity must be unique before any BeginPlay-side effects.
    if (keys.has(key)) throw new Error("Ambiguous native actor load identity: " + piece.id);
    keys.add(key);
    const original = state.actors.find(row => row.instance_name === piece.id).raw_record;
    const endpoint = ref => {
      const component = state.components.find(row => row.instance_name === ref?.pathName);
      if (!component) throw new Error("Wire endpoint lies outside base: " + ref?.pathName);
      return { actor_id: component.parent_entity_name, component_name: component.instance_name.slice(component.parent_entity_name.length + 1) };
    };
    return { ...piece, archive_name: object.instanceName, archive_location: loadPosition, archive_transform: object.transform,
      resource_node: original.properties?.mExtractableResource?.value?.pathName ?? "",
      resource_node_level: original.properties?.mExtractableResource?.value?.levelName ?? "",
      ...(original.specialProperties?.type === "PowerLineSpecialProperties" ? {
        wire: { from: endpoint(original.specialProperties.source), to: endpoint(original.specialProperties.target) },
      } : {}) };
  });
  const lightweight = state.lightweight.map(row => {
    const piece = manifest.pieces.find(p => p.id === `lightweight:${row.group_index}:${row.instance_index}`);
    if (!piece || piece.class_path !== row.class_path) throw new Error("Lightweight identity mismatch");
    return { ...piece, instance: clone(row.raw_instance) };
  });
  const requiredAssets = new Set(objects.map(object => object.typePath));
  const assets = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.pathName === "string" && value.pathName.startsWith("/")) requiredAssets.add(value.pathName);
    Object.values(value).forEach(assets);
  };
  objects.forEach(assets); state.lightweight.forEach(row => assets(row.raw_instance));
  return { sbp, config, runtime: { schema: "aifactory.native-base/v1", source: manifest.source,
    archive_md5: digest(sbp), config_md5: digest(config), actor_count: actors.length,
    piece_count: manifest.piece_count, actors: nativeActors, lightweight, adaptations,
    external_references: manifest.external_references, required_assets: [...requiredAssets].sort(),
    selection: manifest.selection ?? { exclude_hub: false, excluded_hub_actors: [] },
    geometry_verified: false, state_connections_verified: false,
    placement_policy: "absolute_saved_transforms_no_snapping" } };
}
