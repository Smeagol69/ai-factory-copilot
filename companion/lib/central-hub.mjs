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
import { measureSplitterTopology } from "./routing.mjs";
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

/**
 * A splitter class captured in this world, with its connector count measured.
 *
 * Any splitter will do for balancing - no filters are involved - so this takes
 * whichever class the player actually has, rather than demanding a specific
 * one. Without a captured splitter there is nothing to measure and the line
 * keeps free machine inputs; that is reported rather than refused, because a
 * hub with a manual intake is still worth building.
 */
function findBalancerSplitter(graph) {
  const seen = new Set();
  for (const node of graph?.nodes?.values?.() ?? []) {
    const classPath = String(node?.class_path ?? "");
    if (!/splitter/i.test(classPath) || seen.has(classPath)) continue;
    seen.add(classPath);
    const topology = measureSplitterTopology(graph, classPath);
    if (!topology?.resolved) continue;
    const outputs = Number(topology.output_capacity ?? 0);
    if (!(outputs >= 2)) continue;
    const build = findBuildRecipeForBuilding(graph, classPath);
    if (!build?.available) continue;
    return { class_path: classPath, outputs, build, measured_from: topology.measured_from };
  }
  return null;
}

/**
 * Split one incoming belt evenly across `machineIds`, as a tree.
 *
 * A manifold - a chain where each splitter drops one machine and passes the
 * rest on - is simpler, but it only balances once every buffer has filled,
 * which is why a fresh one looks broken for the first ten minutes. A tree
 * divides evenly from the first item.
 *
 * Recursion: give each of the measured outputs an equal share of the machines.
 * A share of one gets the machine directly; a larger share gets another
 * splitter and recurses. Shares differ by at most one when the count does not
 * divide evenly, which is the closest an integer split can come.
 *
 * Appends parts and conveyors, and returns the root splitter's part id - the
 * line's single intake.
 */
function buildBalancer({ splitter, machineIds, linePrefix, origin, parts, conveyors, counter }) {
  if (machineIds.length <= 1) return null;

  const split = (ids, depth, branch) => {
    const partId = `${linePrefix}_split${counter.next++}`;
    parts.push({
      part_id: partId,
      role: "splitter",
      recipe_class: splitter.build.recipe_class,
      relative_location: {
        x: origin.x - (depth + 1) * GRID_CELL_CM,
        y: origin.y + branch * GRID_CELL_CM,
        z: origin.z,
      },
      yaw: 0,
    });

    // Equal shares, differing by at most one.
    const shares = [];
    const per = Math.floor(ids.length / splitter.outputs);
    let spare = ids.length % splitter.outputs;
    let cursor = 0;
    for (let index = 0; index < splitter.outputs && cursor < ids.length; index += 1) {
      const take = per + (spare > 0 ? 1 : 0);
      if (spare > 0) spare -= 1;
      if (take <= 0) continue;
      shares.push(ids.slice(cursor, cursor + take));
      cursor += take;
    }

    for (const [index, share] of shares.entries()) {
      if (share.length === 1) {
        conveyors.push({
          link_id: `${partId}_to_${share[0]}`,
          recipe_class: null,
          from_part_id: partId,
          to_part_id: share[0],
        });
        continue;
      }
      const childId = split(share, depth + 1, branch + index);
      conveyors.push({
        link_id: `${partId}_to_${childId}`,
        recipe_class: null,
        from_part_id: partId,
        to_part_id: childId,
      });
    }
    return partId;
  };

  return split(machineIds, 0, 0);
}

/** How far below a deck's underside the distribution layer sits. */
const SERVICE_DROP_CM = 400;

/**
 * Where the balancer splitters go.
 *
 * Under the deck when that space is real, which is how a good base is built:
 * distribution runs beneath, the walking surface stays clear, and belts rise
 * where they meet a machine. Belt paths themselves are not ours to place - a
 * blueprint carries links and the game draws each spline - so the level is
 * expressed by where the splitters sit.
 *
 * Refused by default when the space is merely *unoccupied*. `describeUnderside`
 * measures clearance against structures and will not guess ground height, so an
 * unblocked underside may equally be open air or solid rock. Dropping splitters
 * into that on every deck would be the exact failure that separation exists to
 * prevent, so it needs either an explicit request or a structure below proving
 * the gap is real.
 */
function resolveServiceLevel(deck, requested) {
  const underside = deck?.underside ?? null;
  if (!underside) {
    return { z: deck.top_z_cm, used: false, why: "this deck reports no underside" };
  }
  const measured = Number(underside.structural_clearance_cm);
  const provenGap = Number.isFinite(measured) && measured > SERVICE_DROP_CM + 200;

  if (requested === false) {
    return { z: deck.top_z_cm, used: false, why: "a service level was not asked for" };
  }
  if (!provenGap && requested !== true) {
    return {
      z: deck.top_z_cm,
      used: false,
      why:
        "nothing is built under this deck, but ground height is unknown here, so the space may be " +
        "open air or solid rock. Pass service_level true to place the distribution below anyway.",
    };
  }
  return {
    z: deck.underside.bottom_z_cm - SERVICE_DROP_CM,
    used: true,
    why: provenGap
      ? `${underside.structural_clearance_m} m of measured space below this deck`
      : "requested explicitly; the space below is unoccupied but its ground is unknown",
    proven: provenGap,
  };
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
    service_level: requestedServiceLevel = null,
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
  // Any splitter will do - balancing involves no filters - so this takes
  // whichever class the world actually has. Without one, lines keep free
  // machine inputs and say so.
  const splitter = findBalancerSplitter(graph);
  const service = resolveServiceLevel(deck, requestedServiceLevel);
  const splitCounter = { next: 1 };
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

    // Split the incoming ore evenly across this line's machines. Without this
    // only the first machine is ever fed, which makes a correctly sized line
    // look broken.
    const machineIds = Array.from(
      { length: count },
      (unused, machineIndex) => `line${index + 1}_machine${machineIndex + 1}`,
    );
    const balancerRoot = splitter
      ? buildBalancer({
          splitter,
          machineIds,
          linePrefix: `line${index + 1}`,
          origin: { x: lineX, y: cursorY, z: service.z },
          parts,
          conveyors,
          counter: splitCounter,
        })
      : null;

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
      intake_part_id: balancerRoot ?? (count === 1 ? machineIds[0] : null),
      balanced: Boolean(balancerRoot) || count === 1,
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
      already_standing_on_it: deck.standing_on_it?.total ?? 0,
    },
    lines: placedLines,
    footprint_m: { x: Math.round(usedX / 100), y: Math.round(usedY / 100) },
    parts,
    conveyors,
    service_level: {
      used: service.used,
      z_cm: service.z,
      deck_top_z_cm: deck.top_z_cm,
      why: service.why,
      what_sits_there: service.used
        ? "the balancer splitters; machines and containers stay on the deck, so belts rise to meet them"
        : "nothing - everything is on the deck",
    },
    balancing: splitter
      ? {
          balanced: true,
          splitter_class: splitter.class_path,
          measured_outputs: splitter.outputs,
          measured_from_instances: splitter.measured_from,
          method:
            "a balanced tree, not a manifold: a manifold only evens out once every buffer has " +
            "filled, so a fresh one looks broken for the first ten minutes",
        }
      : {
          balanced: false,
          why:
            "no splitter is captured in this world, so none could be measured. Each machine keeps a " +
            "free input - build one splitter anywhere and ask again to have the ore split for you.",
          missing: ["captured_splitter"],
        },
    topology: {
      sorted: false,
      why:
        "each production line belts into its own container, so nothing shares a belt and no filter is " +
        "needed. Use plan_storage_bus when the intake is genuinely mixed - that is what sorting is for.",
    },
    intake: {
      free: true,
      per_line: placedLines.map((line) => ({ ore: line.ore, intake_part_id: line.intake_part_id })),
      why: splitter
        ? "belt your miners into each line's intake_part_id after stamping; the tree behind it splits the ore evenly"
        : "belt your miners into each machine after stamping - nothing here splits the ore, see balancing",
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
