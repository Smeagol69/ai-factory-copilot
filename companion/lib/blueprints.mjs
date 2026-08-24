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

function componentEndpoint(component, entitiesByName) {
  const ownerName =
    typeof component?.parentEntityName === "string" && component.parentEntityName
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
