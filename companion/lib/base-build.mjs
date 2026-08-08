/**
 * Designing a whole base, not just placing one machine.
 *
 * "Design a base for me and spawn it in" is the request this exists for.
 * `solveProductionPlan` already works out which recipes are needed and how many
 * machines each step wants; this decides where they go and how they connect,
 * producing an ordered plan the mod can execute as one transaction.
 *
 * Layout is one row per production step, deepest dependency first, flowing along
 * +X. Every machine shares a yaw. That is not the prettiest arrangement
 * possible, and it is chosen on purpose: belts between rows run the short way,
 * nothing crosses, and when one placement is refused the failure is easy to
 * read and the rest of the plan still makes sense.
 *
 * What is deliberately left to the game:
 *
 *   - **Whether each machine fits.** Ground, clearance and cost are answered by
 *     the hologram at placement, per machine, and reported back.
 *   - **Whether each belt can run.** A belt cannot name connection components
 *     for a machine that does not exist yet, so legs reference the *step* that
 *     builds each end and the executor resolves them when it gets there.
 *
 * So a plan from here is a proposal with arithmetic behind it, never a promise
 * that the base will stand.
 */

/** Used only when nothing of a class has been built yet to measure. */
const DEFAULT_MACHINE_SPACING_CM = 1_500;
const DEFAULT_ROW_SPACING_CM = 1_800;
const MAX_MACHINES_PER_PLAN = 256;

/**
 * The best conveyor the player has actually unlocked.
 *
 * Belts are strictly ordered — a Mk3 carries everything a Mk1 does and more —
 * so the highest unlocked tier is always the right default and needs no
 * judgement. The tier number is read from the descriptor rather than assumed,
 * and if nothing resolves the plan says so instead of naming a belt the save
 * may not have.
 */
export function findBestAvailableBelt(graph) {
  let best = null;
  for (const recipe of graph?.snapshot?.content?.recipes ?? []) {
    if (recipe.available !== true) continue;
    if (!(recipe.produced_in ?? []).some((producer) => String(producer).includes("BP_BuildGun"))) continue;

    const product = (recipe.products ?? [])[0];
    const productShort = String(product?.item_class ?? "").split(".").pop()?.replace(/_C$/, "");
    const tier = productShort?.match(/^Desc_ConveyorBeltMk(\d+)$/)?.[1];
    if (!tier) continue;

    const level = Number(tier);
    if (!best || level > best.tier) {
      best = { tier: level, recipe_class: recipe.class_path, name: recipe.name };
    }
  }
  return best;
}

function vectorOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
}

/**
 * The build recipe that constructs a given building.
 *
 * Matched on the recipe's **product descriptor**, never on its name.
 *
 * The obvious rule — `Build_SmelterMk1_C` is built by `Recipe_SmelterMk1_C` —
 * is wrong in the real catalog, and wrong in the worst way. In a live save:
 *
 *   Recipe_SmelterMk1_C       -> Desc_FoundryMk1_C   ("Foundry")
 *   Recipe_SmelterBasicMk1_C  -> Desc_SmelterMk1_C   ("Smelter")
 *
 * Following the name would have quietly built a Foundry every time a plan asked
 * for a Smelter, and the plan would have read as correct throughout. The product
 * descriptor is the actual link between a building and the recipe that places
 * it, so that is what is matched.
 *
 * Returns null rather than a best guess when nothing produces the descriptor:
 * "this step cannot be placed" is a fine answer, and placing the wrong machine
 * is not.
 */
export function findBuildRecipeForBuilding(graph, buildingClassPath) {
  const shortName = String(buildingClassPath ?? "").split(".").pop()?.replace(/_C$/, "");
  if (!shortName || !shortName.startsWith("Build_")) return null;
  const wantedProduct = `Desc_${shortName.slice("Build_".length)}`;

  const matches = [];
  for (const recipe of graph?.snapshot?.content?.recipes ?? []) {
    const producedIn = recipe.produced_in ?? [];
    if (!producedIn.some((producer) => String(producer).includes("BP_BuildGun"))) continue;

    const product = (recipe.products ?? [])[0];
    const productShort = String(product?.item_class ?? "").split(".").pop()?.replace(/_C$/, "");
    if (productShort === wantedProduct) matches.push(recipe);
  }

  if (matches.length === 0) return null;
  // An unlocked recipe beats a locked one when a building has several; that is
  // the one the player can actually use.
  const chosen = matches.find((recipe) => recipe.available === true) ?? matches[0];
  return {
    recipe_class: chosen.recipe_class ?? chosen.class_path,
    name: chosen.name,
    available: chosen.available === true,
    alternatives: matches.length > 1 ? matches.length : undefined,
  };
}

/**
 * Turns a production plan into an ordered, executable build plan.
 *
 * Takes the output of `solveProductionPlan` rather than a goal, so the recipe
 * choice, machine counts and power check stay in one place and this stays about
 * geometry and ordering.
 */
export function planBaseBuild(graph, args = {}) {
  const {
    production_plan: plan = null,
    anchor_cm: anchorOverride = null,
    row_spacing_cm: rowSpacingOverride = null,
    machine_spacing_cm: machineSpacingOverride = null,
    measure_connectors: measureConnectors = null,
  } = args;

  if (!plan?.planned || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return {
      solver: "base_build",
      planned: false,
      reason: "give a planned production_plan — run plan_production first",
    };
  }

  const anchor =
    vectorOf(anchorOverride) ??
    vectorOf(graph?.snapshot?.interaction_context?.player?.pawn_location) ??
    null;
  if (!anchor) {
    return {
      solver: "base_build",
      planned: false,
      reason: "no anchor position was given and the snapshot has no player position",
    };
  }

  const spacingOrDefault = (value, fallback) => value === null || value === undefined
    ? fallback
    : Number(value);
  const rowSpacing = spacingOrDefault(rowSpacingOverride, DEFAULT_ROW_SPACING_CM);
  const machineSpacing = spacingOrDefault(machineSpacingOverride, DEFAULT_MACHINE_SPACING_CM);
  if (![rowSpacing, machineSpacing].every((value) => Number.isFinite(value) && value > 0 && value <= 100_000)) {
    return {
      solver: "base_build",
      planned: false,
      reason: "row_spacing_cm and machine_spacing_cm must be finite positive values no greater than 100000",
    };
  }

  // Deepest dependency first: raw inputs are built before what consumes them,
  // so every belt between rows runs forward along +X and none double back.
  const ordered = [...plan.steps].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));

  const steps = [];
  const unbuildable = [];
  let actionIndex = 0;
  const firstActionOfStep = new Map();

  for (const [rowIndex, productionStep] of ordered.entries()) {
    const buildingClass = (productionStep.produced_in ?? []).find((entry) =>
      String(entry).includes("/Build_"),
    );
    const recipe = buildingClass ? findBuildRecipeForBuilding(graph, buildingClass) : null;

    if (!recipe) {
      unbuildable.push({
        step: productionStep.step,
        produces: productionStep.produces?.item_name ?? null,
        building_class: buildingClass ?? null,
        reason: buildingClass
          ? "no build recipe in the catalog constructs that building"
          : "this recipe names no placeable building — it is hand-crafted or an extractor",
      });
      continue;
    }
    if (!recipe.available) {
      unbuildable.push({
        step: productionStep.step,
        produces: productionStep.produces?.item_name ?? null,
        building_class: buildingClass,
        reason: `${recipe.name} is not unlocked in this save yet`,
      });
      continue;
    }

    const measured = typeof measureConnectors === "function"
      ? measureConnectors(graph, buildingClass)
      : null;
    const required = Number(productionStep.machines_required);
    if (!Number.isFinite(required) || required <= 0) {
      return {
        solver: "base_build",
        planned: false,
        reason: `production step ${productionStep.step ?? "?"} has no finite positive machine count`,
      };
    }
    const count = Math.ceil(required);
    if (actionIndex + count > MAX_MACHINES_PER_PLAN) {
      return {
        solver: "base_build",
        planned: false,
        reason: `the layout needs more than ${MAX_MACHINES_PER_PLAN} machines and is refused before allocation`,
      };
    }
    const rowY = anchor.y + steps.length * rowSpacing;

    const positions = [];
    for (let index = 0; index < count; index += 1) {
      if (index === 0) firstActionOfStep.set(productionStep.step, actionIndex);
      positions.push({
        action_index: actionIndex,
        location_cm: {
          x: round(anchor.x + index * machineSpacing),
          y: round(rowY),
          z: round(anchor.z),
        },
      });
      actionIndex += 1;
    }

    steps.push({
      production_step: productionStep.step,
      row: steps.length + 1,
      produces: productionStep.produces?.item_name ?? null,
      rate_per_minute: productionStep.produces?.display_units_per_minute ?? null,
      recipe_class: productionStep.recipe_class,
      recipe_name: productionStep.recipe_name,
      building_class: buildingClass,
      build_recipe_class: recipe.recipe_class,
      building_name: recipe.name,
      machines: count,
      positions,
      footprint_measured: Boolean(measured),
      spacing_cm: machineSpacing,
    });
  }

  if (steps.length === 0) {
    return {
      solver: "base_build",
      planned: false,
      reason: "nothing in the production plan resolves to a building that can be placed",
      unbuildable,
    };
  }

  const belt = findBestAvailableBelt(graph);

  // Logical material edges come from the production expansion itself, never
  // from visual row adjacency. For an input step, `chain` is the consumer's
  // chain plus the consumer recipe. Matching that provenance and the input item
  // class keeps parallel branches separate even when they share a depth.
  const placedByProductionStep = new Map(
    steps.map((step) => [step.production_step, step]),
  );
  const sameChain = (left, right) =>
    JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  const belts = [];
  for (const consumer of plan.steps) {
    const consumerRow = placedByProductionStep.get(consumer.step);
    if (!consumerRow) continue;
    const childChain = [...(consumer.chain ?? []), consumer.recipe_class];
    const inputClasses = new Set(
      (consumer.inputs_required ?? []).map((input) => input.item_class).filter(Boolean),
    );

    for (const producer of plan.steps) {
      const producerRow = placedByProductionStep.get(producer.step);
      const producedClass = producer.produces?.item_class;
      if (
        !producerRow ||
        producer.step === consumer.step ||
        !producedClass ||
        !inputClasses.has(producedClass) ||
        !sameChain(producer.chain, childChain)
      ) {
        continue;
      }
      belts.push({
        leg: belts.length + 1,
        carries: producer.produces?.item_name ?? null,
        carries_item_class: producedClass,
        from_row: producerRow.row,
        to_row: consumerRow.row,
        from_production_step: producer.step,
        to_production_step: consumer.step,
        from_action_index: firstActionOfStep.get(producer.step),
        to_action_index: firstActionOfStep.get(consumer.step),
        evidence: "producer chain and item class match the consumer recipe input",
      });
    }
  }

  const notes = [];
  if (!belt && belts.length > 0) {
    notes.push(
      "No conveyor belt is unlocked in this save, so the rows cannot be joined. " +
        "The machines can still be placed.",
    );
  }
  if (unbuildable.length > 0) {
    notes.push(
      `${unbuildable.length} production step(s) cannot be placed and are listed in unbuildable.`,
    );
  }
  if (steps.some((step) => !step.footprint_measured)) {
    notes.push(
      `Some footprints could not be measured from buildings you already own, so ` +
        `${machineSpacing} cm spacing was assumed. Build one of each and the layout ` +
        "tightens on its own.",
    );
  }
  notes.push(
    "Power is not wired by this plan. The production plan reports the draw and " +
      "whether an existing circuit can carry it.",
  );
  if (belts.length > 0) {
    notes.push(
      `${belts.length} logical material edge(s) connect producer and consumer rows. ` +
        "Physical splitter, merger, port and fanout routing remains unverified.",
    );
  }

  return {
    solver: "base_build",
    planned: true,
    anchor_cm: anchor,
    target: plan.target ?? null,
    power: plan.power_check ?? null,
    belt: belt ?? null,
    rows: steps.length,
    machines_total: steps.reduce((sum, step) => sum + step.machines, 0),
    belts_planned: belt ? belts.length : 0,
    steps,
    belts,
    unbuildable,
    notes,
    unverified:
      "Every position is a proposal. Ground, clearance, cost and whether each " +
      "belt can run are decided by the game's holograms as the plan executes, " +
      "and each outcome is reported back.",
  };
}

/**
 * The plan as actions the mod can execute, in order.
 *
 * Placements come first in dependency order, then the belts that join them.
 * Belt legs carry `from_step` / `to_step`, which the executor rewrites into the
 * actors those earlier steps created — the only way to belt machines that do
 * not exist when the plan is written.
 *
 * Steps are 1-based to match how the mod reports them back to the player.
 */
export function baseBuildActions(plan, { commit = false, step_offset: stepOffset = 0 } = {}) {
  if (!plan?.planned) return [];
  if (!Number.isInteger(stepOffset) || stepOffset < 0) return [];

  const actions = [];
  for (const step of plan.steps) {
    for (const position of step.positions) {
      actions.push({
        action: "place_building",
        recipe_class: step.build_recipe_class,
        location: position.location_cm,
        yaw: 0,
        commit,
      });
    }
  }

  // Without an unlocked belt there is nothing to join the rows with, so no
  // belt actions are emitted at all rather than ones certain to be refused.
  if (plan.belt?.recipe_class) {
    for (const leg of plan.belts) {
      actions.push({
        action: "place_belt",
        recipe_class: plan.belt.recipe_class,
        // Resolved by the executor from what those steps built.
        from_step: stepOffset + leg.from_action_index + 1,
        to_step: stepOffset + leg.to_action_index + 1,
        commit,
      });
    }
  }
  return actions;
}

/* ---------------- a factory inside a building ---------------- */

/**
 * Plans a production line and the structure that houses it.
 *
 * This is the composite the owner is actually asking for: not machines in a
 * field and not an empty shed, but a raised, walled, roofed deck with the
 * production sitting on it. The reference art is all elevated platforms with
 * the machinery enclosed, and the original request weeks earlier was the same
 * thing in plainer words — "so I can place buildings over them to hide it".
 *
 * The structure is sized from the machines rather than the other way round.
 * Footprints are measured off the player's own buildings, so a Constructor at
 * 10.8 m is correctly given two grid cells rather than one, and a save with
 * none built yet falls back to a stated assumption instead of a silent guess.
 */
export function planEnclosedFactory(graph, args = {}) {
  const {
    production_plan: production = null,
    measure_building: measureBuilding = null,
    measure_connectors: measureConnectors = null,
    plan_structure: planStructure = null,
    plan_tower: planTower = null,
    levels: levelsArg = 1,
    // Where to put the building. Null means the player's position; a solver
    // that picked a site passes its winner here.
    anchor_cm: anchorOverride = null,
    raised_cm: raisedCm = 800,
    glass_roof: glassRoof = true,
    margin_cells: marginCells = 1,
  } = args;

  if (typeof planStructure !== "function") {
    return { solver: "enclosed_factory", planned: false, reason: "no structure planner was provided" };
  }

  const levels = Number(levelsArg);
  const margin = Number(marginCells);
  const raised = Number(raisedCm);
  if (!Number.isInteger(levels) || levels < 1 || levels > 12) {
    return { solver: "enclosed_factory", planned: false, reason: "levels must be a whole number from 1 through 12" };
  }
  if (!Number.isInteger(margin) || margin < 0 || margin > 8) {
    return { solver: "enclosed_factory", planned: false, reason: "margin_cells must be a whole number from 0 through 8" };
  }
  if (!Number.isFinite(raised) || raised < 0 || raised > 100_000) {
    return { solver: "enclosed_factory", planned: false, reason: "raised_cm must be finite and between 0 and 100000" };
  }

  // The machines first: their count and footprint decide how big the shell is.
  const machinePlan = planBaseBuild(graph, {
    production_plan: production,
    measure_connectors: measureConnectors,
  });
  if (!machinePlan.planned) return { ...machinePlan, solver: "enclosed_factory" };

  // Probe the grid with a throwaway structure, so cell size comes from the
  // same place the real one will use rather than a second opinion.
  const probe = planStructure(graph, {
    ...(anchorOverride ? { origin_cm: anchorOverride } : {}),
    width_cells: 1,
    depth_cells: 1,
    height_cm: 0,
  });
  if (!probe.planned) return { ...probe, solver: "enclosed_factory" };
  const cell = probe.grid.cell_size_cm;

  const cellsFor = (lengthCm) => Math.max(1, Math.ceil(lengthCm / cell));
  const assumedFootprints = [];

  // How many cells each row needs, from real measurements where they exist.
  let widestRowCells = 1;
  const rows = machinePlan.steps.map((step) => {
    const measured = typeof measureBuilding === "function"
      ? measureBuilding(graph, [step.building_class])
      : null;
    if (!measured) assumedFootprints.push(step.building_name);

    const widthCells = cellsFor(measured?.width_cm ?? cell);
    const depthCells = cellsFor(measured?.depth_cm ?? cell);
    const rowCells = widthCells * step.machines;
    widestRowCells = Math.max(widestRowCells, rowCells);
    return { ...step, cells_per_machine: widthCells, row_depth_cells: depthCells, row_width_cells: rowCells };
  });

  const interiorWidth = widestRowCells + margin * 2;
  const interiorDepth =
    rows.reduce((sum, row) => sum + row.row_depth_cells, 0) + margin * (rows.length + 1);

  // With several storeys the rows are split between decks, so each floor only
  // has to be deep enough for its share. That is the entire point of building
  // upward rather than sideways, and it is what the reference builds do.
  const rowsPerLevel = Math.ceil(rows.length / levels);
  const deepestLevelCells = (() => {
    let deepest = 1;
    for (let level = 0; level < levels; level += 1) {
      const slice = rows.slice(level * rowsPerLevel, (level + 1) * rowsPerLevel);
      if (slice.length === 0) continue;
      const depth =
        slice.reduce((sum, row) => sum + row.row_depth_cells, 0) + margin * (slice.length + 1);
      deepest = Math.max(deepest, depth);
    }
    return deepest;
  })();

  const structure =
    levels > 1 && typeof planTower === "function"
      ? planTower(graph, {
          levels,
          width_cells: interiorWidth,
          depth_cells: deepestLevelCells,
          height_cm: raised,
          glass_roof: glassRoof,
          clear_terrain: true,
          // Site chosen by the solver when the request asked for one,
          // otherwise the planner falls back to the player position.
          ...(anchorOverride ? { origin_cm: anchorOverride } : {}),
          // Straight sides when housing machines: a tier stepping in would
          // shrink the deck out from under the row it is meant to hold.
          inset_cells: 0,
        })
      : planStructure(graph, {
          width_cells: interiorWidth,
          depth_cells: interiorDepth,
          height_cm: raised,
          glass_roof: glassRoof,
          clear_terrain: true,
          // Site chosen by the solver when the request asked for one,
          // otherwise the planner falls back to the player position.
          ...(anchorOverride ? { origin_cm: anchorOverride } : {}),
        });
  if (!structure.planned) return { ...structure, solver: "enclosed_factory" };

  // Re-place every machine on its own deck, inside the shell, on the grid.
  //
  // A tower reports one interior per storey; a single structure reports one.
  // Normalising them here means the placement code does not care which it got.
  const decks = structure.interiors ?? [{ level: 1, ...structure.interior }];
  const rowCursors = new Map();
  const placed = rows.map((row, rowIndex) => {
    const level = Math.min(decks.length - 1, Math.floor(rowIndex / rowsPerLevel));
    const deck = decks[level];
    const cursor = rowCursors.get(level) ?? margin;
    const y = deck.min_y_cm + cursor * cell;
    rowCursors.set(level, cursor + row.row_depth_cells + margin);
    return {
      ...row,
      level: level + 1,
      positions: row.positions.map((position, machineIndex) => ({
        ...position,
        location_cm: {
          x: deck.min_x_cm + (margin + machineIndex * row.cells_per_machine) * cell,
          y,
          z: deck.floor_z_cm,
        },
      })),
    };
  });

  const notes = [...structure.notes, ...machinePlan.notes];
  if (assumedFootprints.length > 0) {
    notes.push(
      `Footprints for ${[...new Set(assumedFootprints)].join(", ")} could not be ` +
        "measured from buildings you already own, so one grid cell was assumed. " +
        "Build one of each and the layout tightens on its own.",
    );
  }

  return {
    solver: "enclosed_factory",
    planned: true,
    structure: { ...structure, parts: structure.parts },
    machines: { ...machinePlan, steps: placed },
    grid_cell_cm: cell,
    interior_cells: {
      width: interiorWidth,
      depth: levels > 1 ? deepestLevelCells : interiorDepth,
    },
    notes,
    unverified: structure.unverified,
  };
}

/**
 * The whole thing as actions: shell first, then the machines on its deck, then
 * the belts between them.
 *
 * Order matters for more than tidiness — a machine placed before the deck it
 * stands on has nothing to stand on, and the game would refuse it.
 */
export function enclosedFactoryActions(plan, { commit = false, structure_actions: structureActions } = {}) {
  if (!plan?.planned) return [];
  const shell = typeof structureActions === "function"
    ? structureActions(plan.structure, { commit })
    : [];
  // Machine-relative step references must be shifted past the shell. Without
  // this, every housed-factory belt resolves to a foundation or wall instead
  // of the machine it was designed to connect.
  const inside = baseBuildActions(plan.machines, { commit, step_offset: shell.length });
  return [...shell, ...inside];
}
