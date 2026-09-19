/**
 * Composing a sorted storage hub.
 *
 * This is the piece the three preceding contracts existed to make possible: a
 * belt bus feeding a chain of smart splitters, each filtering one item type
 * into its own container, with whatever is unmatched carried on to an overflow
 * container at the end.
 *
 * Why it emits a generated blueprint rather than live placements: a native
 * blueprint export is required to be a standalone commit and is explicitly not
 * undoable, while hundreds of individual placements would fight the undo
 * journal and leave a half-built bus behind on any failure. One file the player
 * stamps is also the only form in which the *sorting* survives -
 * `AFGBuildableSplitterSmart::mSortRules` is a SaveGame property, so filters
 * configured at staging time are serialised into the `.sbp`.
 *
 * Everything here is measured or refused. The splitter's connector topology
 * comes from a captured instance of that exact class, the container and belt
 * from build recipes the save reports as available, the item list from what the
 * world is actually extracting. Nothing is assumed from vanilla values, so a
 * modded splitter with four outputs or a modded container goes through the same
 * code.
 *
 * What this deliberately does not do:
 *
 *   - **Decide belt length or clearance.** Same rule as every other planner
 *     here: the game's hologram is authoritative. This reports the geometry it
 *     wants and the staging step accepts or refuses it.
 *   - **Connect the intake.** The first splitter's input is left free on
 *     purpose. That is where the player belts their own production in after
 *     stamping, and it is why the export's splitter rule requires participation
 *     rather than saturation.
 *   - **Balance rates.** A sorting bus does not need matched throughput the way
 *     a production chain does; a full container backs up its own lane and the
 *     overflow path carries the rest. Belt capacity is reported so an
 *     over-saturated intake is visible, not silently planned around.
 */

import { findBestAvailableBelt, findBuildRecipeForBuilding } from "./base-build.mjs";
import { measureSplitterTopology } from "./routing.mjs";

/** One 8 m build grid cell, in centimetres. */
const GRID_CELL_CM = 800;

/**
 * How far apart consecutive splitters sit along the bus.
 *
 * Two cells rather than one, because each splitter needs a container to either
 * side and a belt run between them. The game validates the real overlap at
 * staging, so this is spacing chosen to be comfortably clear rather than a
 * claim about exact footprints.
 */
const SPLITTER_PITCH_CM = GRID_CELL_CM * 2;

/** Perpendicular offset from the bus centreline to a container row. */
const CONTAINER_OFFSET_CM = GRID_CELL_CM * 2;

function refuse(reason, extra = {}) {
  return { solver: "storage_bus", planned: false, reason, ...extra };
}

function shortName(classPath) {
  return String(classPath ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

/**
 * Every class in the world that behaves like a storage container.
 *
 * Same evidence the fan-out planner uses for a sink: captured inventory slots
 * and no manufacturer block. A manufacturer waiting for a recipe also has no
 * recipe, and belting into one would be wrong.
 */
function capturedContainerClasses(graph) {
  const counts = new Map();
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node?.raw?.manufacturer) continue;
    if (!(Number(node?.inventory_slot_count ?? 0) > 0)) continue;
    const hasFactoryPort = (node?.raw?.connections ?? []).some(
      (connection) => String(connection?.kind ?? "").toLowerCase() === "factory",
    );
    if (!hasFactoryPort) continue;
    const classPath = String(node.class_path ?? "").trim();
    if (!classPath) continue;
    counts.set(classPath, (counts.get(classPath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([class_path, captured]) => ({ class_path, captured }));
}

/**
 * The solid items this save is actually extracting.
 *
 * Read off extractors rather than the whole item catalog, because a hub is
 * built for what the miners produce. An explicit item list overrides it.
 */
function censusExtractedItems(graph) {
  const found = new Map();
  for (const node of graph?.nodes?.values?.() ?? []) {
    const resourceActorId = node?.raw?.extractor?.extractable_resource_actor_id;
    if (!resourceActorId) continue;
    let resourceClass = "";
    for (const candidate of graph?.nodes?.values?.() ?? []) {
      if (candidate.actor_id !== resourceActorId) continue;
      resourceClass = String(candidate?.raw?.resource_class ?? "").trim();
      break;
    }
    if (!resourceClass) continue;
    const entry = found.get(resourceClass) ?? { item_class: resourceClass, extractors: 0 };
    entry.extractors += 1;
    found.set(resourceClass, entry);
  }
  return [...found.values()].sort((a, b) => b.extractors - a.extractors);
}

/**
 * Lay the lanes out across a chain of splitters.
 *
 * With O outputs per splitter, every splitter but the last spends one output
 * carrying the bus onward, so it can serve O-1 lanes. The last splitter has no
 * successor and serves O, the final one of which is the overflow container.
 *
 * The overflow lane is deliberately unfiltered: whatever no rule matched
 * arrives there, which is what stops a full container stalling the whole bus.
 */
function assignLanes(itemCount, outputCount) {
  const perIntermediate = outputCount - 1;
  const splitters = [];
  let remaining = itemCount;
  let index = 0;
  while (remaining > 0 || splitters.length === 0) {
    const isLastPossible = remaining <= outputCount - 1;
    const capacity = isLastPossible ? outputCount - 1 : perIntermediate;
    const take = Math.min(remaining, capacity);
    splitters.push({ index, lanes: take, passes_on: !isLastPossible });
    remaining -= take;
    index += 1;
    if (isLastPossible) break;
  }
  return splitters;
}

export function planStorageBus(graph, args = {}) {
  const {
    splitter_class_path: splitterClassPath = null,
    container_class_path: requestedContainer = null,
    items: requestedItems = null,
    origin_cm: origin = null,
    belt_tier: beltTier = null,
    max_lanes: maxLanes = 16,
  } = args;

  // --- the splitter, measured from a real one -----------------------------
  const topology = measureSplitterTopology(graph, splitterClassPath);
  if (!topology?.resolved) {
    return refuse(
      topology?.reason ??
        "give splitter_class_path for a smart splitter you have already built, so its connectors can be measured",
      {
        missing: topology?.missing ?? ["splitter_class_path"],
        note:
          "A sorting bus needs a smart or programmable splitter. Build one anywhere first: its connector " +
          "topology is measured from the captured instance rather than assumed.",
      },
    );
  }
  const outputCount = Number(topology.output_capacity ?? 0);
  if (!(outputCount >= 2)) {
    return refuse("the measured splitter has fewer than two outputs, so it cannot sort", {
      measured_outputs: outputCount,
    });
  }

  const splitterBuild = findBuildRecipeForBuilding(graph, splitterClassPath);
  if (!splitterBuild) {
    return refuse("no build recipe produces that splitter in this save", {
      splitter_class_path: splitterClassPath,
    });
  }
  if (!splitterBuild.available) {
    return refuse("that splitter is not unlocked yet, so a bus using it cannot be built", {
      splitter_class_path: splitterClassPath,
      recipe: splitterBuild.name,
      missing: ["unlocked_splitter_recipe"],
    });
  }

  // --- the container ------------------------------------------------------
  const containerCandidates = capturedContainerClasses(graph);
  const containerClassPath = requestedContainer ?? containerCandidates[0]?.class_path ?? null;
  if (!containerClassPath) {
    return refuse(
      "no storage container is captured in this world, so none can be measured or priced",
      { missing: ["captured_storage_container"] },
    );
  }
  const containerBuild = findBuildRecipeForBuilding(graph, containerClassPath);
  if (!containerBuild) {
    return refuse("no build recipe produces that storage container in this save", {
      container_class_path: containerClassPath,
    });
  }
  if (!containerBuild.available) {
    return refuse("that storage container is not unlocked yet", {
      container_class_path: containerClassPath,
      recipe: containerBuild.name,
      missing: ["unlocked_container_recipe"],
    });
  }

  // --- the belt -----------------------------------------------------------
  const belt = findBestAvailableBelt(graph, { tier: beltTier });
  if (!belt) {
    return refuse("no unlocked conveyor belt was found, so the bus cannot be linked", {
      missing: ["unlocked_conveyor_recipe"],
    });
  }

  // --- what to sort -------------------------------------------------------
  const census = censusExtractedItems(graph);
  const items = (
    Array.isArray(requestedItems) && requestedItems.length > 0
      ? requestedItems.map((item) => ({ item_class: String(item).trim(), extractors: null }))
      : census
  ).filter((entry) => entry.item_class);

  if (items.length === 0) {
    return refuse(
      "nothing is being extracted in this save and no items were named, so there is nothing to sort",
      { missing: ["items_to_sort"] },
    );
  }
  if (items.length > maxLanes) {
    return refuse("more item types than the requested lane limit", {
      items: items.length,
      max_lanes: maxLanes,
      note: "raise max_lanes, or name the items to sort explicitly.",
    });
  }

  // --- layout -------------------------------------------------------------
  const chain = assignLanes(items.length, outputCount);
  const parts = [];
  const conveyors = [];
  const lanes = [];
  const base = {
    x: Number(origin?.x ?? 0),
    y: Number(origin?.y ?? 0),
    z: Number(origin?.z ?? 0),
  };

  let itemCursor = 0;
  let previousSplitterId = null;
  for (const splitter of chain) {
    const splitterPartId = `splitter_${splitter.index + 1}`;
    const splitterX = base.x + splitter.index * SPLITTER_PITCH_CM;
    // Held by reference. An earlier version reached back with
    // parts[parts.length - 2], which is the splitter only for the first lane -
    // the second lane's rule landed on the first lane's container instead.
    const splitterPart = {
      part_id: splitterPartId,
      role: "splitter",
      recipe_class: splitterBuild.recipe_class,
      relative_location: { x: splitterX, y: base.y, z: base.z },
      yaw: 0,
      sort_rules: [],
    };
    parts.push(splitterPart);

    // The bus carries on from the previous splitter into this one.
    if (previousSplitterId) {
      conveyors.push({
        link_id: `bus_${splitter.index}`,
        recipe_class: belt.recipe_class,
        from_part_id: previousSplitterId,
        to_part_id: splitterPartId,
      });
    }

    // One container per lane this splitter serves, alternating sides so the
    // bus stays walkable down its centre.
    for (let lane = 0; lane < splitter.lanes; lane += 1) {
      const item = items[itemCursor];
      itemCursor += 1;
      const containerPartId = `container_${itemCursor}`;
      const side = lane % 2 === 0 ? 1 : -1;
      parts.push({
        part_id: containerPartId,
        role: "standalone",
        recipe_class: containerBuild.recipe_class,
        relative_location: {
          x: splitterX,
          y: base.y + side * CONTAINER_OFFSET_CM,
          z: base.z,
        },
        yaw: side > 0 ? 90 : 270,
      });
      conveyors.push({
        link_id: `lane_${itemCursor}`,
        recipe_class: belt.recipe_class,
        from_part_id: splitterPartId,
        to_part_id: containerPartId,
      });
      // The rule's output index is positional: the game resolves it against
      // the splitter's own output ordering, which is a runtime cache and not
      // readable from class defaults. Lane order is therefore the contract.
      splitterPart.sort_rules.push({
        output_index: lane,
        item_class: item.item_class,
      });
      lanes.push({
        item_class: item.item_class,
        item_name: shortName(item.item_class),
        splitter_part_id: splitterPartId,
        container_part_id: containerPartId,
        output_index: lane,
        extractors_feeding_it: item.extractors,
      });
    }

    previousSplitterId = splitterPartId;
  }

  // --- overflow -----------------------------------------------------------
  //
  // The last splitter's remaining output goes to an unfiltered container.
  // Without it a full lane backs up into the bus and stalls every lane behind
  // it, which is the failure that makes storage buses miserable to debug.
  const overflowPartId = "container_overflow";
  const lastSplitter = parts.findLast?.((part) => part.role === "splitter") ??
    [...parts].reverse().find((part) => part.role === "splitter");
  parts.push({
    part_id: overflowPartId,
    role: "standalone",
    recipe_class: containerBuild.recipe_class,
    relative_location: {
      x: Number(lastSplitter.relative_location.x) + SPLITTER_PITCH_CM,
      y: base.y,
      z: base.z,
    },
    yaw: 0,
  });
  conveyors.push({
    link_id: "lane_overflow",
    recipe_class: belt.recipe_class,
    from_part_id: lastSplitter.part_id,
    to_part_id: overflowPartId,
  });

  // Splitters that ended up with no rules carry an even split, which is legal
  // but not what was asked for; drop the empty array so the contract reads as
  // "unfiltered" rather than "filtered with nothing".
  for (const part of parts) {
    if (part.role === "splitter" && part.sort_rules.length === 0) delete part.sort_rules;
  }

  return {
    solver: "storage_bus",
    planned: true,
    schema: "aifactory.generated-blueprint/v4",
    lanes,
    overflow: {
      container_part_id: overflowPartId,
      unfiltered: true,
      why: "whatever no rule matched arrives here, so a full lane cannot stall the bus",
    },
    parts,
    conveyors,
    evidence: {
      splitter: {
        class_path: splitterClassPath,
        recipe: splitterBuild.name,
        measured_outputs: outputCount,
        measured_from_instances: topology.measured_from,
        source: topology.source,
      },
      container: {
        class_path: containerClassPath,
        recipe: containerBuild.name,
        captured_instances: containerCandidates[0]?.captured ?? null,
        alternatives: containerCandidates.slice(1, 4).map((entry) => entry.class_path),
      },
      belt: { tier: belt.tier, recipe: belt.recipe_class, name: belt.name },
      items_from: Array.isArray(requestedItems) && requestedItems.length > 0
        ? "explicit_request"
        : "captured_extractors",
    },
    intake: {
      part_id: parts[0].part_id,
      free: true,
      why:
        "the first splitter's input is left free on purpose - that is where you belt your own " +
        "production in after stamping the blueprint",
    },
    unclaimed: [
      "belt length and clearance are decided by the game's hologram, not here",
      "throughput is not balanced; a sorting bus does not require matched rates",
      "the shell around the hub is a separate request - build a storage warehouse here",
    ],
  };
}

/**
 * The plan as one committed `generate_native_blueprint` action.
 *
 * Deliberately a single action. A native blueprint export must be a standalone
 * commit and is explicitly not undoable, so a bus cannot be mixed into a
 * transaction with reversible writes; and the sorting only survives at all
 * because the filters are applied to staged actors and serialised, which is
 * something only this lane does.
 *
 * This adds no authority of its own. Everything downstream still runs: the
 * bridge re-resolves every recipe and item against the captured catalog, the
 * game checks splitter port counts and the sort-rule cap against the captured
 * class, applies the rules and reads them back before serialising, and refuses
 * the whole file if any of it disagrees. A plan that did not compile emits
 * nothing.
 *
 * `buildables` rather than `parts`: that is what the action contract calls the
 * field. The rename lives here so the plan stays readable on its own terms.
 */
export function storageBusActions(plan, { blueprint_name: blueprintName, commit = false } = {}) {
  if (!plan?.planned) return [];
  const name = String(blueprintName ?? "").trim();
  if (!name) return [];

  return [
    {
      action: "generate_native_blueprint",
      blueprint_name: name,
      layout_schema: plan.schema,
      buildables: plan.parts,
      conveyors: plan.conveyors,
      commit,
    },
  ];
}
