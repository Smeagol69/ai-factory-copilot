/**
 * Fail-closed AI Architect -> generated native Blueprint adapter.
 *
 * `megabase.design/v1` is deliberately semantic: a volume marked "tower" is
 * not permission to invent hundreds of walls, floors and lights. This module
 * is the explicit boundary where each semantic element must have a proven,
 * deterministic native placement adapter before the existing game-authority
 * serializer may see it.
 *
 * Every currently emitted massing kind has a deliberately narrow adapter:
 * platforms, configured production machines, facade modules, roof tiles,
 * supports, one-cell orthogonal bridges, and landmark floors/perimeters. Each
 * exact selected recipe, class, dimension, footprint and fit must be proven.
 * Unsupported future elements stay blockers; they are never omitted from a
 * supposedly complete promotion.
 */

import { parsePieceDimensions } from "./architecture.mjs";
import { compileArchitectConveyors } from "./architect-topology.mjs";
import { fingerprintArchitectManifest } from "./architect-revisions.mjs";
import { compileGeneratedBlueprint, generatedBlueprintAction } from "./generated-blueprints.mjs";
import { captureUnlockConstraints, gridPointToWorld, validateMegabaseManifest } from "./megabase.mjs";

export const ARCHITECT_PROMOTION_SCHEMA = "ai-architect.promotion/v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_ELEMENT_KINDS = new Set([
  "structural_platform",
  "production_zone",
  "glazed_facade",
  "sloped_roof_intent",
  "support_pylon",
  "skybridge",
  "vertical_landmark",
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, maximum) {
  const text = String(value ?? "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= maximum ? text : null;
}

function buildGunProduced(recipe) {
  return (recipe?.produced_in ?? []).some((producer) =>
    /(?:BP_)?BuildGun|FGBuildGun/i.test(String(producer)),
  );
}

function itemByClass(graph, classPath) {
  if (!classPath) return null;
  const exact = graph?.itemsByClass?.get?.(classPath);
  if (exact) return exact;
  return (graph?.snapshot?.content?.items ?? []).find((item) => item?.class_path === classPath) ?? null;
}

function recipeByClass(graph, classPath) {
  if (!classPath) return null;
  const exact = graph?.recipesByClass?.get?.(classPath);
  if (exact) return exact;
  return (graph?.snapshot?.content?.recipes ?? []).find(
    (recipe) => recipe?.class_path === classPath,
  ) ?? null;
}

function descriptorShortName(classPath) {
  return String(classPath ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

function requiredRoles(manifest) {
  return [...new Set(
    (manifest?.elements ?? []).flatMap((element) =>
      Array.isArray(element?.requires_roles) ? element.requires_roles : []),
  )].sort();
}

function classifyRole(graph, manifest, role, resolution) {
  if (!resolution) {
    return {
      ok: false,
      reason: `architect_required_role_is_unresolved:${role}`,
    };
  }
  const recipeClass = String(resolution.recipe_class ?? "").trim();
  const recipe = recipeByClass(graph, recipeClass);
  if (!recipe) {
    return { ok: false, reason: `architect_role_recipe_is_not_in_current_catalog:${role}` };
  }
  if (recipe.available !== true) {
    return { ok: false, reason: `architect_role_recipe_is_not_currently_unlocked:${role}` };
  }
  if (!buildGunProduced(recipe)) {
    return { ok: false, reason: `architect_role_recipe_is_not_a_build_gun_recipe:${role}` };
  }
  const product = recipe.products?.[0] ?? null;
  const item = itemByClass(graph, product?.item_class);
  const buildableClass = String(item?.building?.class_path ?? "").trim();
  if (!item || !buildableClass) {
    return { ok: false, reason: `architect_role_recipe_has_no_captured_buildable_class:${role}` };
  }

  const descriptor = descriptorShortName(item.class_path ?? product?.item_class);
  const dimensions = parsePieceDimensions(descriptor);
  const hasPositiveDimensions = dimensions &&
    Number(dimensions.width_cm) > 0 && Number(dimensions.height_cm) > 0;
  const gridUnit = finite(manifest?.grid?.unit_cm);
  const floorHeight = finite(manifest?.grid?.floor_height_cm);
  if (role === "foundation") {
    if (!/^Desc_Foundation_/i.test(descriptor) || !hasPositiveDimensions) {
      return {
        ok: false,
        reason: "architect_foundation_descriptor_dimensions_are_not_proven",
        descriptor,
      };
    }
    if (gridUnit === null || dimensions.width_cm !== gridUnit) {
      return {
        ok: false,
        reason: "architect_foundation_width_does_not_match_manifest_grid",
        descriptor,
        foundation_width_cm: dimensions.width_cm,
        grid_unit_cm: gridUnit,
      };
    }
    return {
      ok: true,
      role,
      native_role: "floor",
      recipe_class: recipe.class_path ?? recipeClass,
      item_class: item.class_path ?? product.item_class,
      buildable_class: buildableClass,
      descriptor,
      dimensions,
      source: "current_captured_unlocked_build_gun_recipe_and_descriptor_dimensions",
    };
  }

  if (role === "wall" || role === "window") {
    const text = `${descriptor} ${recipe.name ?? ""} ${item.name ?? ""}`;
    const semanticMatch = role === "window"
      ? /(?:Window|Glass)/i.test(text)
      : /Wall/i.test(text);
    if (!semanticMatch || !hasPositiveDimensions) {
      return {
        ok: false,
        reason: `architect_${role}_descriptor_dimensions_are_not_proven`,
        descriptor,
      };
    }
    if (gridUnit === null || floorHeight === null ||
        dimensions.width_cm !== gridUnit ||
        dimensions.height_cm > floorHeight ||
        floorHeight % dimensions.height_cm !== 0) {
      return {
        ok: false,
        reason: `architect_${role}_dimensions_do_not_match_manifest_grid`,
        descriptor,
        captured_dimensions: dimensions,
        grid_unit_cm: gridUnit,
        floor_height_cm: floorHeight,
      };
    }
    return {
      ok: true,
      role,
      native_role: "wall",
      recipe_class: recipe.class_path ?? recipeClass,
      item_class: item.class_path ?? product.item_class,
      buildable_class: buildableClass,
      descriptor,
      dimensions,
      source: "current_captured_unlocked_build_gun_recipe_and_descriptor_dimensions",
    };
  }

  if (role === "sloped_roof") {
    const text = `${descriptor} ${recipe.name ?? ""} ${item.name ?? ""}`;
    if (!/Roof/i.test(text) || !hasPositiveDimensions) {
      return {
        ok: false,
        reason: "architect_sloped_roof_descriptor_dimensions_are_not_proven",
        descriptor,
      };
    }
    if (gridUnit === null || dimensions.width_cm !== gridUnit) {
      return {
        ok: false,
        reason: "architect_sloped_roof_width_does_not_match_manifest_grid",
        descriptor,
        captured_dimensions: dimensions,
        grid_unit_cm: gridUnit,
      };
    }
    return {
      ok: true,
      role,
      native_role: "roof",
      recipe_class: recipe.class_path ?? recipeClass,
      item_class: item.class_path ?? product.item_class,
      buildable_class: buildableClass,
      descriptor,
      dimensions,
      source: "current_captured_unlocked_build_gun_recipe_and_descriptor_dimensions",
    };
  }

  if (["support_column", "walkway", "rail"].includes(role)) {
    const text = `${descriptor} ${recipe.name ?? ""} ${item.name ?? ""}`;
    const semanticPattern = role === "support_column"
      ? /(?:Pillar|Column|Support|StructuralBeam)/i
      : role === "walkway"
        ? /(?:Walkway|Catwalk)/i
        : /(?:Railing|Handrail|Rail)/i;
    if (!semanticPattern.test(text) || !hasPositiveDimensions) {
      return {
        ok: false,
        reason: `architect_${role}_descriptor_dimensions_are_not_proven`,
        descriptor,
      };
    }
    const dimensionsMatch = role === "support_column"
      ? dimensions.width_cm <= gridUnit &&
        dimensions.height_cm <= floorHeight &&
        floorHeight % dimensions.height_cm === 0
      : dimensions.width_cm === gridUnit && dimensions.height_cm <= floorHeight;
    if (gridUnit === null || floorHeight === null || !dimensionsMatch) {
      return {
        ok: false,
        reason: `architect_${role}_dimensions_do_not_match_manifest_grid`,
        descriptor,
        captured_dimensions: dimensions,
        grid_unit_cm: gridUnit,
        floor_height_cm: floorHeight,
      };
    }
    return {
      ok: true,
      role,
      native_role: role === "support_column" ? "pillar" : (role === "walkway" ? "floor" : "wall"),
      recipe_class: recipe.class_path ?? recipeClass,
      item_class: item.class_path ?? product.item_class,
      buildable_class: buildableClass,
      descriptor,
      dimensions,
      source: "current_captured_unlocked_build_gun_recipe_and_descriptor_dimensions",
    };
  }

  return {
    ok: false,
    reason: `architect_role_has_no_native_placement_adapter:${role}`,
    recipe_class: recipe.class_path ?? recipeClass,
    buildable_class: buildableClass,
  };
}

function compilePlatformActions(manifest, elements, foundation) {
  const actions = [];
  for (const element of elements) {
    for (let x = 0; x < element.size_cells.x; x += 1) {
      for (let y = 0; y < element.size_cells.y; y += 1) {
        const cell = {
          x: element.local.x + x,
          y: element.local.y + y,
          z: element.local.z,
        };
        const world = gridPointToWorld(cell, manifest.grid, manifest.anchor_cm);
        if (!world) {
          return {
            ok: false,
            reason: "architect_platform_cell_world_transform_is_invalid",
            element_id: element.id,
            cell,
          };
        }
        actions.push({
          action: "place_building",
          recipe_class: foundation.recipe_class,
          location: {
            ...world,
            z: world.z + element.size_cells.z * manifest.grid.floor_height_cm -
              foundation.dimensions.height_cm,
          },
          exact_z: true,
          yaw: manifest.grid.yaw_degrees,
          generated_role: "floor",
          commit: false,
        });
      }
    }
  }
  return { ok: true, actions };
}

function classifyMachineGroup(graph, group) {
  const groupId = String(group?.id ?? "").trim();
  const machines = Number(group?.machines);
  const buildRecipeClass = String(group?.build_recipe_class ?? "").trim();
  const productionRecipeClass = String(group?.production_recipe_class ?? "").trim();
  const footprint = group?.machine_footprint_cm ?? null;
  const footprintCells = group?.machine_footprint_cells ?? null;
  if (!groupId || !Number.isInteger(machines) || machines < 1) {
    return { ok: false, reason: "architect_production_group_identity_or_machine_count_is_invalid" };
  }
  if (![footprint?.width, footprint?.depth, footprint?.height].every((value) =>
    finite(value) !== null && Number(value) > 0)) {
    return { ok: false, reason: `architect_production_group_footprint_is_not_measured:${groupId}` };
  }
  if (![footprintCells?.x, footprintCells?.y].every((value) =>
    Number.isInteger(Number(value)) && Number(value) > 0)) {
    return { ok: false, reason: `architect_production_group_grid_footprint_is_invalid:${groupId}` };
  }
  const buildRecipe = recipeByClass(graph, buildRecipeClass);
  if (!buildRecipe || buildRecipe.available !== true || !buildGunProduced(buildRecipe)) {
    return { ok: false, reason: `architect_machine_build_recipe_is_not_currently_proven:${groupId}` };
  }
  const buildItem = itemByClass(graph, buildRecipe.products?.[0]?.item_class);
  const buildableClass = String(buildItem?.building?.class_path ?? "").trim();
  if (!buildableClass) {
    return { ok: false, reason: `architect_machine_buildable_class_is_not_captured:${groupId}` };
  }
  if (!productionRecipeClass) {
    return { ok: false, reason: `architect_production_recipe_is_missing_from_manifest:${groupId}` };
  }
  const productionRecipe = recipeByClass(graph, productionRecipeClass);
  if (!productionRecipe || productionRecipe.available !== true) {
    return { ok: false, reason: `architect_production_recipe_is_not_currently_unlocked:${groupId}` };
  }
  const compatible = (productionRecipe.produced_in ?? []).some((producer) => {
    const candidate = String(producer);
    return candidate === buildableClass ||
      candidate.split(".").pop() === buildableClass.split(".").pop();
  });
  if (!compatible) {
    return {
      ok: false,
      reason: `architect_production_recipe_is_not_compatible_with_machine:${groupId}`,
      production_recipe_class: productionRecipe.class_path ?? productionRecipeClass,
      buildable_class: buildableClass,
    };
  }
  return {
    ok: true,
    group_id: groupId,
    machines,
    build_recipe_class: buildRecipe.class_path ?? buildRecipeClass,
    production_recipe_class: productionRecipe.class_path ?? productionRecipeClass,
    buildable_class: buildableClass,
    machine_footprint_cm: {
      width: Number(footprint.width),
      depth: Number(footprint.depth),
      height: Number(footprint.height),
    },
    machine_footprint_cells: {
      x: Number(footprintCells.x),
      y: Number(footprintCells.y),
    },
    source: "current_captured_unlocks_and_manifest_measured_machine_geometry",
  };
}

function rotatedWorldOffset(origin, dx, dy, yawDegrees) {
  const radians = (yawDegrees * Math.PI) / 180;
  const rounded = (value) => Math.round(value * 1_000) / 1_000;
  return {
    x: rounded(origin.x + dx * Math.cos(radians) - dy * Math.sin(radians)),
    y: rounded(origin.y + dx * Math.sin(radians) + dy * Math.cos(radians)),
    z: origin.z,
  };
}

function compileMachineActions(manifest, elements, machineEvidence) {
  const actions = [];
  const unit = Number(manifest.grid.unit_cm);
  const yaw = Number(manifest.grid.yaw_degrees);
  for (const element of elements) {
    const evidence = machineEvidence[element.program_group];
    if (!evidence?.ok) {
      return {
        ok: false,
        reason: evidence?.reason ?? "architect_production_zone_group_evidence_is_missing",
        element_id: element.id,
      };
    }
    const occupiedWidthCells = evidence.machine_footprint_cells.x * evidence.machines;
    const remainingX = element.size_cells.x - occupiedWidthCells;
    const remainingY = element.size_cells.y - evidence.machine_footprint_cells.y;
    if (remainingX < 0 || remainingY < 0) {
      return {
        ok: false,
        reason: "architect_production_machines_do_not_fit_the_semantic_zone",
        element_id: element.id,
        required_cells: {
          x: occupiedWidthCells,
          y: evidence.machine_footprint_cells.y,
        },
        available_cells: {
          x: element.size_cells.x,
          y: element.size_cells.y,
        },
      };
    }
    const origin = element.world_origin_cm;
    for (let index = 0; index < evidence.machines; index += 1) {
      const localCenterX = (
        remainingX / 2 +
        index * evidence.machine_footprint_cells.x +
        evidence.machine_footprint_cells.x / 2
      ) * unit;
      const localCenterY = (
        remainingY / 2 + evidence.machine_footprint_cells.y / 2
      ) * unit;
      const world = rotatedWorldOffset(origin, localCenterX, localCenterY, yaw);
      actions.push({
        action: "place_building",
        recipe_class: evidence.build_recipe_class,
        production_recipe_class: evidence.production_recipe_class,
        architect_group_id: evidence.group_id,
        location: world,
        exact_z: true,
        yaw,
        generated_role: "machine",
        commit: false,
      });
    }
  }
  return { ok: true, actions };
}

function compileFacadeActions(manifest, elements, roleEvidence) {
  const actions = [];
  if (elements.length === 0) return { ok: true, actions };
  const unit = Number(manifest.grid.unit_cm);
  const floorHeight = Number(manifest.grid.floor_height_cm);
  const yaw = Number(manifest.grid.yaw_degrees);
  const wall = roleEvidence.wall;
  const window = roleEvidence.window;
  const verticalSegmentsPerFloor = floorHeight / wall.dimensions.height_cm;
  if (!Number.isInteger(verticalSegmentsPerFloor) ||
      window.dimensions.height_cm !== wall.dimensions.height_cm) {
    return {
      ok: false,
      reason: "architect_facade_wall_and_window_vertical_modules_do_not_match",
    };
  }
  for (const element of elements) {
    if (element.size_cells.x < 3) {
      return {
        ok: false,
        reason: "architect_glazed_facade_needs_three_cells_for_wall_frames_and_window",
        element_id: element.id,
      };
    }
    for (let level = 0; level < element.size_cells.z; level += 1) {
      for (let segment = 0; segment < verticalSegmentsPerFloor; segment += 1) {
        for (let column = 0; column < element.size_cells.x; column += 1) {
          const frame = column === 0 || column === element.size_cells.x - 1;
          const selected = frame ? wall : window;
          const world = rotatedWorldOffset(
            {
              x: element.world_origin_cm.x,
              y: element.world_origin_cm.y,
              z: element.world_origin_cm.z + level * floorHeight +
                segment * wall.dimensions.height_cm,
            },
            column * unit,
            unit / 2,
            yaw,
          );
          actions.push({
            action: "place_building",
            recipe_class: selected.recipe_class,
            location: world,
            exact_z: true,
            yaw,
            generated_role: "wall",
            commit: false,
          });
        }
      }
    }
  }
  return { ok: true, actions };
}

function compileRoofActions(manifest, elements, roleEvidence) {
  const actions = [];
  if (elements.length === 0) return { ok: true, actions };
  const unit = Number(manifest.grid.unit_cm);
  const yaw = Number(manifest.grid.yaw_degrees);
  const roof = roleEvidence.sloped_roof;
  for (const element of elements) {
    for (let x = 0; x < element.size_cells.x; x += 1) {
      for (let y = 0; y < element.size_cells.y; y += 1) {
        const world = rotatedWorldOffset(
          element.world_origin_cm,
          x * unit,
          y * unit,
          yaw,
        );
        actions.push({
          action: "place_building",
          recipe_class: roof.recipe_class,
          location: world,
          exact_z: true,
          yaw,
          generated_role: "roof",
          commit: false,
        });
      }
    }
  }
  return { ok: true, actions };
}

function compileSupportActions(manifest, elements, roleEvidence) {
  const actions = [];
  if (elements.length === 0) return { ok: true, actions };
  const floorHeight = Number(manifest.grid.floor_height_cm);
  const yaw = Number(manifest.grid.yaw_degrees);
  const support = roleEvidence.support_column;
  const segmentsPerFloor = floorHeight / support.dimensions.height_cm;
  for (const element of elements) {
    for (let segment = 0; segment < element.size_cells.z * segmentsPerFloor; segment += 1) {
      actions.push({
        action: "place_building",
        recipe_class: support.recipe_class,
        location: {
          x: element.world_origin_cm.x,
          y: element.world_origin_cm.y,
          z: element.world_origin_cm.z + segment * support.dimensions.height_cm,
        },
        exact_z: true,
        yaw,
        generated_role: "pillar",
        commit: false,
      });
    }
  }
  return { ok: true, actions };
}

function compileSkybridgeActions(manifest, elements, roleEvidence) {
  const actions = [];
  if (elements.length === 0) return { ok: true, actions };
  const unit = Number(manifest.grid.unit_cm);
  const baseYaw = Number(manifest.grid.yaw_degrees);
  const walkway = roleEvidence.walkway;
  const rail = roleEvidence.rail;
  for (const element of elements) {
    const alongX = element.size_cells.x > 1 && element.size_cells.y === 1;
    const alongY = element.size_cells.y > 1 && element.size_cells.x === 1;
    if (!alongX && !alongY && !(element.size_cells.x === 1 && element.size_cells.y === 1)) {
      return {
        ok: false,
        reason: "architect_skybridge_must_be_a_one_cell_wide_orthogonal_segment",
        element_id: element.id,
      };
    }
    const length = alongY ? element.size_cells.y : element.size_cells.x;
    const directionYaw = baseYaw + (alongY ? 90 : 0);
    for (let index = 0; index < length; index += 1) {
      const dx = alongY ? 0 : index * unit;
      const dy = alongY ? index * unit : 0;
      const centre = rotatedWorldOffset(element.world_origin_cm, dx, dy, baseYaw);
      actions.push({
        action: "place_building",
        recipe_class: walkway.recipe_class,
        location: centre,
        exact_z: true,
        yaw: directionYaw,
        generated_role: "floor",
        commit: false,
      });
      const sideA = rotatedWorldOffset(
        centre,
        alongY ? unit / 2 : 0,
        alongY ? 0 : unit / 2,
        baseYaw,
      );
      const sideB = rotatedWorldOffset(
        centre,
        alongY ? -unit / 2 : 0,
        alongY ? 0 : -unit / 2,
        baseYaw,
      );
      for (const side of [sideA, sideB]) {
        actions.push({
          action: "place_building",
          recipe_class: rail.recipe_class,
          location: side,
          exact_z: true,
          yaw: directionYaw,
          generated_role: "wall",
          commit: false,
        });
      }
    }
  }
  return { ok: true, actions };
}

function compileLandmarkActions(manifest, elements, roleEvidence) {
  const actions = [];
  if (elements.length === 0) return { ok: true, actions };
  const unit = Number(manifest.grid.unit_cm);
  const floorHeight = Number(manifest.grid.floor_height_cm);
  const baseYaw = Number(manifest.grid.yaw_degrees);
  const foundation = roleEvidence.foundation;
  const wall = roleEvidence.wall;
  const window = roleEvidence.window;
  for (const element of elements) {
    const width = element.size_cells.x;
    const depth = element.size_cells.y;
    if (width < 2 || depth < 2) {
      return {
        ok: false,
        reason: "architect_landmark_needs_at_least_two_by_two_cells",
        element_id: element.id,
      };
    }
    const clearWallHeight = floorHeight - foundation.dimensions.height_cm;
    const wallSegments = clearWallHeight / wall.dimensions.height_cm;
    if (!Number.isInteger(wallSegments) || wallSegments < 1 ||
        window.dimensions.height_cm !== wall.dimensions.height_cm) {
      return {
        ok: false,
        reason: "architect_landmark_floor_wall_vertical_modules_do_not_close_exactly",
        element_id: element.id,
        floor_height_cm: floorHeight,
        foundation_height_cm: foundation.dimensions.height_cm,
        wall_height_cm: wall.dimensions.height_cm,
        window_height_cm: window.dimensions.height_cm,
      };
    }
    for (let level = 0; level < element.size_cells.z; level += 1) {
      const levelOrigin = {
        x: element.world_origin_cm.x,
        y: element.world_origin_cm.y,
        z: element.world_origin_cm.z + level * floorHeight,
      };
      for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < depth; y += 1) {
          actions.push({
            action: "place_building",
            recipe_class: foundation.recipe_class,
            location: rotatedWorldOffset(levelOrigin, x * unit, y * unit, baseYaw),
            exact_z: true,
            yaw: baseYaw,
            generated_role: "floor",
            commit: false,
          });
        }
      }
      const addWall = (recipe, location, yaw) => actions.push({
        action: "place_building",
        recipe_class: recipe.recipe_class,
        location,
        exact_z: true,
        yaw,
        generated_role: "wall",
        commit: false,
      });
      for (let segment = 0; segment < wallSegments; segment += 1) {
        const wallOrigin = {
          ...levelOrigin,
          z: levelOrigin.z + foundation.dimensions.height_cm +
            segment * wall.dimensions.height_cm,
        };
        for (let x = 0; x < width; x += 1) {
          const recipe = (x + level + segment) % 3 === 0 ? wall : window;
          addWall(recipe, rotatedWorldOffset(wallOrigin, x * unit, -unit / 2, baseYaw), baseYaw);
          addWall(
            recipe,
            rotatedWorldOffset(wallOrigin, x * unit, (depth - 0.5) * unit, baseYaw),
            baseYaw + 180,
          );
        }
        for (let y = 1; y < depth - 1; y += 1) {
          const recipe = (y + level + segment) % 3 === 0 ? wall : window;
          addWall(recipe, rotatedWorldOffset(wallOrigin, -unit / 2, y * unit, baseYaw), baseYaw + 90);
          addWall(
            recipe,
            rotatedWorldOffset(wallOrigin, (width - 0.5) * unit, y * unit, baseYaw),
            baseYaw + 270,
          );
        }
      }
    }
  }
  return { ok: true, actions };
}

/**
 * Compile an exact selected Architect manifest as far as native evidence allows.
 * A result is executable only when *every* semantic element has an adapter.
 */
export function compileArchitectPromotion(graph, manifest, {
  revision_id: revisionId,
  selected_revision_id: selectedRevisionId,
  blueprint_name: blueprintName = null,
  description = null,
  commit = false,
} = {}) {
  const blockers = [];
  const validation = validateMegabaseManifest(manifest);
  const fingerprint = fingerprintArchitectManifest(manifest);
  if (!validation.valid) blockers.push("architect_manifest_validation_failed");
  if (!fingerprint.ok) blockers.push(fingerprint.reason);
  if (!SHA256.test(String(revisionId ?? ""))) {
    blockers.push("architect_promotion_requires_exact_revision_id");
  }
  if (selectedRevisionId !== revisionId) {
    blockers.push("architect_revision_is_not_the_selected_revision");
  }

  const currentUnlocks = captureUnlockConstraints(graph);
  const storedUnlockFingerprint = String(
    manifest?.unlock_constraints?.availability_fingerprint ?? "",
  );
  if (currentUnlocks.availability_known !== true) {
    blockers.push("architect_promotion_requires_current_authoritative_unlock_capture");
  } else if (currentUnlocks.availability_fingerprint !== storedUnlockFingerprint) {
    blockers.push("architect_promotion_unlock_fingerprint_is_stale");
  }

  const resolvedByRole = new Map(
    (manifest?.part_resolution?.resolved ?? []).map((entry) => [entry.role, entry]),
  );
  const roleEvidence = {};
  for (const role of requiredRoles(manifest)) {
    const result = classifyRole(graph, manifest, role, resolvedByRole.get(role));
    roleEvidence[role] = result;
    if (!result.ok) blockers.push(result.reason);
  }

  const elements = Array.isArray(manifest?.elements) ? manifest.elements : [];
  const groupsById = new Map(
    (manifest?.program?.groups ?? []).map((group) => [String(group?.id ?? ""), group]),
  );
  const machineEvidence = {};
  for (const element of elements.filter((entry) => entry?.kind === "production_zone")) {
    const groupId = String(element?.program_group ?? "").trim();
    if (!groupId || !groupsById.has(groupId)) {
      blockers.push(`architect_production_zone_group_is_missing:${element?.id ?? "unknown"}`);
      continue;
    }
    if (!machineEvidence[groupId]) {
      machineEvidence[groupId] = classifyMachineGroup(graph, groupsById.get(groupId));
    }
    if (!machineEvidence[groupId].ok) blockers.push(machineEvidence[groupId].reason);
  }
  for (const element of elements) {
    if (!SUPPORTED_ELEMENT_KINDS.has(element?.kind)) {
      blockers.push(`architect_element_kind_has_no_native_compiler:${element?.kind ?? "unknown"}`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const base = {
    schema: ARCHITECT_PROMOTION_SCHEMA,
    compiled: uniqueBlockers.length === 0,
    ready_for_native_generation: uniqueBlockers.length === 0,
    architect_revision_id: revisionId ?? null,
    selected_revision_id: selectedRevisionId ?? null,
    manifest_fingerprint: fingerprint.ok ? fingerprint.manifest_fingerprint : null,
    design_family_fingerprint: fingerprint.ok ? fingerprint.design_family_fingerprint : null,
    unlock_fingerprint: currentUnlocks.availability_fingerprint ?? null,
    supported_native_element_kinds: [...SUPPORTED_ELEMENT_KINDS],
    exact_role_evidence: roleEvidence,
    exact_machine_evidence: machineEvidence,
    element_counts: elements.reduce((counts, element) => {
      const kind = String(element?.kind ?? "unknown");
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {}),
    blockers: uniqueBlockers,
    operational_readiness: {
      ready: false,
      internal_material_topology: "not_evaluated",
      reason: "Native generation is not yet a commissioned factory. A4 can compile the proven direct solid-material subset, while split/merge balancing, lifts, fluids, power, circulation, commissioning isolation, resource/external I/O, and destination hookups remain fail-closed.",
    },
    authority:
      "The companion may compile only proven native parts. Satisfactory remains responsible for staging, native save/load readback, active descriptor registration, Build Gun hologram cost/snap/collision, and final construction.",
  };
  if (uniqueBlockers.length > 0) {
    return {
      ...base,
      effect: "No native Blueprint action was produced; no file, inventory, save, or world actor changed.",
    };
  }

  const name = cleanText(blueprintName, 240);
  if (!name) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: ["architect_promotion_blueprint_name_is_required"],
      effect: "The layout is natively compilable, but no file action was produced without an explicit name.",
    };
  }
  const foundation = roleEvidence.foundation;
  const platformElements = elements.filter((element) => element.kind === "structural_platform");
  const platform = platformElements.length > 0
    ? compilePlatformActions(manifest, platformElements, foundation)
    : { ok: true, actions: [] };
  if (!platform.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [platform.reason],
      diagnostic: platform,
    };
  }
  const machines = compileMachineActions(
    manifest,
    elements.filter((element) => element.kind === "production_zone"),
    machineEvidence,
  );
  if (!machines.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [machines.reason],
      diagnostic: machines,
    };
  }
  const facades = compileFacadeActions(
    manifest,
    elements.filter((element) => element.kind === "glazed_facade"),
    roleEvidence,
  );
  if (!facades.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [facades.reason],
      diagnostic: facades,
    };
  }
  const roofs = compileRoofActions(
    manifest,
    elements.filter((element) => element.kind === "sloped_roof_intent"),
    roleEvidence,
  );
  if (!roofs.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [roofs.reason],
      diagnostic: roofs,
    };
  }
  const supports = compileSupportActions(
    manifest,
    elements.filter((element) => element.kind === "support_pylon"),
    roleEvidence,
  );
  if (!supports.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [supports.reason],
      diagnostic: supports,
    };
  }
  const bridges = compileSkybridgeActions(
    manifest,
    elements.filter((element) => element.kind === "skybridge"),
    roleEvidence,
  );
  if (!bridges.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [bridges.reason],
      diagnostic: bridges,
    };
  }
  const landmarks = compileLandmarkActions(
    manifest,
    elements.filter((element) => element.kind === "vertical_landmark"),
    roleEvidence,
  );
  if (!landmarks.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [landmarks.reason],
      diagnostic: landmarks,
    };
  }
  const buildingActions = [
    ...platform.actions,
    ...machines.actions,
    ...facades.actions,
    ...roofs.actions,
    ...supports.actions,
    ...bridges.actions,
    ...landmarks.actions,
  ];
  const internalConveyors = compileArchitectConveyors(
    graph,
    manifest,
    buildingActions,
  );
  if (!internalConveyors.compiled) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [`architect_internal_conveyor_compiler_refused:${internalConveyors.reason}`],
      internal_conveyors: internalConveyors,
      operational_readiness: {
        ...base.operational_readiness,
        internal_material_topology: "blocked",
        internal_material_topology_reason: internalConveyors.reason,
      },
      effect: "No native Blueprint action was produced; incomplete internal material topology was not omitted.",
    };
  }
  const native = compileGeneratedBlueprint({
    blueprint_name: name,
    description: cleanText(description, 1_000) ??
      `AI Architect revision ${revisionId}; manifest ${fingerprint.manifest_fingerprint}.`,
    actions: [...buildingActions, ...internalConveyors.actions],
    origin_cm: manifest.anchor_cm,
    schema: internalConveyors.topology_schema,
  });
  if (!native.compiled) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [`existing_generated_blueprint_compiler_refused:${native.reason}`],
      native_compiler: native,
    };
  }
  const action = generatedBlueprintAction(native, { commit });
  return {
    ...base,
    native_blueprint: {
      schema: native.schema,
      blueprint_name: native.blueprint_name,
      description: native.description,
      counts: native.counts,
      origin_cm: native.origin_cm,
      generation_status: commit === true
        ? "committed_action_ready_for_game_authority"
        : "validated_preview_action_only",
      next_after_verified_game_readback:
        `preview blueprint ${native.blueprint_name}`,
    },
    internal_conveyors: internalConveyors,
    operational_readiness: {
      ...base.operational_readiness,
      internal_material_topology: internalConveyors.actions.length > 0
        ? "compiled_pending_native_game_readback"
        : "no_internal_material_edges_in_manifest",
      compiled_internal_material_edges: internalConveyors.evidence.length,
      compiled_internal_conveyor_segments: internalConveyors.actions.length,
    },
    action,
  };
}
