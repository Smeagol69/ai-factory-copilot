/**
 * Coal power, from a node to a row of burning generators.
 *
 * The request that produced this — "im switching to coal power i want
 * something step 1 to end compact from this node" — had no local route, so it
 * escalated to a paid model, which errored on billing, and sixty-two seconds
 * later the player had a diagnostic dump instead of a power plant. Before that
 * the local model had offered to process coal into "Iron Ingot, Limestone, or
 * Copper Ore", none of which are coal products.
 *
 * None of the real work needs a model. The node is under the crosshair, the
 * miner and generator come out of the save's own catalog by descriptor, and the
 * belts are geometry. What a model was being asked for was the part it is worst
 * at: specific game facts.
 *
 * Two things this deliberately does not do, because the data to do them
 * honestly is not there:
 *
 *   - **It does not size the plant.** A coal generator's burn rate is not in
 *     the snapshot; `AIFactorySnapshot.cpp` captures circuit totals, not
 *     per-generator fuel. So the count comes from the player, and the reply
 *     says so. Hardcoding 15/min would be inventing a number the save could
 *     have contradicted — the exact habit this project exists to break.
 *   - **It does not run water.** Coal generators need it and there is no pipe
 *     support yet. Saying so is the whole point: a plant that looks finished
 *     and never spins up is worse than one that admits what is missing.
 */

/** Miners hold no dimensions in their names, so the kit is resolved by rank. */
const MINER_RANKS = ["miner mk3", "miner mk2", "miner mk1", "miner"];

/**
 * Generators spaced on the foundation grid.
 *
 * Nothing in the snapshot gives a generator's footprint until one exists to
 * measure, so the spacing is stated rather than derived, and the reply reports
 * it. A wrong guess then shows up as a number the player can correct instead of
 * a silent overlap. The game's hologram is still the thing that decides: any
 * placement it refuses comes back named.
 */
const GENERATOR_SPACING_CELLS = 2;

function resolveFirst(graph, lookup, candidates) {
  for (const building of candidates) {
    const found = lookup(graph, { building });
    if (found?.resolved) return found;
  }
  return null;
}

/**
 * How a node's purity scales what a miner pulls out of it.
 *
 * Written down here, in one place, and reported in the reply, because it is the
 * one number in this file the snapshot does not supply. Every other rate comes
 * from `building_stats`, which the mod reads off the class default object. If
 * this table is ever wrong the reply says which multiplier it used, so it shows
 * up as a number to correct rather than a silently wrong plant.
 */
const PURITY_MULTIPLIER = { impure: 0.5, normal: 1, pure: 2 };

function statsFor(graph, recipeClass) {
  for (const recipe of graph?.snapshot?.content?.recipes ?? []) {
    if (recipe.class_path === recipeClass) return recipe.building_stats ?? null;
  }
  return null;
}

/**
 * How many generators one node keeps fed, or null when the save cannot say.
 *
 * The owner's objection was that the copilot knows the node purity and the tech
 * tier, so it should not have to ask. It should not, and now it does not --
 * once the mod ships `building_stats`. Until then this returns null and the
 * question stands, which is the honest state rather than a guess.
 */
export function sizeGeneratorsForNode(graph, { miner, generator, purity, fuel_item_class: fuelClass }) {
  const minerStats = statsFor(graph, miner?.recipe_class);
  const generatorStats = statsFor(graph, generator?.recipe_class);

  const perMinuteAtNormal = Number(minerStats?.items_per_minute_at_normal_purity);
  const multiplier = PURITY_MULTIPLIER[String(purity ?? "normal").toLowerCase()];
  if (!Number.isFinite(perMinuteAtNormal) || perMinuteAtNormal <= 0) return null;
  if (!Number.isFinite(multiplier)) return null;

  // The generator burns whichever of its fuels this node actually produces.
  const fuels = Array.isArray(generatorStats?.fuels) ? generatorStats.fuels : [];
  const burning = fuelClass
    ? fuels.find((entry) => String(entry.item_class) === String(fuelClass))
    : fuels[0];
  const burnPerMinute = Number(burning?.items_per_minute_at_full_load);
  if (!Number.isFinite(burnPerMinute) || burnPerMinute <= 0) return null;

  const mined = perMinuteAtNormal * multiplier;
  // Whole generators only, and never more than the coal actually supports: a
  // starved generator stutters the whole circuit rather than running slower.
  const count = Math.floor(mined / burnPerMinute);
  if (count < 1) return null;

  return {
    count,
    mined_per_minute: mined,
    burn_per_minute: burnPerMinute,
    purity: purity ?? "normal",
    purity_multiplier: multiplier,
    leftover_per_minute: Math.round((mined - count * burnPerMinute) * 100) / 100,
    power_mw: Number(generatorStats?.power_production_mw) * count || null,
    water_per_minute:
      generatorStats?.requires_supplemental_resource === true
        ? Number(generatorStats?.supplemental_per_minute) * count || null
        : null,
  };
}

/**
 * A miner on the node, generators beside it, belts between.
 *
 * `lookup` and `cell_size_cm` are injected so this stays arithmetic over the
 * catalog rather than another module that reaches for the graph's internals.
 */
export function planCoalPower(graph, args = {}) {
  const {
    node = null,
    generator_count: requestedCount = null,
    build_recipe_lookup: lookup = null,
    belt = null,
    cell_size_cm: cellSize = 800,
    spacing_cells: spacingCells = GENERATOR_SPACING_CELLS,
  } = args;

  if (typeof lookup !== "function") {
    return { solver: "coal_power", planned: false, reason: "no build-recipe lookup was provided" };
  }
  if (!belt?.recipe_class) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no conveyor belt is unlocked in this save, so nothing can carry the coal",
    };
  }
  if (!node?.location) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no resource node was resolved to mine from",
    };
  }
  if (node.node_type === "Deposit") {
    return {
      solver: "coal_power",
      planned: false,
      reason: `${node.on} is a hand-mined deposit, not a node a miner can sit on`,
    };
  }
  if (node.occupied) {
    return {
      solver: "coal_power",
      planned: false,
      reason: `${node.on} already has something on it`,
    };
  }

  const miner = resolveFirst(graph, lookup, MINER_RANKS);
  if (!miner) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no miner is unlocked in this save",
    };
  }

  const generator = resolveFirst(graph, lookup, ["coal generator", "coal-powered generator"]);
  if (!generator) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no coal generator is unlocked in this save",
    };
  }

  // Work it out when the save can say, and only ask when it cannot.
  const sized = Number.isInteger(requestedCount) && requestedCount > 0
    ? null
    : sizeGeneratorsForNode(graph, {
        miner,
        generator,
        purity: node.purity,
        fuel_item_class: node.resource_class ?? null,
      });

  const count = Number.isInteger(requestedCount) && requestedCount > 0
    ? Math.min(requestedCount, 8)
    : (sized?.count ?? null);
  if (count === null) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "how many generators?",
      // Not a shrug: the rates that would answer this are not in this
      // snapshot, so the player is the only authority on it here. Once the mod
      // ships building_stats the question stops being asked.
      why_unknown:
        "A coal generator's fuel rate is not in this snapshot, so the number " +
        "one node supports cannot be worked out yet. Say how many you want — " +
        'for example "coal power here with 4 generators".',
      miner: miner.name,
      generator: generator.name,
    };
  }

  // The row runs off the node along +X, clear of the miner itself.
  const step = cellSize * spacingCells;
  const origin = node.location;
  const generators = [];
  for (let index = 0; index < count; index += 1) {
    generators.push({
      action: "place_building",
      recipe_class: generator.recipe_class,
      location: {
        x: origin.x + step * (index + 1),
        y: origin.y,
        z: origin.z,
      },
      yaw: 0,
      commit: true,
    });
  }

  const minerAction = {
    action: "place_building",
    recipe_class: miner.recipe_class,
    location: { x: origin.x, y: origin.y, z: origin.z },
    yaw: 0,
    // The node itself. A downward trace finds the terrain mesh beside it, which
    // puts the miner in the right place bound to nothing and refuses.
    ...(node.actor_id ? { target_actor_id: node.actor_id } : {}),
    commit: true,
  };

  // A miner has one output port. Belting it straight to four generators would
  // be refused three times over, so the coal goes through a splitter spine:
  // each splitter feeds its own generator and passes the rest along, and the
  // last one carries the tail and feeds two.
  const splitters = [];
  if (count > 1) {
    const splitter = resolveFirst(graph, lookup, ["conveyor splitter", "splitter"]);
    if (!splitter) {
      return {
        solver: "coal_power",
        planned: false,
        reason:
          "more than one generator needs a splitter to share the coal, and none " +
          "is unlocked in this save",
      };
    }
    for (let index = 0; index < count - 1; index += 1) {
      splitters.push({
        action: "place_building",
        recipe_class: splitter.recipe_class,
        // A row parallel to the generators, one cell back toward the miner.
        location: {
          x: origin.x + step * (index + 1),
          y: origin.y - cellSize,
          z: origin.z,
        },
        yaw: 0,
        commit: true,
      });
    }
  }

  // Belts refer to the steps that create their endpoints, so the whole plan
  // goes in as one transaction and the game resolves the actors it just made.
  // Steps are 1-based and refer backwards only: miner is 1, generators are
  // 2..count+1, splitters follow.
  const minerStep = 1;
  const generatorStep = (index) => index + 2;
  const splitterStep = (index) => count + 2 + index;

  const belts = [];
  const beltBetween = (fromStep, toStep) => {
    belts.push({
      action: "place_belt",
      recipe_class: belt.recipe_class,
      from_step: fromStep,
      to_step: toStep,
      commit: true,
    });
  };

  if (count === 1) {
    beltBetween(minerStep, generatorStep(0));
  } else {
    beltBetween(minerStep, splitterStep(0));
    for (let index = 0; index < count - 1; index += 1) {
      beltBetween(splitterStep(index), generatorStep(index));
      if (index < count - 2) beltBetween(splitterStep(index), splitterStep(index + 1));
    }
    beltBetween(splitterStep(count - 2), generatorStep(count - 1));
  }

  return {
    solver: "coal_power",
    planned: true,
    node: node.on,
    miner: miner.name,
    generator: generator.name,
    generator_count: count,
    // Present only when the count was worked out rather than asked for, so the
    // reply can show its arithmetic instead of asserting a number.
    sizing: sized ?? null,
    splitter_count: splitters.length,
    belt: belt.name ?? null,
    spacing_cells: spacingCells,
    spacing_cm: step,
    actions: [minerAction, ...generators, ...splitters, ...belts],
    missing: {
      water:
        "Coal generators need water as well as coal, and there is no pipe " +
        "support yet, so nothing here runs water to them. Run it yourself and " +
        "the plant will start.",
    },
    unverified:
      "Spacing is stated, not measured — no generator exists in this save to " +
      "measure. The game refuses any placement that does not fit and names it.",
  };
}
