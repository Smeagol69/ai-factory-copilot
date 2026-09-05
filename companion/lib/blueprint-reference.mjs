/**
 * A curated library of human-authored blueprints, kept as measured facts.
 *
 * The planner already reads the player's own saved blueprints at runtime
 * (`list_blueprints`, `inspect_blueprint_layout`). That is live evidence and it
 * disappears when the bridge is not pointed at a blueprint folder. This module
 * is the other half: a small, versioned set of reference designs that ship with
 * the project so the Architect has worked examples of how people actually build
 * even when no save is attached.
 *
 * Everything here is derived from `inspectBlueprintStructure`, which decodes the
 * pinned read-only serializer. Nothing in a catalog entry is recalled or
 * estimated. The one exception is `declared_io`, which is parsed out of the
 * author's own free-text description and is therefore an author claim, not a
 * decoded fact - it is labelled that way in the record and must never be used as
 * a rate the planner trusts. Rates come from `content.recipes`, as always.
 *
 * The reason this library exists at all is a measurement. Across the first seven
 * designer blueprints, production machines were 24 of 890 placed buildings -
 * 2.7% - while enclosure was 63.7%. A planner that emits machines and belts is
 * not building a smaller version of these designs; it is building a different
 * kind of object. The role census below is what makes that difference visible to
 * the model.
 */

export const REFERENCE_CATALOG_VERSION = "aifactory.blueprint-reference/v1";

/**
 * Buildable roles. `unclassified` is a real bucket and is always reported: a
 * silently absorbed class would understate the vocabulary a reference uses.
 */
export const BUILDABLE_ROLES = Object.freeze([
  "production",
  "logistics",
  "power",
  "enclosure",
  "access",
  "signage",
  "ambience",
  "utility",
  "unclassified",
]);

// Ordered. The first matching pattern wins, so narrow rules sit above broad
// ones: `ConveyorPoleWall` is logistics even though `Wall` looks like enclosure,
// while `Wall_Concrete_8x4_ConveyorHole_01` is enclosure even though a belt
// passes through it.
const ROLE_RULES = Object.freeze([
  [/^(Constructor|Assembler|Manufacturer|Smelter|Foundry|Refinery|Packager|Blender|HadronCollider|QuantumEncoder|Converter|ParticleAccelerator)/i, "production"],
  [/^(MinerMk|OilPump|WaterPump|FrackingSmasher|FrackingExtractor|ResourceSink|ResourceWell)/i, "production"],
  [/^Generator/i, "power"],
  [/^(PowerLine|PowerPole|PowerSwitch|PriorityPowerSwitch|PowerTower|PowerStorage|Battery)/i, "power"],
  [/^(ConveyorPole|ConveyorCeilingAttachment|ConveyorWallHole|ConveyorAttachment|ConveyorBelt|ConveyorLift)/i, "logistics"],
  [/^(Pipe|PipelinePump|PipelineJunction|PipeStorage|IndustrialTank|Valve|Hypertube)/i, "logistics"],
  [/^(Storage|StackableShelf|DronePort|Drone|TruckStation|Train|RailroadTrack|RailroadSwitch|Locomotive|FreightWagon|FoundationPassthrough)/i, "logistics"],
  [/^(StandaloneWidgetSign|SignPole|Billboard)/i, "signage"],
  [/^(BlueprintDesigner|Workshop|Mam|RadarTower|Portal|TradingPost|HubTerminal|SpaceElevator)/i, "utility"],
  [/^(Catwalk|Walkway|Ladder|Stair|Railing|ChainLinkFence|Gate_|Door|JumpPad|Escalator|Elevator|BP_Elevator)/i, "access"],
  [/^(Foundation|Wall|SteelWall|ConcreteWall|Ramp|InvertedRamp|QuarterPipe|Pillar|Beam|Roof|Frame|Fence)/i, "enclosure"],
  [/^(Light|Flood|Fan|LargeFan|Speaker|Decoration|Statue|Flower|Tree|Lamp)/i, "ambience"],
]);

/**
 * The role a class falls into, by its `Build_*_C` basename. Returns
 * `unclassified` rather than guessing, so an unfamiliar modded class stays
 * visible in the census instead of inflating a bucket it does not belong to.
 */
export function classifyBuildable(className) {
  const name = String(className ?? "").trim();
  if (!name) return "unclassified";
  for (const [pattern, role] of ROLE_RULES) {
    if (pattern.test(name)) return role;
  }
  return "unclassified";
}

function emptyRoleCensus() {
  const census = {};
  for (const role of BUILDABLE_ROLES) census[role] = 0;
  return census;
}

/**
 * Counts by role across `[{ class_name, count }]` entries, plus each role's
 * share of the total. Shares are rounded to four decimals so a regenerated
 * catalog does not churn on float noise.
 */
export function censusByRole(buildableClasses) {
  const counts = emptyRoleCensus();
  const unclassifiedClasses = [];
  let total = 0;
  for (const entry of buildableClasses ?? []) {
    const count = Number(entry?.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const role = classifyBuildable(entry?.class_name);
    counts[role] += count;
    total += count;
    if (role === "unclassified") unclassifiedClasses.push(String(entry?.class_name ?? ""));
  }
  const share = {};
  for (const role of BUILDABLE_ROLES) {
    share[role] = total > 0 ? Math.round((counts[role] / total) * 10000) / 10000 : 0;
  }
  return {
    total_buildables: total,
    counts,
    share,
    unclassified_classes: unclassifiedClasses.sort(),
  };
}

const IO_LINE = /^\s*(input|output)\s*:?\s*(.*)$/i;
const IO_QUANTITY = /^\s*([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s*$/;

/**
 * Pulls input/output claims out of an author's description.
 *
 * These descriptions are free text ("Input:    120 Iron ore"), sometimes with a
 * continuation line carrying a second input. This reads what it can and keeps
 * the raw string alongside. It is an author claim: a parsed rate must never be
 * used as a verified throughput.
 */
export function parseDeclaredIo(description) {
  const raw = String(description ?? "");
  const inputs = [];
  const outputs = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const labelled = IO_LINE.exec(line);
    const body = labelled ? labelled[2] : line;
    if (labelled) current = labelled[1].toLowerCase() === "input" ? inputs : outputs;
    if (!current) continue;
    const quantity = IO_QUANTITY.exec(body);
    if (!quantity) continue;
    current.push({
      amount_per_minute: Number(quantity[1]),
      item_label: quantity[2].replace(/\s+/g, " ").trim(),
    });
  }
  return {
    raw_description: raw,
    inputs,
    outputs,
    evidence: "author_supplied_description_text",
    caveat:
      "Parsed from the blueprint author's own description. It is a claim about the design, not a decoded or simulated rate. Verify against content.recipes before planning to it.",
  };
}

const FOUNDATION_CELL_CM = 800;

/**
 * One catalog entry from a successful `inspectBlueprintStructure` result.
 */
export function summarizeReference(
  inspection,
  { id, kind = "unknown", author = null, notes = null } = {},
) {
  if (!inspection?.available) {
    throw new Error(
      `reference blueprint not decodable: ${inspection?.reason ?? "unknown_reason"}`,
    );
  }
  const header = inspection.header ?? {};
  const dims = header.designer_dimensions ?? {};
  const span = inspection.pivot_bounds_cm?.span_cm ?? {};
  const roles = censusByRole(inspection.buildable_classes);
  const classes = (inspection.buildable_classes ?? [])
    .map((entry) => ({
      class_name: entry.class_name,
      count: entry.count,
      role: classifyBuildable(entry.class_name),
    }))
    .sort((a, b) => b.count - a.count || a.class_name.localeCompare(b.class_name));

  return {
    id: id ?? String(inspection.blueprint_name ?? "").trim(),
    name: inspection.blueprint_name ?? null,
    kind,
    author,
    notes,
    authored_on: {
      game_changelist: header.game_changelist ?? null,
      factory_save_custom_version: header.factory_save_custom_version ?? null,
    },
    designer_dimensions: {
      x: dims.x ?? null,
      y: dims.y ?? null,
      z: dims.z ?? null,
    },
    occupied_span_cm: {
      x: span.x ?? null,
      y: span.y ?? null,
      z: span.z ?? null,
    },
    occupied_span_cells: {
      x: Number.isFinite(span.x) ? Math.round((span.x / FOUNDATION_CELL_CM) * 100) / 100 : null,
      y: Number.isFinite(span.y) ? Math.round((span.y / FOUNDATION_CELL_CM) * 100) / 100 : null,
    },
    declared_io: parseDeclaredIo(header.description),
    role_census: roles,
    buildable_classes: classes,
    distinct_buildable_classes: inspection.distinct_buildable_classes ?? classes.length,
    topology: {
      reciprocal_conveyor_pairs:
        inspection.connection_topology?.reciprocal_connection_pair_count ?? null,
      verified_power_wires: inspection.power_wire_topology?.verified_power_wire_count ?? null,
    },
    build_cost: (header.build_cost ?? []).map((cost) => ({
      item_name: cost.item_name,
      amount: cost.amount,
    })),
    source: "decoded_from_saved_native_blueprint",
    certainty: "authoritative_for_decoded_entities",
  };
}

// A blueprint-designer blueprint carries `Build_*_C` asset paths. A world export
// also carries engine classes such as `/Script/FactoryGame.FGBlueprintProxy`,
// which have no asset name to strip.
function classNameFromPath(path) {
  const value = String(path ?? "");
  if (!value) return "";
  const tail = value.slice(value.lastIndexOf("/") + 1);
  if (value.startsWith("/Script/")) return tail.slice(tail.lastIndexOf(".") + 1);
  const asset = tail.split(".")[0];
  return asset.startsWith("Build_") ? asset.slice("Build_".length) : asset;
}

// Placed-blueprint containers, not buildings. Counting them as buildables would
// double-count everything they hold.
const WORLD_EXPORT_PROXY_CLASS = "FGBlueprintProxy";

// The blueprint reader identifies buildables by the native `Build_*_C`
// convention. A world export also contains engine-side actors that are not
// buildings at all, so apply the same test here - otherwise the two ingest paths
// would be counting different populations and the aggregate role census would
// mean nothing.
const NATIVE_BUILDABLE_ASSET = "/Build_";

/**
 * A catalog entry for a whole-world export rather than a designer blueprint.
 *
 * The interactive map exports a base as a flat list of actors with absolute
 * world transforms. There is no designer envelope and no build cost, so those
 * fields stay null rather than being invented; the span is measured from the
 * actor pivots that are present.
 */
export function summarizeWorldExport(
  entries,
  { id, name = null, kind = "base_build", author = null, notes = null, saveVersion = null, buildVersion = null } = {},
) {
  const counts = new Map();
  const swatches = new Map();
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let proxyCount = 0;
  let placedCount = 0;
  let nonBuildableActorCount = 0;

  for (const entry of entries ?? []) {
    const actor = entry?.parent ?? entry;
    const classPath = String(actor?.className ?? "");
    const className = classNameFromPath(classPath);
    if (!className) continue;
    if (className === WORLD_EXPORT_PROXY_CLASS) {
      proxyCount += 1;
      continue;
    }
    if (!classPath.includes(NATIVE_BUILDABLE_ASSET)) {
      nonBuildableActorCount += 1;
      continue;
    }
    placedCount += 1;
    counts.set(className, (counts.get(className) ?? 0) + 1);
    const translation = actor?.transform?.translation;
    if (Array.isArray(translation) && translation.every((n) => Number.isFinite(n))) {
      bounds.minX = Math.min(bounds.minX, translation[0]);
      bounds.maxX = Math.max(bounds.maxX, translation[0]);
      bounds.minY = Math.min(bounds.minY, translation[1]);
      bounds.maxY = Math.max(bounds.maxY, translation[1]);
      bounds.minZ = Math.min(bounds.minZ, translation[2]);
      bounds.maxZ = Math.max(bounds.maxZ, translation[2]);
    }
    const swatch = actor?.customizationData?.SwatchDesc?.pathName;
    if (swatch) {
      const label = classNameFromPath(swatch);
      swatches.set(label, (swatches.get(label) ?? 0) + 1);
    }
  }

  const buildableClasses = [...counts.entries()]
    .map(([class_name, count]) => ({ class_name, count, role: classifyBuildable(class_name) }))
    .sort((a, b) => b.count - a.count || a.class_name.localeCompare(b.class_name));
  const finite = Number.isFinite(bounds.minX);
  const span = finite
    ? {
        x: Math.round(bounds.maxX - bounds.minX),
        y: Math.round(bounds.maxY - bounds.minY),
        z: Math.round(bounds.maxZ - bounds.minZ),
      }
    : { x: null, y: null, z: null };

  return {
    id,
    name,
    kind,
    author,
    notes,
    authored_on: { game_changelist: buildVersion, factory_save_custom_version: saveVersion },
    designer_dimensions: { x: null, y: null, z: null },
    occupied_span_cm: span,
    occupied_span_cells: {
      x: Number.isFinite(span.x) ? Math.round((span.x / FOUNDATION_CELL_CM) * 100) / 100 : null,
      y: Number.isFinite(span.y) ? Math.round((span.y / FOUNDATION_CELL_CM) * 100) / 100 : null,
    },
    declared_io: parseDeclaredIo(""),
    role_census: censusByRole(buildableClasses),
    buildable_classes: buildableClasses,
    distinct_buildable_classes: buildableClasses.length,
    world_export: {
      placed_buildable_count: placedCount,
      blueprint_proxy_count: proxyCount,
      non_buildable_actor_count: nonBuildableActorCount,
      palette: [...swatches.entries()]
        .map(([swatch, count]) => ({ swatch, count }))
        .sort((a, b) => b.count - a.count || a.swatch.localeCompare(b.swatch))
        .slice(0, 12),
      caveat:
        "Blueprint proxies are placed-blueprint containers and are counted separately, not as buildings. Their contents are already present as individual actors.",
    },
    topology: { reciprocal_conveyor_pairs: null, verified_power_wires: null },
    build_cost: [],
    source: "decoded_from_interactive_map_world_export",
    certainty: "authoritative_for_decoded_actors",
  };
}

/**
 * Aggregate vocabulary across the library: which parts real designs reach for,
 * how often, and in how many separate designs. `design_frequency` matters more
 * than raw count when deciding whether a part is idiomatic - one reference that
 * places 154 walls should not outvote a part that five separate designs use.
 */
export function architecturalVocabulary(references) {
  const byClass = new Map();
  for (const reference of references ?? []) {
    for (const entry of reference.buildable_classes ?? []) {
      const existing = byClass.get(entry.class_name) ?? {
        class_name: entry.class_name,
        role: entry.role ?? classifyBuildable(entry.class_name),
        total_count: 0,
        design_frequency: 0,
      };
      existing.total_count += entry.count;
      existing.design_frequency += 1;
      byClass.set(entry.class_name, existing);
    }
  }
  return [...byClass.values()].sort(
    (a, b) =>
      b.design_frequency - a.design_frequency ||
      b.total_count - a.total_count ||
      a.class_name.localeCompare(b.class_name),
  );
}

/**
 * The library-wide role mix. This is the number that tells the Architect a
 * factory is mostly not machines.
 */
export function aggregateRoleCensus(references) {
  const counts = emptyRoleCensus();
  let total = 0;
  for (const reference of references ?? []) {
    for (const role of BUILDABLE_ROLES) {
      const value = Number(reference?.role_census?.counts?.[role] ?? 0);
      if (!Number.isFinite(value)) continue;
      counts[role] += value;
      total += value;
    }
  }
  const share = {};
  for (const role of BUILDABLE_ROLES) {
    share[role] = total > 0 ? Math.round((counts[role] / total) * 10000) / 10000 : 0;
  }
  return { total_buildables: total, counts, share };
}

/**
 * Assembles the committed catalog document.
 */
export function buildReferenceCatalog(references, { generated_from = null } = {}) {
  const list = [...(references ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    catalog_version: REFERENCE_CATALOG_VERSION,
    reference_count: list.length,
    generated_from,
    role_census: aggregateRoleCensus(list),
    vocabulary: architecturalVocabulary(list),
    references: list,
    source: "decoded_from_saved_native_blueprints",
    certainty: "authoritative_for_decoded_entities",
    caveat:
      "Designer dimensions, spans, class counts, costs, and topology counts are decoded. Declared inputs and outputs are author claims parsed from description text. Nothing here proves terrain fit, hologram validity, or that a reference is buildable at a given site.",
  };
}

function matchesText(haystack, needle) {
  return String(haystack ?? "")
    .toLowerCase()
    .includes(String(needle).toLowerCase());
}

/**
 * Query the catalog. Every filter is optional; with none, the whole library
 * comes back in catalog order.
 */
export function findReferenceDesigns(
  catalog,
  { produces, consumes, kind, uses_class, max_cells, limit = 10 } = {},
) {
  let results = [...(catalog?.references ?? [])];
  if (kind) results = results.filter((r) => r.kind === kind);
  if (produces) {
    results = results.filter((r) =>
      (r.declared_io?.outputs ?? []).some((o) => matchesText(o.item_label, produces)),
    );
  }
  if (consumes) {
    results = results.filter((r) =>
      (r.declared_io?.inputs ?? []).some((i) => matchesText(i.item_label, consumes)),
    );
  }
  if (uses_class) {
    results = results.filter((r) =>
      (r.buildable_classes ?? []).some((c) => matchesText(c.class_name, uses_class)),
    );
  }
  if (Number.isFinite(max_cells)) {
    results = results.filter((r) => {
      const { x, y } = r.designer_dimensions ?? {};
      return Number.isFinite(x) && Number.isFinite(y) && x <= max_cells && y <= max_cells;
    });
  }
  const bounded = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return results.slice(0, bounded);
}
