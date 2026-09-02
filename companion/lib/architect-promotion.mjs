/**
 * Fail-closed AI Architect -> generated native Blueprint adapter.
 *
 * `megabase.design/v1` is deliberately semantic: a volume marked "tower" is
 * not permission to invent hundreds of walls, floors and lights. This module
 * is the explicit boundary where each semantic element must have a proven,
 * deterministic native placement adapter before the existing game-authority
 * serializer may see it.
 *
 * The first adapter is intentionally narrow but real: structural platforms
 * whose exact selected Foundation recipe is captured, unlocked, Build-Gun
 * produced, and dimensioned to the manifest grid. Unsupported elements stay
 * blockers; they are never omitted from a supposedly complete promotion.
 */

import { parsePieceDimensions } from "./architecture.mjs";
import { fingerprintArchitectManifest } from "./architect-revisions.mjs";
import { compileGeneratedBlueprint, generatedBlueprintAction } from "./generated-blueprints.mjs";
import { captureUnlockConstraints, gridPointToWorld, validateMegabaseManifest } from "./megabase.mjs";

export const ARCHITECT_PROMOTION_SCHEMA = "ai-architect.promotion/v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_ELEMENT_KINDS = new Set(["structural_platform"]);

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

  if (role !== "foundation") {
    return {
      ok: false,
      reason: `architect_role_has_no_native_placement_adapter:${role}`,
      recipe_class: recipe.class_path ?? recipeClass,
      buildable_class: buildableClass,
    };
  }

  const descriptor = descriptorShortName(item.class_path ?? product?.item_class);
  const dimensions = parsePieceDimensions(descriptor);
  const gridUnit = finite(manifest?.grid?.unit_cm);
  if (!/^Desc_Foundation_/i.test(descriptor) || !dimensions) {
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
          location: world,
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
    element_counts: elements.reduce((counts, element) => {
      const kind = String(element?.kind ?? "unknown");
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {}),
    blockers: uniqueBlockers,
    operational_readiness: {
      ready: false,
      reason: "A3 creates a native architectural Blueprint; A4 must still compile and verify production logistics, power, fluids, circulation, commissioning isolation, and destination hookups.",
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
  const platform = compilePlatformActions(manifest, platformElements, foundation);
  if (!platform.ok) {
    return {
      ...base,
      compiled: false,
      ready_for_native_generation: false,
      blockers: [platform.reason],
      diagnostic: platform,
    };
  }
  const native = compileGeneratedBlueprint({
    blueprint_name: name,
    description: cleanText(description, 1_000) ??
      `AI Architect revision ${revisionId}; manifest ${fingerprint.manifest_fingerprint}.`,
    actions: platform.actions,
    origin_cm: manifest.anchor_cm,
    schema: "aifactory.generated-blueprint/v1",
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
    action,
  };
}

