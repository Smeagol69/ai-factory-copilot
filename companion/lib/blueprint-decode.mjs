/**
 * Complete, unbounded decode of one saved native blueprint.
 *
 * `inspectBlueprintStructure` is the *live tool* view: deliberately bounded, so
 * a large blueprint cannot overflow a provider context. Those bounds are correct
 * there and are not touched here.
 *
 * This is the offline view. It runs from a file on disk into a committed
 * artifact, where there is no context to overflow and truncation would be a
 * defect: an agent that can only see the first eighty buildings cannot rebuild
 * the design. Everything the pinned parser knows is kept - every transform, the
 * recipe each machine is actually set to, its clock, and its colour.
 *
 * The extra facts over the census matter more than they look. `mCurrentRecipe`
 * is what a machine makes; `mPendingPotential` is its clock. Together with the
 * machine count they explain an author's declared throughput arithmetically -
 * four Constructors on Recipe_Screw at 0.75 is exactly the "120 Screw" the
 * author wrote in the description. That turns a claim we were repeating into one
 * we can check.
 *
 * What is still not claimed here: the base per-machine rate of a recipe. That
 * lives in `content.recipes` on a live snapshot, never in a blueprint file. This
 * module derives the rate the author's own numbers *imply* and says so; it does
 * not assert a vanilla constant.
 */

import { Parser } from "@etothepii/satisfactory-file-parser";

import {
  decodeBlueprintConnectionTopology,
  decodeBlueprintPowerWireTopology,
  parseBlueprintConfig,
  parseBlueprintHeader,
} from "./blueprints.mjs";
import { classifyBuildable, parseDeclaredIo } from "./blueprint-reference.mjs";

/** One foundation cell. The blueprint designer snaps to this. */
export const CELL_CM = 800;

// Offline, so the only reason to bound anything is to refuse a pathological
// file rather than to protect a context window.
const OFFLINE_TOPOLOGY_LIMIT = 100000;

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Yaw in degrees from a saved quaternion, normalised to [0, 360).
 *
 * Buildings in a blueprint are almost always yaw-only, so this is the whole
 * rotation story for them. Pitch and roll are reported separately when a saved
 * quaternion is not yaw-only, rather than being silently flattened.
 */
export function yawDegreesFromQuaternion(quaternion) {
  const x = Number(quaternion?.x ?? 0);
  const y = Number(quaternion?.y ?? 0);
  const z = Number(quaternion?.z ?? 0);
  const w = Number(quaternion?.w ?? 1);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const degrees = (yaw * 180) / Math.PI;
  const normalised = ((degrees % 360) + 360) % 360;
  // Round before the final wrap, not after: a yaw a hair below zero normalises
  // to 359.999... and would otherwise round up to exactly 360, which is outside
  // the range this function promises.
  const rounded = Math.round(normalised * 100) / 100;
  return rounded >= 360 ? 0 : rounded;
}

/** True when a saved quaternion turns about Z only. */
export function isYawOnly(quaternion, tolerance = 1e-4) {
  return (
    Math.abs(Number(quaternion?.x ?? 0)) <= tolerance &&
    Math.abs(Number(quaternion?.y ?? 0)) <= tolerance
  );
}

function assetName(path) {
  const value = String(path ?? "");
  if (!value) return null;
  const tail = value.slice(value.lastIndexOf("/") + 1);
  return tail.split(".")[0] || null;
}

function buildableName(typePath) {
  const asset = assetName(typePath);
  if (!asset) return null;
  return asset.startsWith("Build_") ? asset.slice("Build_".length) : asset;
}

/**
 * The two readers disagree on property shape: the blueprint parser hands back a
 * keyed object, the interactive-map export an array of `{name, value}`. Both are
 * normalised here so one decoder handles either.
 */
function propertyMap(properties) {
  if (!properties) return {};
  if (!Array.isArray(properties)) return properties;
  const map = {};
  for (const entry of properties) {
    if (entry?.name) map[entry.name] = entry;
  }
  return map;
}

function objectPropertyPath(properties, name) {
  const value = properties?.[name]?.value;
  const pathName = value?.pathName;
  return typeof pathName === "string" && pathName ? pathName : null;
}

function floatProperty(properties, name) {
  const value = Number(properties?.[name]?.value);
  return Number.isFinite(value) ? value : null;
}

function byteProperty(properties, name) {
  const raw = properties?.[name]?.value;
  const value = Number(raw?.value ?? raw);
  return Number.isFinite(value) ? value : null;
}

function swatchName(properties) {
  const customization = properties?.mCustomizationData?.value?.properties;
  return assetName(customization?.SwatchDesc?.value?.pathName);
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * One decoded building. Positions are blueprint-local: the designer's own
 * origin, not world coordinates.
 */
function decodeBuilding(entity, index) {
  const className = buildableName(entity?.typePath);
  const transform = entity?.transform ?? {};
  // The interactive-map export writes transforms as plain arrays.
  const translation = Array.isArray(transform.translation)
    ? { x: transform.translation[0], y: transform.translation[1], z: transform.translation[2] }
    : (transform.translation ?? {});
  const rotation = Array.isArray(transform.rotation)
    ? {
        x: transform.rotation[0],
        y: transform.rotation[1],
        z: transform.rotation[2],
        w: transform.rotation[3],
      }
    : (transform.rotation ?? {});
  const scale = Array.isArray(transform.scale3d)
    ? { x: transform.scale3d[0], y: transform.scale3d[1], z: transform.scale3d[2] }
    : (transform.scale3d ?? {});
  const properties = propertyMap(entity?.properties);

  const x = Number(translation.x ?? NaN);
  const y = Number(translation.y ?? NaN);
  const z = Number(translation.z ?? NaN);
  const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

  const currentRecipe = objectPropertyPath(properties, "mCurrentRecipe");
  const builtWithRecipe = objectPropertyPath(properties, "mBuiltWithRecipe");
  const potential = floatProperty(properties, "mPendingPotential");

  const yawOnly = isYawOnly(rotation);
  const unitScale =
    Math.abs((scale.x ?? 1) - 1) < 1e-6 &&
    Math.abs((scale.y ?? 1) - 1) < 1e-6 &&
    Math.abs((scale.z ?? 1) - 1) < 1e-6;

  // Kept deliberately narrow. `class_path` is recovered from the decode's
  // class_paths index, and a yaw-only quaternion is fully described by
  // yaw_degrees - carrying both on every one of several thousand records buys
  // nothing and costs megabytes.
  const building = {
    index,
    class_name: className,
    role: classifyBuildable(className),
    position_cm: finite ? { x: round(x, 1), y: round(y, 1), z: round(z, 1) } : null,
    grid_cells: finite ? { x: round(x / CELL_CM, 3), y: round(y / CELL_CM, 3) } : null,
    height_m: finite ? round(z / 100, 2) : null,
    yaw_degrees: yawDegreesFromQuaternion(rotation),
    yaw_only: yawOnly,
    recipe: currentRecipe ? assetName(currentRecipe) : null,
    built_with_recipe: builtWithRecipe ? assetName(builtWithRecipe) : null,
    // Saved as a fraction. Absent means the game never wrote one, which is the
    // unmodified default; it is reported as unknown rather than assumed to be
    // 100% so a summary can say which machines actually carried a clock.
    clock_percent: potential === null ? null : round(potential * 100, 2),
    color_slot: byteProperty(properties, "mColorSlot"),
    swatch: swatchName(properties) ?? null,
  };
  // Only when it carries information the compact fields cannot.
  if (!yawOnly) {
    building.rotation_quaternion = {
      x: round(rotation.x ?? 0, 6),
      y: round(rotation.y ?? 0, 6),
      z: round(rotation.z ?? 0, 6),
      w: round(rotation.w ?? 1, 6),
    };
  }
  if (!unitScale) {
    building.scale = { x: round(scale.x ?? 1, 3), y: round(scale.y ?? 1, 3), z: round(scale.z ?? 1, 3) };
  }
  return building;
}

/** class_name -> full asset path, so the per-building records can stay compact. */
function classPathIndex(entities) {
  const index = {};
  for (const entity of entities) {
    const typePath = entity?.typePath ?? entity?.className;
    const name = buildableName(typePath);
    if (name && !index[name]) index[name] = String(typePath);
  }
  return index;
}

/**
 * Machines grouped by what they are set to make and how hard they are driven.
 * This is the semantic core of a production blueprint.
 */
export function summarizeMachines(buildings) {
  const groups = new Map();
  for (const building of buildings) {
    if (building.role !== "production") continue;
    const key = `${building.class_name}|${building.recipe ?? "none"}|${building.clock_percent ?? "unset"}`;
    const existing = groups.get(key) ?? {
      class_name: building.class_name,
      recipe: building.recipe,
      clock_percent: building.clock_percent,
      count: 0,
    };
    existing.count += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || String(a.class_name).localeCompare(String(b.class_name)),
  );
}

/**
 * What the author's declared numbers imply for a single machine at full clock.
 *
 * This is arithmetic on the author's own claim, not a recipe lookup: if they say
 * 120 Screw and the file contains four Constructors at 75%, then each machine is
 * being credited with 40/min at 100%. A live `content.recipes` check can then
 * confirm or contradict that, which is exactly the point - it gives the claim
 * something to be wrong against.
 */
export function checkDeclaredThroughput(declaredIo, machineGroups) {
  const outputs = declaredIo?.outputs ?? [];
  const producing = machineGroups.filter((group) => group.recipe);
  if (outputs.length !== 1 || producing.length !== 1) {
    return {
      status: "not_attempted",
      reason:
        outputs.length !== 1
          ? "the author declared no single output"
          : "the blueprint does not contain exactly one machine-and-recipe group",
      declared_outputs: outputs,
      machine_groups: machineGroups,
    };
  }
  const [output] = outputs;
  const [group] = producing;
  const clockFraction = group.clock_percent === null ? null : group.clock_percent / 100;
  if (!clockFraction || !group.count) {
    return {
      status: "not_attempted",
      reason: "no saved clock on the producing machines",
      declared_outputs: outputs,
      machine_groups: machineGroups,
    };
  }
  return {
    status: "derived",
    declared_output: output,
    machine_class: group.class_name,
    recipe: group.recipe,
    machine_count: group.count,
    clock_percent: group.clock_percent,
    implied_rate_per_machine_at_full_clock: round(
      output.amount_per_minute / (group.count * clockFraction),
      4,
    ),
    evidence: "author_declared_output_divided_by_decoded_machine_count_and_clock",
    caveat:
      "Arithmetic on the author's own declared output, not a recipe rate. Confirm against content.recipes on a live snapshot before planning to it.",
  };
}

const WORLD_EXPORT_PROXY_CLASS = "FGBlueprintProxy";

/**
 * The same decode for an interactive-map world export.
 *
 * A `.cbp` is not a blueprint: it is a flat list of actors at absolute world
 * coordinates with no designer envelope, no build cost, and no author
 * description. Positions are rebased onto the export's own minimum corner so the
 * result is directly comparable with a designer blueprint, and the world origin
 * is kept so nothing is lost.
 *
 * Placed-blueprint proxies are counted, never treated as buildings: their
 * contents are already present as individual actors and counting both
 * double-counts the base.
 */
export function decodeWorldExport(name, document) {
  const entries = Array.isArray(document?.data) ? document.data : [];
  let proxyCount = 0;
  let nonBuildableCount = 0;
  const actors = [];
  for (const entry of entries) {
    const actor = entry?.parent ?? entry;
    const classPath = String(actor?.className ?? "");
    if (!classPath) continue;
    if (classPath.includes(WORLD_EXPORT_PROXY_CLASS)) {
      proxyCount += 1;
      continue;
    }
    if (!classPath.includes("/Build_")) {
      nonBuildableCount += 1;
      continue;
    }
    actors.push(actor);
  }

  const buildings = actors.map((actor, index) => {
    const building = decodeBuilding(
      { typePath: actor.className, transform: actor.transform, properties: actor.properties },
      index,
    );
    // A world export carries customization on the actor, not in its properties.
    const swatch = assetName(actor?.customizationData?.SwatchDesc?.pathName);
    return swatch ? { ...building, swatch } : building;
  });

  const positioned = buildings.filter((building) => building.position_cm);
  const origin = positioned.length
    ? {
        x: Math.min(...positioned.map((b) => b.position_cm.x)),
        y: Math.min(...positioned.map((b) => b.position_cm.y)),
        z: Math.min(...positioned.map((b) => b.position_cm.z)),
      }
    : { x: 0, y: 0, z: 0 };

  const rebased = buildings.map((building) =>
    building.position_cm
      ? {
          ...building,
          position_cm: {
            x: round(building.position_cm.x - origin.x, 1),
            y: round(building.position_cm.y - origin.y, 1),
            z: round(building.position_cm.z - origin.z, 1),
          },
          grid_cells: {
            x: round((building.position_cm.x - origin.x) / CELL_CM, 3),
            y: round((building.position_cm.y - origin.y) / CELL_CM, 3),
          },
          height_m: round((building.position_cm.z - origin.z) / 100, 2),
        }
      : building,
  );
  rebased.sort((a, b) => a.class_name?.localeCompare(b.class_name ?? "") || a.index - b.index);

  const machineGroups = summarizeMachines(rebased);
  const declaredIo = parseDeclaredIo("");

  return {
    available: true,
    name,
    decoded_with: { package: "interactive_map_world_export", mode: "read_only" },
    header: {
      blueprint_header_version: null,
      factory_save_custom_version: document?.saveVersion ?? null,
      game_changelist: document?.buildVersion ?? null,
      designer_dimensions: { x: null, y: null, z: null },
      description: null,
      build_cost: [],
    },
    declared_io: declaredIo,
    totals: {
      saved_objects: entries.length,
      saved_entities: actors.length,
      buildings: rebased.length,
      buildings_with_position: positioned.length,
      distinct_classes: new Set(rebased.map((b) => b.class_name)).size,
      distinct_yaw_degrees: [...new Set(rebased.map((b) => b.yaw_degrees))].sort((a, b) => a - b),
      non_yaw_only_buildings: rebased.filter((b) => !b.yaw_only).length,
      blueprint_proxy_count: proxyCount,
      non_buildable_actor_count: nonBuildableCount,
    },
    world_origin_cm: origin,
    pivot_extent: positioned.length
      ? {
          min_cm: { x: 0, y: 0, z: 0 },
          max_cm: {
            x: round(Math.max(...positioned.map((b) => b.position_cm.x)) - origin.x, 1),
            y: round(Math.max(...positioned.map((b) => b.position_cm.y)) - origin.y, 1),
            z: round(Math.max(...positioned.map((b) => b.position_cm.z)) - origin.z, 1),
          },
        }
      : null,
    class_paths: classPathIndex(actors.map((actor) => ({ typePath: actor.className }))),
    machine_groups: machineGroups,
    throughput_check: checkDeclaredThroughput(declaredIo, machineGroups),
    connection_topology: {
      status: "not_available",
      reason:
        "An interactive-map world export does not carry the saved component records the blueprint connection decoder reads.",
      reciprocal_connection_pair_count: null,
    },
    power_wire_topology: {
      status: "not_available",
      reason: "The same: no saved native power-connection component records in this format.",
      verified_power_wire_count: null,
    },
    buildings: rebased,
    coordinate_note:
      "Positions are rebased onto this export's own minimum corner so they read like a blueprint; world_origin_cm is the offset that recovers the original absolute coordinate. Proxies and non-buildable actors are counted separately and are not buildings.",
    source: "decoded_from_interactive_map_world_export",
    certainty: "authoritative_for_decoded_actors",
  };
}

/**
 * The full decode. Throws nothing for a readable file; returns an unavailable
 * record with a reason for one it cannot decode.
 */
export function decodeBlueprint(name, sbpBuffer, sbpcfgBuffer) {
  let header;
  try {
    header = parseBlueprintHeader(sbpBuffer);
  } catch (error) {
    return {
      available: false,
      name,
      reason: "blueprint_header_unreadable",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  if (!sbpcfgBuffer) {
    return { available: false, name, reason: "blueprint_config_missing" };
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
      name,
      reason: "blueprint_parser_rejected_file",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  const objects = Array.isArray(parsed?.objects) ? parsed.objects : [];
  const entities = objects.filter((object) => object?.type === "SaveEntity");
  const buildings = entities
    .filter((entity) => String(entity?.typePath ?? "").includes("/Build_"))
    .map((entity, index) => decodeBuilding(entity, index))
    .sort((a, b) => a.class_name?.localeCompare(b.class_name ?? "") || a.index - b.index);

  // The description is the author's, and it lives in the .sbpcfg - never in the
  // .sbp header. Reading it off the wrong file silently yields no declared I/O
  // and quietly disables the throughput check.
  const config = parseBlueprintConfig(sbpcfgBuffer);
  const declaredIo = parseDeclaredIo(config.description);
  const machineGroups = summarizeMachines(buildings);

  const positioned = buildings.filter((building) => building.position_cm);
  const extent = positioned.length
    ? {
        min_cm: {
          x: Math.min(...positioned.map((b) => b.position_cm.x)),
          y: Math.min(...positioned.map((b) => b.position_cm.y)),
          z: Math.min(...positioned.map((b) => b.position_cm.z)),
        },
        max_cm: {
          x: Math.max(...positioned.map((b) => b.position_cm.x)),
          y: Math.max(...positioned.map((b) => b.position_cm.y)),
          z: Math.max(...positioned.map((b) => b.position_cm.z)),
        },
      }
    : null;

  const distinctYaws = [...new Set(buildings.map((b) => b.yaw_degrees))].sort((a, b) => a - b);

  return {
    available: true,
    name,
    decoded_with: { package: "@etothepii/satisfactory-file-parser", mode: "read_only" },
    header: {
      blueprint_header_version: header.blueprint_header_version,
      factory_save_custom_version: header.factory_save_custom_version,
      game_changelist: header.game_changelist,
      designer_dimensions: header.designer_dimensions,
      description: config.description ?? null,
      build_cost: header.build_cost,
    },
    declared_io: declaredIo,
    totals: {
      saved_objects: objects.length,
      saved_entities: entities.length,
      buildings: buildings.length,
      buildings_with_position: positioned.length,
      distinct_classes: new Set(buildings.map((b) => b.class_name)).size,
      distinct_yaw_degrees: distinctYaws,
      non_yaw_only_buildings: buildings.filter((b) => !b.yaw_only).length,
    },
    pivot_extent: extent,
    class_paths: classPathIndex(entities),
    machine_groups: machineGroups,
    throughput_check: checkDeclaredThroughput(declaredIo, machineGroups),
    connection_topology: decodeBlueprintConnectionTopology(objects, {
      maximumConnections: OFFLINE_TOPOLOGY_LIMIT,
    }),
    power_wire_topology: decodeBlueprintPowerWireTopology(objects, {
      maximumPowerWires: OFFLINE_TOPOLOGY_LIMIT,
    }),
    buildings,
    coordinate_note:
      "Positions are blueprint-local, taken from the saved pivot of each buildable. They are not world coordinates and are not collision or visual extents. grid_cells is position_cm divided by the 800 cm foundation cell.",
    source: "decoded_from_saved_native_blueprint",
    certainty: "authoritative_for_decoded_entities",
  };
}
