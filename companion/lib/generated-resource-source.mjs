/**
 * Turn one explicitly aimed ordinary resource node into the native v4
 * Resource Anchor + vanilla Miner source for a generated Blueprint.
 *
 * This module does not infer a resource from the requested product. The aimed
 * node supplies the exact descriptor and purity, the live catalog supplies
 * the unlocked Anchor/Miner/connector classes, and the production solver
 * supplies the exact raw-input rate. The first implementation deliberately
 * accepts one raw input and one first-stage machine only. Splitter fan-out is
 * a separate native topology primitive; pretending one Miner output can feed
 * several machine inputs would produce a Blueprint that cannot run.
 */

import { normalizeResourcePurity } from "./solvers.mjs";

const PURITY_MULTIPLIER = { impure: 0.5, normal: 1, pure: 2 };
const NATIVE_PURITY = {
  impure: "RP_Inpure", // The engine spelling is intentionally preserved.
  normal: "RP_Normal",
  pure: "RP_Pure",
};
const EPSILON = 1e-6;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function shortClass(value) {
  return String(value ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

function catalogEntryByClass(map, classPath) {
  const exact = map?.get?.(classPath);
  if (exact) return exact;
  const wanted = shortClass(classPath);
  if (!wanted) return null;
  const matches = [...(map?.values?.() ?? [])].filter(
    (entry) => shortClass(entry?.class_path) === wanted,
  );
  return matches.length === 1 ? matches[0] : null;
}

function sameClass(left, right) {
  if (String(left ?? "") === String(right ?? "")) return true;
  const leftShort = shortClass(left);
  return Boolean(leftShort) && leftShort === shortClass(right);
}

function buildRecipeMetadata(graph, recipeClass) {
  const recipe = catalogEntryByClass(graph?.recipesByClass, recipeClass);
  if (!recipe) return null;
  const product = (recipe.products ?? [])[0];
  const item = catalogEntryByClass(graph?.itemsByClass, product?.item_class);
  return item?.building && typeof item.building === "object"
    ? { recipe, item, building: item.building }
    : null;
}

function availableBuildGunMetadata(graph) {
  if (graph?.snapshot?.content?.availability_known !== true) return [];
  return [...(graph?.recipesByClass?.values?.() ?? [])]
    .filter(
      (recipe) => recipe?.available === true &&
        (recipe.produced_in ?? []).some((producer) => String(producer).includes("BP_BuildGun")),
    )
    .map((recipe) => buildRecipeMetadata(graph, recipe.class_path))
    .filter(Boolean);
}

function tierOfMiner(metadata) {
  const identity = `${metadata?.item?.name ?? ""} ${metadata?.item?.class_path ?? ""} ` +
    `${metadata?.building?.class_path ?? ""}`;
  const match = identity.match(/(?:miner[^0-9]{0,12})?(?:mk\.?\s*|mark\s*)([123])\b/i);
  return match ? Number(match[1]) : null;
}

function directionMatches(value, wanted) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (wanted === "input") return normalized === "FCD_INPUT" || normalized === "INPUT";
  return normalized === "FCD_OUTPUT" || normalized === "OUTPUT";
}

function nativeFactoryPort(building, wanted) {
  const captured = Array.isArray(building?.native_factory_connections)
    ? building.native_factory_connections
    : null;
  if (!captured) {
    return {
      resolved: false,
      reason: "native factory-connection defaults were not captured for this building class",
    };
  }
  const matches = captured
    .filter((entry) => directionMatches(entry?.direction, wanted))
    .map((entry) => ({
      name: String(entry?.component_name ?? "").trim(),
      location: vector(entry?.native_default_location_cm),
      normal: vector(entry?.native_default_normal),
      clearance_cm: finite(entry?.connector_clearance_cm),
    }))
    .filter((entry) => entry.name && entry.location && entry.normal);
  if (matches.length !== 1) {
    return {
      resolved: false,
      reason: `expected exactly one captured native ${wanted} factory port, found ${matches.length}`,
      captured_port_count: captured.length,
      matching_port_count: matches.length,
    };
  }
  const horizontalLength = Math.hypot(matches[0].normal.x, matches[0].normal.y);
  if (horizontalLength <= EPSILON) {
    return {
      resolved: false,
      reason: `the captured native ${wanted} factory port has no horizontal facing direction`,
    };
  }
  return {
    resolved: true,
    ...matches[0],
    normal: {
      x: matches[0].normal.x / horizontalLength,
      y: matches[0].normal.y / horizontalLength,
      z: 0,
    },
  };
}

function measuredCollisionRadius(graph, buildingClass) {
  const radii = [];
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (!sameClass(node?.class_path, buildingClass)) continue;
    const extent = node?.raw?.bounds?.extent;
    const x = finite(extent?.x);
    const y = finite(extent?.y);
    if (x !== null && y !== null && x > 0 && y > 0) radii.push(Math.hypot(x, y));
  }
  if (radii.length === 0) return null;
  // Largest observed horizontal half-diagonal is rotation-independent and
  // conservative for keeping the generated Miner clear of the shell floor.
  return Math.max(...radii);
}

function rotate(value, yawDegrees) {
  const radians = yawDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: value.x * cosine - value.y * sine,
    y: value.x * sine + value.y * cosine,
    z: value.z,
  };
}

function yawAlign(localNormal, desiredWorldNormal) {
  const desired = Math.atan2(desiredWorldNormal.y, desiredWorldNormal.x);
  const local = Math.atan2(localNormal.y, localNormal.x);
  return (desired - local) * 180 / Math.PI;
}

function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value, amount) {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function observedBeltCapacity(graph, beltRecipeClass) {
  const metadata = buildRecipeMetadata(graph, beltRecipeClass);
  const buildableClass = metadata?.building?.class_path;
  if (!metadata || !buildableClass) return null;
  const observed = [...(graph?.nodes?.values?.() ?? [])]
    .filter((node) => sameClass(node?.class_path, buildableClass))
    .map((node) => ({
      actor_id: node.actor_id,
      items_per_minute: finite(node?.conveyor?.items_per_minute),
    }))
    .filter((entry) => entry.items_per_minute !== null && entry.items_per_minute > 0)
    .sort((left, right) => left.items_per_minute - right.items_per_minute);
  return observed[0]
    ? { ...observed[0], recipe_class: metadata.recipe.class_path, building_class: buildableClass }
    : null;
}

/** Resolve exact current node, resource, Anchor and vanilla Miner evidence. */
export function resolveAimedGeneratedBlueprintSource(graph, {
  target = null,
  requested_miner_tier: requestedTier = null,
} = {}) {
  if (!target?.resolved) {
    return { resolved: false, reason: target?.reason ?? "the aimed target did not resolve" };
  }
  if (target.node_type !== "Node") {
    return {
      resolved: false,
      reason: target.node_type
        ? `the aimed resource type ${target.node_type} is not an ordinary Miner node`
        : "the aimed target is not proven to be an ordinary Miner node",
    };
  }
  if (!target.actor_id || !target.resource_class || !target.purity) {
    return {
      resolved: false,
      reason: "the aimed node is missing its exact actor, resource descriptor, or purity",
    };
  }
  if (graph?.snapshot?.content?.availability_known !== true) {
    return {
      resolved: false,
      reason: "the current AFGRecipeManager unlock state was not captured",
    };
  }

  const resourceItem = catalogEntryByClass(graph?.itemsByClass, target.resource_class);
  if (!resourceItem) {
    return { resolved: false, reason: "the aimed node's exact resource descriptor is absent from the catalog" };
  }
  if (String(resourceItem.form ?? "").toUpperCase() !== "RF_SOLID") {
    return {
      resolved: false,
      reason: `the aimed resource is ${resourceItem.form ?? "unknown form"}, not a solid Miner resource`,
    };
  }

  const purity = normalizeResourcePurity(target.purity);
  const nativePurity = NATIVE_PURITY[purity];
  if (!nativePurity) {
    return { resolved: false, reason: "the aimed node's native purity is unknown" };
  }

  const buildRecipes = availableBuildGunMetadata(graph);
  const anchors = buildRecipes.filter(
    (entry) => entry.building.native_topology_kind === "blueprint_resource_anchor" &&
      entry.building.supports_generated_solid_resource_configuration === true,
  );
  if (anchors.length !== 1) {
    return {
      resolved: false,
      reason: `expected exactly one unlocked native Blueprint Resource Anchor recipe, found ${anchors.length}`,
    };
  }

  const requested = requestedTier === null || requestedTier === undefined
    ? null
    : Number(requestedTier);
  if (requested !== null && ![1, 2, 3].includes(requested)) {
    return { resolved: false, reason: "the requested Miner tier must be Mk.1, Mk.2, or Mk.3" };
  }
  const miners = buildRecipes
    .filter(
      (entry) => entry.building.native_topology_kind === "resource_extractor" &&
        entry.building.supports_generated_blueprint_resource_anchor === true,
    )
    .map((entry) => ({ ...entry, tier: tierOfMiner(entry) }))
    .filter((entry) => entry.tier !== null && (requested === null || entry.tier === requested))
    .sort((left, right) =>
      left.tier - right.tier || String(left.recipe.class_path).localeCompare(String(right.recipe.class_path)),
    );
  if (miners.length === 0) {
    return {
      resolved: false,
      reason: requested === null
        ? "no unlocked captured vanilla Miner Mk.1-Mk.3 supports generated Resource Anchors"
        : `Miner Mk.${requested} is not unlocked with captured generated-Anchor capability`,
    };
  }

  const miner = miners[0];
  const output = nativeFactoryPort(miner.building, "output");
  if (!output.resolved) {
    return { resolved: false, reason: `the selected Miner cannot be laid out: ${output.reason}` };
  }
  const normalRate = finite(miner.recipe?.building_stats?.items_per_minute_at_normal_purity);
  const multiplier = PURITY_MULTIPLIER[purity];
  if (normalRate === null || normalRate <= 0 || !Number.isFinite(multiplier)) {
    return {
      resolved: false,
      reason: "the selected Miner's captured normal-purity extraction rate is unavailable",
    };
  }
  const collisionRadius = measuredCollisionRadius(graph, miner.building.class_path);
  if (collisionRadius === null) {
    return {
      resolved: false,
      reason: "no captured instance of the selected Miner proves its collision footprint",
    };
  }

  return {
    resolved: true,
    target_actor_id: target.actor_id,
    target_name: target.on ?? null,
    resource_class: resourceItem.class_path,
    resource_name: resourceItem.name ?? target.resource_name ?? resourceItem.class_path,
    purity,
    native_purity: nativePurity,
    anchor_recipe_class: anchors[0].recipe.class_path,
    anchor_name: anchors[0].item.name ?? anchors[0].recipe.name,
    miner_recipe_class: miner.recipe.class_path,
    miner_building_class: miner.building.class_path,
    miner_name: miner.item.name ?? miner.recipe.name,
    miner_tier: miner.tier,
    miner_output: output,
    miner_collision_radius_cm: collisionRadius,
    normal_rate_per_minute: normalRate,
    available_rate_per_minute: normalRate * multiplier,
    source:
      "aimed ordinary resource node + current unlock catalog + captured native class defaults and collision bounds",
    certainty: "exact_for_current_capture; destination Build Gun placement remains game-authoritative",
  };
}

/**
 * Add the resolved Anchor/Miner and one straight native belt to a one-machine
 * generated layout. The pair sits outside the front floor edge and the exact
 * wall cell intersected by the belt is omitted as an input aperture.
 */
export function attachAimedGeneratedBlueprintSource(graph, actions, source, {
  production_plan: production = null,
  shell = null,
  belt_recipe_class: beltRecipeClass = null,
} = {}) {
  if (!source?.resolved) {
    return { attached: false, reason: source?.reason ?? "the aimed source was not resolved" };
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return { attached: false, reason: "the generated factory action list is empty" };
  }
  if (!production?.planned || !Array.isArray(production.raw_inputs_required)) {
    return { attached: false, reason: "the production plan did not expose exact raw inputs" };
  }
  const requiredRaw = production.raw_inputs_required.filter(
    (entry) => finite(entry?.display_units_per_minute) > EPSILON,
  );
  if (requiredRaw.length !== 1 || !sameClass(requiredRaw[0].item_class, source.resource_class)) {
    return {
      attached: false,
      reason:
        "the generated factory must have exactly one raw input and it must be the aimed node's exact resource",
      raw_inputs: requiredRaw.map((entry) => ({
        item_class: entry.item_class ?? null,
        item_name: entry.item_name ?? null,
        rate_per_minute: finite(entry.display_units_per_minute),
      })),
    };
  }
  const requiredRate = finite(requiredRaw[0].display_units_per_minute);
  if (requiredRate === null || requiredRate > source.available_rate_per_minute + EPSILON) {
    return {
      attached: false,
      reason: `the selected ${source.miner_name} on this ${source.purity} node cannot supply the exact raw-input rate`,
      required_rate_per_minute: requiredRate,
      available_rate_per_minute: source.available_rate_per_minute,
    };
  }

  const transportActions = actions.filter((action) => action?.action === "place_belt");
  const machineActions = actions.filter(
    (action) => action?.action === "place_building" &&
      action?.generated_role === "machine" &&
      String(action?.production_recipe_class ?? "").trim(),
  );
  if (machineActions.length !== 1 || transportActions.length !== 0) {
    return {
      attached: false,
      reason:
        "automatic node sourcing currently requires exactly one production machine and no pre-existing material link; splitter or multi-stage topology is not inferred",
      production_machines: machineActions.length,
      existing_material_links: transportActions.length,
    };
  }
  const machineAction = machineActions[0];
  const productionRecipe = catalogEntryByClass(
    graph?.recipesByClass,
    machineAction.production_recipe_class,
  );
  if (!productionRecipe || !(productionRecipe.ingredients ?? []).some(
    (ingredient) => sameClass(ingredient?.item_class, source.resource_class),
  )) {
    return {
      attached: false,
      reason: "the only generated machine is not proven to consume the aimed resource",
    };
  }
  const machineMetadata = buildRecipeMetadata(graph, machineAction.recipe_class);
  const machineInput = nativeFactoryPort(machineMetadata?.building, "input");
  if (!machineMetadata || !machineInput.resolved) {
    return {
      attached: false,
      reason: `the generated machine cannot be aligned: ${machineInput.reason ?? "build recipe metadata is absent"}`,
    };
  }
  if (!beltRecipeClass) {
    return { attached: false, reason: "no unlocked conveyor recipe was selected for the resource input" };
  }
  const beltCapacity = observedBeltCapacity(graph, beltRecipeClass);
  if (!beltCapacity) {
    return {
      attached: false,
      reason: "no captured conveyor of the selected class proves its items-per-minute capacity",
    };
  }
  if (requiredRate > beltCapacity.items_per_minute + EPSILON) {
    return {
      attached: false,
      reason: "the selected conveyor cannot carry the exact raw-input rate",
      required_rate_per_minute: requiredRate,
      belt_capacity_per_minute: beltCapacity.items_per_minute,
    };
  }

  const footprint = shell?.footprint;
  const grid = shell?.grid;
  const origin = vector(footprint?.origin_cm);
  const cell = finite(grid?.cell_size_cm);
  const machineLocation = vector(machineAction.location);
  if (!origin || cell === null || cell <= 0 || !machineLocation) {
    return {
      attached: false,
      reason: "the housed layout lacks an exact shell origin, grid size, or machine transform",
    };
  }

  // The architecture planner's front edge is -Y. Rotate the sole machine so
  // its exact native input faces that edge; there are no downstream links to
  // invalidate in this deliberately narrow first topology.
  const towardSource = { x: 0, y: -1, z: 0 };
  const consumerYaw = yawAlign(machineInput.normal, towardSource);
  const consumerInputOffset = rotate(machineInput.location, consumerYaw);
  const inputPoint = add(machineLocation, consumerInputOffset);

  const minerOutputDirection = scale(towardSource, -1);
  const minerYaw = yawAlign(source.miner_output.normal, minerOutputDirection);
  const minerOutputOffset = rotate(source.miner_output.location, minerYaw);
  const frontFloorEdgeY = origin.y - cell / 2;
  let gap = cell;
  const minerCenterForGap = (distance) => subtract(
    add(inputPoint, scale(towardSource, distance)),
    minerOutputOffset,
  );
  let minerLocation = minerCenterForGap(gap);
  const maximumMinerY = minerLocation.y + source.miner_collision_radius_cm;
  if (maximumMinerY > frontFloorEdgeY - 1) {
    gap += maximumMinerY - (frontFloorEdgeY - 1);
    minerLocation = minerCenterForGap(gap);
  }

  const left = origin.x - cell / 2;
  const right = origin.x + finite(footprint.width_cm) - cell / 2;
  if (!Number.isFinite(left) || !Number.isFinite(right) || inputPoint.x < left || inputPoint.x > right) {
    return {
      attached: false,
      reason: "the aligned input belt does not cross the measured front edge of the shell",
    };
  }

  // Remove only the exact front-wall cell the straight input belt crosses. If
  // it is already the architecture planner's entrance cell, no wall exists and
  // nothing is removed.
  const frontWallY = origin.y - cell / 2;
  let removedWall = null;
  const frontWalls = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) =>
      action?.action === "place_building" && action?.generated_role === "wall" &&
      vector(action.location) && Math.abs(action.location.y - frontWallY) <= 1,
    )
    .sort((leftWall, rightWall) =>
      Math.abs(leftWall.action.location.x - inputPoint.x) -
        Math.abs(rightWall.action.location.x - inputPoint.x),
    );
  if (frontWalls[0] && Math.abs(frontWalls[0].action.location.x - inputPoint.x) <= cell / 2) {
    removedWall = frontWalls[0].index;
  }
  const withoutWall = actions.filter((_action, index) => index !== removedWall);
  const originalMachine = machineAction;
  const adjustedMachineIndex = withoutWall.indexOf(originalMachine);
  if (adjustedMachineIndex < 0) {
    return { attached: false, reason: "the adjusted generated machine step could not be resolved" };
  }
  const adjusted = withoutWall.map((action) =>
    action === originalMachine ? { ...action, yaw: consumerYaw } : { ...action },
  );
  const firstTransport = adjusted.findIndex((action) => action?.action !== "place_building");
  const buildingCount = firstTransport < 0 ? adjusted.length : firstTransport;
  if (adjusted.slice(buildingCount).some((action) => action?.action !== "place_belt")) {
    return { attached: false, reason: "generated source attachment requires buildings before transport actions" };
  }
  const consumerStep = adjustedMachineIndex + 1;

  const anchorStep = buildingCount + 1;
  const minerStep = buildingCount + 2;
  const commit = actions.some((action) => action?.commit === true);
  const anchorAction = {
    action: "place_building",
    recipe_class: source.anchor_recipe_class,
    location: minerLocation,
    exact_z: true,
    yaw: minerYaw,
    generated_role: "resource_anchor",
    resource_class: source.resource_class,
    resource_purity: source.native_purity,
    commit,
  };
  const minerAction = {
    action: "place_building",
    recipe_class: source.miner_recipe_class,
    location: minerLocation,
    exact_z: true,
    yaw: minerYaw,
    generated_role: "miner",
    target_step: anchorStep,
    commit,
  };
  const inputBelt = {
    action: "place_belt",
    recipe_class: beltCapacity.recipe_class,
    from_step: minerStep,
    to_step: consumerStep,
    from_connector_name: source.miner_output.name,
    to_connector_name: machineInput.name,
    commit,
  };
  const resultActions = [
    ...adjusted.slice(0, buildingCount),
    anchorAction,
    minerAction,
    ...adjusted.slice(buildingCount),
    inputBelt,
  ];

  return {
    attached: true,
    actions: resultActions,
    anchor_step: anchorStep,
    miner_step: minerStep,
    consumer_step: consumerStep,
    removed_front_wall: removedWall !== null,
    input_aperture_x_cm: inputPoint.x,
    straight_belt_length_cm: gap,
    required_rate_per_minute: requiredRate,
    available_rate_per_minute: source.available_rate_per_minute,
    belt_capacity_per_minute: beltCapacity.items_per_minute,
    connector_evidence: {
      miner_output: source.miner_output.name,
      consumer_input: machineInput.name,
      from_alignment: 1,
      to_alignment: -1,
    },
    source:
      "captured native connector defaults + exact recipe/raw-rate evidence + measured Miner collision radius + shell grid",
    certainty: "exact inputs to game-side staged bounds and native topology readback",
  };
}
