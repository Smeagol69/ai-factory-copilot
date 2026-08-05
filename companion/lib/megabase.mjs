/**
 * Preview-only megabase architecture compiler.
 *
 * A model may choose a style and proportions, but it never writes raw world
 * coordinates or engine class paths here. This module takes a factory layout
 * whose machine footprints were measured from the current save, expresses it
 * as integer grid cells, and compiles those cells into exact world transforms.
 *
 * The result is deliberately not executable. It is the declarative seam for a
 * future game-authoritative construction pipeline.
 */

import { FOUNDATION_CM } from "./designer.mjs";

export const MEGABASE_SCHEMA = "megabase.design/v1";

export const MEGABASE_STYLES = Object.freeze([
  "elevated_industrial_campus",
  "terraced_megafactory",
  "curvilinear_future_campus",
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
    const widthCm = positive(row?.machine_footprint_cm?.width);
    const depthCm = positive(row?.machine_footprint_cm?.depth);
    const measured = String(row?.footprint_measured_from ?? "").trim();
    const buildRecipe = String(row?.build_recipe_class ?? "").trim();
    if (machines === null || machines < 1 || widthCm === null || depthCm === null || !measured) {
      return {
        valid: false,
        reason: "every_machine_group_needs_a_measured_positive_footprint",
        row: row?.row ?? null,
      };
    }
    if (!buildRecipe) {
      return {
        valid: false,
        reason: "every_machine_group_needs_a_captured_build_recipe",
        row: row?.row ?? null,
      };
    }

    const machineWidthCells = Math.ceil(widthCm / unitCm);
    const machineDepthCells = Math.ceil(depthCm / unitCm);
    groups.push({
      id: `production-${groups.length + 1}`,
      row: whole(row.row) ?? groups.length + 1,
      produces: row.produces ?? null,
      machines,
      building_class: row.building_class ?? null,
      build_recipe_class: buildRecipe,
      machine_footprint_cm: { width: widthCm, depth: depthCm },
      machine_footprint_cells: { x: machineWidthCells, y: machineDepthCells },
      hall_size_cells: {
        x: Math.max(4, machineWidthCells * machines + marginCells * 2),
        y: Math.max(4, machineDepthCells + marginCells * 2),
      },
      measurement_source: measured,
    });
  }
  return { valid: true, groups };
}

function resolveSemanticRoles(partCatalog = {}) {
  const resolved = [];
  const unresolved = [];
  for (const role of SEMANTIC_ROLES) {
    const entry = partCatalog?.[role];
    const recipeClass = String(entry?.recipe_class ?? "").trim();
    if (entry?.source === "captured_game_catalog" && entry?.available === true && recipeClass) {
      resolved.push({
        role,
        recipe_class: recipeClass,
        item_class: entry.item_class ?? null,
        mod_reference: entry.mod_reference ?? null,
        source: entry.source,
      });
    } else {
      unresolved.push({
        role,
        reason: !entry
          ? "no_captured_part_selected_for_role"
          : entry.source !== "captured_game_catalog"
            ? "part_did_not_come_from_the_captured_game_catalog"
            : entry.available !== true
              ? "captured_part_is_not_available_in_this_save"
              : "captured_part_has_no_build_recipe",
      });
    }
  }
  return { resolved, unresolved };
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
  return { valid: issues.length === 0, issues };
}

function zonePlacements(groups, style, parameters) {
  const placements = [];
  let cursorY = 0;
  for (const [index, group] of groups.entries()) {
    const width = group.hall_size_cells.x;
    const depth = group.hall_size_cells.y;
    let x = -Math.floor(width / 2);
    let y = cursorY;
    let z = parameters.deck_floor;

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
    }

    placements.push({ group, local: { x, y, z }, size: { x: width, y: depth, z: parameters.hall_floors } });
    if (style !== "terraced_megafactory") cursorY += depth + parameters.hall_gap_cells;
  }
  return placements;
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
export function compileMegabaseConcept(factoryLayout, options = {}) {
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
  const program = normalizeProgram(factoryLayout, unitCm, parameters.service_margin_cells);
  if (!program.valid) return failed(program.reason, { row: program.row ?? null });

  const grid = { unit_cm: unitCm, floor_height_cm: floorHeightCm, yaw_degrees: yaw };
  const zones = zonePlacements(program.groups, style, parameters);
  const rawElements = [];
  const add = (id, kind, local, size, requires = [], extra = {}) => {
    rawElements.push({ id, kind, local, size, requires, ...extra });
  };

  for (const [index, zone] of zones.entries()) {
    const number = index + 1;
    add(
      `production-zone-${number}`,
      "production_zone",
      zone.local,
      zone.size,
      ["foundation", "wall", "lighting"],
      { program_group: zone.group.id, produces: zone.group.produces },
    );
    add(
      `platform-${number}`,
      "structural_platform",
      { x: zone.local.x - 1, y: zone.local.y - 1, z: Math.max(0, zone.local.z - 1) },
      { x: zone.size.x + 2, y: zone.size.y + 2, z: 1 },
      ["foundation"],
    );
    add(
      `facade-${number}`,
      "glazed_facade",
      { x: zone.local.x, y: zone.local.y - 1, z: zone.local.z },
      { x: zone.size.x, y: 1, z: zone.size.z },
      ["window", "wall"],
    );
    add(
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
        add(
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
    ["foundation", "wall", "window", "lighting"],
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
    world_yaw_degrees: yaw,
    requires_roles: element.requires,
    ...(element.program_group ? { program_group: element.program_group } : {}),
    ...(element.produces ? { produces: element.produces } : {}),
  }));

  const parts = resolveSemanticRoles(options.part_catalog);
  const manifest = {
    schema: MEGABASE_SCHEMA,
    compiled: true,
    status: "concept_only",
    style,
    anchor_cm: { x: Number(anchor.x), y: Number(anchor.y), z: Number(anchor.z) },
    grid,
    creative_parameters: parameters,
    program: {
      source: "measured_factory_layout",
      groups: program.groups,
    },
    elements,
    connections,
    part_resolution: parts,
    actions: [],
    construction_ready: false,
    construction_blockers: [
      "semantic_parts_must_resolve_to_available_captured_build_recipes",
      "complete_footprint_terrain_and_collision_preflight_has_not_run",
      "machine_logistics_power_and_circulation_are_not_routed",
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
  const validation = validateMegabaseManifest(manifest);
  return { ...manifest, validation };
}

