/**
 * A narrow, deterministic Mk.1 Wire factory built from the aimed Copper node.
 *
 * This is intentionally not a generic prose-to-layout guess. The topology is
 * the exact early-game chain whose rates can all be proven from the live
 * catalog: Miner Mk.1 -> 2 Smelters -> 4 Constructors -> two storage lanes.
 * Splitters and mergers make every connector one-to-one, so no action asks the
 * game to attach several belts to a machine's single port.
 */

import { findBestAvailableBelt, findBuildRecipeForBuilding } from "./base-build.mjs";
import { normalizeResourcePurity, solveProductionPlan } from "./solvers.mjs";
import { captureUnlockConstraints } from "./unlock-constraints.mjs";

const PURITY_MULTIPLIER = { impure: 0.5, normal: 1, pure: 2 };
const EPSILON = 1e-6;

/**
 * Where each stage sits, in centimetres out from the node.
 *
 * The first live build put storage 129 m from the miner and strung the whole
 * line across open rock; the owner's verdict was "placement is very bad", and
 * looking at it, fair. Every machine also sat on its own separate foundation,
 * so the line climbed and dropped with the terrain instead of reading as one
 * factory.
 *
 * These are the distances between stages, gathered here rather than left as
 * literals down the layout so the shape can be changed in one place. They are
 * spacings, not machine sizes: a Constructor's real footprint is not in the
 * snapshot, so the gaps are deliberately larger than the biggest machine any
 * stage places rather than fitted to it.
 *
 * Roughly two thirds of the original run, which keeps belt runs short without
 * crowding machines into each other.
 */
const STAGE = {
  raw_splitter: 1_200,
  raw_splitter_step: 800,
  smelter: 2_600,
  ingot_merger: 3_900,
  ingot_merger_step: 800,
  ingot_splitter: 4_900,
  ingot_splitter_step: 800,
  constructor: 6_400,
  output_merger: 7_900,
  storage: 9_200,
  /** Sideways gap between machines in the same row. */
  lateral: 1_400,
};

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function sameItem(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function catalogRecipe(graph, classPath) {
  return graph?.recipesByClass?.get(classPath) ?? null;
}

function observedMk1BeltCapacity(graph, belt) {
  const matches = [...(graph?.nodes?.values?.() ?? [])]
    .filter((node) => node.role === "conveyor")
    .filter((node) => /conveyorbeltmk1/i.test(String(node.class_path ?? node.name ?? "")))
    .filter((node) => !belt?.owner_mod || !node.owner_mod || node.owner_mod === belt.owner_mod)
    .map((node) => ({
      actor_id: node.actor_id,
      items_per_minute: Number(node.conveyor?.items_per_minute),
      basis: node.conveyor ?? null,
    }))
    .filter((entry) => Number.isFinite(entry.items_per_minute) && entry.items_per_minute > 0);
  if (matches.length === 0) return null;

  // If a mod has several same-named Mk.1 variants, size against the slowest
  // observed one. Overbuilding is worse than leaving headroom, and the chosen
  // raw evidence remains in the result.
  matches.sort((left, right) => left.items_per_minute - right.items_per_minute);
  return matches[0];
}

function unitVectors(nodeLocation, playerLocation) {
  // The usual interaction pose has the player standing in front of and aiming
  // at the node. Grow the factory through the far side of the node, not back
  // through the player's collision capsule. Relative machine spacing and belt
  // lengths are unchanged; only the world-facing axis is reversed.
  const dx = Number(nodeLocation?.x) - Number(playerLocation?.x);
  const dy = Number(nodeLocation?.y) - Number(playerLocation?.y);
  const length = Math.hypot(dx, dy);
  const forward = length > EPSILON ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
  return {
    forward,
    lateral: { x: -forward.y, y: forward.x },
    yaw: round((Math.atan2(forward.y, forward.x) * 180) / Math.PI, 2),
  };
}

function translate(origin, axes, forwardCm, lateralCm) {
  return {
    x: round(origin.x + axes.forward.x * forwardCm + axes.lateral.x * lateralCm, 1),
    y: round(origin.y + axes.forward.y * forwardCm + axes.lateral.y * lateralCm, 1),
    z: round(origin.z, 1),
  };
}

function recipeProduces(recipe, itemClass) {
  return (recipe?.products ?? []).some((product) => sameItem(product.item_class, itemClass));
}

function isMk1ConstructorRecipe(recipe) {
  return (recipe?.produced_in ?? []).some((value) => /Build_ConstructorMk1/i.test(String(value)));
}

export function planAimedMk1WireFactory(graph, {
  target = null,
  item = null,
  build_recipe_lookup: lookup = null,
} = {}) {
  if (!target?.resolved) {
    return { planned: false, reason: target?.reason ?? "the aimed target did not resolve" };
  }
  if (target.node_type === "Deposit") {
    return { planned: false, reason: "the aimed target is a hand-mined deposit, not a miner node" };
  }
  if (!target.actor_id || !target.location || !target.resource_class) {
    return {
      planned: false,
      reason: "the aimed node is missing actor_id, location, or resource_class in the snapshot",
    };
  }
  if (target.occupied) {
    return {
      planned: false,
      reason: "the aimed node is already occupied; replacing or reusing its extractor was not requested",
    };
  }
  if (String(item?.name ?? "").trim().toLowerCase() !== "wire") {
    return {
      planned: false,
      reason: "this deterministic Mk.1 node layout currently supports Wire only",
    };
  }
  if (typeof lookup !== "function") {
    return { planned: false, reason: "no build-recipe lookup was provided" };
  }

  const unlockConstraints = captureUnlockConstraints(graph);
  if (!unlockConstraints.availability_known) {
    return {
      planned: false,
      reason: "the current AFGRecipeManager unlock state was not captured, so no build recipe may be assumed available",
      unlock_constraints: unlockConstraints,
    };
  }

  const miner = lookup(graph, { building: "miner mk1" });
  const splitter = lookup(graph, { building: "conveyor splitter" });
  const merger = lookup(graph, { building: "conveyor merger" });
  const storage = lookup(graph, { building: "storage container" });
  const belt = findBestAvailableBelt(graph, { tier: 1 });
  const foundation = [...(graph?.recipesByClass?.values?.() ?? [])].find((recipe) =>
    recipe?.available === true &&
    /Recipe_Foundation_8x1_01(?:\.|_C|$)/i.test(String(recipe.class_path ?? "")),
  );
  if (!miner?.resolved || !splitter?.resolved || !merger?.resolved || !storage?.resolved || !belt || !foundation) {
    const missing = [
      !miner?.resolved && "Miner Mk.1",
      !splitter?.resolved && "Conveyor Splitter",
      !merger?.resolved && "Conveyor Merger",
      !storage?.resolved && "Storage Container",
      !belt && "Conveyor Belt Mk.1",
      !foundation && "Foundation (1 m)",
    ].filter(Boolean);
    return { planned: false, reason: `required unlocked Mk.1 parts are missing: ${missing.join(", ")}` };
  }

  const minerRecipe = catalogRecipe(graph, miner.recipe_class);
  const normalRate = Number(
    miner.building_stats?.items_per_minute_at_normal_purity ??
      minerRecipe?.building_stats?.items_per_minute_at_normal_purity,
  );
  const purity = normalizeResourcePurity(target.purity);
  const multiplier = PURITY_MULTIPLIER[purity];
  if (!Number.isFinite(normalRate) || normalRate <= 0 || !Number.isFinite(multiplier)) {
    return {
      planned: false,
      reason: "the snapshot cannot prove the Miner Mk.1 normal rate or this node's purity",
    };
  }

  const beltCapacity = observedMk1BeltCapacity(graph, belt);
  if (!beltCapacity) {
    return {
      planned: false,
      reason: "no captured Mk.1 belt proves the selected belt's items-per-minute capacity",
    };
  }
  const extractedPerMinute = normalRate * multiplier;
  const lineInputPerMinute = Math.min(extractedPerMinute, beltCapacity.items_per_minute);

  const candidatePlans = [...(graph?.recipesByClass?.values?.() ?? [])]
    .filter((recipe) => recipe?.available === true)
    .filter((recipe) => recipeProduces(recipe, item.class_path))
    .filter(isMk1ConstructorRecipe)
    .map((recipe) => {
      const plan = solveProductionPlan(graph, {
        item_class: item.class_path,
        target_rate_per_minute: 1,
        recipe_class: recipe.class_path,
        use_existing_surplus: false,
        prefer_standard_recipes: true,
        stop_at_item_classes: [target.resource_class],
      });
      const matchingRaw = plan.raw_inputs_required?.find((raw) =>
        sameItem(raw.item_class, target.resource_class),
      );
      const otherRaw = (plan.raw_inputs_required ?? []).filter((raw) =>
        !sameItem(raw.item_class, target.resource_class),
      );
      return {
        recipe,
        plan,
        raw_per_output: Number(matchingRaw?.display_units_per_minute),
        other_raw: otherRaw,
      };
    })
    .filter(({ plan, raw_per_output: rawPerOutput, other_raw: otherRaw }) =>
      plan.planned &&
      !plan.unresolved?.length &&
      Number.isFinite(rawPerOutput) &&
      rawPerOutput > 0 &&
      otherRaw.length === 0,
    )
    .sort((left, right) =>
      left.raw_per_output - right.raw_per_output ||
      String(left.recipe.class_path).localeCompare(String(right.recipe.class_path)),
    );
  const selected = candidatePlans[0];
  if (!selected) {
    return {
      planned: false,
      reason:
        "no unlocked Mk.1 Constructor Wire recipe has a complete dependency chain rooted only in the aimed node's captured resource",
    };
  }

  const outputPerMinute = lineInputPerMinute / selected.raw_per_output;
  const production = solveProductionPlan(graph, {
    item_class: item.class_path,
    target_rate_per_minute: outputPerMinute,
    recipe_class: selected.recipe.class_path,
    use_existing_surplus: false,
    prefer_standard_recipes: true,
    stop_at_item_classes: [target.resource_class],
  });
  if (!production.planned || production.unresolved?.length || production.steps.length !== 2) {
    return { planned: false, reason: "the selected two-stage Wire production chain did not resolve", production };
  }

  const wireStep = production.steps.find((step) => sameItem(step.produces?.item_class, item.class_path));
  const ingotStep = production.steps.find((step) =>
    (wireStep?.inputs_required ?? []).some((input) => sameItem(input.item_class, step.produces?.item_class)),
  );
  if (!wireStep || !ingotStep || ingotStep.machines_required < 1 || wireStep.machines_required < 1) {
    return {
      planned: false,
      reason: "the captured recipes did not produce a usable Smelter/Constructor topology",
      production,
    };
  }

  const smelterClass = (ingotStep.produced_in ?? []).find((value) => /Build_SmelterMk1/i.test(String(value)));
  const constructorClass = (wireStep.produced_in ?? []).find((value) => /Build_ConstructorMk1/i.test(String(value)));
  const smelterBuild = findBuildRecipeForBuilding(graph, smelterClass);
  const constructorBuild = findBuildRecipeForBuilding(graph, constructorClass);
  if (!smelterBuild?.available || !constructorBuild?.available) {
    return { planned: false, reason: "the exact Smelter Mk.1 or Constructor Mk.1 build recipe is unavailable" };
  }
  if (wireStep.per_machine_display_units_per_minute > beltCapacity.items_per_minute + EPSILON) {
    return {
      planned: false,
      reason: "one Constructor's selected-recipe output exceeds a Mk.1 belt and clock-speed actions are not implemented",
    };
  }

  const player = graph.snapshot?.interaction_context?.player?.pawn_location;
  const axes = unitVectors(target.location, player);
  const at = (forward, lateral) => translate(target.location, axes, forward, lateral);
  const place = (recipeClass, location, productionRecipe = null) => ({
    action: "place_building",
    recipe_class: recipeClass,
    ...(productionRecipe ? { production_recipe_class: productionRecipe } : {}),
    location,
    yaw: axes.yaw,
    commit: true,
  });

  // All building placements come first, so every later belt references an
  // earlier actor-creating step. Splitter manifolds fan out two consumers per
  // splitter and use their third output for the next splitter. Merger chains
  // combine three sources first, then add two sources per additional merger.
  const actions = [];
  const beltEdges = [];
  const addPlacement = (action) => {
    actions.push(action);
    return actions.length;
  };
  const addSupportedPlacement = (action) => {
    const foundationStep = addPlacement({
      ...place(foundation.class_path, action.location),
      yaw: action.yaw,
    });
    return addPlacement({ ...action, target_step: foundationStep });
  };
  const connect = (fromStep, toStep) => beltEdges.push([fromStep, toStep]);
  const centredLaterals = (count, spacing = STAGE.lateral) =>
    Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * spacing);
  const connectFanOut = (sourceStep, splitterSteps, consumerSteps) => {
    if (consumerSteps.length === 1) {
      connect(sourceStep, consumerSteps[0]);
      return;
    }
    connect(sourceStep, splitterSteps[0]);
    for (let index = 0; index < splitterSteps.length; index += 1) {
      const splitterStep = splitterSteps[index];
      for (const consumer of consumerSteps.slice(index * 2, index * 2 + 2)) {
        connect(splitterStep, consumer);
      }
      if (splitterSteps[index + 1]) connect(splitterStep, splitterSteps[index + 1]);
    }
  };
  const addMergerChain = (sourceSteps, forwardCm, lateralCm = 0, stepCm = 800) => {
    if (sourceSteps.length === 1) return sourceSteps[0];
    let cursor = 0;
    let previous = null;
    let mergerIndex = 0;
    while (cursor < sourceSteps.length) {
      const mergerStep = addSupportedPlacement(
        place(merger.recipe_class, at(forwardCm + mergerIndex * stepCm, lateralCm)),
      );
      const inputs = previous
        ? [previous, ...sourceSteps.slice(cursor, cursor + 2)]
        : sourceSteps.slice(cursor, cursor + 3);
      cursor += previous ? 2 : 3;
      for (const input of inputs) connect(input, mergerStep);
      previous = mergerStep;
      mergerIndex += 1;
    }
    return previous;
  };

  const minerStep = addPlacement({
    ...place(miner.recipe_class, target.location),
    target_actor_id: target.actor_id,
    yaw: 0,
  });

  const smelterCount = ingotStep.machines_required;
  const rawSplitterSteps = smelterCount > 1
    ? Array.from({ length: Math.ceil(smelterCount / 2) }, (_, index) =>
        addSupportedPlacement(place(splitter.recipe_class, at(STAGE.raw_splitter + index * STAGE.raw_splitter_step, 0))))
    : [];
  const smelterSteps = centredLaterals(smelterCount).map((lateral) =>
    addSupportedPlacement(place(smelterBuild.recipe_class, at(STAGE.smelter, lateral), ingotStep.recipe_class)));
  connectFanOut(minerStep, rawSplitterSteps, smelterSteps);
  const ingotSourceStep = addMergerChain(smelterSteps, STAGE.ingot_merger, 0, STAGE.ingot_merger_step);

  const constructorCount = wireStep.machines_required;
  const ingotSplitterSteps = constructorCount > 1
    ? Array.from({ length: Math.ceil(constructorCount / 2) }, (_, index) =>
        addSupportedPlacement(place(splitter.recipe_class, at(STAGE.ingot_splitter + index * STAGE.ingot_splitter_step, 0))))
    : [];
  const constructorLaterals = centredLaterals(constructorCount);
  const constructorSteps = constructorLaterals.map((lateral) =>
    addSupportedPlacement(place(constructorBuild.recipe_class, at(STAGE.constructor, lateral), wireStep.recipe_class)));
  connectFanOut(ingotSourceStep, ingotSplitterSteps, constructorSteps);

  const constructorsPerLane = Math.max(
    1,
    Math.min(3, Math.floor(beltCapacity.items_per_minute / wireStep.per_machine_display_units_per_minute + EPSILON)),
  );
  const storageLanes = [];
  for (let start = 0; start < constructorSteps.length; start += constructorsPerLane) {
    const group = constructorSteps.slice(start, start + constructorsPerLane);
    const groupLaterals = constructorLaterals.slice(start, start + constructorsPerLane);
    const lateral = groupLaterals.reduce((sum, value) => sum + value, 0) / groupLaterals.length;
    const outputStep = addMergerChain(group, STAGE.output_merger, lateral);
    const storageStep = addSupportedPlacement(place(storage.recipe_class, at(STAGE.storage, lateral)));
    connect(outputStep, storageStep);
    storageLanes.push(storageStep);
  }

  for (const [fromStep, toStep] of beltEdges) {
    actions.push({
      action: "place_belt",
      recipe_class: belt.recipe_class,
      from_step: fromStep,
      to_step: toStep,
      commit: true,
    });
  }

  // A foundation cannot be laid across a resource node, and the layout runs
  // along an axis without looking at what else is on it. A live plan put a
  // Foundation (1 m) five metres from BP_ResourceNode206 and the game refused
  // it with FGCDInvalidPlacement at step 16, after fifteen other placements had
  // already been validated.
  //
  // The refusal is cheap and the whole plan is thrown away either way, so it
  // belongs here where the reason can be named. Only the node being mined is
  // exempt: the miner is supposed to be on that one.
  const blockingNode = findResourceNodeUnderPlan(graph, actions, target);
  if (blockingNode) {
    return {
      solver: "aimed_mk1_wire_factory",
      planned: false,
      reason:
        `the factory's foundations would cross ${blockingNode.name}, ` +
        `${blockingNode.distance_m} m away, and a foundation cannot be laid over a ` +
        "resource node. Stand so the space behind the node is clear and ask again — " +
        "the layout runs away from where you are standing",
      blocked_by: blockingNode,
    };
  }

  return {
    solver: "aimed_mk1_wire_factory",
    planned: true,
    node: target.on,
    resource: target.resource_name,
    purity,
    miner: miner.name,
    belt: belt.name,
    extracted_per_minute: round(extractedPerMinute),
    belt_capacity_per_minute: round(beltCapacity.items_per_minute),
    line_input_per_minute: round(lineInputPerMinute),
    output_per_minute: round(outputPerMinute),
    node_utilisation_percent: round((lineInputPerMinute / extractedPerMinute) * 100, 1),
    capacity_evidence_actor_id: beltCapacity.actor_id,
    recipe: selected.recipe.name,
    recipe_class: selected.recipe.class_path,
    smelters: smelterCount,
    constructors: constructorCount,
    last_constructor_utilisation_percent: wireStep.utilisation_of_last_machine_percent,
    storage_lanes: storageLanes.length,
    foundations: actions.filter((action) => action.recipe_class === foundation.class_path).length,
    production,
    unlock_constraints: unlockConstraints,
    optimization: {
      recalculated_from_current_capture: true,
      recipe_candidates_considered: candidatePlans.length,
      recipe_objective: "maximize output from the aimed resource subject to the requested Mk.1 transport and machine constraints",
      selected_raw_input_per_output: round(selected.raw_per_output, 6),
      placement_objective: "grow away from the captured player and keep production stages compact on supported grid-aligned rows",
      routing_objective: "use the fewest deterministic splitter/merger fan-out stages without reusing a single-port endpoint",
      final_authority: "the game recalculates connector endpoints and validates every hologram immediately before each construction",
    },
    actions,
    notes: [
      `The ${purity} node and Miner Mk.1 can produce ${round(extractedPerMinute)} ore/min, but one Mk.1 belt carries ${round(beltCapacity.items_per_minute)}/min; this line is capped at ${round(lineInputPerMinute)}/min and uses ${round((lineInputPerMinute / extractedPerMinute) * 100, 1)}% of the node.`,
      "Production recipes are assigned and read back during each machine placement.",
      `Power is not wired because the action contract does not yet place power lines; connect the ${smelterCount + constructorCount} machines to a circuit before expecting production.`,
    ],
  };
}

/**
 * The first resource node a planned placement would sit on top of, or null.
 *
 * Foundations and machines cannot occupy a resource node, and the game says so
 * only when it reaches that action — a live plan validated fifteen placements
 * before refusing the sixteenth with FGCDInvalidPlacement, five metres from
 * BP_ResourceNode206.
 *
 * The radius is stated, not measured, and the reply says so. A resource node
 * reports no `bounds` in the snapshot — only a centre — so its true extent is
 * not knowable here.
 *
 * It is calibrated against the one real observation available: a Foundation
 * (1 m) centred 5 m from BP_ResourceNode206 was refused. A foundation is 8 m
 * square, so its own half-width is 4 m, which alone would not have reached a
 * node centre 5 m away — the node therefore has an extent of its own. 8 m is
 * four metres of foundation plus four of node, the smallest value consistent
 * with what the game actually rejected.
 *
 * Being cautious costs a few metres of siting. Being optimistic costs the
 * whole transaction, which is what happened.
 *
 * Capturing `bounds` for resource nodes would replace this with a measurement.
 * That is a snapshot change and a rebuild; this is the honest version until
 * then.
 */
const NODE_CLEARANCE_CM = 800;

export function findResourceNodeUnderPlan(graph, actions, target) {
  const targetId = String(target?.actor_id ?? "");
  const nodes = [];
  for (const node of graph?.nodes?.values() ?? []) {
    if (node.kind !== "resource_node") continue;
    const location = node.raw?.location ?? node.location;
    if (!location) continue;
    // The node being mined is where the miner goes; it is not an obstruction.
    if (targetId && String(node.actor_id ?? node.raw?.actor_id ?? "") === targetId) continue;

    // Deposits are not nodes. The snapshot files both under kind
    // "resource_node" and separates them by node_type, and the clearance here
    // was calibrated against a full node — applying it to a hand-minable rock
    // refused a whole factory over BP_ResourceDeposit539 at 0.56 m, which is
    // close enough to be under the miner itself.
    //
    // Only a node is refused, because a node is the only thing observed to
    // block a foundation. Guessing that deposits behave the same way would be
    // inventing a second rule from the evidence for the first.
    if (String(node.raw?.node_type ?? node.node_type ?? "") === "Deposit") continue;

    nodes.push({ name: node.raw?.name ?? node.display_name ?? node.actor_id, location });
  }
  if (nodes.length === 0) return null;

  for (const action of actions ?? []) {
    const at = action?.location;
    if (!at) continue;
    for (const node of nodes) {
      const distance = Math.hypot(node.location.x - at.x, node.location.y - at.y);
      if (distance <= NODE_CLEARANCE_CM) {
        return {
          name: node.name,
          distance_m: Math.round(distance) / 100,
          clearance_used_cm: NODE_CLEARANCE_CM,
        };
      }
    }
  }
  return null;
}
