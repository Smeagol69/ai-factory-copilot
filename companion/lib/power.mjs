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
 * Two limits stay explicit because the game data or construction support to
 * solve them honestly is not there:
 *
 *   - **It only sizes from captured class data.** New snapshots carry the
 *     miner's extraction rate and each generator fuel's exact burn rate. Older
 *     snapshots still ask for a count rather than guessing one.
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

function availableBuildingRecipes(graph) {
  return (graph?.snapshot?.content?.recipes ?? []).filter((recipe) =>
    recipe?.available === true && recipe?.building_stats
  );
}

/** Prefer the strongest captured coal generator, including modded tiers. */
function resolveCoalGenerator(graph, node, lookup) {
  const resourceClass = String(node?.resource_class ?? "");
  const resourceName = String(node?.resource_name ?? "").toLowerCase();
  const candidates = availableBuildingRecipes(graph)
    .filter((recipe) => /coal.*generator|generator.*coal/i.test(String(recipe.name ?? "")))
    .filter((recipe) => (recipe.building_stats?.fuels ?? []).some((fuel) =>
      (resourceClass && String(fuel.item_class) === resourceClass) ||
      (resourceName && String(fuel.item_name ?? "").toLowerCase() === resourceName)
    ))
    .sort((left, right) => {
      const power = Number(right.building_stats?.power_production_mw) -
        Number(left.building_stats?.power_production_mw);
      if (Number.isFinite(power) && power !== 0) return power;
      return String(left.class_path).localeCompare(String(right.class_path));
    });
  const [best] = candidates;
  if (best) {
    return {
      resolved: true,
      recipe_class: best.class_path,
      name: best.name,
      owner_mod: best.owner_mod ?? null,
      product_class: best.products?.[0]?.item_class ?? null,
      building_stats: best.building_stats,
      selected_by: "highest_captured_power_tier_compatible_with_resource",
    };
  }
  return resolveFirst(graph, lookup, ["coal generator", "coal-powered generator"]);
}

/** Prefer the fastest captured real extractor rather than a similarly named prop. */
function resolveBestMiner(graph, lookup) {
  const candidates = availableBuildingRecipes(graph)
    .filter((recipe) => {
      const type = String(recipe.building_stats?.extractor_type_name ?? "").trim().toLowerCase();
      if (type) return type === "miner";
      // Compatibility with snapshots captured before extractor_type_name was
      // added. Keep this narrow: a fluid/resource-well extractor's raw cycle
      // amount is in inventory units and can be thousands of times larger.
      return /\bminer\b/i.test(String(recipe.name ?? ""));
    })
    .filter((recipe) => Number(recipe.building_stats?.items_per_minute_at_normal_purity) > 0)
    .sort((left, right) =>
      Number(right.building_stats.items_per_minute_at_normal_purity) -
      Number(left.building_stats.items_per_minute_at_normal_purity)
    );
  const [best] = candidates;
  if (best) {
    return {
      resolved: true,
      recipe_class: best.class_path,
      name: best.name,
      owner_mod: best.owner_mod ?? null,
      product_class: best.products?.[0]?.item_class ?? null,
      building_stats: best.building_stats,
      selected_by: "highest_captured_extraction_tier",
    };
  }
  return resolveFirst(graph, lookup, MINER_RANKS);
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

function purityKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  // The engine sends RP_Inpure (its spelling), while tests and imported data
  // may use either human-readable spelling.
  if (text.includes("inpure") || text.includes("impure")) return "impure";
  if (text.includes("normal")) return "normal";
  if (text.endsWith("pure")) return "pure";
  return null;
}

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
export function sizeGeneratorsForNode(graph, {
  miner,
  generator,
  purity,
  fuel_item_class: fuelClass,
  extraction_per_minute: capturedExtractionRate = null,
}) {
  const minerStats = statsFor(graph, miner?.recipe_class);
  const generatorStats = statsFor(graph, generator?.recipe_class);

  const perMinuteAtNormal = Number(minerStats?.items_per_minute_at_normal_purity);
  const normalizedPurity = purityKey(purity);
  const multiplier = PURITY_MULTIPLIER[normalizedPurity];
  const directRate = Number(capturedExtractionRate);
  const hasDirectRate = Number.isFinite(directRate) && directRate > 0;
  if (!hasDirectRate && (!Number.isFinite(perMinuteAtNormal) || perMinuteAtNormal <= 0)) return null;
  if (!hasDirectRate && !Number.isFinite(multiplier)) return null;

  // The generator burns whichever of its fuels this node actually produces.
  const fuels = Array.isArray(generatorStats?.fuels) ? generatorStats.fuels : [];
  const burning = fuelClass
    ? fuels.find((entry) => String(entry.item_class) === String(fuelClass))
    : fuels[0];
  const burnPerMinute = Number(burning?.items_per_minute_at_full_load);
  if (!Number.isFinite(burnPerMinute) || burnPerMinute <= 0) return null;

  const mined = hasDirectRate ? directRate : perMinuteAtNormal * multiplier;
  // Whole generators only, and never more than the coal actually supports: a
  // starved generator stutters the whole circuit rather than running slower.
  const count = Math.floor(mined / burnPerMinute);
  if (count < 1) return null;

  const producedPower = Number(generatorStats?.power_production_mw) * count;
  const supplementalRate = Number(generatorStats?.supplemental_per_minute) * count;
  return {
    count,
    mined_per_minute: mined,
    burn_per_minute: burnPerMinute,
    purity: normalizedPurity,
    purity_multiplier: hasDirectRate ? null : multiplier,
    rate_source: hasDirectRate
      ? "authoritative_live_extractor_rate"
      : "captured_class_rate_times_node_purity",
    leftover_per_minute: Math.round((mined - count * burnPerMinute) * 100) / 100,
    power_mw: Number.isFinite(producedPower) && producedPower > 0 ? producedPower : null,
    water_per_minute:
      generatorStats?.requires_supplemental_resource === true
        ? (Number.isFinite(supplementalRate) && supplementalRate > 0 ? supplementalRate : null)
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
    cell_size_cm: cellSize = null,
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
  const origin = {
    x: Number(node.location.x),
    y: Number(node.location.y),
    z: Number(node.location.z),
  };
  if (!Object.values(origin).every(Number.isFinite)) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "the resource node has no complete finite XYZ position",
    };
  }
  const resourceIdentity = `${node.resource_name ?? ""} ${node.resource_class ?? ""}`.toLowerCase();
  if (!resourceIdentity.trim()) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "the aimed node's resource is missing from the snapshot, so coal cannot be assumed",
    };
  }
  if (!resourceIdentity.includes("coal")) {
    return {
      solver: "coal_power",
      planned: false,
      reason: `${node.on} contains ${node.resource_name ?? node.resource_class}, not coal`,
    };
  }
  if (node.node_type === "Deposit") {
    return {
      solver: "coal_power",
      planned: false,
      reason: `${node.on} is a hand-mined deposit, not a node a miner can sit on`,
    };
  }
  const existingExtractorActorId = String(node.existing_extractor_actor_id ?? "").trim();
  const reusesExistingExtractor = Boolean(existingExtractorActorId);
  if (node.occupied && !reusesExistingExtractor) {
    return {
      solver: "coal_power",
      planned: false,
      reason: `${node.on} already has something on it`,
    };
  }

  const miner = reusesExistingExtractor
    ? {
        recipe_class: null,
        name: node.existing_extractor_name ?? "existing extractor",
        building_stats: null,
      }
    : resolveBestMiner(graph, lookup);
  if (!miner) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no miner is unlocked in this save",
    };
  }

  const generator = resolveCoalGenerator(graph, node, lookup);
  if (!generator) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no coal generator is unlocked in this save",
    };
  }

  const compatibleFuels = generator.building_stats?.fuels;
  if (Array.isArray(compatibleFuels) && compatibleFuels.length > 0) {
    const exactFuel = compatibleFuels.some((fuel) =>
      (node.resource_class && fuel.item_class === node.resource_class) ||
      String(fuel.item_name ?? "").toLowerCase() === String(node.resource_name ?? "").toLowerCase()
    );
    if (!exactFuel) {
      return {
        solver: "coal_power",
        planned: false,
        reason: `${generator.name} does not list ${node.resource_name ?? node.resource_class} as a captured fuel`,
      };
    }
  }

  const hasExplicitCount = requestedCount !== null && requestedCount !== undefined;
  const validExplicitCount = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 8;
  if (hasExplicitCount && !validExplicitCount) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "generator_count must be a whole number from 1 through 8",
    };
  }

  // Work it out when the save can say, and only ask when it cannot.
  const sized = validExplicitCount
    ? null
    : sizeGeneratorsForNode(graph, {
        miner,
        generator,
        purity: node.purity,
        fuel_item_class: node.resource_class ?? null,
        extraction_per_minute: reusesExistingExtractor ? node.extraction_per_minute : null,
      });

  if (sized?.count > 8) {
    return {
      solver: "coal_power",
      planned: false,
      reason: `the captured rates size this plant at ${sized.count} generators, above this compact planner's limit of 8`,
      sizing: sized,
    };
  }

  const count = validExplicitCount
    ? requestedCount
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

  const cell = Number(cellSize);
  const spacing = Number(spacingCells);
  if (!Number.isFinite(cell) || cell <= 0) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "no foundation grid was derived from this save, so generator spacing is unknown",
    };
  }
  if (!Number.isInteger(spacing) || spacing < 1 || spacing > 8) {
    return {
      solver: "coal_power",
      planned: false,
      reason: "spacing_cells must be a whole number from 1 through 8",
    };
  }

  // The row runs off the node along +X, clear of the miner itself.
  const step = cell * spacing;
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

  const minerAction = reusesExistingExtractor ? null : {
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
          y: origin.y - cell,
          z: origin.z,
        },
        yaw: 0,
        commit: true,
      });
    }
  }

  // Belts refer to the steps that create their endpoints, so the whole plan
  // goes in as one transaction and the game resolves the actors it just made.
  // Steps are 1-based and refer backwards only. When the crosshair names an
  // existing extractor there is no miner placement step; the first generator
  // is step 1 and the source belt names the captured extractor actor directly.
  const createdMinerSteps = minerAction ? 1 : 0;
  const minerStep = minerAction ? 1 : null;
  const generatorStep = (index) => createdMinerSteps + index + 1;
  const splitterStep = (index) => createdMinerSteps + count + index + 1;

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

  const beltFromExtractor = (toStep) => {
    belts.push({
      action: "place_belt",
      recipe_class: belt.recipe_class,
      ...(reusesExistingExtractor
        ? { from_actor_id: existingExtractorActorId }
        : { from_step: minerStep }),
      to_step: toStep,
      commit: true,
    });
  };

  if (count === 1) {
    beltFromExtractor(generatorStep(0));
  } else {
    beltFromExtractor(splitterStep(0));
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
    reused_existing_extractor: reusesExistingExtractor,
    source_extractor_actor_id: reusesExistingExtractor ? existingExtractorActorId : null,
    belt: belt.name ?? null,
    spacing_cells: spacing,
    spacing_cm: step,
    actions: [...(minerAction ? [minerAction] : []), ...generators, ...splitters, ...belts],
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
