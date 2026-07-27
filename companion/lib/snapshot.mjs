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
