const RELEVANT_WORD_MIN_LENGTH = 3;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function questionTerms(question) {
  return new Set(
    String(question)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length >= RELEVANT_WORD_MIN_LENGTH),
  );
}

function textMatchesTerms(value, terms) {
  const haystack = JSON.stringify(value).toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) return true;
  }
  return false;
}

function removeReflection(snapshot) {
  for (const actor of snapshot.actors ?? []) {
    delete actor.reflected_properties;
  }
  const focusedActor = snapshot.interaction_context?.preferred_target?.actor_snapshot;
  if (focusedActor) {
    delete focusedActor.reflected_properties;
  }
}

function removeLongDescriptions(snapshot) {
  for (const item of snapshot.content?.items ?? []) {
    delete item.description;
  }
}

function filterCatalog(snapshot, question) {
  if (!snapshot.content) return;
  const terms = questionTerms(question);
  if (terms.size === 0) {
    snapshot.content.items = [];
    snapshot.content.recipes = [];
    return;
  }

  const matchingItems = (snapshot.content.items ?? []).filter((item) =>
    textMatchesTerms(item, terms),
  );
  const matchingClasses = new Set(matchingItems.map((item) => item.class_path));

  const recipes = snapshot.content.recipes ?? [];
  const directlyMatchingRecipes = recipes.filter(
    (recipe) =>
      textMatchesTerms(
        {
          class_path: recipe.class_path,
          name: recipe.name,
          owner_mod: recipe.owner_mod,
        },
        terms,
      ) ||
      recipe.ingredients?.some((entry) => matchingClasses.has(entry.item_class)) ||
      recipe.products?.some((entry) => matchingClasses.has(entry.item_class)),
  );

  const referencedClasses = new Set(matchingClasses);
  for (const recipe of directlyMatchingRecipes) {
    for (const entry of [...(recipe.ingredients ?? []), ...(recipe.products ?? [])]) {
      referencedClasses.add(entry.item_class);
    }
  }

  snapshot.content.recipes = directlyMatchingRecipes;
  snapshot.content.items = (snapshot.content.items ?? []).filter((item) =>
    referencedClasses.has(item.class_path),
  );
}

export function compactSnapshot(original, question, maximumCharacters) {
  const snapshot = cloneJson(original);
  const omissions = [];

  let serialized = JSON.stringify(snapshot);
  if (serialized.length <= maximumCharacters) {
    return { snapshot, omissions, serialized };
  }

  removeReflection(snapshot);
  omissions.push("reflected_properties");
  serialized = JSON.stringify(snapshot);
  if (serialized.length <= maximumCharacters) {
    return { snapshot, omissions, serialized };
  }

  removeLongDescriptions(snapshot);
  omissions.push("item_descriptions");
  serialized = JSON.stringify(snapshot);
  if (serialized.length <= maximumCharacters) {
    return { snapshot, omissions, serialized };
  }

  filterCatalog(snapshot, question);
  omissions.push("unrelated_content_catalog_entries");
  serialized = JSON.stringify(snapshot);
  if (serialized.length <= maximumCharacters) {
    return { snapshot, omissions, serialized };
  }

  const actors = snapshot.actors ?? [];
  const keptActors = [];
  snapshot.actors = [];

  let fixedLength = JSON.stringify(snapshot).length;
  if (fixedLength > maximumCharacters && snapshot.content) {
    snapshot.content = { items: [], recipes: [] };
    omissions.push("content_catalog_over_hard_limit");
    fixedLength = JSON.stringify(snapshot).length;
  }
  if (fixedLength > maximumCharacters && snapshot.progression?.purchased_schematics) {
    snapshot.progression.purchased_schematics = [];
    omissions.push("purchased_schematics_over_hard_limit");
    fixedLength = JSON.stringify(snapshot).length;
  }
  if (fixedLength > maximumCharacters && Array.isArray(snapshot.mods)) {
    snapshot.mods = snapshot.mods.map((mod) => ({ reference: mod.reference }));
    omissions.push("extended_mod_metadata_over_hard_limit");
    fixedLength = JSON.stringify(snapshot).length;
  }

  for (const actor of actors) {
    const actorLength = JSON.stringify(actor).length + 1;
    if (fixedLength + actorLength > maximumCharacters) break;
    keptActors.push(actor);
    fixedLength += actorLength;
  }
  snapshot.actors = keptActors;
  omissions.push(`actors_after_index_${keptActors.length - 1}`);
  serialized = JSON.stringify(snapshot);

  if (serialized.length > maximumCharacters) {
    const minimal = {
      schema: snapshot.schema,
      schema_version: snapshot.schema_version,
      data_policy: snapshot.data_policy,
      world_revision: snapshot.world_revision,
      generated_at_utc: snapshot.generated_at_utc,
      units: snapshot.units,
      world: snapshot.world,
      interaction_context: snapshot.interaction_context,
      completeness: {
        actor_limit_reached: true,
        bridge_hard_limit_reached: true,
      },
      mods: [],
      content: { items: [], recipes: [] },
      actors: [],
    };
    omissions.push("all_optional_snapshot_data_over_hard_limit");
    return { snapshot: minimal, omissions, serialized: JSON.stringify(minimal) };
  }

  return {
    snapshot,
    omissions,
    serialized,
  };
}

function finiteVectorOrNull(value) {
  if (!value || typeof value !== "object") return null;
  const numbers = [Number(value.x), Number(value.y), Number(value.z)];
  return numbers.every(Number.isFinite) ? numbers : null;
}

/**
 * The lean view of the world sent to the model.
 *
 * The content catalog is the overwhelming majority of a whole-world snapshot —
 * on a real save the recipes and items alone run to hundreds of thousands of
 * tokens — and every question about it is answered better by a solver than by
 * the model reading raw JSON. So the catalog and Unreal reflection stay on the
 * bridge, where the solvers read them in full, and the model receives grounding
 * plus the actors nearest to it.
 *
 * Omissions are always declared, and each one names the solver that serves it.
 */
export function buildLeanPayload(snapshot, { maxActors = 120, maxCharacters = 200_000 } = {}) {
  const omissions = [];
  const interaction = snapshot?.interaction_context ?? null;
  const playerLocation =
    finiteVectorOrNull(interaction?.player?.pawn_location) ??
    finiteVectorOrNull((snapshot?.actors ?? []).find((actor) => actor?.kind === "player")?.location);
  const focusActorId = interaction?.preferred_target?.actor_id ?? null;

  const scored = [];
  for (const actor of snapshot?.actors ?? []) {
    const { reflected_properties, ...rest } = actor ?? {};
    const location = finiteVectorOrNull(actor?.location);
    let distance = Number.POSITIVE_INFINITY;
    if (playerLocation && location) {
      distance = Math.hypot(
        location[0] - playerLocation[0],
        location[1] - playerLocation[1],
        location[2] - playerLocation[2],
      );
    }
    // The actor being looked at is never dropped: pronoun grounding depends on it.
    scored.push({ actor: rest, distance: actor?.actor_id === focusActorId ? -1 : distance });
  }
  scored.sort((a, b) => a.distance - b.distance);

  const totalActors = scored.length;
  const kept = [];
  let usedCharacters = 0;
  for (const entry of scored) {
    if (kept.length >= maxActors) break;
    const size = JSON.stringify(entry.actor).length + 1;
    if (usedCharacters + size > maxCharacters) break;
    kept.push(entry.actor);
    usedCharacters += size;
  }

  if ((snapshot?.actors ?? []).some((actor) => actor?.reflected_properties)) {
    omissions.push("reflected_properties (bridge-side only; solvers read them)");
  }
  if (snapshot?.content) {
    omissions.push(
      "content_catalog (all items and recipes; query it with find_recipes, get_item_balance, or get_machine_rates)",
    );
  }
  if (kept.length < totalActors) {
    omissions.push(
      `actors_beyond_the_nearest_${kept.length}_of_${totalActors} (every actor is still visible to the solvers)`,
    );
  }

  const progression = snapshot?.progression ?? {};
  const payload = {
    schema: snapshot?.schema ?? "aifactory.snapshot",
    schema_version: snapshot?.schema_version ?? 1,
    data_policy: snapshot?.data_policy,
    world_revision: snapshot?.world_revision ?? null,
    generated_at_utc: snapshot?.generated_at_utc ?? null,
    units: snapshot?.units ?? null,
    world: snapshot?.world ?? null,
    interaction_context: interaction,
    mods: (snapshot?.mods ?? []).map((mod) => ({ reference: mod?.reference, version: mod?.version })),
    visible_ui: snapshot?.visible_ui ?? null,
    progression_summary: {
      highest_available_tech_tier: progression.highest_available_tech_tier ?? null,
      purchased_schematic_count: (progression.purchased_schematics ?? []).length,
      active_schematic: progression.active_schematic ?? null,
      onboarding: progression.onboarding ?? null,
      game_phase: progression.game_phase ?? null,
      todo_lists: progression.todo_lists ?? null,
      recipe_availability: {
        known: snapshot?.content?.availability_known ?? false,
        available_recipe_count: snapshot?.content?.available_recipe_count ?? null,
        unavailable_recipe_count: snapshot?.content?.unavailable_recipe_count ?? null,
      },
      detail:
        "Progression-manager state and rendered visible_ui text are separate live observations. Report any conflict. Call get_unlock_status for the purchased schematic list.",
    },
    actors_nearest_to_the_player: kept,
    completeness: {
      ...(snapshot?.completeness ?? {}),
      view: "lean",
      total_actors_in_snapshot: totalActors,
      actors_included: kept.length,
      policy:
        "This is a reduced view for context size. The solvers read the complete snapshot, so anything omitted here is still exact when a solver returns it. Never treat an omission as absence.",
    },
  };

  return { payload, omissions, serialized: JSON.stringify(payload) };
}

export function summarizeSnapshot(snapshot) {
  const actors = snapshot?.actors ?? [];
  const byKind = Object.create(null);
  const byOwnerMod = Object.create(null);
  for (const actor of actors) {
    const kind = actor.kind ?? "unknown";
    const owner = actor.owner_mod ?? "Unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byOwnerMod[owner] = (byOwnerMod[owner] ?? 0) + 1;
  }

  return {
    world: snapshot?.world ?? {},
    world_revision: snapshot?.world_revision ?? null,
    mods: snapshot?.mods?.length ?? 0,
    items: snapshot?.content?.items?.length ?? 0,
    recipes: snapshot?.content?.recipes?.length ?? 0,
    actors: actors.length,
    actors_by_kind: byKind,
    actors_by_owner_mod: byOwnerMod,
    actor_limit_reached: Boolean(snapshot?.completeness?.actor_limit_reached),
  };
}
