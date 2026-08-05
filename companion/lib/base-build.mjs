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

  const rowSpacing = Number(rowSpacingOverride) || DEFAULT_ROW_SPACING_CM;
  const machineSpacing = Number(machineSpacingOverride) || DEFAULT_MACHINE_SPACING_CM;

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
    const count = Math.max(1, Math.ceil(Number(productionStep.machines_required) || 1));
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

  // One belt per row boundary, referencing the step that builds each end.
  const belts = steps.slice(0, -1).map((step, index) => ({
    leg: index + 1,
    carries: step.produces,
    from_row: step.row,
    to_row: steps[index + 1].row,
    from_action_index: firstActionOfStep.get(step.production_step),
    to_action_index: firstActionOfStep.get(steps[index + 1].production_step),
  }));

  const notes = [];
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
      `${belts.length} belt leg(s) connect the rows. Each names the step that ` +
        "builds its end, because the machines do not exist when the plan is written.",
    );
  }

  return {
    solver: "base_build",
    planned: true,
    anchor_cm: anchor,
    target: plan.target ?? null,
    power: plan.power_check ?? null,
    rows: steps.length,
    machines_total: steps.reduce((sum, step) => sum + step.machines, 0),
    belts_planned: belts.length,
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
export function baseBuildActions(plan, { commit = false } = {}) {
  if (!plan?.planned) return [];

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

  for (const belt of plan.belts) {
    actions.push({
      action: "place_belt",
      // Resolved by the executor from what those steps built.
      from_step: belt.from_action_index + 1,
      to_step: belt.to_action_index + 1,
      commit,
    });
  }
  return actions;
}
