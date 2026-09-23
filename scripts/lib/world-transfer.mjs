import { createHash } from "node:crypto";
import { createRequire } from "node:module";



const require = createRequire(new URL("../../companion/package.json", import.meta.url));
const { Parser } = require("@etothepii/satisfactory-file-parser");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function transformEvidence(transform) {
  const bits = {};
  for (const [group, axes] of Object.entries({ translation: ["x", "y", "z"],
    rotation: ["x", "y", "z", "w"], scale3d: ["x", "y", "z"] })) {
    bits[group] = {};
    for (const axis of axes) {
      const value = transform?.[group]?.[axis];
      if (!Number.isFinite(value)) throw new Error(`Missing/non-finite transform ${group}.${axis}`);
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleLE(value);
      bits[group][axis] = bytes.toString("hex");
    }
  }
  return { transform, transform_float64_le_hex: bits };
}

/** Census all records, never filter by class-name guesses or scanner limits. */
export function inspectParsedWorld(save) {
  if (!save?.levels || typeof save.levels !== "object") throw new Error("Save has no levels");
  const records = [];
  const lightweight = [];
  const levels = [];
  const classes = new Map();
  let explicit = 0;
  let inherited = 0;
  let components = 0;
  let trailingBytes = 0;
  const addClass = (type, category) => {
    const row = classes.get(type) ?? { class_path: type, actors: 0, components: 0, lightweight_instances: 0 };
    row[category]++;
    classes.set(type, row);
  };
  for (const [levelKey, level] of Object.entries(save.levels)) {
    if (!Array.isArray(level.objects)) throw new Error(`Level has no object array: ${levelKey}`);
    levels.push({ key: levelKey, name: level.name, object_count: level.objects.length,
      collectible_record_count: level.collectables?.length ?? null,
      destroyed_actor_data_present: level.destroyedActorsMap !== undefined });
    for (const [objectIndex, object] of level.objects.entries()) {
      const isEntity = object.type === "SaveEntity";
      const isComponent = object.type === "SaveComponent";
      if (!isEntity && !isComponent) throw new Error(`Unknown record type: ${object.type}`);
      if (!object.instanceName || !object.typePath) throw new Error("Object identity is missing");
      const ownsTransform = isEntity;
      if (isEntity && typeof object.needTransform !== "boolean") throw new Error("Unknown transform serialization flag");
      if (isEntity && object.needTransform) explicit++; else if (isEntity) inherited++;
      else components++;
      trailingBytes += object.trailingData?.length ?? 0;
      addClass(object.typePath, isEntity ? "actors" : "components");
      records.push({
        record_index: records.length, level_key: levelKey, object_index: objectIndex,
        instance_name: object.instanceName, class_path: object.typePath, record_type: object.type,
        transform_source: ownsTransform ? "serialized_save_transform" : "component_owned_by_parent",
        apply_saved_transform: isEntity ? object.needTransform : null,
        ...(ownsTransform ? transformEvidence(object.transform) : { transform: null }),
        parent_entity_name: object.parentEntityName ?? null,
        raw_record: object,
      });
      const special = object.specialProperties;
      if (object.typePath === "/Script/FactoryGame.FGLightweightBuildableSubsystem" &&
          special?.type !== "BuildableSubsystemSpecialProperties") {
        throw new Error("Lightweight subsystem was not decoded");
      }
      if (special?.type !== "BuildableSubsystemSpecialProperties") continue;
      if (!Array.isArray(special.buildables)) throw new Error("Lightweight groups are missing");
      for (const [groupIndex, group] of special.buildables.entries()) {
        const classPath = group.typeReference?.pathName;
        if (!classPath || !Array.isArray(group.instances)) throw new Error("Invalid lightweight group");
        for (const [instanceIndex, instance] of group.instances.entries()) {
          addClass(classPath, "lightweight_instances");
          lightweight.push({
            record_index: lightweight.length, level_key: levelKey,
            subsystem_name: object.instanceName, group_index: groupIndex, instance_index: instanceIndex,
            class_path: classPath, lightweight_version: special.currentLightweightVersion ?? null,
            transform_source: "serialized_lightweight_transform",
            ...transformEvidence(instance.transform), raw_instance: instance,
          });
        }
      }
    }
  }
  const transformFingerprint = sha256(JSON.stringify({
    actors: records.filter((record) => record.transform !== null).map((record) =>
      [record.level_key, record.instance_name, record.transform_float64_le_hex]),
    lightweight: lightweight.map((record) => [record.level_key, record.subsystem_name,
      record.group_index, record.instance_index, record.class_path, record.transform_float64_le_hex]),
  }));
  return {
    summary: {
      schema: "aifactory.world-transfer-scan/v1", scope: "all_serialized_world_records",
      session_name: save.header?.sessionName ?? null, map_name: save.header?.mapName ?? null,
      save_version: save.header?.saveVersion ?? null, build_version: save.header?.buildVersion ?? null,
      declared_mods: save.header?.modMetadata?.Mods ?? null,
      counts: { levels: levels.length, object_records: records.length,
        actor_records: explicit + inherited, component_records: components,
        actors_applying_saved_transforms: explicit, actors_not_applying_saved_transforms: inherited,
        lightweight_instances: lightweight.length, exact_transform_records: explicit + inherited + lightweight.length,
        retained_trailing_bytes: trailingBytes },
      coordinate_policy: "absolute_world_centimetres_no_translation_rotation_snapping_or_rounding",
      transform_fingerprint: transformFingerprint,
    },
    records, lightweight, levels,
    class_census: [...classes.values()].sort((a, b) => a.class_path.localeCompare(b.class_path)),
  };
}

export function parseWorld(bytes, name = "world-transfer") {
  return Parser.ParseSave(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    { throwErrors: true });
}
