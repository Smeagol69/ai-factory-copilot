/**
 * Preview-only megabase architecture compiler.
 *
 * A model may choose a style and proportions, but it never writes raw world
 * coordinates or self-certify engine class paths here. This module takes a
 * factory layout whose machine footprints were measured from the current save,
 * expresses it as integer grid cells, and compiles those cells into exact world
 * transforms. Selected parts resolve only by matching the captured graph.
 *
 * The result is deliberately not executable. It is the declarative seam for a
 * future game-authoritative construction pipeline.
 */

import { createHash } from "node:crypto";
import { captureUnlockConstraints } from "./unlock-constraints.mjs";

export { captureUnlockConstraints } from "./unlock-constraints.mjs";

import { FOUNDATION_CM } from "./designer.mjs";

export const MEGABASE_SCHEMA = "megabase.design/v1";

export const MEGABASE_STYLES = Object.freeze([
  "elevated_industrial_campus",
  "terraced_megafactory",
  "curvilinear_future_campus",
  "radial_hub_campus",
]);

const STYLE_DEFAULTS = Object.freeze({
  elevated_industrial_campus: Object.freeze({
    deck_floor: 4,
    hall_floors: 2,
    hall_gap_cells: 3,
    service_margin_cells: 2,
    tower_width_cells: 8,
    tower_depth_cells: 8,
    tower_floors: 7,
  }),
  terraced_megafactory: Object.freeze({
    deck_floor: 0,
    hall_floors: 2,
    hall_gap_cells: 2,
    service_margin_cells: 2,
    terrace_step_cells: 2,
    terrace_level_floors: 2,
    tower_width_cells: 8,
    tower_depth_cells: 8,
    tower_floors: 6,
  }),
  curvilinear_future_campus: Object.freeze({
    deck_floor: 2,
    hall_floors: 2,
    hall_gap_cells: 3,
    service_margin_cells: 2,
    curve_amplitude_cells: 7,
    tower_width_cells: 9,
    tower_depth_cells: 9,
    tower_floors: 5,
  }),
  // The first family whose halls are not parallel to the campus grid.
  //
  // Every other style arranges axis-aligned boxes; even curvilinear_future_campus
  // only offsets boxes along a sine wave and rounds to whole cells. Here the
  // halls are arrayed about a centre and each one is rotated to face it, so the
  // composition reads as a rotunda rather than a row of sheds. The ring radius
  // is derived from the halls themselves rather than assumed, so the ring grows
  // with the factory instead of overlapping it.
  radial_hub_campus: Object.freeze({
    deck_floor: 2,
    hall_floors: 2,
    hall_gap_cells: 3,
    service_margin_cells: 3,
    // Extra breathing room between neighbouring halls on the ring, in cells.
    ring_clearance_cells: 2,
    // Degrees of arc the ring may not use, kept clear as an entrance.
    ring_entrance_degrees: 40,
    // 1 turns each hall's front toward the hub, -1 turns it outward.
    hall_facing: 1,
    tower_width_cells: 9,
    tower_depth_cells: 9,
    tower_floors: 8,
  }),
});

const SEMANTIC_ROLES = Object.freeze([
  "foundation",
  "support_column",
  "walkway",
  "rail",
  "wall",
  "window",
  "sloped_roof",
  "lighting",
]);

const MAX_COMMISSIONING_PHASES = 8;

const ROLE_NAME_PATTERNS = Object.freeze({
  foundation: Object.freeze(["foundation"]),
  support_column: Object.freeze(["pillar", "column", "support beam", "structural beam"]),
  walkway: Object.freeze(["walkway", "catwalk"]),
  rail: Object.freeze(["railing", "handrail"]),
  wall: Object.freeze(["wall"]),
  window: Object.freeze(["window", "glass wall", "glass frame"]),
  sloped_roof: Object.freeze(["roof"]),
  lighting: Object.freeze(["light", "lights", "lightbulb", "lamp", "floodlight"]),
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function whole(value) {
  const number = finite(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function failed(reason, details = {}) {
  return {
    schema: MEGABASE_SCHEMA,
    compiled: false,
    status: "concept_refused",
    reason,
    ...details,
    actions: [],
  };
}

function normalizeDesignFamilyId(value, style) {
  const familyId = String(value ?? style).trim();
  if (!familyId || familyId.length > 80 || /[\u0000-\u001f\u007f]/.test(familyId)) {
    return { valid: false, reason: "design_family_id_must_be_1_to_80_printable_characters" };
  }
  return { valid: true, family_id: familyId };
}

/**
 * Splits every measured production group into independently commissionable
 * machine allocations without changing the factory total.
 *
 * This deliberately does not divide rates arithmetically. A partially clocked
 * final machine can make two equal machine counts produce unequal rates, and
 * only the production solver has enough recipe evidence to size each phase.
 */
export function planCommissioningPhases(groups, requestedPhases = 1) {
  const phaseCount = whole(requestedPhases);
  if (phaseCount === null || phaseCount < 1 || phaseCount > MAX_COMMISSIONING_PHASES) {
    return {
      planned: false,
      reason: `commissioning_phases_must_be_a_whole_number_from_1_through_${MAX_COMMISSIONING_PHASES}`,
    };
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    return { planned: false, reason: "commissioning_requires_measured_production_groups" };
  }

  const smallestGroup = Math.min(...groups.map((group) => whole(group?.machines) ?? 0));
  if (phaseCount > smallestGroup) {
    return {
      planned: false,
      reason: "commissioning_phases_exceed_the_smallest_machine_group",
      requested_phases: phaseCount,
      smallest_machine_group: smallestGroup,
      effect:
        "At least one phase would omit a production stage, so it could not be called independently operable.",
    };
  }

  const phases = Array.from({ length: phaseCount }, (_unused, index) => ({
    id: `phase-${index + 1}`,
    sequence: index + 1,
    machine_groups: [],
  }));
  let identical = true;
  for (const group of groups) {
    const machines = whole(group.machines);
    const base = Math.floor(machines / phaseCount);
    const remainder = machines % phaseCount;
    if (remainder !== 0) identical = false;
    for (let index = 0; index < phaseCount; index += 1) {
      phases[index].machine_groups.push({
        program_group: group.id,
        produces: group.produces,
        machines: base + (index < remainder ? 1 : 0),
      });
    }
  }

  return {
    planned: true,
    requested_phases: phaseCount,
    phases,
    balanced_identical_machine_allocations: identical,
    exact_total_preserved: groups.every((group) =>
      phases.reduce(
        (sum, phase) => sum + phase.machine_groups.find((entry) => entry.program_group === group.id).machines,
        0,
      ) === group.machines),
    rate_allocation: "not_calculated_from_machine_counts",
    rate_allocation_reason:
      "Each phase must be re-solved deterministically because the last machine in a production step may be supply-limited or underclocked.",
    spatial_layout: "not_compiled",
    independence_requirements: [
      "dedicated_or_isolatable_input_trunks_per_phase",
      "dedicated_output_collection_per_phase",
      "separately_switchable_power_distribution_per_phase",
      "complete_internal_recipe_and_transport_path_per_phase",
      "game_readback_of_material_and_power_connectivity_before_phase_is_called_operational",
    ],
  };
}

function designFamilyIdentity(style, familyId, creativeParameters, parts) {
  const roleRecipes = Object.fromEntries(
    SEMANTIC_ROLES.map((role) => [
      role,
      parts.resolved.find((entry) => entry.role === role)?.recipe_class ?? null,
    ]),
  );
  const signature = {
    family_id: familyId,
    style_grammar: style,
    creative_parameters: creativeParameters,
    exact_role_recipes: roleRecipes,
  };
  return {
    family_id: familyId,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(signature)).digest("hex")}`,
    signature,
    complete: Object.values(roleRecipes).every(Boolean),
    reuse_contract:
      "Reuse this exact signature for related buildings. A different style parameter or role recipe is a new family revision, not the same theme.",
    unresolved_effect:
      Object.values(roleRecipes).some((value) => !value)
        ? "The theme is provisional because one or more semantic roles have no captured available recipe selection."
        : null,
  };
}

/** Converts an integer grid cell into an exact world-space point. */
export function gridPointToWorld(local, grid, anchor) {
  const x = whole(local?.x);
  const y = whole(local?.y);
  const z = whole(local?.z);
  const unit = positive(grid?.unit_cm);
  const floorHeight = positive(grid?.floor_height_cm);
  const yaw = finite(grid?.yaw_degrees);
  const anchorX = finite(anchor?.x);
  const anchorY = finite(anchor?.y);
  const anchorZ = finite(anchor?.z);
  if (
    x === null || y === null || z === null || unit === null ||
    floorHeight === null || yaw === null || anchorX === null ||
    anchorY === null || anchorZ === null
  ) {
    return null;
  }

  const radians = (yaw * Math.PI) / 180;
  const localX = x * unit;
  const localY = y * unit;
  return {
    x: round(anchorX + localX * Math.cos(radians) - localY * Math.sin(radians)),
    y: round(anchorY + localX * Math.sin(radians) + localY * Math.cos(radians)),
    z: round(anchorZ + z * floorHeight),
  };
}

function normalizeParameters(style, overrides = {}) {
  const defaults = STYLE_DEFAULTS[style];
  const parameters = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const supplied = overrides[name];
    const value = supplied === undefined ? fallback : whole(supplied);
    if (value === null || value < 0) {
      return { valid: false, reason: `creative_parameter_${name}_must_be_a_non_negative_integer` };
    }
    parameters[name] = value;
  }
  if (parameters.hall_floors < 1 || parameters.service_margin_cells < 1) {
    return { valid: false, reason: "hall_floors_and_service_margin_must_be_positive" };
  }
  if (parameters.tower_width_cells < 1 || parameters.tower_depth_cells < 1 || parameters.tower_floors < 1) {
    return { valid: false, reason: "tower_dimensions_must_be_positive" };
  }
  return { valid: true, parameters };
}

function normalizeProgram(factoryLayout, unitCm, marginCells) {
  if (factoryLayout?.designed !== true) {
    return { valid: false, reason: "factory_layout_must_be_successfully_designed_first" };
  }
  const rows = factoryLayout?.layout?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: false, reason: "factory_layout_has_no_measured_machine_rows" };
  }

  const groups = [];
  for (const row of rows) {
    const machines = whole(row?.machines);
    const productionStep = whole(row?.production_step);
    const machinesExact = positive(row?.machines_exact);
    const perMachineOutput = positive(row?.per_machine_output_rate_per_minute);
    const producesItemClass = String(row?.produces_item_class ?? "").trim();
    const producesRate = positive(row?.produces_rate_per_minute);
    const widthCm = positive(row?.machine_footprint_cm?.width);
    const depthCm = positive(row?.machine_footprint_cm?.depth);
    const heightCm = positive(row?.machine_footprint_cm?.height);
    const measured = String(row?.footprint_measured_from ?? "").trim();
    const buildRecipe = String(row?.build_recipe_class ?? "").trim();
    const productionRecipe = String(row?.production_recipe_class ?? "").trim();
    if (
      machines === null || machines < 1 || productionStep === null ||
      productionStep < 1 || machinesExact === null || machinesExact > machines ||
      perMachineOutput === null || !producesItemClass || producesRate === null ||
      widthCm === null || depthCm === null || heightCm === null || !measured
    ) {
      return {
        valid: false,
        reason: "every_machine_group_needs_exact_production_rates_and_a_measured_positive_footprint",
        row: row?.row ?? null,
      };
    }
    if (!buildRecipe || !productionRecipe) {
      return {
        valid: false,
        reason: "every_machine_group_needs_captured_build_and_production_recipes",
        row: row?.row ?? null,
      };
    }

    const machineWidthCells = Math.ceil(widthCm / unitCm);
    const machineDepthCells = Math.ceil(depthCm / unitCm);
    const inputs = [];
    for (const input of row?.inputs_required ?? []) {
      const itemClass = String(input?.item_class ?? "").trim();
      const rate = positive(input?.rate_per_minute);
      if (!itemClass || rate === null) {
        return {
          valid: false,
          reason: "every_machine_group_input_needs_an_exact_item_and_positive_rate",
          row: row?.row ?? null,
        };
      }
      inputs.push({
        item_class: itemClass,
        item_name: String(input?.item_name ?? "").trim() || null,
        rate_per_minute: rate,
      });
    }
    const chain = Array.isArray(row?.production_chain)
      ? row.production_chain.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    groups.push({
      id: `production-${groups.length + 1}`,
      row: whole(row.row) ?? groups.length + 1,
      production_step: productionStep,
      produces: row.produces ?? null,
      produces_item_class: producesItemClass,
      produces_rate_per_minute: producesRate,
      machines,
      machines_exact: machinesExact,
      per_machine_output_rate_per_minute: perMachineOutput,
      inputs_required: inputs,
      production_chain: chain,
      building_class: row.building_class ?? null,
      build_recipe_class: buildRecipe,
      production_recipe_class: productionRecipe,
      machine_footprint_cm: { width: widthCm, depth: depthCm, height: heightCm },
      machine_footprint_cells: { x: machineWidthCells, y: machineDepthCells },
      hall_size_cells: {
        x: Math.max(4, machineWidthCells * machines + marginCells * 2),
        y: Math.max(4, machineDepthCells + marginCells * 2),
      },
      measurement_source: measured,
    });
  }
  const seenSteps = new Set();
  for (const group of groups) {
    if (seenSteps.has(group.production_step)) {
      return { valid: false, reason: "production_step_ids_must_be_unique" };
    }
    seenSteps.add(group.production_step);
  }
  const sameChain = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  const materialEdges = [];
  const externalInputs = [];
  const remainingOutputByGroup = new Map(
    groups.map((group) => [group.id, group.produces_rate_per_minute]),
  );
  for (const consumer of groups) {
    const producerChain = [...consumer.production_chain, consumer.production_recipe_class];
    for (const input of consumer.inputs_required) {
      const candidates = groups.filter((producer) =>
        producer.id !== consumer.id &&
        producer.produces_item_class === input.item_class &&
        sameChain(producer.production_chain, producerChain));
      if (candidates.length > 1) {
        return {
          valid: false,
          reason: "production_material_edge_has_multiple_producer_groups",
          consumer_group: consumer.id,
          item_class: input.item_class,
        };
      }
      const producer = candidates[0] ?? null;
      const producerRemaining = producer
        ? remainingOutputByGroup.get(producer.id) ?? 0
        : 0;
      const internalRate = round(Math.min(producerRemaining, input.rate_per_minute), 6);
      const externalRate = round(input.rate_per_minute - internalRate, 6);
      if (producer && internalRate > 0) {
        materialEdges.push({
          id: `material-edge-${materialEdges.length + 1}`,
          from_program_group: producer.id,
          to_program_group: consumer.id,
          item_class: input.item_class,
          item_name: input.item_name ?? producer.produces ?? null,
          required_rate_per_minute: internalRate,
          evidence:
            "exact production-chain provenance with rate bounded by the planned producer output",
        });
        remainingOutputByGroup.set(
          producer.id,
          round(Math.max(0, producerRemaining - internalRate), 6),
        );
      }
      if (externalRate > 0) {
        externalInputs.push({
          consumer_group: consumer.id,
          item_class: input.item_class,
          item_name: input.item_name,
          rate_per_minute: externalRate,
          evidence: producer
            ? "exact consumer demand minus the provenance-matched planned producer output"
            : "no provenance-matched producer exists in this compiled program",
        });
      }
    }
  }
  const externalOutputs = groups
    .map((group) => ({ group, rate: round(remainingOutputByGroup.get(group.id) ?? 0, 6) }))
    .filter(({ rate }) => rate > 0)
    .map(({ group, rate }) => ({
      producer_group: group.id,
      item_class: group.produces_item_class,
      item_name: group.produces ?? null,
      rate_per_minute: rate,
      evidence: "planned producer output minus every provenance-matched internal material edge",
    }));
  return {
    valid: true,
    groups,
    material_edges: materialEdges,
    external_inputs: externalInputs,
    external_outputs: externalOutputs,
  };
}

/**
 * Chooses a safe concept floor height from measured machines.
 *
 * One half-grid unit of service clearance is added above the tallest captured
 * machine, then the result is rounded upward to that half-grid. This is an
 * explicit architectural choice grounded by captured height, not a claim about
 * a wall part's dimensions or a hologram's clearance rules.
 */
export function deriveMegabaseFloorHeight(factoryLayout, { grid_unit_cm = FOUNDATION_CM } = {}) {
  const unit = positive(grid_unit_cm);
  if (unit === null) {
    return { derived: false, reason: "grid_unit_must_be_positive" };
  }
  const rows = factoryLayout?.layout?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { derived: false, reason: "factory_layout_has_no_machine_rows" };
  }
  const heights = rows.map((row) => positive(row?.machine_footprint_cm?.height));
  if (heights.some((height) => height === null)) {
    return {
      derived: false,
      reason: "every_machine_group_needs_a_measured_height",
      effect: "No vertical architecture was produced; an unknown machine height was not guessed.",
    };
  }
  const tallestMachineCm = Math.max(...heights);
  const verticalDesignModuleCm = unit / 2;
  return {
    derived: true,
    floor_height_cm:
      Math.ceil((tallestMachineCm + verticalDesignModuleCm) / verticalDesignModuleCm) *
      verticalDesignModuleCm,
    tallest_machine_cm: tallestMachineCm,
    service_clearance_cm: verticalDesignModuleCm,
    vertical_design_module_cm: verticalDesignModuleCm,
    source: "tallest_measured_machine_plus_one_half_grid_unit_rounded_up_to_the_half_grid",
  };
}

function resolveSemanticRoles(graph, selections = {}) {
  const capturedRecipes = new Map(
    (graph?.snapshot?.content?.recipes ?? [])
      .filter((recipe) => typeof recipe?.class_path === "string" && recipe.class_path)
      .map((recipe) => [recipe.class_path, recipe]),
  );
  const resolved = [];
  const unresolved = [];
  for (const role of SEMANTIC_ROLES) {
    const selectedRecipeClass = String(selections?.[role] ?? "").trim();
    const captured = capturedRecipes.get(selectedRecipeClass);
    if (captured?.available === true) {
      resolved.push({
        role,
        recipe_class: captured.class_path,
        recipe_name: captured.name ?? null,
        item_class: captured.products?.[0]?.item_class ?? null,
        mod_reference: captured.mod_reference ?? captured.mod_id ?? null,
        source: "captured_game_catalog",
      });
    } else {
      unresolved.push({
        role,
        selected_recipe_class: selectedRecipeClass || null,
        reason: !selectedRecipeClass
          ? "no_part_selected_for_role"
          : !captured
            ? "selected_recipe_is_not_in_the_captured_game_catalog"
            : "captured_part_is_not_available_in_this_save",
      });
    }
  }
  return { resolved, unresolved };
}

function containsWholePhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

/**
 * Finds bounded, name-evidenced candidates for each architectural role.
 *
 * This is discovery, not classification. A mod may call a control panel a
 * "light" or a decorative prop a "support"; the captured name proves only why
 * it was suggested. `behavior_verified` therefore stays false until a specific
 * adapter or the game's hologram supplies stronger evidence.
 */
export function findMegabasePartCandidates(graph, { limit_per_role = 5 } = {}) {
  const requestedLimit = whole(limit_per_role);
  const limit = Math.min(10, Math.max(1, requestedLimit ?? 5));
  const buildRecipes = (graph?.snapshot?.content?.recipes ?? []).filter((recipe) =>
    (recipe.produced_in ?? []).some((producer) => /(?:BP_)?BuildGun|FGBuildGun/i.test(String(producer))),
  );

  const candidatesByRole = {};
  const totalsByRole = {};
  for (const role of SEMANTIC_ROLES) {
    const phrases = ROLE_NAME_PATTERNS[role] ?? [];
    const grouped = new Map();
    for (const recipe of buildRecipes) {
      const product = recipe.products?.[0] ?? null;
      const displayText = `${recipe.name ?? ""} ${product?.item_name ?? ""}`;
      const pathText = `${recipe.class_path ?? ""} ${product?.item_class ?? ""}`;
      const displayMatches = phrases.filter((phrase) => containsWholePhrase(displayText, phrase));
      const pathMatches = phrases.filter((phrase) => containsWholePhrase(pathText, phrase));
      const matched = [...new Set([...displayMatches, ...pathMatches])];
      if (matched.length === 0) continue;
      const roleFitPenalty = role === "sloped_roof" && containsWholePhrase(displayText, "flat roof") ? 50 : 0;
      const ownerMod = recipe.owner_mod ?? null;
      const displayName = product?.item_name ?? recipe.name ?? recipe.class_path;
      const groupKey = `${String(ownerMod ?? "").toLowerCase()}|${String(displayName).toLowerCase()}`;
      const candidate = {
        role,
        recipe_class: recipe.class_path,
        recipe_name: recipe.name ?? null,
        product_item_class: product?.item_class ?? null,
        product_name: product?.item_name ?? null,
        owner_mod: ownerMod,
        registrar_mod: recipe.registrar_mod ?? null,
        available: recipe.available === true,
        matched_name_terms: matched,
        match_scope: displayMatches.length > 0 ? "display_name" : "class_path_only",
        name_match_score: displayMatches.length * 100 + pathMatches.length * 10 - roleFitPenalty,
        variant_count: 1,
        evidence:
          displayMatches.length > 0
            ? "captured Build Gun recipe/product display name matched the semantic role terms"
            : "captured Build Gun recipe/product class path matched the semantic role terms",
        certainty: "name_match_candidate_only",
        behavior_verified: false,
      };
      const existing = grouped.get(groupKey);
      if (!existing) {
        grouped.set(groupKey, candidate);
      } else {
        const variantCount = existing.variant_count + 1;
        const candidateRanksHigher =
          Number(candidate.available) > Number(existing.available) ||
          (candidate.available === existing.available && candidate.name_match_score > existing.name_match_score);
        grouped.set(groupKey, candidateRanksHigher
          ? { ...candidate, variant_count: variantCount }
          : { ...existing, variant_count: variantCount });
      }
    }
    const matches = [...grouped.values()];
    matches.sort((left, right) =>
      Number(right.available) - Number(left.available) ||
      right.name_match_score - left.name_match_score ||
      String(left.owner_mod ?? "").localeCompare(String(right.owner_mod ?? "")) ||
      String(left.recipe_name ?? "").localeCompare(String(right.recipe_name ?? "")),
    );
    totalsByRole[role] = matches.length;
    candidatesByRole[role] = matches.slice(0, limit);
  }

  return {
    source: "captured_build_gun_recipe_catalog",
    certainty: "candidate_names_only_mod_behavior_not_inferred",
    limit_per_role: limit,
    totals_by_role: totalsByRole,
    candidates_by_role: candidatesByRole,
    note:
      "Candidates are suggestions grounded by captured names and availability. " +
      "Select an exact recipe deliberately; opaque mod behavior remains unknown until adapted or game-validated.",
  };
}

/** Exact union bounds of every declarative element in design and world space. */
export function megabaseFootprint(manifest) {
  const elements = manifest?.elements ?? [];
  if (elements.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const element of elements) {
    for (const axis of ["x", "y", "z"]) {
      min[axis] = Math.min(min[axis], element.local[axis]);
      max[axis] = Math.max(max[axis], element.local[axis] + element.size_cells[axis]);
    }
  }

  const corners = [
    { x: min.x, y: min.y, z: min.z },
    { x: min.x, y: max.y, z: min.z },
    { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: min.z },
  ].map((point) => gridPointToWorld(point, manifest.grid, manifest.anchor_cm));
  const worldMin = {
    x: Math.min(...corners.map((point) => point.x)),
    y: Math.min(...corners.map((point) => point.y)),
    z: manifest.anchor_cm.z + min.z * manifest.grid.floor_height_cm,
  };
  const worldMax = {
    x: Math.max(...corners.map((point) => point.x)),
    y: Math.max(...corners.map((point) => point.y)),
    z: manifest.anchor_cm.z + max.z * manifest.grid.floor_height_cm,
  };
  const sizeCells = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  return {
    local_min_cells: min,
    local_max_cells: max,
    size_cells: sizeCells,
    size_meters: {
      x: round((sizeCells.x * manifest.grid.unit_cm) / 100, 2),
      y: round((sizeCells.y * manifest.grid.unit_cm) / 100, 2),
      z: round((sizeCells.z * manifest.grid.floor_height_cm) / 100, 2),
    },
    world_aabb_cm: { min: worldMin, max: worldMax },
    note:
      "The world AABB encloses the rotated design. It is conservative for non-axis-aligned grids and is used only for captured-obstruction screening.",
  };
}

function boxesOverlap(left, right) {
  return (
    left.min.x < right.max.x && left.max.x > right.min.x &&
    left.min.y < right.max.y && left.max.y > right.min.y &&
    left.min.z < right.max.z && left.max.z > right.min.z
  );
}

/**
 * Screens a concept against captured bounds and terrain coverage.
 *
 * This cannot replace hologram checks: uncaptured actors and streamed-out
 * terrain remain unknown. Its value is that a known collision is found early,
 * and a 24 m terrain probe cannot be mistaken for evidence about a 120 m campus.
 */
export function assessMegabaseSite(graph, manifest) {
  const footprint = megabaseFootprint(manifest);
  if (!footprint) {
    return { assessed: false, reason: "manifest_has_no_elements", game_validation_pending: true };
  }
  const designBox = footprint.world_aabb_cm;
  const overlaps = [];
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node.kind !== "buildable") continue;
    const bounds = node.raw?.bounds;
    const origin = bounds?.origin;
    const extent = bounds?.extent;
    if (!origin || !extent) continue;
    if (![origin.x, origin.y, origin.z, extent.x, extent.y, extent.z].every(Number.isFinite)) continue;
    if (extent.x <= 0 || extent.y <= 0 || extent.z <= 0) continue;
    const actorBox = {
      min: { x: origin.x - Math.abs(extent.x), y: origin.y - Math.abs(extent.y), z: origin.z - Math.abs(extent.z) },
      max: { x: origin.x + Math.abs(extent.x), y: origin.y + Math.abs(extent.y), z: origin.z + Math.abs(extent.z) },
    };
    if (boxesOverlap(designBox, actorBox)) {
      overlaps.push({ actor_id: node.actor_id, name: node.name, class_path: node.class_path });
    }
  }

  const samples = [];
  const atScanCenter = graph?.snapshot?.terrain?.at_scan_center;
  const scanCenter = graph?.snapshot?.world?.scan_center ??
    graph?.snapshot?.interaction_context?.player?.pawn_location ?? null;
  if (atScanCenter && scanCenter) {
    samples.push({ terrain: atScanCenter, location: scanCenter, source_actor_id: null, source: "scan_center" });
  }
  for (const node of graph?.nodes?.values?.() ?? []) {
    if (node.raw?.terrain?.sampled && node.raw?.location) {
      samples.push({
        terrain: node.raw.terrain,
        location: node.raw.location,
        source_actor_id: node.actor_id,
        source: "captured_actor_terrain_probe",
      });
    }
  }
  samples.sort((left, right) => {
    const distance = (sample) => Math.hypot(
      sample.location.x - manifest.anchor_cm.x,
      sample.location.y - manifest.anchor_cm.y,
      sample.location.z - manifest.anchor_cm.z,
    );
    return distance(left) - distance(right);
  });
  const nearest = samples[0] ?? null;
  const anchorDistanceCm = nearest
    ? Math.hypot(
      nearest.location.x - manifest.anchor_cm.x,
      nearest.location.y - manifest.anchor_cm.y,
      nearest.location.z - manifest.anchor_cm.z,
    )
    : null;
  const anchorMatched = anchorDistanceCm !== null && anchorDistanceCm <= manifest.grid.unit_cm / 2;
  const measuredFootprintMeters = positive(nearest?.terrain?.footprint_meters) ??
    positive(graph?.snapshot?.terrain?.probe_footprint_meters);
  const requiredFootprintMeters = Math.max(footprint.size_meters.x, footprint.size_meters.y);
  const terrainCoversWholeDesign = Boolean(
    anchorMatched && nearest?.terrain?.sampled === true &&
    measuredFootprintMeters !== null && measuredFootprintMeters >= requiredFootprintMeters,
  );
  const terrainVerdict = anchorMatched ? nearest?.terrain?.verdict ?? null : null;

  let status = "unknown_terrain_coverage";
  if (overlaps.length > 0) status = "blocked_by_captured_buildings";
  else if (terrainCoversWholeDesign && ["over_water", "steep", "obstructed", "no_ground_found"].includes(terrainVerdict)) {
    status = `blocked_by_measured_terrain:${terrainVerdict}`;
  } else if (terrainCoversWholeDesign) {
    status = "no_captured_site_blocker_found_game_validation_still_required";
  }

  return {
    assessed: true,
    status,
    footprint,
    captured_building_overlaps: {
      count: overlaps.length,
      examples: overlaps.slice(0, 12),
      truncated: overlaps.length > 12,
      source: "captured_buildable_bounds",
    },
    terrain: {
      anchor_probe_found: anchorMatched,
      anchor_distance_cm: anchorDistanceCm === null ? null : round(anchorDistanceCm, 1),
      source: anchorMatched ? nearest.source : null,
      source_actor_id: anchorMatched ? nearest.source_actor_id : null,
      sampled: anchorMatched ? nearest.terrain?.sampled === true : false,
      verdict: terrainVerdict,
      measured_footprint_meters: measuredFootprintMeters,
      required_footprint_meters: requiredFootprintMeters,
      covers_whole_design: terrainCoversWholeDesign,
      unknown_reason: terrainCoversWholeDesign
        ? null
        : !anchorMatched
          ? "no_authoritative_terrain_probe_at_the_design_anchor"
          : nearest?.terrain?.sampled !== true
            ? "terrain_probe_at_anchor_was_not_sampled"
            : "terrain_probe_footprint_is_smaller_than_the_complete_design",
    },
    certainty: "authoritative_for_captured_bounds_and_reported_probe_coverage_only",
    game_validation_pending: true,
  };
}

function overlaps3d(left, right) {
  const a = left.local;
  const as = left.size_cells;
  const b = right.local;
  const bs = right.size_cells;
  return (
    a.x < b.x + bs.x && a.x + as.x > b.x &&
    a.y < b.y + bs.y && a.y + as.y > b.y &&
    a.z < b.z + bs.z && a.z + as.z > b.z
  );
}

/** Validates the declarative contract without consulting or mutating the game. */
export function validateMegabaseManifest(manifest) {
  const issues = [];
  if (manifest?.schema !== MEGABASE_SCHEMA) issues.push("schema_is_not_megabase_design_v1");
  if (!Array.isArray(manifest?.actions) || manifest.actions.length !== 0) {
    issues.push("a_preview_manifest_must_not_contain_actions");
  }
  if (manifest?.commissioning?.planned !== true) {
    issues.push("commissioning_plan_is_missing_or_unplanned");
  } else if (manifest.commissioning.exact_total_preserved !== true) {
    issues.push("commissioning_plan_does_not_preserve_machine_totals");
  }
  if (!manifest?.design_family?.family_id || !manifest?.design_family?.fingerprint) {
    issues.push("design_family_identity_is_missing");
  }
  if (
    manifest?.unlock_constraints?.availability_known === true &&
    !/^sha256:[0-9a-f]{64}$/.test(
      String(manifest.unlock_constraints.availability_fingerprint ?? ""),
    )
  ) {
    issues.push("authoritative_unlock_fingerprint_is_missing");
  }

  const ids = new Set();
  for (const element of manifest?.elements ?? []) {
    if (!element?.id || ids.has(element.id)) issues.push(`duplicate_or_missing_element_id:${element?.id ?? ""}`);
    ids.add(element?.id);
    for (const axis of ["x", "y", "z"]) {
      if (whole(element?.local?.[axis]) === null) issues.push(`non_integer_local_${axis}:${element?.id ?? ""}`);
      if (whole(element?.size_cells?.[axis]) === null || element.size_cells[axis] < 1) {
        issues.push(`invalid_size_${axis}:${element?.id ?? ""}`);
      }
    }
    const expected = gridPointToWorld(element.local, manifest.grid, manifest.anchor_cm);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(element.world_origin_cm)) {
      issues.push(`world_transform_mismatch:${element?.id ?? ""}`);
    }

    // Rotation is checked the same way the origin is: recomputed, not trusted.
    // An element may carry its own yaw offset, but its world yaw must still be
    // exactly the campus yaw plus that offset, so a manifest cannot claim a
    // rotation the compiler did not derive.
    const gridYaw = finite(manifest?.grid?.yaw_degrees);
    const offset = element?.yaw_offset_degrees === undefined
      ? 0
      : finite(element.yaw_offset_degrees);
    const worldYaw = finite(element?.world_yaw_degrees);
    if (offset === null || worldYaw === null || gridYaw === null) {
      issues.push(`non_finite_yaw:${element?.id ?? ""}`);
    } else if (offset < 0 || offset >= 360) {
      issues.push(`yaw_offset_must_be_0_to_under_360:${element?.id ?? ""}`);
    } else {
      const expectedYaw = offset ? normalizeDegrees(gridYaw + offset) : gridYaw;
      if (round(worldYaw) !== round(expectedYaw)) {
        issues.push(`world_yaw_mismatch:${element?.id ?? ""}`);
      }
    }
  }

  const zones = (manifest?.elements ?? []).filter((element) => element.kind === "production_zone");
  for (let left = 0; left < zones.length; left += 1) {
    for (let right = left + 1; right < zones.length; right += 1) {
      if (overlaps3d(zones[left], zones[right])) {
        issues.push(`production_zones_overlap:${zones[left].id}:${zones[right].id}`);
      }
    }
  }

  for (const connection of manifest?.connections ?? []) {
    if (!ids.has(connection.from) || !ids.has(connection.to)) {
      issues.push(`connection_endpoint_missing:${connection.id}`);
    }
    for (const segment of connection.segments ?? []) {
      if (!ids.has(segment)) issues.push(`connection_segment_missing:${connection.id}:${segment}`);
    }
  }
  const groupIds = new Set();
  const groupsById = new Map();
  for (const group of manifest?.program?.groups ?? []) {
    if (!group?.id || groupIds.has(group.id)) {
      issues.push(`duplicate_or_missing_program_group_id:${group?.id ?? ""}`);
    }
    groupIds.add(group?.id);
    groupsById.set(group?.id, group);
  }
  for (const zone of zones) {
    if (!groupIds.has(zone?.program_group)) {
      issues.push(`production_zone_program_group_missing:${zone?.id ?? ""}`);
    }
  }
  const materialEdges = manifest?.program?.material_edges;
  const externalInputs = manifest?.program?.external_inputs;
  const externalOutputs = manifest?.program?.external_outputs;
  if (!Array.isArray(materialEdges)) issues.push("program_material_edges_must_be_an_array");
  if (!Array.isArray(externalInputs)) issues.push("program_external_inputs_must_be_an_array");
  if (!Array.isArray(externalOutputs)) issues.push("program_external_outputs_must_be_an_array");
  const ratesMatch = (left, right) => Math.abs(Number(left) - Number(right)) <= 1e-6;
  const addRate = (map, key, rate) => map.set(key, (map.get(key) ?? 0) + rate);
  const incomingRates = new Map();
  const outgoingRates = new Map();
  const edgeIds = new Set();
  const edgeRoutes = new Set();
  for (const edge of materialEdges ?? []) {
    if (!edge?.id || edgeIds.has(edge.id)) {
      issues.push(`duplicate_or_missing_material_edge_id:${edge?.id ?? ""}`);
    }
    edgeIds.add(edge?.id);
    const routeKey = `${edge?.from_program_group ?? ""}|${edge?.to_program_group ?? ""}|${edge?.item_class ?? ""}`;
    if (edgeRoutes.has(routeKey)) issues.push(`duplicate_material_edge_route:${routeKey}`);
    edgeRoutes.add(routeKey);
    if (!groupIds.has(edge?.from_program_group) || !groupIds.has(edge?.to_program_group) ||
        edge.from_program_group === edge.to_program_group) {
      issues.push(`material_edge_endpoint_missing_or_invalid:${edge?.id ?? ""}`);
    }
    const edgeRate = positive(edge?.required_rate_per_minute);
    if (!String(edge?.item_class ?? "").trim() || edgeRate === null) {
      issues.push(`material_edge_item_or_rate_invalid:${edge?.id ?? ""}`);
    }
    const producer = groupsById.get(edge?.from_program_group);
    const consumer = groupsById.get(edge?.to_program_group);
    if (producer && consumer && edgeRate !== null) {
      const matchingInputs = (consumer.inputs_required ?? []).filter(
        (input) => input?.item_class === edge?.item_class,
      );
      const requiredInputRate = matchingInputs.reduce(
        (total, input) => total + (positive(input?.rate_per_minute) ?? 0),
        0,
      );
      const producerOutputRate = positive(producer?.produces_rate_per_minute);
      const expectedProducerChain = [
        ...(consumer.production_chain ?? []),
        consumer.production_recipe_class,
      ];
      if (producer.produces_item_class !== edge?.item_class || matchingInputs.length === 0 ||
          producerOutputRate === null || edgeRate > producerOutputRate + 1e-6 ||
          edgeRate > requiredInputRate + 1e-6 ||
          JSON.stringify(producer.production_chain ?? []) !== JSON.stringify(expectedProducerChain)) {
        issues.push(`material_edge_provenance_or_rate_mismatch:${edge?.id ?? ""}`);
      }
      addRate(incomingRates, `${consumer.id}|${edge.item_class}`, edgeRate);
      addRate(outgoingRates, `${producer.id}|${edge.item_class}`, edgeRate);
    }
  }
  const externalInputKeys = new Set();
  for (const input of externalInputs ?? []) {
    const consumer = groupsById.get(input?.consumer_group);
    const key = `${input?.consumer_group ?? ""}|${input?.item_class ?? ""}`;
    if (externalInputKeys.has(key)) issues.push(`duplicate_external_input:${key}`);
    externalInputKeys.add(key);
    const inputRate = positive(input?.rate_per_minute);
    if (!consumer || !String(input?.item_class ?? "").trim() || inputRate === null) {
      issues.push(`external_input_endpoint_item_or_rate_invalid:${key}`);
      continue;
    }
    const matchingInputs = (consumer.inputs_required ?? []).filter(
      (entry) => entry?.item_class === input.item_class,
    );
    const requiredInputRate = matchingInputs.reduce(
      (total, entry) => total + (positive(entry?.rate_per_minute) ?? 0),
      0,
    );
    if (matchingInputs.length === 0 || inputRate > requiredInputRate + 1e-6) {
      issues.push(`external_input_provenance_or_rate_mismatch:${key}`);
    }
    addRate(incomingRates, key, inputRate);
  }
  const externalOutputKeys = new Set();
  for (const output of externalOutputs ?? []) {
    const producer = groupsById.get(output?.producer_group);
    const key = `${output?.producer_group ?? ""}|${output?.item_class ?? ""}`;
    if (externalOutputKeys.has(key)) issues.push(`duplicate_external_output:${key}`);
    externalOutputKeys.add(key);
    const outputRate = positive(output?.rate_per_minute);
    const producerRate = positive(producer?.produces_rate_per_minute);
    if (!producer || !String(output?.item_class ?? "").trim() || outputRate === null) {
      issues.push(`external_output_endpoint_item_or_rate_invalid:${key}`);
      continue;
    }
    if (producer.produces_item_class !== output.item_class || producerRate === null ||
        outputRate > producerRate + 1e-6) {
      issues.push(`external_output_provenance_or_rate_mismatch:${key}`);
    }
    addRate(outgoingRates, key, outputRate);
  }
  for (const group of groupsById.values()) {
    const requiredByItem = new Map();
    for (const input of group?.inputs_required ?? []) {
      const itemClass = String(input?.item_class ?? "");
      addRate(requiredByItem, itemClass, positive(input?.rate_per_minute) ?? 0);
    }
    for (const [itemClass, requiredRate] of requiredByItem) {
      const key = `${group.id}|${itemClass}`;
      if (!ratesMatch(incomingRates.get(key) ?? 0, requiredRate)) {
        issues.push(`production_input_rate_is_not_fully_accounted:${key}`);
      }
    }
    const outputKey = `${group.id}|${group?.produces_item_class ?? ""}`;
    const producesRate = positive(group?.produces_rate_per_minute);
    if (producesRate === null ||
        !ratesMatch(outgoingRates.get(outputKey) ?? 0, producesRate ?? 0)) {
      issues.push(`production_output_rate_is_not_fully_accounted:${outputKey}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function zonePlacements(groups, style, parameters) {
  const placements = [];
  let cursorY = 0;
  // Ring geometry is derived from the halls, not assumed, so the ring grows
  // with the factory rather than overlapping it. Adjacent hall centres are a
  // chord apart; solving the chord for the radius is what guarantees the gap
  // actually exists at the ring rather than only at the hub.
  const ring = style === "radial_hub_campus" ? ringGeometry(groups, parameters) : null;

  for (const [index, group] of groups.entries()) {
    const width = group.hall_size_cells.x;
    const depth = group.hall_size_cells.y;
    let x = -Math.floor(width / 2);
    let y = cursorY;
    let z = parameters.deck_floor;
    let yawOffset = 0;

    if (style === "elevated_industrial_campus") {
      const side = index % 2 === 0 ? -1 : 1;
      x += side * (parameters.hall_gap_cells + Math.ceil(width / 3));
    } else if (style === "terraced_megafactory") {
      y = index * parameters.terrace_step_cells;
      z = parameters.deck_floor + index * parameters.terrace_level_floors;
    } else if (style === "curvilinear_future_campus") {
      const denominator = Math.max(1, groups.length - 1);
      const phase = (index / denominator) * Math.PI;
      x += Math.round(Math.sin(phase) * parameters.curve_amplitude_cells);
    } else if (ring) {
      const degrees = ring.start_degrees + index * ring.step_degrees;
      const radians = (degrees * Math.PI) / 180;
      // The hall's centre lands on the ring; its origin is the corner, which is
      // why the half-extents come off here rather than at emission.
      const centreX = Math.round(ring.radius_cells * Math.cos(radians));
      const centreY = Math.round(ring.radius_cells * Math.sin(radians));
      x = centreX - Math.floor(width / 2);
      y = centreY - Math.floor(depth / 2);
      // Local +Y is the hall's depth axis. Rotating by the ring angle plus a
      // quarter turn points that axis radially; facing 1 then turns the front
      // toward the hub, -1 leaves it looking outward.
      yawOffset = degrees + 90 + (parameters.hall_facing >= 0 ? 180 : 0);
    }

    placements.push({
      group,
      local: { x, y, z },
      size: { x: width, y: depth, z: parameters.hall_floors },
      ...(yawOffset ? { yaw_offset_degrees: normalizeDegrees(yawOffset) } : {}),
    });
    if (ring) continue;
    if (style !== "terraced_megafactory") cursorY += depth + parameters.hall_gap_cells;
  }
  return placements;
}

/** Degrees folded into [0, 360) so a manifest never carries 450 or -90. */
function normalizeDegrees(degrees) {
  const wrapped = degrees % 360;
  return round(wrapped < 0 ? wrapped + 360 : wrapped);
}

/**
 * Where the halls sit on the ring, and how big the ring has to be.
 *
 * The radius is whichever is larger of two independent requirements, because
 * satisfying one does not satisfy the other:
 *
 *   - neighbouring halls must not touch. Their centres are a chord apart, so
 *     radius = chord / (2 sin(half the angular step));
 *   - no hall may reach the hub, or the ring closes into a disc and the
 *     entrance and service margin have nothing to open onto.
 *
 * A single hall has no neighbour and no meaningful ring, so it is placed at the
 * hub radius and the caller still gets a valid, if unexciting, ring of one.
 */
function ringGeometry(groups, parameters) {
  const count = Math.max(1, groups.length);
  const widest = Math.max(...groups.map((group) => group.hall_size_cells.x), 1);
  const deepest = Math.max(...groups.map((group) => group.hall_size_cells.y), 1);

  const entrance = Math.min(180, Math.max(0, parameters.ring_entrance_degrees ?? 0));
  const usable = 360 - entrance;
  // With one hall the step is the whole usable arc; it is never zero, so the
  // sine below cannot divide by zero.
  const step = count > 1 ? usable / count : usable;

  const chord = widest + Math.max(0, parameters.ring_clearance_cells ?? 0);
  const halfStep = (step * Math.PI) / 360;
  const spacingRadius = count > 1 ? chord / (2 * Math.sin(halfStep)) : 0;
  const hubRadius = deepest + (parameters.service_margin_cells ?? 0);

  return {
    radius_cells: Math.max(Math.ceil(spacingRadius), hubRadius),
    step_degrees: step,
    // Centre the used arc so the entrance gap sits opposite the ring's middle.
    start_degrees: entrance / 2 + step / 2,
  };
}

function bridgeSegments(from, to, index) {
  const fromCenter = {
    x: from.local.x + Math.floor(from.size.x / 2),
    y: from.local.y + Math.floor(from.size.y / 2),
    z: from.local.z + 1,
  };
  const toCenter = {
    x: to.local.x + Math.floor(to.size.x / 2),
    y: to.local.y + Math.floor(to.size.y / 2),
    z: to.local.z + 1,
  };
  const z = Math.max(fromCenter.z, toCenter.z);
  const elements = [];
  const xStart = Math.min(fromCenter.x, toCenter.x);
  const xLength = Math.abs(toCenter.x - fromCenter.x) + 1;
  elements.push({
    id: `skybridge-${index}-x`,
    kind: "skybridge",
    local: { x: xStart, y: fromCenter.y, z },
    size: { x: xLength, y: 1, z: 1 },
    requires: ["walkway", "rail"],
  });
  if (fromCenter.y !== toCenter.y) {
    elements.push({
      id: `skybridge-${index}-y`,
      kind: "skybridge",
      local: { x: toCenter.x, y: Math.min(fromCenter.y, toCenter.y), z },
      size: { x: 1, y: Math.abs(toCenter.y - fromCenter.y) + 1, z: 1 },
      requires: ["walkway", "rail"],
    });
  }
  return elements;
}

/**
 * Compiles a measured factory layout into an architectural concept.
 *
 * `floor_height_cm` is mandatory because Satisfactory and modded wall sets can
 * use different vertical modules. It must come from the chosen captured parts;
 * silently assuming four metres would break the exact-coordinate contract.
 */
export function compileMegabaseConcept(graph, factoryLayout, options = {}) {
  const style = String(options.style ?? "").trim();
  if (!MEGABASE_STYLES.includes(style)) {
    return failed("style_must_be_one_of_the_supported_megabase_grammars", {
      supported_styles: [...MEGABASE_STYLES],
    });
  }

  const anchor = options.anchor_cm ?? factoryLayout?.origin;
  if ([anchor?.x, anchor?.y, anchor?.z].some((value) => finite(value) === null)) {
    return failed("anchor_requires_explicit_authoritative_x_y_and_z");
  }
  const unitCm = positive(options.grid_unit_cm ?? FOUNDATION_CM);
  const floorHeightCm = positive(options.floor_height_cm);
  const yaw = finite(options.yaw_degrees ?? factoryLayout?.base_grid?.yaw_degrees);
  if (unitCm === null || floorHeightCm === null || yaw === null) {
    return failed("grid_requires_positive_unit_floor_height_and_finite_yaw");
  }

  const normalizedParameters = normalizeParameters(style, options.creative_parameters);
  if (!normalizedParameters.valid) return failed(normalizedParameters.reason);
  const parameters = normalizedParameters.parameters;
  const normalizedFamily = normalizeDesignFamilyId(options.design_family_id, style);
  if (!normalizedFamily.valid) return failed(normalizedFamily.reason);
  const program = normalizeProgram(factoryLayout, unitCm, parameters.service_margin_cells);
  if (!program.valid) return failed(program.reason, { row: program.row ?? null });
  const commissioning = planCommissioningPhases(
    program.groups,
    options.commissioning_phases ?? 1,
  );
  if (!commissioning.planned) return failed(commissioning.reason, commissioning);

  const grid = { unit_cm: unitCm, floor_height_cm: floorHeightCm, yaw_degrees: yaw };
  const zones = zonePlacements(program.groups, style, parameters);
  const rawElements = [];
  const add = (id, kind, local, size, requires = [], extra = {}) => {
    rawElements.push({ id, kind, local, size, requires, ...extra });
  };

  for (const [index, zone] of zones.entries()) {
    // Every piece of one hall carries the hall's rotation. A facade or roof
    // left at the campus yaw while its zone turns would read as a bug, not a
    // design, and would be invisible until someone looked at the preview.
    const addPart = (id, kind, local, size, requires = [], extra = {}) =>
      add(id, kind, local, size, requires,
        zone.yaw_offset_degrees
          ? { ...extra, yaw_offset_degrees: zone.yaw_offset_degrees }
          : extra);
    const number = index + 1;
    const phaseMachineAllocation = commissioning.phases.map((phase) => ({
      phase_id: phase.id,
      machines: phase.machine_groups.find(
        (entry) => entry.program_group === zone.group.id,
      )?.machines ?? 0,
    }));
    addPart(
      `production-zone-${number}`,
      "production_zone",
      zone.local,
      zone.size,
      ["foundation", "wall"],
      {
        program_group: zone.group.id,
        produces: zone.group.produces,
        phase_machine_allocation: phaseMachineAllocation,
        optional_roles: ["lighting"],
      },
    );
    addPart(
      `platform-${number}`,
      "structural_platform",
      { x: zone.local.x - 1, y: zone.local.y - 1, z: Math.max(0, zone.local.z - 1) },
      { x: zone.size.x + 2, y: zone.size.y + 2, z: 1 },
      ["foundation"],
    );
    addPart(
      `facade-${number}`,
      "glazed_facade",
      { x: zone.local.x, y: zone.local.y - 1, z: zone.local.z },
      { x: zone.size.x, y: 1, z: zone.size.z },
      ["window", "wall"],
    );
    addPart(
      `roof-${number}`,
      "sloped_roof_intent",
      { x: zone.local.x, y: zone.local.y, z: zone.local.z + zone.size.z },
      { x: zone.size.x, y: zone.size.y, z: 1 },
      ["sloped_roof"],
    );

    const platformFloor = Math.max(0, zone.local.z - 1);
    if (platformFloor > 0) {
      const corners = [
        [zone.local.x - 1, zone.local.y - 1],
        [zone.local.x + zone.size.x, zone.local.y - 1],
        [zone.local.x - 1, zone.local.y + zone.size.y],
        [zone.local.x + zone.size.x, zone.local.y + zone.size.y],
      ];
      for (const [corner, [x, y]] of corners.entries()) {
        addPart(
          `support-${number}-${corner + 1}`,
          "support_pylon",
          { x, y, z: 0 },
          { x: 1, y: 1, z: platformFloor },
          ["support_column"],
        );
      }
    }
  }

  const connections = [];
  for (let index = 0; index < zones.length - 1; index += 1) {
    const segments = bridgeSegments(zones[index], zones[index + 1], index + 1);
    for (const segment of segments) {
      add(segment.id, segment.kind, segment.local, segment.size, segment.requires);
    }
    connections.push({
      id: `connection-${index + 1}`,
      kind: "skybridge",
      from: `production-zone-${index + 1}`,
      to: `production-zone-${index + 2}`,
      segments: segments.map((segment) => segment.id),
    });
  }

  const maxY = Math.max(...zones.map((zone) => zone.local.y + zone.size.y));
  const towerX = -Math.floor(parameters.tower_width_cells / 2);
  const towerZ = style === "terraced_megafactory"
    ? Math.max(...zones.map((zone) => zone.local.z + zone.size.z))
    : parameters.deck_floor;
  add(
    "central-tower",
    "vertical_landmark",
    { x: towerX, y: maxY + parameters.hall_gap_cells, z: towerZ },
    { x: parameters.tower_width_cells, y: parameters.tower_depth_cells, z: parameters.tower_floors },
    ["foundation", "wall", "window"],
    { optional_roles: ["lighting"] },
  );

  const elements = rawElements.map((element) => ({
    id: element.id,
    kind: element.kind,
    local: element.local,
    size_cells: element.size,
    world_origin_cm: gridPointToWorld(element.local, grid, anchor),
    world_size_cm: {
      x: element.size.x * unitCm,
      y: element.size.y * unitCm,
      z: element.size.z * floorHeightCm,
    },
    // The campus yaw plus this element's own rotation. Every previous style
    // left the offset undefined, so those manifests are byte-for-byte unchanged.
    world_yaw_degrees: element.yaw_offset_degrees
      ? normalizeDegrees(yaw + element.yaw_offset_degrees)
      : yaw,
    ...(element.yaw_offset_degrees
      ? { yaw_offset_degrees: element.yaw_offset_degrees }
      : {}),
    requires_roles: element.requires,
    ...(element.program_group ? { program_group: element.program_group } : {}),
    ...(element.produces ? { produces: element.produces } : {}),
    ...(element.phase_machine_allocation
      ? { phase_machine_allocation: element.phase_machine_allocation }
      : {}),
    ...(element.optional_roles ? { optional_roles: element.optional_roles } : {}),
  }));

  const parts = resolveSemanticRoles(graph, options.part_selections);
  const unlockConstraints = captureUnlockConstraints(graph);
  const designFamily = designFamilyIdentity(
    style,
    normalizedFamily.family_id,
    parameters,
    parts,
  );
  const requiredFamilyFingerprint = String(
    options.match_design_family_fingerprint ?? "",
  ).trim();
  if (
    requiredFamilyFingerprint &&
    !/^sha256:[0-9a-f]{64}$/.test(requiredFamilyFingerprint)
  ) {
    return failed("match_design_family_fingerprint_must_be_an_exact_sha256_fingerprint");
  }
  if (
    requiredFamilyFingerprint &&
    requiredFamilyFingerprint !== designFamily.fingerprint
  ) {
    return failed("design_family_signature_does_not_match_the_requested_family", {
      expected_fingerprint: requiredFamilyFingerprint,
      actual_fingerprint: designFamily.fingerprint,
      effect:
        "The proposed style parameters or captured role recipes differ, so this building was not labelled as the same theme.",
    });
  }
  const manifest = {
    schema: MEGABASE_SCHEMA,
    compiled: true,
    status: "concept_only",
    style,
    anchor_cm: { x: Number(anchor.x), y: Number(anchor.y), z: Number(anchor.z) },
    grid,
    creative_parameters: parameters,
    design_family: {
      ...designFamily,
      matched_required_fingerprint: requiredFamilyFingerprint || null,
    },
    commissioning,
    unlock_constraints: unlockConstraints,
    optimization: {
      method: "unlock_constrained_lexicographic_feasibility_then_multi_objective_scoring",
      hard_constraints: [
        "every_selected_recipe_is_proven_available_in_the_current_capture",
        "requested_output_and_explicit_tier_limits_are_preserved",
        "captured_machine_and_transport_capacities_are_not_exceeded",
        "no_unknown_coordinate_or_machine_dimension_is_invented",
        "the_game_must_accept_every_hologram_and_read_back_every_connection",
      ],
      soft_objectives_in_order: [
        "minimize_total_transport_length_bends_lifts_and_crossings",
        "minimize_footprint_without_removing_service_clearance",
        "minimize_machine_and_logistics_complexity",
        "preserve_independent_commissioning_and_expansion_space",
        "maximize_design_family_cohesion",
      ],
      recalculated_from_this_capture: {
        production_recipe_selection: true,
        machine_counts: true,
        architectural_part_candidates: true,
        placement_geometry: true,
        internal_material_dependencies: true,
        transport_routing: false,
      },
      transport_routing_effect:
        "Transport routing remains a construction blocker and must be recalculated from current connector occupancy, unlocked transports, capacities, terrain, and obstructions immediately before action compilation.",
    },
    program: {
      source: "measured_factory_layout",
      groups: program.groups,
      material_edges: program.material_edges,
      external_inputs: program.external_inputs,
      external_outputs: program.external_outputs,
    },
    elements,
    connections,
    part_resolution: parts,
    part_candidates: findMegabasePartCandidates(graph),
    actions: [],
    construction_ready: false,
    construction_blockers: [
      ...(!unlockConstraints.availability_known
        ? ["complete_current_recipe_availability_was_not_captured"]
        : []),
      "semantic_parts_must_resolve_to_available_captured_build_recipes",
      "complete_footprint_terrain_and_collision_preflight_has_not_run",
      "machine_logistics_power_and_circulation_are_not_routed",
      "commissioning_phase_rates_and_spatial_isolation_have_not_been_compiled",
      "game_holograms_have_not_validated_the_elements",
      "transactional_construction_and_world_readback_have_not_run",
    ],
    provenance: {
      coordinates: "integer_design_cells_compiled_from_the_authoritative_anchor_and_grid",
      machine_geometry: "measured_factory_layout",
      creative_geometry: "explicit_style_grammar_and_parameters",
      part_recipes: "captured_game_catalog_only",
    },
  };
  manifest.footprint = megabaseFootprint(manifest);
  manifest.site_assessment = assessMegabaseSite(graph, manifest);
  const validation = validateMegabaseManifest(manifest);
  return { ...manifest, validation };
}
