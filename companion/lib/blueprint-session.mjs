/**
 * The bridge can read every `.sbp` below the player's configured disk library,
 * but Satisfactory's Blueprint subsystem deliberately exposes only the
 * descriptors registered for the active save session. Keep those two facts
 * separate: a file in another save folder is useful to inspect, but it cannot
 * be handed to this session's native Build Gun.
 *
 * The game captures this registry from `AFGBlueprintSubsystem` immediately
 * before each request. These helpers only interpret that authoritative capture;
 * they never resolve a path, refresh a library, or manufacture a descriptor.
 */

function cleanName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function keyForName(value) {
  return cleanName(value).toLocaleLowerCase();
}

/**
 * Returns the active session's complete descriptor registry, or an explicit
 * unknown. A missing registry is not the same as an empty one: old snapshots
 * cannot prove that any disk blueprint is safe to arm.
 */
export function getCurrentSessionBlueprintRegistry(graph) {
  const snapshot = graph?.snapshot ?? null;
  const captured = snapshot?.blueprint_library ?? null;
  const sessionName = cleanName(snapshot?.world?.session_name) || null;

  if (!captured || captured.available !== true) {
    return {
      available: false,
      complete: false,
      session_name: sessionName,
      reason: captured?.reason ?? "blueprint_current_session_library_not_captured",
      names: [],
    };
  }

  if (captured.complete !== true) {
    return {
      available: false,
      complete: false,
      session_name: sessionName,
      reason: captured?.reason ?? "blueprint_current_session_library_incomplete",
      names: [],
    };
  }

  if (!Array.isArray(captured.registered_blueprint_names)) {
    return {
      available: false,
      complete: false,
      session_name: sessionName,
      reason: "blueprint_current_session_descriptor_names_not_captured",
      names: [],
    };
  }

  const names = captured.registered_blueprint_names
    .map(cleanName)
    .filter(Boolean);
  return {
    available: true,
    complete: true,
    session_name: sessionName,
    descriptor_count: Number.isInteger(captured.registered_descriptor_count)
      ? captured.registered_descriptor_count
      : names.length,
    names,
  };
}

/**
 * Resolves a display name only against the descriptor registry of the current
 * game session. The canonical descriptor spelling travels back to the game so
 * a case-insensitive disk match cannot hide an ambiguous registry entry.
 */
export function resolveCurrentSessionBlueprint(graph, requestedName) {
  const name = cleanName(requestedName);
  if (!name) {
    return {
      registered: false,
      reason: "blueprint_name_is_required",
      blueprint_name: name,
    };
  }

  const registry = getCurrentSessionBlueprintRegistry(graph);
  if (!registry.available) {
    return {
      registered: false,
      reason: registry.reason,
      blueprint_name: name,
      session_name: registry.session_name,
    };
  }

  const matches = registry.names.filter((entry) => keyForName(entry) === keyForName(name));
  if (matches.length === 0) {
    return {
      registered: false,
      reason: "blueprint_not_registered_for_current_session",
      blueprint_name: name,
      session_name: registry.session_name,
      registered_descriptor_count: registry.descriptor_count,
    };
  }
  if (matches.length > 1) {
    return {
      registered: false,
      reason: "blueprint_current_session_descriptor_name_ambiguous",
      blueprint_name: name,
      session_name: registry.session_name,
      candidates: matches,
    };
  }

  return {
    registered: true,
    blueprint_name: matches[0],
    session_name: registry.session_name,
    registered_descriptor_count: registry.descriptor_count,
  };
}
