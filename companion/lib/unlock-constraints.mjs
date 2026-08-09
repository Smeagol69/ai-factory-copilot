import { createHash } from "node:crypto";

/**
 * Exact recipe-availability boundary used by a design calculation.
 *
 * The fingerprint contains only class paths the current AFGRecipeManager capture
 * marked available. It changes when a recipe is unlocked or becomes unavailable,
 * without depending on the global world revision that moving belt items advance.
 */
export function captureUnlockConstraints(graph) {
  const content = graph?.snapshot?.content ?? {};
  const recipes = Array.isArray(content.recipes) ? content.recipes : [];
  const availableClasses = [...new Set(
    recipes
      .filter((recipe) => recipe?.available === true)
      .map((recipe) => String(recipe?.class_path ?? recipe?.recipe_class ?? "").trim())
      .filter(Boolean),
  )].sort();
  const availabilityKnown = content.availability_known === true;
  const availableBuildRecipes = recipes.filter((recipe) =>
    recipe?.available === true &&
    (recipe.produced_in ?? []).some((producer) =>
      /(?:BP_)?BuildGun|FGBuildGun/i.test(String(producer)),
    ),
  );

  return {
    availability_known: availabilityKnown,
    availability_fingerprint: availabilityKnown
      ? `sha256:${createHash("sha256").update(JSON.stringify(availableClasses)).digest("hex")}`
      : null,
    captured_world_revision: graph?.world_revision ?? graph?.snapshot?.world_revision ?? null,
    captured_at_utc:
      graph?.snapshot?.interaction_context?.captured_at_utc ??
      graph?.snapshot?.generated_at_utc ??
      null,
    registered_recipe_count: recipes.length,
    available_recipe_count: availableClasses.length,
    available_build_recipe_count: availableBuildRecipes.length,
    unavailable_recipe_count: recipes.filter((recipe) => recipe?.available === false).length,
    unknown_recipe_availability_count: recipes.filter(
      (recipe) => typeof recipe?.available !== "boolean",
    ).length,
    source: availabilityKnown
      ? "captured_AFGRecipeManager_availability"
      : "incomplete_recipe_catalog_availability",
    selection_rule:
      "Production, transport, machine, and architecture candidates may be selected only when this capture proves their recipe available; every selected recipe is checked again by the game immediately before construction.",
    replan_rule:
      "Capture a fresh snapshot and rerun production, site, routing, placement, and part selection before action compilation. Discard an older plan when this fingerprint changes.",
  };
}
