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

const PURITY_MULTIPLIER = { impure: 0.5, normal: 1, pure: 2 };
const EPSILON = 1e-6;

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
  const dx = Number(playerLocation?.x) - Number(nodeLocation?.x);
  const dy = Number(playerLocation?.y) - Number(nodeLocation?.y);
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

function exactlyWholeMachines(production) {
  return production.steps.every((step) =>
    Math.abs(Number(step.machines_exact) - Math.round(Number(step.machines_exact))) < EPSILON,
  );
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

  const miner = lookup(graph, { building: "miner mk1" });
  const splitter = lookup(graph, { building: "conveyor splitter" });
  const merger = lookup(graph, { building: "conveyor merger" });
  const storage = lookup(graph, { building: "storage container" });
  const belt = findBestAvailableBelt(graph, { tier: 1 });
  if (!miner?.resolved || !splitter?.resolved || !merger?.resolved || !storage?.resolved || !belt) {
    const missing = [
      !miner?.resolved && "Miner Mk.1",
      !splitter?.resolved && "Conveyor Splitter",
      !merger?.resolved && "Conveyor Merger",
      !storage?.resolved && "Storage Container",
      !belt && "Conveyor Belt Mk.1",
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

  const unitPlan = solveProductionPlan(graph, {
    item_class: item.class_path,
    target_rate_per_minute: 1,
    use_existing_surplus: false,
    prefer_standard_recipes: true,
  });
  const matchingRaw = unitPlan.raw_inputs_required?.find((raw) =>
    sameItem(raw.item_class, target.resource_class),
  );
  const otherRaw = (unitPlan.raw_inputs_required ?? []).filter((raw) =>
    !sameItem(raw.item_class, target.resource_class),
  );
  const rawPerOutput = Number(matchingRaw?.display_units_per_minute);
  if (!unitPlan.planned || !Number.isFinite(rawPerOutput) || rawPerOutput <= 0 || otherRaw.length > 0) {
    return {
      planned: false,
      reason:
        "the standard Wire chain is not proven to use only the aimed node's captured resource",
      other_raw_inputs: otherRaw,
    };
  }

  const outputPerMinute = lineInputPerMinute / rawPerOutput;
  const production = solveProductionPlan(graph, {
    item_class: item.class_path,
    target_rate_per_minute: outputPerMinute,
    use_existing_surplus: false,
    prefer_standard_recipes: true,
  });
  if (!production.planned || production.unresolved?.length || production.steps.length !== 2) {
    return { planned: false, reason: "the standard two-stage Wire production chain did not resolve", production };
  }
  if (!exactlyWholeMachines(production)) {
    return {
      planned: false,
      reason: "the Mk.1 transport rate would require underclocking, which the action contract cannot yet set safely",
    };
  }

  const wireStep = production.steps.find((step) => sameItem(step.produces?.item_class, item.class_path));
  const ingotStep = production.steps.find((step) =>
    (wireStep?.inputs_required ?? []).some((input) => sameItem(input.item_class, step.produces?.item_class)),
  );
  if (!wireStep || !ingotStep || ingotStep.machines_required !== 2 || wireStep.machines_required !== 4) {
    return {
      planned: false,
      reason: "the captured standard recipes do not size to the verified 2-Smelter/4-Constructor Mk.1 topology",
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

  // One-based step numbers are intentionally named. Belts only ever reference
  // earlier actor-creating steps, which the game resolves after construction.
  const actions = [
    {
      ...place(miner.recipe_class, target.location),
      target_actor_id: target.actor_id,
      yaw: 0,
    }, // 1 miner
    place(splitter.recipe_class, at(1_600, 0)), // 2 ore splitter
    place(smelterBuild.recipe_class, at(3_200, -900), ingotStep.recipe_class), // 3
    place(smelterBuild.recipe_class, at(3_200, 900), ingotStep.recipe_class), // 4
    place(merger.recipe_class, at(4_900, 0)), // 5 ingot merger
    place(splitter.recipe_class, at(6_300, 0)), // 6 ingot splitter A
    place(splitter.recipe_class, at(7_700, 0)), // 7 ingot splitter B
    place(constructorBuild.recipe_class, at(9_400, -2_700), wireStep.recipe_class), // 8
    place(constructorBuild.recipe_class, at(9_400, -900), wireStep.recipe_class), // 9
    place(constructorBuild.recipe_class, at(9_400, 900), wireStep.recipe_class), // 10
    place(constructorBuild.recipe_class, at(9_400, 2_700), wireStep.recipe_class), // 11
    place(merger.recipe_class, at(11_200, -1_800)), // 12 wire merger A
    place(merger.recipe_class, at(11_200, 1_800)), // 13 wire merger B
    place(storage.recipe_class, at(12_800, -1_800)), // 14 storage A
    place(storage.recipe_class, at(12_800, 1_800)), // 15 storage B
  ];
  const beltBetween = (fromStep, toStep) => actions.push({
    action: "place_belt",
    recipe_class: belt.recipe_class,
    from_step: fromStep,
    to_step: toStep,
    commit: true,
  });
  beltBetween(1, 2);
  beltBetween(2, 3);
  beltBetween(2, 4);
  beltBetween(3, 5);
  beltBetween(4, 5);
  beltBetween(5, 6);
  beltBetween(6, 8);
  beltBetween(6, 9);
  beltBetween(6, 7);
  beltBetween(7, 10);
  beltBetween(7, 11);
  beltBetween(8, 12);
  beltBetween(9, 12);
  beltBetween(10, 13);
  beltBetween(11, 13);
  beltBetween(12, 14);
  beltBetween(13, 15);

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
    smelters: 2,
    constructors: 4,
    storage_lanes: 2,
    production,
    actions,
    notes: [
      `The ${purity} node and Miner Mk.1 can produce ${round(extractedPerMinute)} ore/min, but one Mk.1 belt carries ${round(beltCapacity.items_per_minute)}/min; this line is capped at ${round(lineInputPerMinute)}/min and uses ${round((lineInputPerMinute / extractedPerMinute) * 100, 1)}% of the node.`,
      "Production recipes are assigned and read back during each machine placement.",
      "Power is not wired because the action contract does not yet place power lines; connect the six machines to a circuit before expecting production.",
    ],
  };
}
