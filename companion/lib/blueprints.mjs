/**
 * Satisfactory blueprint files.
 *
 * A saved blueprint is a pair: `<name>.sbp` holds the header and the object
 * graph, `<name>.sbpcfg` holds the description shown in the build menu. Only the
 * header is decoded here — it carries the designer dimensions, the exact build
 * cost, and the game changelist the blueprint was authored on, which is enough to
 * tell the player what a blueprint costs, whether it fits, and whether it was
 * made for their game version.
 *
 * Layout, verified against two real blueprints authored on different game builds:
 *
 *   u32  save_version          (2)
 *   u32  header_size           (60)
 *   u32  game_changelist       (495413 / 491125)
 *   u32  dimension_x, y, z     (designer size in foundations)
 *   u32  cost_entry_count
 *   u32  reserved              (0)
 *   repeat cost_entry_count:
 *     u32   path_length        (bytes, including the null terminator)
 *     char  item_class_path[path_length]
 *     u32   amount
 *     u32   reserved           (0)
 *
 * The object graph after the cost list is not decoded. Reading it means
 * implementing Satisfactory's save serialiser; `satisfactory-file-parser`
 * already does, and is the intended route when per-building detail is needed.
 */

const SUPPORTED_SAVE_VERSION = 2;
const COST_LIST_OFFSET = 24;
const MAXIMUM_COST_ENTRIES = 512;
const MAXIMUM_PATH_LENGTH = 4096;

function shortName(itemClassPath) {
  const tail = String(itemClassPath).split(".").pop() ?? "";
  return tail.replace(/_C$/, "").replace(/^(Desc|Recipe|Build)_/, "");
}

/** Decodes the `.sbp` header and build cost. Throws only on a malformed file. */
export function parseBlueprintHeader(buffer) {
  if (!buffer || buffer.length < COST_LIST_OFFSET + 8) {
    throw new Error("Blueprint file is too short to contain a header.");
  }

  const saveVersion = buffer.readUInt32LE(0);
  const headerSize = buffer.readUInt32LE(4);
  const gameChangelist = buffer.readUInt32LE(8);
  const dimensions = {
    x: buffer.readUInt32LE(12),
    y: buffer.readUInt32LE(16),
    z: buffer.readUInt32LE(20),
  };

  const entryCount = buffer.readUInt32LE(COST_LIST_OFFSET);
  if (entryCount > MAXIMUM_COST_ENTRIES) {
    throw new Error(`Blueprint declares ${entryCount} cost entries, which is not plausible.`);
  }

  const cost = [];
  let offset = COST_LIST_OFFSET + 8;
  let truncated = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 4 > buffer.length) {
      truncated = true;
      break;
    }
    const pathLength = buffer.readUInt32LE(offset);
    offset += 4;
    if (pathLength === 0 || pathLength > MAXIMUM_PATH_LENGTH || offset + pathLength + 8 > buffer.length) {
      truncated = true;
      break;
    }
    // The stored length includes the trailing null.
    const itemClassPath = buffer.toString("utf8", offset, offset + pathLength - 1);
    offset += pathLength;
    const amount = buffer.readUInt32LE(offset);
    offset += 8;

    cost.push({ item_class: itemClassPath, item_name: shortName(itemClassPath), amount });
  }

  return {
    save_version: saveVersion,
    header_size: headerSize,
    game_changelist: gameChangelist,
    designer_dimensions: dimensions,
    build_cost: cost,
    cost_entry_count_declared: entryCount,
    cost_entries_read: cost.length,
    cost_list_truncated: truncated,
    object_graph_offset: offset,
    object_graph_bytes: Math.max(0, buffer.length - offset),
    object_graph_decoded: false,
    object_graph_note:
      "Per-building layout is not decoded here. Use satisfactory-file-parser for the object graph.",
    supported: saveVersion === SUPPORTED_SAVE_VERSION,
    source: "parsed_from_sbp_header",
    certainty: truncated ? "partial" : "authoritative",
  };
}

/**
 * Recovers the class paths referenced in a blueprint's object graph.
 *
 * The graph is length-prefixed UE data. Fully decoding it means implementing
 * Satisfactory's save serialiser, which this does not attempt — but every object
 * the blueprint references appears as a length-prefixed `/Game/...` string, and
 * those can be recovered exactly by walking valid length prefixes. That yields
 * *what* a blueprint contains, with per-class counts. It does not yield where
 * anything sits: transforms stay unknown and are reported as such.
 */
export function scanBlueprintReferences(buffer, startOffset = 0) {
  const seen = new Map();
  const limit = buffer.length - 8;

  for (let offset = Math.max(0, startOffset); offset < limit; offset += 1) {
    const length = buffer.readUInt32LE(offset);
    if (length < 8 || length > 512 || offset + 4 + length > buffer.length) continue;
    // A UE string field is null-terminated; require it before decoding.
    if (buffer[offset + 4 + length - 1] !== 0) continue;

    const text = buffer.toString("utf8", offset + 4, offset + 4 + length - 1);
    if (!text.startsWith("/Game/") || !/^[\x20-\x7e]+$/.test(text)) continue;

    seen.set(text, (seen.get(text) ?? 0) + 1);
    offset += 3 + length;
  }

  const buildings = [];
  const recipes = [];
  const items = [];
  const other = [];
  for (const [classPath, count] of seen) {
    const tail = classPath.split(".").pop() ?? "";
    const entry = { class_path: classPath, name: shortName(classPath), occurrences: count };
    if (tail.startsWith("Build_")) buildings.push(entry);
    else if (tail.startsWith("Recipe_")) recipes.push(entry);
    else if (tail.startsWith("Desc_")) items.push(entry);
    else other.push(entry);
  }
  const byOccurrence = (a, b) => b.occurrences - a.occurrences;
  buildings.sort(byOccurrence);
  recipes.sort(byOccurrence);

  return {
    buildings,
    recipes,
    items,
    other,
    distinct_building_classes: buildings.length,
    distinct_recipes: recipes.length,
    method: "length_prefixed_class_path_scan_over_the_object_graph",
    certainty: "class_paths_are_exact_counts_are_indicative",
    counts_caveat:
      "Occurrences count how often a class path appears in the graph, which is not necessarily the number of that building placed. Treat it as presence and rough weight, not an exact count.",
    transforms: "not_decoded",
    transforms_note:
      "Positions and rotations require Satisfactory's save serialiser; satisfactory-file-parser implements it.",
  };
}

/** Decodes the `.sbpcfg` description. */
export function parseBlueprintConfig(buffer) {
  if (!buffer || buffer.length < 8) {
    return { description: null, certainty: "unknown" };
  }
  const configVersion = buffer.readUInt32LE(0);
  const length = buffer.readUInt32LE(4);
  if (length === 0 || 8 + length > buffer.length + 1) {
    return { config_version: configVersion, description: null, certainty: "unknown" };
  }
  const end = Math.min(8 + length - 1, buffer.length);
  return {
    config_version: configVersion,
    description: buffer.toString("utf8", 8, end),
    trailing_bytes: Math.max(0, buffer.length - (8 + length)),
    source: "parsed_from_sbpcfg",
    certainty: "authoritative",
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
  const contents = scanContents
    ? scanBlueprintReferences(sbpBuffer, header.object_graph_offset)
    : null;
  return {
    name,
    ...header,
    description: config?.description ?? null,
    has_config: Boolean(sbpcfgBuffer),
    contents,
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
