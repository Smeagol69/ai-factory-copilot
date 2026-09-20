/**
 * Composing a central hub onto a deck that already exists.
 *
 * This is the piece every other lane was building toward: one call that looks
 * at the world, picks a surface, sizes production against the miners actually
 * running, lays it out at the right height, and emits a single blueprint to
 * stamp.
 *
 * It composes rather than computes. The deck comes from `surveyDecks`, the ore
 * rates and machine counts from `planSupplyDrivenProduction`, the footprints
 * from `measureBuilding` reading the player's own buildings, and the classes
 * from build recipes the save reports available. Nothing here invents a number.
 *
 * ---------------------------------------------------------------------------
 * ONE LINE PER ORE, ONE CONTAINER PER LINE - AND WHY THERE ARE NO FILTERS
 *
 * Sorting exists to separate items that share a belt. Give each production line
 * its own container and nothing ever shares a belt, so a smart splitter would
 * be ceremony: it would also require merging the lines onto one bus first, and
 * a merger is still refused by the generated-blueprint denylist.
 *
 * `plan_storage_bus` remains the right tool when the intake really is mixed -
 * belting an existing shared line in. The hub says which topology it chose, so
 * a missing filter is a reported decision rather than a silent omission.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES
 *
 * No deck, a footprint that will not fit the deck, an ore whose chain does not
 * resolve, a machine whose footprint has never been measured in this world, or
 * a container that is not unlocked. Each refuses by name. The alternative - an
 * approximate hub placed into a wall - is worse than no hub.
 */

import { findBuildRecipeForBuilding } from "./base-build.mjs";
import { measureBuilding } from "./designer.mjs";
import { surveyDecks } from "./site-survey.mjs";
import { censusExtractedSupply, planSupplyDrivenProduction } from "./supply-production.mjs";

/** One 8 m build grid cell, in centimetres. */
const GRID_CELL_CM = 800;

/** Gap left between machines in a row, so a player can walk between them. */
const MACHINE_GAP_CM = 200;

/** Gap between one production line and the next. */
const LINE_GAP_CM = 800;

/** How far a line's storage container sits beyond its last machine. */
const CONTAINER_GAP_CM = 600;

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * The obvious thing to make from an ore, when the player did not say.
 *
 * Without this the composer asked the supply planner for a product it had not
 * been given and every line was skipped - "build me a hub" would have refused
 * on a world that was perfectly buildable.
 *
 * "Obvious" is defined narrowly and reported: an available recipe that consumes
 * this ore, has the fewest ingredients (so smelting beats alloying), and is not
 * an alternate. Anything less clear-cut is left to the player to name.
 */
function defaultProductFor(graph, oreClass) {
  const candidates = [];
  for (const recipe of graph?.snapshot?.content?.recipes ?? []) {
    if (recipe.available !== true) continue;
    const ingredients = recipe.ingredients ?? [];
    if (!ingredients.some((entry) => String(entry?.item_class ?? "") === String(oreClass))) continue;
    // A build recipe makes a building, not a part.
    if ((recipe.produced_in ?? []).some((entry) => String(entry).includes("BuildGun"))) continue;
    const product = (recipe.products ?? [])[0];
    if (!product?.item_class) continue;
    candidates.push({
      recipe,
      product_class: product.item_class,
      ingredient_count: ingredients.length,
      is_alternate: /alternate/i.test(String(recipe.name ?? "")),
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      Number(a.is_alternate) - Number(b.is_alternate) ||
      a.ingredient_count - b.ingredient_count ||
      String(a.recipe.name ?? "").localeCompare(String(b.recipe.name ?? "")),
  );
  return candidates[0];
}

function refuse(reason, extra = {}) {
  return { solver: "central_hub", composed: false, reason, ...extra };
}

/** The deck to build on: the one asked for, else the largest that fits nearby. */
function chooseDeck(graph, { deckId, center, radiusM }) {
  const survey = surveyDecks(graph, {
    ...(center ? { center_cm: center } : {}),
    ...(center && radiusM ? { radius_m: radiusM } : {}),
  });
  if (survey.deck_count === 0) {
    return { survey, deck: null };
  }
  if (deckId) {
    return { survey, deck: survey.decks.find((entry) => entry.deck_id === deckId) ?? null };
  }
  // Largest first is already the survey's order, and largest is the right
  // default: a hub that does not fit is the failure this is trying to avoid.
  return { survey, deck: survey.decks[0] };
}

/**
 * The machine class a production step runs in, measured in this world.
 *
 * `produced_in` names the machine; `measureBuilding` reads its real footprint
 * from the player's own captured buildings. A machine never built here has no
 * measured footprint, and guessing one would place a row that overlaps.
 */
function resolveMachine(graph, step) {
  const producedIn = step?.produced_in ?? [];
  const footprint = measureBuilding(graph, producedIn);
  if (!footprint?.class_path || !finite(footprint.width_cm) || !finite(footprint.depth_cm)) {
    return {
      resolved: false,
      reason: "machine_footprint_has_never_been_measured_in_this_world",
      produced_in: producedIn,
    };
  }
  const build = findBuildRecipeForBuilding(graph, footprint.class_path);
  if (!build) {
    return { resolved: false, reason: "no_build_recipe_produces_that_machine", class_path: footprint.class_path };
  }
  if (!build.available) {
    return { resolved: false, reason: "machine_is_not_unlocked", class_path: footprint.class_path };
  }
  return { resolved: true, footprint, build };
}

export function composeCentralHub(graph, args = {}) {
  const {
    center_cm: center = null,
    radius_m: radiusM = null,
    deck_id: deckId = null,
    items: requestedItems = null,
    max_lines: maxLines = 6,
    container_class_path: requestedContainer = null,
  } = args;

  // --- where ---------------------------------------------------------------
  const { survey, deck } = chooseDeck(graph, { deckId, center, radiusM });
  if (!deck) {
    return refuse(
      deckId
        ? "no deck with that id was found in this survey"
        : "no buildable deck was found, so there is nowhere to put a hub",
      { missing: ["a_foundation_deck"], decks_seen: survey.deck_count, survey_scope: survey.scope },
    );
  }

  // --- what to make --------------------------------------------------------
  const census = censusExtractedSupply(graph);
  if (census.supply.length === 0) {
    return refuse("nothing is being extracted, so a hub would have nothing to process", {
      missing: ["captured_extractors"],
      unresolved_extractors: census.unresolved,
    });
  }

  // --- the container -------------------------------------------------------
  const containerClass =
    requestedContainer ??
    [...(graph?.nodes?.values?.() ?? [])]
      .filter((node) => !node?.raw?.manufacturer)
      .filter((node) => Number(node?.inventory_slot_count ?? 0) > 0)
      .filter((node) =>
        (node?.raw?.connections ?? []).some(
          (connection) => String(connection?.kind ?? "").toLowerCase() === "factory",
        ),
      )
      .map((node) => String(node.class_path ?? "").trim())
      .find(Boolean) ?? null;
  if (!containerClass) {
    return refuse("no storage container is captured in this world, so none can be placed or priced", {
      missing: ["captured_storage_container"],
    });
  }
  const containerBuild = findBuildRecipeForBuilding(graph, containerClass);
  if (!containerBuild?.available) {
    return refuse("the storage container is not unlocked", {
      container_class_path: containerClass,
      missing: ["unlocked_container_recipe"],
    });
  }
  const containerFootprint = measureBuilding(graph, [containerClass]);

  // --- size one line per ore ----------------------------------------------
  const wanted = Array.isArray(requestedItems) && requestedItems.length > 0 ? requestedItems : null;
  const lines = [];
  const skipped = [];

  for (const supply of census.supply) {
    if (lines.length >= maxLines) break;
    // The supply planner needs a named product. When the player did not name
    // one, work out the obvious thing this ore makes rather than skipping it.
    let productClass = wanted ? wanted[lines.length] ?? wanted[0] : null;
    let defaulted = null;
    if (!productClass) {
      defaulted = defaultProductFor(graph, supply.item_class);
      if (!defaulted) {
        skipped.push({
          ore: supply.item_class,
          reason: "no_available_recipe_obviously_consumes_this_ore",
          note: "name the product with `items` to build a line for it anyway.",
        });
        continue;
      }
      productClass = defaulted.product_class;
    }

    const sized = planSupplyDrivenProduction(graph, {
      ore_class: supply.item_class,
      item_class: productClass,
    });
    if (!sized.planned) {
      skipped.push({ ore: supply.item_class, reason: sized.reason });
      continue;
    }
    const plan = sized;
    const step = (plan.chain?.steps ?? [])[0] ?? null;
    if (!step) {
      skipped.push({ ore: supply.item_class, reason: "production_chain_has_no_steps" });
      continue;
    }
    const machine = resolveMachine(graph, step);
    if (!machine.resolved) {
      skipped.push({ ore: supply.item_class, reason: machine.reason, detail: machine });
      continue;
    }
    lines.push({ supply, plan, step, machine, defaulted });
  }

  if (lines.length === 0) {
    return refuse("no extracted ore could be turned into a placeable production line", {
      attempts: skipped,
      available_supply: census.supply.map((entry) => entry.item_name ?? entry.item_class),
      note:
        "name the products explicitly with `items` if the default product for an ore cannot be resolved.",
    });
  }

  // --- lay it out on the deck ---------------------------------------------
  //
  // Lines run along +X, stacked in +Y. Everything sits at the deck's top Z, so
  // the hub stands on the surface rather than inside it.
  const parts = [];
  const conveyors = [];
  const placedLines = [];
  let cursorY = deck.bounds_cm.min_y + GRID_CELL_CM;
  let widestX = 0;

  for (const [index, line] of lines.entries()) {
    const count = Math.max(1, Number(line.step.machines_required ?? 1));
    const width = Number(line.machine.footprint.width_cm);
    const depth = Number(line.machine.footprint.depth_cm);
    const rowLength = count * width + (count - 1) * MACHINE_GAP_CM;
    const lineX = deck.bounds_cm.min_x + GRID_CELL_CM;

    for (let machineIndex = 0; machineIndex < count; machineIndex += 1) {
      parts.push({
        part_id: `line${index + 1}_machine${machineIndex + 1}`,
        role: "machine",
        recipe_class: line.machine.build.recipe_class,
        production_recipe_class: line.step.recipe_class,
        relative_location: {
          x: lineX + machineIndex * (width + MACHINE_GAP_CM),
          y: cursorY,
          z: deck.top_z_cm,
        },
        yaw: 0,
      });
    }

    const containerId = `line${index + 1}_container`;
    parts.push({
      part_id: containerId,
      role: "standalone",
      recipe_class: containerBuild.recipe_class,
      relative_location: {
        x: lineX + rowLength + CONTAINER_GAP_CM,
        y: cursorY,
        z: deck.top_z_cm,
      },
      yaw: 0,
    });

    // Each machine belts into this line's own container. No sorting is needed
    // because nothing shares a belt - see the note at the top of this file.
    for (let machineIndex = 0; machineIndex < count; machineIndex += 1) {
      conveyors.push({
        link_id: `line${index + 1}_out${machineIndex + 1}`,
        recipe_class: null,
        from_part_id: `line${index + 1}_machine${machineIndex + 1}`,
        to_part_id: containerId,
      });
    }

    placedLines.push({
      ore: line.supply.item_name ?? line.supply.item_class,
      ore_class: line.supply.item_class,
      product: line.plan.product?.item_name ?? line.plan.product?.item_class ?? null,
      machines: count,
      machine_class: line.machine.footprint.class_path,
      recipe: line.step.recipe_name ?? line.step.recipe_class,
      product_chosen_by: line.defaulted ? "default_for_this_ore" : "named_by_the_request",
      output_per_minute: line.plan.product?.output_per_minute ?? null,
      ore_consumed_per_minute: line.plan.ore_consumed_per_minute ?? null,
      ore_left_over_per_minute: line.plan.ore_left_over_per_minute ?? null,
      container_part_id: containerId,
      row_length_cm: rowLength,
    });

    widestX = Math.max(widestX, rowLength + CONTAINER_GAP_CM + Number(containerFootprint?.width_cm ?? GRID_CELL_CM));
    cursorY += depth + LINE_GAP_CM;
  }

  // --- does it fit? --------------------------------------------------------
  const usedX = widestX + GRID_CELL_CM * 2;
  const usedY = cursorY - deck.bounds_cm.min_y + GRID_CELL_CM;
  const deckX = deck.bounds_cm.max_x - deck.bounds_cm.min_x;
  const deckY = deck.bounds_cm.max_y - deck.bounds_cm.min_y;
  if (usedX > deckX || usedY > deckY) {
    return refuse("the hub does not fit on this deck", {
      needs_m: { x: Math.round(usedX / 100), y: Math.round(usedY / 100) },
      deck_m: { x: Math.round(deckX / 100), y: Math.round(deckY / 100) },
      deck_id: deck.deck_id,
      note:
        "extend the deck, choose a larger one with deck_id, or reduce max_lines to build part of it now.",
    });
  }

  return {
    solver: "central_hub",
    composed: true,
    schema: "aifactory.generated-blueprint/v4",
    deck: {
      deck_id: deck.deck_id,
      top_z_cm: deck.top_z_cm,
      size_m: deck.size_m,
      pieces: deck.pieces,
      classified_by: deck.classified_by,
      already_standing_on_it: deck.standing_on_it.length,
    },
    lines: placedLines,
    footprint_m: { x: Math.round(usedX / 100), y: Math.round(usedY / 100) },
    parts,
    conveyors,
    topology: {
      sorted: false,
      why:
        "each production line belts into its own container, so nothing shares a belt and no filter is " +
        "needed. Use plan_storage_bus when the intake is genuinely mixed - that is what sorting is for.",
    },
    intake: {
      free: true,
      why: "machine inputs are left free: belt your miners into them after stamping",
    },
    skipped_ores: skipped,
    supply_census: census.supply,
    caveats: [
      "machine footprints are measured from your own buildings; a machine you have never built refuses rather than being guessed",
      "fit is checked against the deck's own bounds, not against what already stands on it - check deck.already_standing_on_it",
      "belt length, clearance and final placement remain the game's decision",
      "nothing is built: this composes a blueprint for you to stamp",
    ],
  };
}

/** The composed hub as one committed `generate_native_blueprint` action. */
export function centralHubActions(plan, { blueprint_name: blueprintName, commit = false } = {}) {
  if (!plan?.composed) return [];
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
