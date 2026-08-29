/**
 * Satisfactory blueprint files.
 *
 * A native blueprint is a pair: `<name>.sbp` is its binary header and compressed
 * object stream, while `<name>.sbpcfg` is its menu configuration. The quick
 * library reader below consumes the official `FBlueprintHeader` layout exactly;
 * the on-demand structure reader uses the pinned, read-only
 * `satisfactory-file-parser` implementation for the compressed object stream.
 *
 * This split matters. A previous length-prefixed string scan accidentally read
 * recipe references left in the header and then described the compressed body as
 * an object graph. It could not prove positions or building counts. Do not turn a
 * byte pattern into an in-game fact: use `inspectBlueprintStructure` when actual
 * layout evidence is needed.
 */

import { Parser } from "@etothepii/satisfactory-file-parser";

const SUPPORTED_BLUEPRINT_HEADER_VERSION = 2;
const SAVE_VERSION_WITH_OBJECT_VERSION_DATA = 53;
const INITIAL_HEADER_BYTES = 28;
const MAXIMUM_COST_ENTRIES = 512;
const MAXIMUM_RECIPE_REFERENCES = 4096;
const MAXIMUM_STRING_CODE_UNITS = 8192;
const MAXIMUM_BUILDABLE_CLASSES = 200;
const DEFAULT_MAXIMUM_BUILDABLES = 80;
const MAXIMUM_BUILDABLES = 200;
const DEFAULT_MAXIMUM_CONNECTIONS = 80;
const MAXIMUM_CONNECTIONS = 200;
const PARSER_VERSION = "4.1.2";
const NATIVE_POWER_CONNECTION_COMPONENT = "/Script/FactoryGame.FGPowerConnectionComponent";
// Hypertubes use the generic pipe-connection base with a distinct native
// component class. Keep this exact path separate from ordinary fluid pipes:
// the saved links prove a hypertube connection, not a fluid network.
const NATIVE_HYPERTUBE_CONNECTION_COMPONENT =
  "/Script/FactoryGame.FGPipeConnectionComponentHyper";
const NATIVE_HYPERTUBE_PIPE_CLASS =
  "/Game/FactoryGame/Buildable/Factory/PipeHyper/Build_PipeHyper.Build_PipeHyper_C";
const NATIVE_HYPERTUBE_START_CLASS =
  "/Game/FactoryGame/Buildable/Factory/PipeHyperStart/Build_PipeHyperStart.Build_PipeHyperStart_C";
const NATIVE_HYPERTUBE_PASSTHROUGH_CLASS =
  "/Game/FactoryGame/Buildable/Factory/FoundationPassthrough/Build_FoundationPassthrough_Hypertube.Build_FoundationPassthrough_Hypertube_C";
const NATIVE_HYPERTUBE_WALL_HOLE_CLASS =
  "/Game/FactoryGame/Buildable/Factory/HyperTubeWallSupport/Build_HyperTubeWallHole.Build_HyperTubeWallHole_C";
const NATIVE_HYPERTUBE_SUPPORT_CLASS =
  "/Game/FactoryGame/Buildable/Factory/PipeHyperSupport/Build_PipeHyperSupport.Build_PipeHyperSupport_C";
const NATIVE_HYPERTUBE_BUILDABLE_CLASSES = new Map([
  [NATIVE_HYPERTUBE_PIPE_CLASS, "pipe"],
  [NATIVE_HYPERTUBE_START_CLASS, "entrance"],
  [NATIVE_HYPERTUBE_PASSTHROUGH_CLASS, "passthrough"],
  [NATIVE_HYPERTUBE_WALL_HOLE_CLASS, "wall_hole"],
  [NATIVE_HYPERTUBE_SUPPORT_CLASS, "support"],
]);
// Railroad tracks are spline buildables, but their saved `mSplineData` is not
// a factory connection component. Keep this class path exact: a property named
// mSplineData on an arbitrary modded Build_* object is not enough to call it a
// rail. The native header exposes AFGBuildableRailroadTrack::GetSplinePointData
// and its persisted mSplineData in the installed CL 502094 Starter Project.
const NATIVE_RAIL_TRACK_CLASS =
  "/Game/FactoryGame/Buildable/Factory/Train/Track/Build_RailroadTrack.Build_RailroadTrack_C";
const DEFAULT_MAXIMUM_RAIL_TRACKS = 40;
const MAXIMUM_RAIL_TRACKS = 80;
const DEFAULT_MAXIMUM_RAIL_SPLINE_POINTS = 200;
const MAXIMUM_RAIL_SPLINE_POINTS = 1000;
const DEFAULT_MAXIMUM_HYPERTUBE_PIPES = 40;
const MAXIMUM_HYPERTUBE_PIPES = 80;
const DEFAULT_MAXIMUM_HYPERTUBE_SPLINE_POINTS = 200;
const MAXIMUM_HYPERTUBE_SPLINE_POINTS = 1000;
const NATIVE_POWER_LINE_CLASSES = new Set([
  "/Game/FactoryGame/Buildable/Factory/PowerLine/Build_PowerLine.Build_PowerLine_C",
  "/Game/FactoryGame/Events/Christmas/Buildings/PowerLineLights/Build_XmassLightsLine.Build_XmassLightsLine_C",
]);

function shortName(itemClassPath) {
  const tail = String(itemClassPath).split(".").pop() ?? "";
  return tail.replace(/_C$/, "").replace(/^(Desc|Recipe|Build)_/, "");
}

function requireBytes(buffer, offset, count, field) {
  if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0 || offset + count > buffer.length) {
    throw new Error(`Blueprint is truncated while reading ${field}.`);
  }
}

function readInt32(buffer, offset, field) {
  requireBytes(buffer, offset, 4, field);
  return buffer.readInt32LE(offset);
}

function readUint16(buffer, offset, field) {
  requireBytes(buffer, offset, 2, field);
  return buffer.readUInt16LE(offset);
}

function readUint32(buffer, offset, field) {
  requireBytes(buffer, offset, 4, field);
  return buffer.readUInt32LE(offset);
}

/** Reads Satisfactory's signed-length FString and returns its next byte offset. */
function readFString(buffer, offset, field) {
  const length = readInt32(buffer, offset, `${field} length`);
  offset += 4;
  if (length === 0) return { value: "", offset };

  const codeUnits = Math.abs(length);
  if (codeUnits > MAXIMUM_STRING_CODE_UNITS) {
    throw new Error(`Blueprint ${field} length ${codeUnits} is not plausible.`);
  }
  const bytes = length > 0 ? codeUnits : codeUnits * 2;
  requireBytes(buffer, offset, bytes, field);
  const end = offset + bytes;

  if (length > 0) {
    if (buffer[end - 1] !== 0) throw new Error(`Blueprint ${field} is missing its UTF-8 terminator.`);
    return { value: buffer.toString("utf8", offset, end - 1), offset: end };
  }
  if (buffer[end - 2] !== 0 || buffer[end - 1] !== 0) {
    throw new Error(`Blueprint ${field} is missing its UTF-16 terminator.`);
  }
  return { value: buffer.toString("utf16le", offset, end - 2), offset: end };
}

function readObjectReference(buffer, offset, field) {
  const level = readFString(buffer, offset, `${field} level name`);
  const path = readFString(buffer, level.offset, `${field} path name`);
  return {
    value: { level_name: level.value, path_name: path.value },
    offset: path.offset,
  };
}

function readObjectVersionData(buffer, offset) {
  const layoutVersion = readUint32(buffer, offset, "object version data layout version");
  offset += 4;
  const ue4Version = readInt32(buffer, offset, "object version data UE4 package version");
  offset += 4;
  const ue5Version = readInt32(buffer, offset, "object version data UE5 package version");
  offset += 4;
  const licenseeVersion = readInt32(buffer, offset, "object version data licensee version");
  offset += 4;
  const major = readUint16(buffer, offset, "object version data engine major");
  offset += 2;
  const minor = readUint16(buffer, offset, "object version data engine minor");
  offset += 2;
  const patch = readUint16(buffer, offset, "object version data engine patch");
  offset += 2;
  const changelist = readUint32(buffer, offset, "object version data engine changelist");
  offset += 4;
  const branch = readFString(buffer, offset, "object version data engine branch");
  offset = branch.offset;
  const customVersionCount = readInt32(buffer, offset, "object version data custom version count");
  offset += 4;
  if (customVersionCount < 0 || customVersionCount > MAXIMUM_COST_ENTRIES) {
    throw new Error(`Blueprint custom version count ${customVersionCount} is not plausible.`);
  }

  const customVersions = [];
  for (let index = 0; index < customVersionCount; index += 1) {
    const guid = [0, 1, 2, 3].map((part) => {
      const value = readUint32(buffer, offset, `custom version ${index} GUID ${part}`);
      offset += 4;
      return value.toString(16).padStart(8, "0");
    });
    const version = readInt32(buffer, offset, `custom version ${index} version`);
    offset += 4;
    customVersions.push({ guid: guid.join("-"), version });
  }

  return {
    value: {
      layout_version: layoutVersion,
      package_file_version: { ue4: ue4Version, ue5: ue5Version },
      licensee_version: licenseeVersion,
      engine_version: { major, minor, patch, changelist, branch: branch.value },
      custom_version_count: customVersions.length,
      custom_versions: customVersions,
    },
    offset,
  };
}

function compressedBodyInfo(buffer, offset) {
  const byteCount = Math.max(0, buffer.length - offset);
  if (byteCount < 8) {
    return {
      present: false,
      bytes: byteCount,
      chunk_header_sane: false,
      note: "No complete compressed-blueprint chunk header remains after the decoded header.",
    };
  }
  const packageFileTag = readUint32(buffer, offset, "compressed body package tag");
  const chunkHeaderVersion = readUint32(buffer, offset + 4, "compressed body chunk header version");
  return {
    present: true,
    bytes: byteCount,
    package_file_tag: packageFileTag,
    chunk_header_version: chunkHeaderVersion,
    chunk_header_sane: chunkHeaderVersion === 0 || chunkHeaderVersion === 0x22222222,
    note: "The remaining bytes are compressed blueprint data; they are not scanned as raw object records.",
  };
}

/** Decodes the exact `FBlueprintHeader`. Throws on unsupported or malformed data. */
export function parseBlueprintHeader(buffer) {
  if (!buffer || buffer.length < INITIAL_HEADER_BYTES) {
    throw new Error("Blueprint file is too short to contain a header.");
  }

  const blueprintHeaderVersion = readInt32(buffer, 0, "blueprint header version");
  if (blueprintHeaderVersion !== SUPPORTED_BLUEPRINT_HEADER_VERSION) {
    throw new Error(
      `Unsupported blueprint header version ${blueprintHeaderVersion}; only ${SUPPORTED_BLUEPRINT_HEADER_VERSION} is decoded safely.`,
    );
  }
  const factorySaveCustomVersion = readInt32(buffer, 4, "factory save custom version");
  const gameChangelist = readInt32(buffer, 8, "game changelist");
  const dimensions = {
    x: readInt32(buffer, 12, "designer dimension x"),
    y: readInt32(buffer, 16, "designer dimension y"),
    z: readInt32(buffer, 20, "designer dimension z"),
  };
  const entryCount = readInt32(buffer, 24, "cost entry count");
  if (entryCount < 0 || entryCount > MAXIMUM_COST_ENTRIES) {
    throw new Error(`Blueprint declares ${entryCount} cost entries, which is not plausible.`);
  }

  const cost = [];
  let offset = INITIAL_HEADER_BYTES;

  for (let index = 0; index < entryCount; index += 1) {
    const reference = readObjectReference(buffer, offset, `cost entry ${index}`);
    offset = reference.offset;
    const amount = readInt32(buffer, offset, `cost entry ${index} amount`);
    offset += 4;
    cost.push({
      item_class: reference.value.path_name,
      item_level_name: reference.value.level_name,
      item_name: shortName(reference.value.path_name),
      amount,
    });
  }

  const recipeCount = readInt32(buffer, offset, "recipe reference count");
  offset += 4;
  if (recipeCount < 0 || recipeCount > MAXIMUM_RECIPE_REFERENCES) {
    throw new Error(`Blueprint declares ${recipeCount} recipe references, which is not plausible.`);
  }
  const recipeReferences = [];
  for (let index = 0; index < recipeCount; index += 1) {
    const reference = readObjectReference(buffer, offset, `recipe reference ${index}`);
    offset = reference.offset;
    recipeReferences.push({
      recipe_class: reference.value.path_name,
      recipe_level_name: reference.value.level_name,
      recipe_name: shortName(reference.value.path_name),
    });
  }

  let objectVersionData = null;
  if (factorySaveCustomVersion >= SAVE_VERSION_WITH_OBJECT_VERSION_DATA) {
    const result = readObjectVersionData(buffer, offset);
    objectVersionData = result.value;
    offset = result.offset;
  }

  const compressedBody = compressedBodyInfo(buffer, offset);

  return {
    blueprint_header_version: blueprintHeaderVersion,
    factory_save_custom_version: factorySaveCustomVersion,
    game_changelist: gameChangelist,
    designer_dimensions: dimensions,
    build_cost: cost,
    cost_entry_count_declared: entryCount,
    cost_entries_read: cost.length,
    recipe_reference_count_declared: recipeCount,
    recipe_references: recipeReferences,
    object_version_data: objectVersionData,
    header_bytes: offset,
    compressed_body_offset: offset,
    compressed_body: compressedBody,
    object_graph_decoded: false,
    object_graph_note:
      "The blueprint object stream is compressed. Per-building layout is available only through the read-only structural parser.",
    supported: true,
    source: "parsed_from_exact_fblueprintheader",
    certainty: "authoritative",
  };
}

/** Decodes the `.sbpcfg` description. */
export function parseBlueprintConfig(buffer) {
  if (!buffer || buffer.length < 8) {
    return { description: null, certainty: "unknown" };
  }
  try {
    const configVersion = readInt32(buffer, 0, "blueprint config version");
    const description = readFString(buffer, 4, "blueprint config description");
    return {
      config_version: configVersion,
      description: description.value || null,
      trailing_bytes: Math.max(0, buffer.length - description.offset),
      source: "parsed_from_sbpcfg_header",
      certainty: "authoritative_for_description",
    };
  } catch {
    return { description: null, certainty: "unknown" };
  }
}

function headerContents(header) {
  const recipes = (header.recipe_references ?? [])
    .filter((reference) => reference.recipe_class)
    .map((reference) => ({
    class_path: reference.recipe_class,
    level_name: reference.recipe_level_name,
    name: reference.recipe_name,
    occurrences: null,
    }));
  return {
    recipes,
    buildings: [],
    distinct_recipes: recipes.length,
    method: "exact_recipe_references_from_fblueprintheader",
    certainty: "recipe_references_are_exact_presence_not_per_building_counts",
    counts_caveat:
      "Header recipe references prove the recipe classes used by the blueprint, but do not encode how many buildings use each recipe.",
    transforms: "not_decoded",
    transforms_note:
      "Use the read-only structural parser for saved entity transforms and exact buildable counts.",
  };
}

/**
 * Reads one blueprint from its `.sbp`, pulling in the matching `.sbpcfg` when it
 * sits alongside. `readFile` is injected so this stays testable and so the caller
 * controls which directories are ever touched.
 */
export function readBlueprint(name, sbpBuffer, sbpcfgBuffer = null, { scanContents = true } = {}) {
  const header = parseBlueprintHeader(sbpBuffer);
  const config = sbpcfgBuffer ? parseBlueprintConfig(sbpcfgBuffer) : null;
  const contents = scanContents ? headerContents(header) : null;
  return {
    name,
    ...header,
    description: config?.description ?? null,
    has_config: Boolean(sbpcfgBuffer),
    contents,
  };
}

function exactArrayBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function finiteVector(vector, keys) {
  if (!vector || typeof vector !== "object") return null;
  const result = {};
  for (const key of keys) {
    const value = Number(vector[key]);
    if (!Number.isFinite(value)) return null;
    result[key] = value;
  }
  return result;
}

/**
 * The serializer exposes concrete entity class paths, not the runtime UClass
 * hierarchy. Native buildables conventionally end in `Build_*_C`; preserve the
 * classification caveat in the output rather than silently treating a naming
 * convention as a proof for every future mod.
 */
function blueprintBuildableCandidate(object) {
  if (object?.type !== "SaveEntity" || typeof object.typePath !== "string") return false;
  const tail = object.typePath.split(".").pop() ?? "";
  return tail.startsWith("Build_") && tail.endsWith("_C");
}

function builtWithRecipe(object) {
  const reference = object?.properties?.mBuiltWithRecipe?.value;
  if (!reference || typeof reference.pathName !== "string" || !reference.pathName) return null;
  return {
    recipe_class: reference.pathName,
    recipe_level_name: typeof reference.levelName === "string" ? reference.levelName : "",
    recipe_name: shortName(reference.pathName),
  };
}

function readBuildableTransform(object) {
  const translation = finiteVector(object?.transform?.translation, ["x", "y", "z"]);
  const rotation = finiteVector(object?.transform?.rotation, ["x", "y", "z", "w"]);
  const scale = finiteVector(object?.transform?.scale3d, ["x", "y", "z"]);
  if (!translation || !rotation || !scale) return null;
  return { translation_cm: translation, rotation_quat: rotation, scale3d: scale };
}

function pivotBounds(transforms) {
  if (transforms.length === 0) return null;
  const minimum = { ...transforms[0].translation_cm };
  const maximum = { ...transforms[0].translation_cm };
  for (const transform of transforms.slice(1)) {
    for (const axis of ["x", "y", "z"]) {
      minimum[axis] = Math.min(minimum[axis], transform.translation_cm[axis]);
      maximum[axis] = Math.max(maximum[axis], transform.translation_cm[axis]);
    }
  }
  return {
    minimum_cm: minimum,
    maximum_cm: maximum,
    span_cm: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
    caveat: "These are saved buildable pivot locations, not collision or visual extents.",
  };
}

function boundedMaximum(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAXIMUM_BUILDABLES, Math.max(1, Math.trunc(numeric)));
}

function boundedMaximumConnections(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAXIMUM_CONNECTIONS, Math.max(1, Math.trunc(numeric)));
}

/*
 * Blueprint files do retain an exact mConnectedComponent reference for the
 * conveyor and pipe connection components that were saved together. That is
 * useful evidence, but it is deliberately narrower than an in-game routing
 * graph: a bare component class does not prove its direction, speed, fluid,
 * or that it will still connect to anything outside the Blueprint after it is
 * placed. Keep the supported class paths exact rather than treating every
 * object property named mConnectedComponent as a factory link.
 */
function blueprintConnectionKind(component) {
  switch (component?.typePath) {
    case "/Script/FactoryGame.FGFactoryConnectionComponent":
      return "conveyor";
    case "/Script/FactoryGame.FGPipeConnectionFactory":
    case "/Script/FactoryGame.FGPipeConnectionComponent":
      return "pipe";
    default:
      return null;
  }
}

function objectPropertyPathName(property) {
  const pathName = property?.value?.pathName;
  return typeof pathName === "string" && pathName.trim() ? pathName : null;
}

function objectReferencePathName(reference) {
  const pathName = reference?.pathName;
  return validSavedInstanceName(pathName) ? pathName : null;
}

function validSavedInstanceName(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function componentEndpoint(component, entitiesByName) {
  const ownerName =
    validSavedInstanceName(component?.parentEntityName)
      ? component.parentEntityName
      : null;
  const owner = ownerName ? entitiesByName.get(ownerName) ?? null : null;
  const classPath = typeof component?.typePath === "string" ? component.typePath : null;
  const ownerClassPath = typeof owner?.typePath === "string" ? owner.typePath : null;
  return {
    component_instance_name:
      typeof component?.instanceName === "string" && component.instanceName ? component.instanceName : null,
    component_class_path: classPath,
    component_class_name: classPath ? shortName(classPath) : null,
    owner_entity_instance_name: ownerName,
    owner_entity_class_path: ownerClassPath,
    owner_entity_class_name: ownerClassPath ? shortName(ownerClassPath) : null,
    owner_entity_resolved: owner !== null,
  };
}

function canonicalComponentPair(left, right) {
  const leftName = left?.instanceName ?? "";
  const rightName = right?.instanceName ?? "";
  return leftName.localeCompare(rightName) <= 0 ? [left, right] : [right, left];
}

function isNativePowerConnectionComponent(component) {
  return component?.type === "SaveComponent" && component.typePath === NATIVE_POWER_CONNECTION_COMPONENT;
}

function isNativeHypertubeConnectionComponent(component) {
  return component?.type === "SaveComponent" && component.typePath === NATIVE_HYPERTUBE_CONNECTION_COMPONENT;
}

function isNativePowerLine(entity) {
  return entity?.type === "SaveEntity" && NATIVE_POWER_LINE_CLASSES.has(entity.typePath);
}

function isNativeRailTrack(entity) {
  return entity?.type === "SaveEntity" && entity.typePath === NATIVE_RAIL_TRACK_CLASS;
}

function railTrackGraphId(entity) {
  const property = entity?.properties?.mTrackGraphID;
  if (!property) return { state: "missing", value: null };
  if (
    property.type !== "IntProperty" ||
    property.name !== "mTrackGraphID" ||
    property.propertyTagType?.name !== "IntProperty" ||
    !Number.isInteger(property.value)
  ) {
    return { state: "malformed", value: null };
  }
  return { state: "valid", value: property.value };
}

function railSplinePoint(point) {
  if (point?.type !== "SplinePointData" || !point.properties) return null;
  const vectorProperty = (property, name) =>
    property?.type === "StructProperty" && property.name === name
      ? finiteVector(property.value, ["x", "y", "z"])
      : null;
  const location = vectorProperty(point.properties.Location, "Location");
  const arriveTangent = vectorProperty(point.properties.ArriveTangent, "ArriveTangent");
  const leaveTangent = vectorProperty(point.properties.LeaveTangent, "LeaveTangent");
  if (!location || !arriveTangent || !leaveTangent) return null;
  return {
    location_cm: location,
    arrive_tangent_cm: arriveTangent,
    leave_tangent_cm: leaveTangent,
  };
}

function railSplineData(entity) {
  const property = entity?.properties?.mSplineData;
  if (!property) return { state: "missing", points: [], malformed_point_count: 0 };
  const exactArray =
    property.type === "ArrayProperty" &&
    property.name === "mSplineData" &&
    property.propertyTagType?.name === "ArrayProperty" &&
    Array.isArray(property.propertyTagType.children) &&
    property.propertyTagType.children.length === 1 &&
    property.propertyTagType.children[0]?.name === "StructProperty" &&
    property.propertyTagType.children[0]?.children?.[0]?.name === "SplinePointData" &&
    Array.isArray(property.values);
  if (!exactArray) return { state: "malformed", points: [], malformed_point_count: 0 };

  const points = [];
  let malformedPointCount = 0;
  for (const value of property.values) {
    const point = railSplinePoint(value);
    if (!point) malformedPointCount += 1;
    else points.push(point);
  }
  return {
    state: malformedPointCount > 0 ? "malformed_points" : "valid",
    points,
    declared_point_count: property.values.length,
    malformed_point_count: malformedPointCount,
  };
}

function railLocalBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const minimum = { ...points[0].location_cm };
  const maximum = { ...points[0].location_cm };
  for (const point of points.slice(1)) {
    for (const axis of ["x", "y", "z"]) {
      minimum[axis] = Math.min(minimum[axis], point.location_cm[axis]);
      maximum[axis] = Math.max(maximum[axis], point.location_cm[axis]);
    }
  }
  return {
    minimum_cm: minimum,
    maximum_cm: maximum,
    span_cm: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
    caveat: "Bounds are saved local spline-point positions, not rail collision or visual extents.",
  };
}

function railChordLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].location_cm;
    const current = points[index].location_cm;
    length += Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
      current.z - previous.z,
    );
  }
  return length;
}

function transformRailPoint(transform, point) {
  const translation = transform?.translation_cm;
  const rotation = transform?.rotation_quat;
  const scale = transform?.scale3d;
  const local = point?.location_cm;
  if (!translation || !rotation || !scale || !local) return null;
  const scaled = {
    x: local.x * scale.x,
    y: local.y * scale.y,
    z: local.z * scale.z,
  };
  // Unreal's FTransform applies scale, then quaternion rotation, then
  // translation. Keep this derived value explicitly Blueprint-relative: it is
  // not a destination world coordinate until the Build Gun chooses an origin.
  const q = rotation;
  const qCross = {
    x: q.y * scaled.z - q.z * scaled.y,
    y: q.z * scaled.x - q.x * scaled.z,
    z: q.x * scaled.y - q.y * scaled.x,
  };
  const qCrossTwice = {
    x: q.y * qCross.z - q.z * qCross.y,
    y: q.z * qCross.x - q.x * qCross.z,
    z: q.x * qCross.y - q.y * qCross.x,
  };
  return {
    x: scaled.x + q.w * qCross.x * 2 + qCrossTwice.x * 2 + translation.x,
    y: scaled.y + q.w * qCross.y * 2 + qCrossTwice.y * 2 + translation.y,
    z: scaled.z + q.w * qCross.z * 2 + qCrossTwice.z * 2 + translation.z,
  };
}

function railRelativeEndpoints(transform, points) {
  if (!transform || !Array.isArray(points) || points.length === 0) return null;
  const first = transformRailPoint(transform, points[0]);
  const last = transformRailPoint(transform, points[points.length - 1]);
  return first && last ? { start_cm: first, end_cm: last } : null;
}

function railMaximum(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(numeric)));
}

/**
 * Decode saved native railroad tracks without pretending that a Blueprint's
 * graph ID or spline endpoints prove that two placed segments will join. The
 * track header and point/tangent data are authoritative observations of this
 * file; terrain, clearance, graph remapping, and destination hookups remain
 * game-side questions.
 */
export function decodeBlueprintRailTopology(
  objects,
  {
    maximumRailTracks = DEFAULT_MAXIMUM_RAIL_TRACKS,
    maximumRailSplinePoints = DEFAULT_MAXIMUM_RAIL_SPLINE_POINTS,
  } = {},
) {
  const allObjects = Array.isArray(objects) ? objects : [];
  const railTracks = allObjects.filter(isNativeRailTrack);
  const entities = allObjects.filter((object) => object?.type === "SaveEntity");
  const entityIndexes = new Map(entities.map((entity, index) => [entity, index]));
  const maximumTracks = railMaximum(maximumRailTracks, DEFAULT_MAXIMUM_RAIL_TRACKS, MAXIMUM_RAIL_TRACKS);
  const maximumPoints = railMaximum(
    maximumRailSplinePoints,
    DEFAULT_MAXIMUM_RAIL_SPLINE_POINTS,
    MAXIMUM_RAIL_SPLINE_POINTS,
  );
  const trackRecords = [];
  const graphIds = new Set();
  let malformedTrackEntityRecordCount = 0;
  let missingGraphIdCount = 0;
  let malformedGraphIdCount = 0;
  let missingSplineDataCount = 0;
  let malformedSplineDataCount = 0;
  let malformedSplinePointCount = 0;
  let finiteTransformCount = 0;
  let totalSplinePointCount = 0;

  for (const [entityIndex, entity] of allObjects.entries()) {
    if (!isNativeRailTrack(entity)) continue;
    const instanceName = validSavedInstanceName(entity.instanceName) ? entity.instanceName : null;
    if (!instanceName) malformedTrackEntityRecordCount += 1;
    const graphId = railTrackGraphId(entity);
    if (graphId.state === "valid") graphIds.add(graphId.value);
    else if (graphId.state === "missing") missingGraphIdCount += 1;
    else malformedGraphIdCount += 1;
    const spline = railSplineData(entity);
    if (spline.state === "missing") missingSplineDataCount += 1;
    else if (spline.state === "malformed") malformedSplineDataCount += 1;
    malformedSplinePointCount += spline.malformed_point_count ?? 0;
    const transform = readBuildableTransform(entity);
    if (transform) finiteTransformCount += 1;
    const points = spline.points;
    totalSplinePointCount += spline.declared_point_count ?? points.length;
    const returnedPoints = points.slice(0, maximumPoints);
    const record = {
      entity_index: entityIndexes.get(entity) ?? entityIndex,
      track_instance_name: instanceName,
      track_class_path: entity.typePath,
      track_class_name: shortName(entity.typePath),
      transform,
      track_graph_id: graphId.value,
      track_graph_id_state: graphId.state,
      spline_data_state: spline.state,
      spline_point_count: spline.declared_point_count ?? points.length,
      malformed_spline_point_count: spline.malformed_point_count ?? 0,
      spline_points: returnedPoints,
      spline_points_returned: returnedPoints.length,
      spline_points_truncated: Math.max(0, points.length - returnedPoints.length),
      local_bounds_cm: railLocalBounds(points),
      chord_length_cm: spline.state === "valid" ? railChordLength(points) : null,
      blueprint_relative_endpoints_cm: railRelativeEndpoints(transform, points),
      built_with_recipe: builtWithRecipe(entity),
    };
    trackRecords.push(record);
  }

  const hasInconclusiveRecords =
    malformedTrackEntityRecordCount > 0 ||
    missingGraphIdCount > 0 ||
    malformedGraphIdCount > 0 ||
    missingSplineDataCount > 0 ||
    malformedSplineDataCount > 0 ||
    malformedSplinePointCount > 0;
  const returnedTracks = trackRecords.slice(0, maximumTracks);
  const returnedSplinePointCount = returnedTracks.reduce(
    (total, record) => total + (record.spline_points_returned ?? 0),
    0,
  );
  return {
    status: "decoded",
    scope: "saved_native_railroad_track_spline_records",
    native_rail_track_entity_count: railTracks.length,
    rail_track_records_returned: returnedTracks.length,
    rail_track_records_truncated: Math.max(0, trackRecords.length - returnedTracks.length),
    rail_tracks: returnedTracks,
    total_spline_point_count: totalSplinePointCount,
    returned_spline_point_count: returnedSplinePointCount,
    spline_points_truncated: Math.max(0, totalSplinePointCount - returnedSplinePointCount),
    track_graph_ids: [...graphIds].sort((left, right) => left - right),
    finite_transform_count: finiteTransformCount,
    malformed_rail_track_entity_record_count: malformedTrackEntityRecordCount,
    missing_track_graph_id_count: missingGraphIdCount,
    malformed_track_graph_id_count: malformedGraphIdCount,
    missing_spline_data_count: missingSplineDataCount,
    malformed_spline_data_count: malformedSplineDataCount,
    malformed_spline_point_count: malformedSplinePointCount,
    rail_connectivity: "not_proven_from_saved_spline_points_or_m_track_graph_id",
    external_connections: "not_proven_by_the_saved_blueprint",
    terrain_clearance_and_destination_fit: "not_proven_by_the_saved_blueprint",
    caveat:
      "Track transforms and mSplineData points/tangents are exact saved native observations. Chord length is the straight-line lower bound between saved points, not the curved spline length. mTrackGraphID is retained metadata; it does not prove cross-segment joins after placement, terrain excavation, collision clearance, signals, power, or external rail hookups.",
    source: "decoded_from_saved_native_railroad_track_m_spline_data",
    certainty: hasInconclusiveRecords
      ? "authoritative_observation_with_inconclusive_rail_records"
      : "authoritative_for_saved_native_rail_spline_records",
  };
}

function uniqueObjectsByInstanceName(objects) {
  const byName = new Map();
  const duplicateNames = new Set();
  for (const object of objects) {
    if (
      !validSavedInstanceName(object?.instanceName)
    ) continue;
    if (byName.has(object.instanceName)) {
      duplicateNames.add(object.instanceName);
      byName.set(object.instanceName, null);
      continue;
    }
    byName.set(object.instanceName, object);
  }
  return { byName, duplicateNames };
}

function mWiresReferences(component) {
  const property = component?.properties?.mWires;
  if (!property) return { state: "absent", references: [] };
  const arrayIsExact =
    property.type === "ArrayProperty" &&
    property.name === "mWires" &&
    property.propertyTagType?.name === "ArrayProperty" &&
    Array.isArray(property.propertyTagType.children) &&
    property.propertyTagType.children.length === 1 &&
    property.propertyTagType.children[0]?.name === "ObjectProperty" &&
    Array.isArray(property.values);
  if (!arrayIsExact) return { state: "malformed_property", references: [] };

  const references = [];
  let malformedReferenceCount = 0;
  for (const value of property.values) {
    const pathName = objectReferencePathName(value);
    if (!pathName) {
      malformedReferenceCount += 1;
      continue;
    }
    references.push(pathName);
  }
  return {
    state: malformedReferenceCount > 0 ? "malformed_references" : "valid",
    references,
    malformed_reference_count: malformedReferenceCount,
  };
}

/**
 * Decodes internal native power wires by inverting the exact saved mWires
 * membership of FGPowerConnectionComponent records. The game stores each
 * AFGBuildableWire reference on both of its endpoints; the wire actor itself
 * has only replicated endpoint pointers, so those are intentionally not used
 * as a saved-blueprint source of truth here.
 *
 * mHiddenConnections are deliberately excluded: they are logical circuit
 * relationships, not physical AFGBuildableWire instances.
 */
export function decodeBlueprintPowerWireTopology(
  objects,
  { maximumPowerWires = DEFAULT_MAXIMUM_CONNECTIONS } = {},
) {
  const allObjects = Array.isArray(objects) ? objects : [];
  const entities = allObjects.filter((object) => object?.type === "SaveEntity");
  const components = allObjects.filter((object) => object?.type === "SaveComponent");
  const { byName: entitiesByName, duplicateNames: duplicateEntityNames } = uniqueObjectsByInstanceName(entities);
  const { duplicateNames: duplicateComponentNames } = uniqueObjectsByInstanceName(components);
  const nativePowerLines = entities.filter(isNativePowerLine);
  const nativePowerConnectionComponents = components.filter(isNativePowerConnectionComponent);
  const malformedPowerWireEntityRecordCount = nativePowerLines.filter(
    (entity) =>
      !validSavedInstanceName(entity?.instanceName),
  ).length;
  const mWiresPropertyRecords = allObjects.filter(
    (object) => Object.hasOwn(object?.properties ?? {}, "mWires"),
  );
  const supportedMWiresRecords = nativePowerConnectionComponents.filter(
    (component) => Object.hasOwn(component?.properties ?? {}, "mWires"),
  );

  const referencesByWireName = new Map();
  let malformedPowerConnectionComponentRecordCount = 0;
  let ambiguousPowerConnectionComponentRecordCount = 0;
  let malformedMWiresPropertyCount = 0;
  let malformedMWiresReferenceCount = 0;
  let duplicateMWiresReferenceCount = 0;
  let unresolvedPowerWireReferenceCount = 0;
  let ambiguousPowerWireReferenceCount = 0;
  let unsupportedPowerWireTargetCount = 0;
  let savedPowerWireReferenceCount = 0;

  for (const component of supportedMWiresRecords) {
    const componentName = component.instanceName;
    if (!validSavedInstanceName(componentName)) {
      malformedPowerConnectionComponentRecordCount += 1;
      continue;
    }
    if (duplicateComponentNames.has(componentName)) {
      ambiguousPowerConnectionComponentRecordCount += 1;
      continue;
    }

    const parsedReferences = mWiresReferences(component);
    if (parsedReferences.state === "malformed_property") {
      malformedMWiresPropertyCount += 1;
      continue;
    }
    malformedMWiresReferenceCount += parsedReferences.malformed_reference_count ?? 0;
    const referencesSeenOnThisComponent = new Set();
    for (const wireName of parsedReferences.references) {
      savedPowerWireReferenceCount += 1;
      const duplicateOnEndpoint = referencesSeenOnThisComponent.has(wireName);
      if (duplicateOnEndpoint) duplicateMWiresReferenceCount += 1;
      referencesSeenOnThisComponent.add(wireName);

      if (duplicateEntityNames.has(wireName)) {
        ambiguousPowerWireReferenceCount += 1;
        continue;
      }
      const wireEntity = entitiesByName.get(wireName) ?? null;
      if (!wireEntity) {
        unresolvedPowerWireReferenceCount += 1;
        continue;
      }
      if (!isNativePowerLine(wireEntity)) {
        unsupportedPowerWireTargetCount += 1;
        continue;
      }

      if (!referencesByWireName.has(wireName)) {
        referencesByWireName.set(wireName, {
          wire_entity: wireEntity,
          endpoints_by_component_name: new Map(),
          duplicate_endpoint_reference_count: 0,
        });
      }
      const observation = referencesByWireName.get(wireName);
      if (duplicateOnEndpoint || observation.endpoints_by_component_name.has(componentName)) {
        observation.duplicate_endpoint_reference_count += 1;
        continue;
      }
      observation.endpoints_by_component_name.set(componentName, component);
    }
  }

  let duplicatePowerWireEntityNameCount = 0;
  for (const entityName of duplicateEntityNames) {
    const matchingEntities = nativePowerLines.filter((entity) => entity.instanceName === entityName);
    if (matchingEntities.length > 0) duplicatePowerWireEntityNameCount += 1;
  }

  const unreferencedPowerWireEntityCount = nativePowerLines.filter((entity) => {
    const entityName = entity.instanceName;
    return validSavedInstanceName(entityName) &&
      !duplicateEntityNames.has(entityName) &&
      !referencesByWireName.has(entityName);
  }).length;
  const pairs = [];
  const endpointOwnerResolution = { both: 0, one: 0, neither: 0 };
  let unresolvedPowerWireEndpointOwnerCount = 0;
  let duplicatePowerWireEndpointReferenceCount = 0;
  let incompletePowerWireEndpointCount = 0;
  let overconnectedPowerWireEndpointCount = 0;

  for (const [wireName, observation] of referencesByWireName) {
    const endpoints = [...observation.endpoints_by_component_name.values()];
    if (observation.duplicate_endpoint_reference_count > 0) {
      duplicatePowerWireEndpointReferenceCount += observation.duplicate_endpoint_reference_count;
      continue;
    }
    if (endpoints.length < 2) {
      incompletePowerWireEndpointCount += 1;
      continue;
    }
    if (endpoints.length > 2) {
      overconnectedPowerWireEndpointCount += 1;
      continue;
    }
    const [firstComponent, secondComponent] = canonicalComponentPair(endpoints[0], endpoints[1]);
    const firstEndpoint = componentEndpoint(firstComponent, entitiesByName);
    const secondEndpoint = componentEndpoint(secondComponent, entitiesByName);
    unresolvedPowerWireEndpointOwnerCount += Number(!firstEndpoint.owner_entity_resolved);
    unresolvedPowerWireEndpointOwnerCount += Number(!secondEndpoint.owner_entity_resolved);
    const resolvedOwners = Number(firstEndpoint.owner_entity_resolved) + Number(secondEndpoint.owner_entity_resolved);
    if (resolvedOwners === 2) endpointOwnerResolution.both += 1;
    else if (resolvedOwners === 1) endpointOwnerResolution.one += 1;
    else endpointOwnerResolution.neither += 1;
    pairs.push({
      power_wire_instance_name: wireName,
      power_wire_class_path: observation.wire_entity.typePath,
      power_wire_class_name: shortName(observation.wire_entity.typePath),
      endpoint_a: firstEndpoint,
      endpoint_b: secondEndpoint,
    });
  }

  pairs.sort((left, right) => left.power_wire_instance_name.localeCompare(right.power_wire_instance_name));
  const maximum = boundedMaximumConnections(maximumPowerWires, DEFAULT_MAXIMUM_CONNECTIONS);
  const unsupportedMWiresPropertyRecordCount = mWiresPropertyRecords.length - supportedMWiresRecords.length;
  const hasInconclusiveReferences =
    malformedPowerWireEntityRecordCount > 0 ||
    malformedPowerConnectionComponentRecordCount > 0 ||
    ambiguousPowerConnectionComponentRecordCount > 0 ||
    malformedMWiresPropertyCount > 0 ||
    malformedMWiresReferenceCount > 0 ||
    duplicateMWiresReferenceCount > 0 ||
    unresolvedPowerWireReferenceCount > 0 ||
    ambiguousPowerWireReferenceCount > 0 ||
    unsupportedPowerWireTargetCount > 0 ||
    duplicatePowerWireEntityNameCount > 0 ||
    duplicatePowerWireEndpointReferenceCount > 0 ||
    incompletePowerWireEndpointCount > 0 ||
    overconnectedPowerWireEndpointCount > 0 ||
    unreferencedPowerWireEntityCount > 0 ||
    unresolvedPowerWireEndpointOwnerCount > 0 ||
    unsupportedMWiresPropertyRecordCount > 0;

  return {
    status: "decoded",
    scope: "native_power_wire_edges_inverted_from_exact_m_wires_membership",
    native_power_connection_component_count: nativePowerConnectionComponents.length,
    m_wires_property_record_count: mWiresPropertyRecords.length,
    supported_m_wires_property_record_count: supportedMWiresRecords.length,
    unsupported_m_wires_property_record_count: unsupportedMWiresPropertyRecordCount,
    power_wire_entity_count: nativePowerLines.length,
    referenced_power_wire_entity_count: referencesByWireName.size,
    saved_power_wire_reference_count: savedPowerWireReferenceCount,
    verified_power_wire_count: pairs.length,
    endpoint_owner_resolution: endpointOwnerResolution,
    malformed_power_wire_entity_record_count: malformedPowerWireEntityRecordCount,
    malformed_power_connection_component_record_count: malformedPowerConnectionComponentRecordCount,
    ambiguous_power_connection_component_record_count: ambiguousPowerConnectionComponentRecordCount,
    malformed_m_wires_property_count: malformedMWiresPropertyCount,
    malformed_m_wires_reference_count: malformedMWiresReferenceCount,
    duplicate_m_wires_reference_count: duplicateMWiresReferenceCount,
    unresolved_power_wire_reference_count: unresolvedPowerWireReferenceCount,
    ambiguous_power_wire_reference_count: ambiguousPowerWireReferenceCount,
    unsupported_power_wire_target_count: unsupportedPowerWireTargetCount,
    duplicate_power_wire_entity_name_count: duplicatePowerWireEntityNameCount,
    duplicate_power_wire_endpoint_reference_count: duplicatePowerWireEndpointReferenceCount,
    incomplete_power_wire_endpoint_count: incompletePowerWireEndpointCount,
    overconnected_power_wire_endpoint_count: overconnectedPowerWireEndpointCount,
    unreferenced_power_wire_entity_count: unreferencedPowerWireEntityCount,
    unresolved_power_wire_endpoint_owner_count: unresolvedPowerWireEndpointOwnerCount,
    power_wires: pairs.slice(0, maximum),
    power_wires_returned: Math.min(maximum, pairs.length),
    power_wires_truncated: Math.max(0, pairs.length - maximum),
    electricity_direction: "not_inferred_from_saved_power_wire_edges",
    voltage_load_and_capacity: "not_inferred_from_saved_power_wire_edges",
    hidden_circuit_connections: "not_counted_as_physical_power_wires",
    external_connections: "not_proven_by_the_saved_blueprint",
    caveat:
      "Only exact mWires membership on native FGPowerConnectionComponent records is inverted into physical native power-wire edges. This does not prove electricity direction, voltage, load, capacity, live circuit state, wire length, terrain clearance, Build Gun validity, or hookups outside the Blueprint.",
    source: "decoded_from_saved_blueprint_power_connection_m_wires",
    certainty: hasInconclusiveReferences
      ? "authoritative_observation_with_inconclusive_power_wire_references"
      : "authoritative_for_verified_native_power_wire_edges",
  };
}

/**
 * Decode the exact reciprocal conveyor/pipe component references already
 * present in a parsed native Blueprint. Exported separately so malformed,
 * one-way, and ambiguous references receive regression coverage without
 * relying on a writer to serialize intentionally corrupt save data.
 */
export function decodeBlueprintConnectionTopology(
  objects,
  { maximumConnections = DEFAULT_MAXIMUM_CONNECTIONS } = {},
) {
  const allObjects = Array.isArray(objects) ? objects : [];
  const entitiesByName = new Map();
  for (const object of allObjects) {
    if (object?.type !== "SaveEntity" || typeof object.instanceName !== "string" || !object.instanceName) continue;
    // A duplicated saved entity name cannot be resolved safely to one owner.
    if (entitiesByName.has(object.instanceName)) entitiesByName.set(object.instanceName, null);
    else entitiesByName.set(object.instanceName, object);
  }

  const savedComponents = allObjects.filter((object) => object?.type === "SaveComponent");
  const componentsByName = new Map();
  const duplicateComponentNames = new Set();
  for (const component of savedComponents) {
    if (typeof component.instanceName !== "string" || !component.instanceName) continue;
    if (componentsByName.has(component.instanceName)) {
      duplicateComponentNames.add(component.instanceName);
      continue;
    }
    componentsByName.set(component.instanceName, component);
  }

  const connectionComponents = savedComponents.filter((component) => blueprintConnectionKind(component) !== null);
  const linkedComponentRecords = savedComponents.filter(
    (component) => Object.hasOwn(component?.properties ?? {}, "mConnectedComponent"),
  );
  const supportedLinkedComponents = linkedComponentRecords.filter(
    (component) => blueprintConnectionKind(component) !== null,
  );
  const unsupportedLinkedComponentRecordCount = linkedComponentRecords.length - supportedLinkedComponents.length;
  const pairs = new Map();
  const kindCounts = { conveyor: 0, pipe: 0, mixed: 0 };
  const ownerResolution = { both: 0, one: 0, neither: 0 };
  let malformedReferenceCount = 0;
  let unresolvedReferenceCount = 0;
  let ambiguousReferenceCount = 0;
  let nonreciprocalReferenceCount = 0;
  let unsupportedTargetReferenceCount = 0;
  let selfReferenceCount = 0;
  let reciprocalReferenceCount = 0;

  for (const component of supportedLinkedComponents) {
    const componentName = component.instanceName;
    const targetName = objectPropertyPathName(component.properties?.mConnectedComponent);
    if (!componentName || !targetName) {
      malformedReferenceCount += 1;
      continue;
    }
    if (duplicateComponentNames.has(componentName)) {
      ambiguousReferenceCount += 1;
      continue;
    }
    if (componentName === targetName) {
      selfReferenceCount += 1;
      continue;
    }
    if (duplicateComponentNames.has(targetName)) {
      ambiguousReferenceCount += 1;
      continue;
    }
    const target = componentsByName.get(targetName) ?? null;
    if (!target) {
      unresolvedReferenceCount += 1;
      continue;
    }
    if (blueprintConnectionKind(target) === null) {
      unsupportedTargetReferenceCount += 1;
      continue;
    }
    const targetBackReference = objectPropertyPathName(target.properties?.mConnectedComponent);
    if (targetBackReference !== componentName) {
      nonreciprocalReferenceCount += 1;
      continue;
    }

    reciprocalReferenceCount += 1;
    const [first, second] = canonicalComponentPair(component, target);
    const key = `${first.instanceName}\u0000${second.instanceName}`;
    if (pairs.has(key)) continue;
    const firstKind = blueprintConnectionKind(first);
    const secondKind = blueprintConnectionKind(second);
    const connectionKind = firstKind === secondKind ? firstKind : "mixed";
    kindCounts[connectionKind] += 1;
    const firstEndpoint = componentEndpoint(first, entitiesByName);
    const secondEndpoint = componentEndpoint(second, entitiesByName);
    const resolvedOwners = Number(firstEndpoint.owner_entity_resolved) + Number(secondEndpoint.owner_entity_resolved);
    if (resolvedOwners === 2) ownerResolution.both += 1;
    else if (resolvedOwners === 1) ownerResolution.one += 1;
    else ownerResolution.neither += 1;
    pairs.set(key, {
      connection_kind: connectionKind,
      endpoint_a: firstEndpoint,
      endpoint_b: secondEndpoint,
    });
  }

  const allPairs = [...pairs.values()].sort((left, right) => {
    const leftKey = `${left.endpoint_a.component_instance_name}\u0000${left.endpoint_b.component_instance_name}`;
    const rightKey = `${right.endpoint_a.component_instance_name}\u0000${right.endpoint_b.component_instance_name}`;
    return leftKey.localeCompare(rightKey);
  });
  const maximum = boundedMaximumConnections(maximumConnections, DEFAULT_MAXIMUM_CONNECTIONS);
  const hasInconclusiveReference =
    malformedReferenceCount > 0 ||
    unresolvedReferenceCount > 0 ||
    ambiguousReferenceCount > 0 ||
    nonreciprocalReferenceCount > 0 ||
    unsupportedTargetReferenceCount > 0 ||
    selfReferenceCount > 0;
  const powerWirePropertyRecords = allObjects.filter(
    (object) => Object.hasOwn(object?.properties ?? {}, "mWires"),
  ).length;

  return {
    status: "decoded",
    scope: "reciprocal_conveyor_and_pipe_component_references",
    connection_component_count: connectionComponents.length,
    m_connected_component_record_count: linkedComponentRecords.length,
    supported_connection_reference_record_count: supportedLinkedComponents.length,
    unsupported_connection_component_record_count: unsupportedLinkedComponentRecordCount,
    reciprocal_connection_reference_count: reciprocalReferenceCount,
    reciprocal_connection_pair_count: allPairs.length,
    reciprocal_connection_pairs_by_kind: kindCounts,
    endpoint_owner_resolution: ownerResolution,
    malformed_component_reference_count: malformedReferenceCount,
    unresolved_component_reference_count: unresolvedReferenceCount,
    ambiguous_component_reference_count: ambiguousReferenceCount,
    nonreciprocal_component_reference_count: nonreciprocalReferenceCount,
    unsupported_target_component_reference_count: unsupportedTargetReferenceCount,
    self_component_reference_count: selfReferenceCount,
    connections: allPairs.slice(0, maximum),
    connections_returned: Math.min(maximum, allPairs.length),
    connections_truncated: Math.max(0, allPairs.length - maximum),
    power_wire_property_records_not_interpreted: powerWirePropertyRecords,
    flow_direction: "not_inferred_from_component_references",
    external_connections: "not_proven_by_the_saved_blueprint",
    caveat:
      "Only exact reciprocal mConnectedComponent links on native conveyor/pipe connection components are decoded. This does not prove item/fluid flow direction, rate, power wiring, terrain clearance, Build Gun validity, or hookups outside the Blueprint.",
    source: "decoded_from_saved_blueprint_component_references",
    certainty: hasInconclusiveReference
      ? "authoritative_observation_with_inconclusive_component_references"
      : "authoritative_for_decoded_reciprocal_component_links",
  };
}

function hypertubeSplinePoint(point) {
  if (point?.type !== "SplinePointData" || !point.properties) return null;
  const vectorProperty = (property, name) =>
    property?.type === "StructProperty" && property.name === name
      ? finiteVector(property.value, ["x", "y", "z"])
      : null;
  const location = vectorProperty(point.properties.Location, "Location");
  const arriveTangent = vectorProperty(point.properties.ArriveTangent, "ArriveTangent");
  const leaveTangent = vectorProperty(point.properties.LeaveTangent, "LeaveTangent");
  if (!location || !arriveTangent || !leaveTangent) return null;
  return {
    location_cm: location,
    arrive_tangent_cm: arriveTangent,
    leave_tangent_cm: leaveTangent,
  };
}

function hypertubeSplineData(entity) {
  const property = entity?.properties?.mSplineData;
  if (!property) return { state: "missing", points: [], malformed_point_count: 0 };
  const exactArray =
    property.type === "ArrayProperty" &&
    property.name === "mSplineData" &&
    property.propertyTagType?.name === "ArrayProperty" &&
    Array.isArray(property.propertyTagType.children) &&
    property.propertyTagType.children.length === 1 &&
    property.propertyTagType.children[0]?.name === "StructProperty" &&
    property.propertyTagType.children[0]?.children?.[0]?.name === "SplinePointData" &&
    Array.isArray(property.values);
  if (!exactArray) return { state: "malformed", points: [], malformed_point_count: 0 };

  const points = [];
  let malformedPointCount = 0;
  for (const value of property.values) {
    const point = hypertubeSplinePoint(value);
    if (!point) malformedPointCount += 1;
    else points.push(point);
  }
  return {
    state: malformedPointCount > 0 ? "malformed_points" : "valid",
    points,
    declared_point_count: property.values.length,
    malformed_point_count: malformedPointCount,
  };
}

function hypertubeLocalBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const minimum = { ...points[0].location_cm };
  const maximum = { ...points[0].location_cm };
  for (const point of points.slice(1)) {
    for (const axis of ["x", "y", "z"]) {
      minimum[axis] = Math.min(minimum[axis], point.location_cm[axis]);
      maximum[axis] = Math.max(maximum[axis], point.location_cm[axis]);
    }
  }
  return {
    minimum_cm: minimum,
    maximum_cm: maximum,
    span_cm: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
    caveat: "Bounds are saved local spline-point positions, not hypertube collision or visual extents.",
  };
}

function hypertubeChordLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].location_cm;
    const current = points[index].location_cm;
    length += Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
      current.z - previous.z,
    );
  }
  return length;
}

function hypertubeTransformPoint(transform, point) {
  const translation = transform?.translation_cm;
  const rotation = transform?.rotation_quat;
  const scale = transform?.scale3d;
  const local = point?.location_cm;
  if (!translation || !rotation || !scale || !local) return null;
  const scaled = {
    x: local.x * scale.x,
    y: local.y * scale.y,
    z: local.z * scale.z,
  };
  const q = rotation;
  const qCross = {
    x: q.y * scaled.z - q.z * scaled.y,
    y: q.z * scaled.x - q.x * scaled.z,
    z: q.x * scaled.y - q.y * scaled.x,
  };
  const qCrossTwice = {
    x: q.y * qCross.z - q.z * qCross.y,
    y: q.z * qCross.x - q.x * qCross.z,
    z: q.x * qCross.y - q.y * qCross.x,
  };
  return {
    x: scaled.x + q.w * qCross.x * 2 + qCrossTwice.x * 2 + translation.x,
    y: scaled.y + q.w * qCross.y * 2 + qCrossTwice.y * 2 + translation.y,
    z: scaled.z + q.w * qCross.z * 2 + qCrossTwice.z * 2 + translation.z,
  };
}

function hypertubeRelativeEndpoints(transform, points) {
  if (!transform || !Array.isArray(points) || points.length === 0) return null;
  const first = hypertubeTransformPoint(transform, points[0]);
  const last = hypertubeTransformPoint(transform, points[points.length - 1]);
  return first && last ? { start_cm: first, end_cm: last } : null;
}

function hypertubeSnappedPassthroughs(entity) {
  const property = entity?.properties?.mSnappedPassthroughs;
  if (!property) {
    return {
      state: "missing",
      declared_count: null,
      nonempty_reference_count: 0,
      blank_reference_count: 0,
      malformed_reference_count: 0,
      references: [],
    };
  }
  if (
    property.type !== "ArrayProperty" ||
    property.name !== "mSnappedPassthroughs" ||
    !Array.isArray(property.values)
  ) {
    return {
      state: "malformed",
      declared_count: null,
      nonempty_reference_count: 0,
      blank_reference_count: 0,
      malformed_reference_count: 0,
      references: [],
    };
  }
  const references = [];
  let blankReferenceCount = 0;
  let malformedReferenceCount = 0;
  for (const value of property.values) {
    const levelName = value?.levelName;
    const pathName = value?.pathName;
    if (typeof levelName !== "string" || typeof pathName !== "string") {
      malformedReferenceCount += 1;
    } else if (!pathName.trim()) {
      // Empty references are how an open end is represented in the sample
      // blueprints. Preserve them as an explicit observation, not a join.
      blankReferenceCount += 1;
    } else if (!validSavedInstanceName(pathName)) {
      malformedReferenceCount += 1;
    } else {
      references.push({ level_name: levelName, path_name: pathName });
    }
  }
  return {
    state: malformedReferenceCount > 0 ? "malformed_references" : "decoded",
    declared_count: property.values.length,
    nonempty_reference_count: references.length,
    blank_reference_count: blankReferenceCount,
    malformed_reference_count: malformedReferenceCount,
    references,
  };
}

function boundedHypertubeMaximum(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(numeric)));
}

/**
 * Decode exact native hypertube component links and PipeHyper spline records.
 * The native CL 502094 headers define UFGPipeConnectionComponentHyper as a
 * UFGPipeConnectionComponentBase and AFGBuildablePipeHyper as a spline
 * buildable. Saved reciprocal references are therefore useful evidence, but
 * they do not prove traversal direction, speed, underground clearance, or a
 * join between separately placed blueprints.
 */
export function decodeBlueprintHypertubeTopology(
  objects,
  {
    maximumConnections = DEFAULT_MAXIMUM_CONNECTIONS,
    maximumPipes = DEFAULT_MAXIMUM_HYPERTUBE_PIPES,
    maximumSplinePoints = DEFAULT_MAXIMUM_HYPERTUBE_SPLINE_POINTS,
  } = {},
) {
  const allObjects = Array.isArray(objects) ? objects : [];
  const entities = allObjects.filter((object) => object?.type === "SaveEntity");
  const entitiesByName = new Map();
  for (const entity of entities) {
    if (typeof entity.instanceName !== "string" || !entity.instanceName) continue;
    if (entitiesByName.has(entity.instanceName)) entitiesByName.set(entity.instanceName, null);
    else entitiesByName.set(entity.instanceName, entity);
  }
  const savedComponents = allObjects.filter((object) => object?.type === "SaveComponent");
  const componentsByName = new Map();
  const duplicateComponentNames = new Set();
  for (const component of savedComponents) {
    if (typeof component.instanceName !== "string" || !component.instanceName) continue;
    if (componentsByName.has(component.instanceName)) {
      duplicateComponentNames.add(component.instanceName);
      continue;
    }
    componentsByName.set(component.instanceName, component);
  }

  const connectionComponents = savedComponents.filter(isNativeHypertubeConnectionComponent);
  const linkedComponentRecords = savedComponents.filter(
    (component) => Object.hasOwn(component?.properties ?? {}, "mConnectedComponent"),
  );
  const supportedLinkedComponents = linkedComponentRecords.filter(isNativeHypertubeConnectionComponent);
  const unsupportedLinkedComponentRecordCount = linkedComponentRecords.length - supportedLinkedComponents.length;
  const pairs = new Map();
  const ownerResolution = { both: 0, one: 0, neither: 0 };
  let malformedReferenceCount = 0;
  let unresolvedReferenceCount = 0;
  let ambiguousReferenceCount = 0;
  let nonreciprocalReferenceCount = 0;
  let unsupportedTargetReferenceCount = 0;
  let selfReferenceCount = 0;
  let reciprocalReferenceCount = 0;

  for (const component of supportedLinkedComponents) {
    const componentName = component.instanceName;
    const targetName = objectPropertyPathName(component.properties?.mConnectedComponent);
    if (!componentName || !targetName) {
      malformedReferenceCount += 1;
      continue;
    }
    if (duplicateComponentNames.has(componentName)) {
      ambiguousReferenceCount += 1;
      continue;
    }
    if (componentName === targetName) {
      selfReferenceCount += 1;
      continue;
    }
    if (duplicateComponentNames.has(targetName)) {
      ambiguousReferenceCount += 1;
      continue;
    }
    const target = componentsByName.get(targetName) ?? null;
    if (!target) {
      unresolvedReferenceCount += 1;
      continue;
    }
    if (!isNativeHypertubeConnectionComponent(target)) {
      unsupportedTargetReferenceCount += 1;
      continue;
    }
    const targetBackReference = objectPropertyPathName(target.properties?.mConnectedComponent);
    if (targetBackReference !== componentName) {
      nonreciprocalReferenceCount += 1;
      continue;
    }
    reciprocalReferenceCount += 1;
    const [first, second] = canonicalComponentPair(component, target);
    const key = `${first.instanceName}\u0000${second.instanceName}`;
    if (pairs.has(key)) continue;
    const firstEndpoint = componentEndpoint(first, entitiesByName);
    const secondEndpoint = componentEndpoint(second, entitiesByName);
    const resolvedOwners = Number(firstEndpoint.owner_entity_resolved) + Number(secondEndpoint.owner_entity_resolved);
    if (resolvedOwners === 2) ownerResolution.both += 1;
    else if (resolvedOwners === 1) ownerResolution.one += 1;
    else ownerResolution.neither += 1;
    pairs.set(key, {
      connection_kind: "hypertube",
      endpoint_a: firstEndpoint,
      endpoint_b: secondEndpoint,
    });
  }

  const allPairs = [...pairs.values()].sort((left, right) => {
    const leftKey = `${left.endpoint_a.component_instance_name}\u0000${left.endpoint_b.component_instance_name}`;
    const rightKey = `${right.endpoint_a.component_instance_name}\u0000${right.endpoint_b.component_instance_name}`;
    return leftKey.localeCompare(rightKey);
  });
  const maximumConnectionCount = boundedHypertubeMaximum(
    maximumConnections,
    DEFAULT_MAXIMUM_CONNECTIONS,
    MAXIMUM_CONNECTIONS,
  );
  const hypertubeEntities = entities.filter((entity) => NATIVE_HYPERTUBE_BUILDABLE_CLASSES.has(entity.typePath));
  const classCounts = new Map();
  for (const entity of hypertubeEntities) {
    const classPath = entity.typePath;
    classCounts.set(classPath, (classCounts.get(classPath) ?? 0) + 1);
  }
  const classRecords = [...classCounts.entries()]
    .map(([classPath, count]) => ({ class_path: classPath, class_name: shortName(classPath), count }))
    .sort((left, right) => right.count - left.count || left.class_path.localeCompare(right.class_path));
  const maximumPipeCount = boundedHypertubeMaximum(
    maximumPipes,
    DEFAULT_MAXIMUM_HYPERTUBE_PIPES,
    MAXIMUM_HYPERTUBE_PIPES,
  );
  const maximumPointCount = boundedHypertubeMaximum(
    maximumSplinePoints,
    DEFAULT_MAXIMUM_HYPERTUBE_SPLINE_POINTS,
    MAXIMUM_HYPERTUBE_SPLINE_POINTS,
  );
  const pipeRecords = [];
  let totalSplinePointCount = 0;
  let finiteTransformCount = 0;
  let malformedPipeEntityRecordCount = 0;
  let missingSplineDataCount = 0;
  let malformedSplineDataCount = 0;
  let malformedSplinePointCount = 0;
  let missingPassthroughPropertyCount = 0;
  let malformedPassthroughPropertyCount = 0;
  let blankPassthroughReferenceCount = 0;
  let malformedPassthroughReferenceCount = 0;
  for (const [entityIndex, entity] of allObjects.entries()) {
    if (entity?.typePath !== NATIVE_HYPERTUBE_PIPE_CLASS) continue;
    const instanceName = validSavedInstanceName(entity.instanceName) ? entity.instanceName : null;
    if (!instanceName) malformedPipeEntityRecordCount += 1;
    const transform = readBuildableTransform(entity);
    if (transform) finiteTransformCount += 1;
    const spline = hypertubeSplineData(entity);
    if (spline.state === "missing") missingSplineDataCount += 1;
    else if (spline.state === "malformed") malformedSplineDataCount += 1;
    malformedSplinePointCount += spline.malformed_point_count ?? 0;
    totalSplinePointCount += spline.declared_point_count ?? spline.points.length;
    const passthroughs = hypertubeSnappedPassthroughs(entity);
    if (passthroughs.state === "missing") missingPassthroughPropertyCount += 1;
    else if (passthroughs.state === "malformed") malformedPassthroughPropertyCount += 1;
    blankPassthroughReferenceCount += passthroughs.blank_reference_count;
    malformedPassthroughReferenceCount += passthroughs.malformed_reference_count;
    const points = spline.points;
    const returnedPoints = points.slice(0, maximumPointCount);
    pipeRecords.push({
      entity_index: entityIndex,
      pipe_instance_name: instanceName,
      pipe_class_path: entity.typePath,
      pipe_class_name: shortName(entity.typePath),
      transform,
      spline_data_state: spline.state,
      spline_point_count: spline.declared_point_count ?? points.length,
      malformed_spline_point_count: spline.malformed_point_count ?? 0,
      spline_points: returnedPoints,
      spline_points_returned: returnedPoints.length,
      spline_points_truncated: Math.max(0, points.length - returnedPoints.length),
      local_bounds_cm: hypertubeLocalBounds(points),
      chord_length_cm: spline.state === "valid" ? hypertubeChordLength(points) : null,
      blueprint_relative_endpoints_cm: hypertubeRelativeEndpoints(transform, points),
      snapped_passthroughs: passthroughs,
      built_with_recipe: builtWithRecipe(entity),
    });
  }
  const returnedPipes = pipeRecords.slice(0, maximumPipeCount);
  const returnedSplinePointCount = returnedPipes.reduce(
    (total, record) => total + (record.spline_points_returned ?? 0),
    0,
  );
  const hasInconclusiveReference =
    malformedReferenceCount > 0 ||
    unresolvedReferenceCount > 0 ||
    ambiguousReferenceCount > 0 ||
    nonreciprocalReferenceCount > 0 ||
    unsupportedTargetReferenceCount > 0 ||
    selfReferenceCount > 0;
  const hasInconclusiveSpline =
    malformedPipeEntityRecordCount > 0 ||
    missingSplineDataCount > 0 ||
    malformedSplineDataCount > 0 ||
    malformedSplinePointCount > 0 ||
    malformedPassthroughPropertyCount > 0 ||
    malformedPassthroughReferenceCount > 0;
  return {
    status: "decoded",
    scope: "reciprocal_native_hypertube_component_references_and_saved_pipe_hyper_splines",
    native_hypertube_connection_component_count: connectionComponents.length,
    m_connected_component_record_count: linkedComponentRecords.length,
    supported_connection_reference_record_count: supportedLinkedComponents.length,
    unsupported_linked_component_record_count: unsupportedLinkedComponentRecordCount,
    reciprocal_connection_reference_count: reciprocalReferenceCount,
    reciprocal_connection_pair_count: allPairs.length,
    endpoint_owner_resolution: ownerResolution,
    malformed_component_reference_count: malformedReferenceCount,
    unresolved_component_reference_count: unresolvedReferenceCount,
    ambiguous_component_reference_count: ambiguousReferenceCount,
    nonreciprocal_component_reference_count: nonreciprocalReferenceCount,
    unsupported_target_component_reference_count: unsupportedTargetReferenceCount,
    self_component_reference_count: selfReferenceCount,
    connections: allPairs.slice(0, maximumConnectionCount),
    connections_returned: Math.min(maximumConnectionCount, allPairs.length),
    connections_truncated: Math.max(0, allPairs.length - maximumConnectionCount),
    native_hypertube_entity_count: hypertubeEntities.length,
    hypertube_buildable_classes: classRecords,
    hypertube_pipe_entity_count: pipeRecords.length,
    pipe_records_returned: returnedPipes.length,
    pipe_records_truncated: Math.max(0, pipeRecords.length - returnedPipes.length),
    pipe_hyper_records: returnedPipes,
    total_spline_point_count: totalSplinePointCount,
    returned_spline_point_count: returnedSplinePointCount,
    spline_points_truncated: Math.max(0, totalSplinePointCount - returnedSplinePointCount),
    missing_spline_data_count: missingSplineDataCount,
    malformed_spline_data_count: malformedSplineDataCount,
    malformed_spline_point_count: malformedSplinePointCount,
    finite_pipe_transform_count: finiteTransformCount,
    missing_passthrough_property_count: missingPassthroughPropertyCount,
    malformed_passthrough_property_count: malformedPassthroughPropertyCount,
    blank_passthrough_reference_count: blankPassthroughReferenceCount,
    malformed_passthrough_reference_count: malformedPassthroughReferenceCount,
    traversal_direction: "not_inferred_from_component_references_or_spline_order",
    speed_and_throughput: "not_inferred_from_saved_hypertube_records",
    cross_blueprint_joins: "not_proven_from_saved_component_references",
    external_connections: "not_proven_by_the_saved_blueprint",
    terrain_clearance_and_destination_fit: "not_proven_by_the_saved_blueprint",
    caveat:
      "Only exact reciprocal mConnectedComponent links on native FGPipeConnectionComponentHyper records and exact Build_PipeHyper mSplineData are decoded. This does not prove travel direction, speed, throughput, junction behavior, underground excavation, collision clearance, Build Gun validity, cross-blueprint joins, or hookups outside the Blueprint.",
    source: "decoded_from_saved_native_hypertube_component_and_pipe_hyper_records",
    certainty:
      hasInconclusiveReference || hasInconclusiveSpline
        ? "authoritative_observation_with_inconclusive_hypertube_records"
        : "authoritative_for_verified_native_hypertube_records",
  };
}

/**
 * Reads the compressed object stream through a pinned parser without mutating the
 * file or game. The returned individual entity list is deliberately bounded;
 * aggregate class counts and pivot bounds cover every decoded buildable.
 */
export function inspectBlueprintStructure(
  name,
  sbpBuffer,
  sbpcfgBuffer = null,
  {
    maximumBuildables = DEFAULT_MAXIMUM_BUILDABLES,
    maximumConnections = DEFAULT_MAXIMUM_CONNECTIONS,
    maximumPowerWires = DEFAULT_MAXIMUM_CONNECTIONS,
    maximumRailTracks = DEFAULT_MAXIMUM_RAIL_TRACKS,
    maximumRailSplinePoints = DEFAULT_MAXIMUM_RAIL_SPLINE_POINTS,
    maximumHypertubeConnections = DEFAULT_MAXIMUM_CONNECTIONS,
    maximumHypertubePipes = DEFAULT_MAXIMUM_HYPERTUBE_PIPES,
    maximumHypertubeSplinePoints = DEFAULT_MAXIMUM_HYPERTUBE_SPLINE_POINTS,
  } = {},
) {
  let header;
  try {
    header = parseBlueprintHeader(sbpBuffer);
  } catch (error) {
    return {
      available: false,
      blueprint_name: name,
      reason: "blueprint_header_unreadable",
      diagnostic: error instanceof Error ? error.message : String(error),
      source: "none",
      certainty: "unknown",
    };
  }
  if (!sbpcfgBuffer) {
    return {
      available: false,
      blueprint_name: name,
      reason: "blueprint_config_missing",
      note: "The matching .sbpcfg file is required before the structural parser can safely decode this native blueprint.",
      header,
      source: "none",
      certainty: "unknown",
    };
  }

  let parsed;
  try {
    parsed = Parser.ParseBlueprintFiles(
      String(name),
      exactArrayBuffer(sbpBuffer),
      exactArrayBuffer(sbpcfgBuffer),
      { throwErrors: true },
    );
  } catch (error) {
    return {
      available: false,
      blueprint_name: name,
      reason: "blueprint_parser_rejected_file",
      diagnostic: error instanceof Error ? error.message : String(error),
      header,
      source: "pinned_satisfactory_file_parser",
      certainty: "unknown",
    };
  }

  const parserHeader = parsed?.header ?? {};
  const dimensions = parserHeader.designerDimension ?? {};
  if (
    parserHeader.headerVersion !== header.blueprint_header_version ||
    parserHeader.saveVersion !== header.factory_save_custom_version ||
    parserHeader.buildVersion !== header.game_changelist ||
    dimensions.x !== header.designer_dimensions.x ||
    dimensions.y !== header.designer_dimensions.y ||
    dimensions.z !== header.designer_dimensions.z
  ) {
    return {
      available: false,
      blueprint_name: name,
      reason: "parser_header_disagrees_with_exact_header",
      header,
      parser_header: {
        blueprint_header_version: parserHeader.headerVersion ?? null,
        factory_save_custom_version: parserHeader.saveVersion ?? null,
        game_changelist: parserHeader.buildVersion ?? null,
        designer_dimensions: dimensions,
      },
      source: "pinned_satisfactory_file_parser",
      certainty: "unknown",
    };
  }

  const objects = Array.isArray(parsed?.objects) ? parsed.objects : [];
  const entities = objects.filter((object) => object?.type === "SaveEntity");
  const components = objects.filter((object) => object?.type === "SaveComponent");
  const buildables = entities
    .map((object, entityIndex) => ({ object, entity_index: entityIndex }))
    .filter(({ object }) => blueprintBuildableCandidate(object));
  const transformed = buildables
    .map(({ object, entity_index }) => ({ object, entity_index, transform: readBuildableTransform(object) }))
    .filter(({ transform }) => transform !== null);

  const classCounts = new Map();
  for (const { object } of buildables) {
    classCounts.set(object.typePath, (classCounts.get(object.typePath) ?? 0) + 1);
  }
  const allClassCounts = [...classCounts.entries()]
    .map(([class_path, count]) => ({ class_path, class_name: shortName(class_path), count }))
    .sort((left, right) => right.count - left.count || left.class_path.localeCompare(right.class_path));
  const maximum = boundedMaximum(maximumBuildables, DEFAULT_MAXIMUM_BUILDABLES);
  const rows = transformed.slice(0, maximum).map(({ object, entity_index, transform }) => ({
    entity_index,
    class_path: object.typePath,
    class_name: shortName(object.typePath),
    instance_name: typeof object.instanceName === "string" ? object.instanceName : null,
    transform,
    built_with_recipe: builtWithRecipe(object),
  }));
  const objectsWithTrailingData = objects.filter(
    (object) => Array.isArray(object?.trailingData) && object.trailingData.length > 0,
  ).length;
  const connectionTopology = decodeBlueprintConnectionTopology(objects, { maximumConnections });
  const powerWireTopology = decodeBlueprintPowerWireTopology(objects, { maximumPowerWires });
  const railTopology = decodeBlueprintRailTopology(objects, {
    maximumRailTracks,
    maximumRailSplinePoints,
  });
  const hypertubeTopology = decodeBlueprintHypertubeTopology(objects, {
    maximumConnections: maximumHypertubeConnections,
    maximumPipes: maximumHypertubePipes,
    maximumSplinePoints: maximumHypertubeSplinePoints,
  });

  return {
    available: true,
    blueprint_name: name,
    parser: {
      package: "@etothepii/satisfactory-file-parser",
      version: PARSER_VERSION,
      mode: "read_only",
    },
    header: {
      blueprint_header_version: header.blueprint_header_version,
      factory_save_custom_version: header.factory_save_custom_version,
      game_changelist: header.game_changelist,
      designer_dimensions: header.designer_dimensions,
      description: typeof parsed?.config?.description === "string" ? parsed.config.description : null,
      build_cost: header.build_cost,
      recipe_references: header.recipe_references,
    },
    decoded: {
      object_count: objects.length,
      entity_count: entities.length,
      component_count: components.length,
      buildable_count: buildables.length,
      buildable_identification:
        "SaveEntity class-path basename matches the native Build_*_C convention.",
      buildable_identification_caveat:
        "The standalone blueprint file does not include runtime class hierarchy data, so a modded buildable that breaks this naming convention may not be counted here.",
      buildables_with_finite_transform: transformed.length,
      objects_with_opaque_trailing_data: objectsWithTrailingData,
      opaque_property_data_note:
        objectsWithTrailingData > 0
          ? "Some decoded objects retain opaque property bytes. Their entity headers and transforms remain decoded; opaque property values are not interpreted."
          : null,
    },
    buildable_classes: allClassCounts.slice(0, MAXIMUM_BUILDABLE_CLASSES),
    distinct_buildable_classes: allClassCounts.length,
    buildable_classes_truncated: Math.max(0, allClassCounts.length - MAXIMUM_BUILDABLE_CLASSES),
    pivot_bounds_cm: pivotBounds(transformed.map(({ transform }) => transform)),
    buildables: rows,
    buildables_returned: rows.length,
    buildables_truncated: Math.max(0, transformed.length - rows.length),
    transform_coverage_caveat:
      "Only native Build_* entities with finite saved transforms are listed. The blueprint file does not prove terrain clearance, hologram validity, or external connections at a destination.",
    connection_topology: connectionTopology,
    power_wire_topology: powerWireTopology,
    rail_topology: railTopology,
    hypertube_topology: hypertubeTopology,
    source: "decoded_from_saved_native_blueprint",
    certainty:
      rows.length < transformed.length
        ? "authoritative_summary_with_bounded_entity_list"
        : "authoritative_for_decoded_entities",
  };
}

/**
 * Compares a blueprint's cost against what the player is carrying, using the same
 * captured inventories `get_build_cost` reads.
 */
export function costAgainstInventory(blueprint, heldByItemClass) {
  const lines = [];
  let affordable = true;

  for (const entry of blueprint.build_cost ?? []) {
    // Blueprints store full class paths; captured inventories may key on the
    // full path, the descriptor with or without the _C suffix, or the bare name.
    const held =
      heldByItemClass.get(entry.item_class) ??
      heldByItemClass.get(`Desc_${entry.item_name}_C`) ??
      heldByItemClass.get(`Desc_${entry.item_name}`) ??
      heldByItemClass.get(entry.item_name) ??
      0;
    const shortfall = Math.max(0, entry.amount - held);
    if (shortfall > 0) affordable = false;
    lines.push({
      item_class: entry.item_class,
      item_name: entry.item_name,
      required: entry.amount,
      held_in_player_inventories: held,
      shortfall,
    });
  }

  return {
    ingredients: lines,
    affordable_from_captured_player_inventories: lines.length > 0 ? affordable : null,
    inventory_scope:
      "Captured player inventories only; storage containers and the dimensional depot are not counted.",
  };
}
