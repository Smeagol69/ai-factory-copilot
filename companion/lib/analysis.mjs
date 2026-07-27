import {
  solveBottlenecks,
  solveItemBalance,
  solvePowerCircuits,
  solveTransportCapacity,
} from "./solvers.mjs";

const DIGEST_ROW_LIMIT = 8;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function rateEntries(entries, cyclesPerMinute, multiplier = 1) {
  return (entries ?? []).map((entry) => ({
    item_class: entry.item_class,
    item_name: entry.item_name,
    registry_units_per_minute: entry.amount * cyclesPerMinute * multiplier,
  }));
}

function finiteVector(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function deriveSpatialContext(snapshot) {
  const interaction = snapshot?.interaction_context ?? {};
  const playerLocation = finiteVector(interaction?.player?.pawn_location);
  const preferredTarget = interaction?.preferred_target ?? {};
  const nearestActors = [];

  if (playerLocation) {
    for (const actor of snapshot?.actors ?? []) {
      const location = finiteVector(actor?.location);
      if (!location) continue;
      const dx = location.x - playerLocation.x;
      const dy = location.y - playerLocation.y;
      const dz = location.z - playerLocation.z;
      nearestActors.push({
        actor_id: actor.actor_id,
        name: actor.name,
        class_path: actor.class_path,
        kind: actor.kind,
        owner_mod: actor.owner_mod,
        location_cm: location,
        distance_meters: Math.hypot(dx, dy, dz) / 100,
        horizontal_distance_meters: Math.hypot(dx, dy) / 100,
        vertical_delta_meters: dz / 100,
        source: "deterministic_geometry_from_live_transforms",
        certainty: "calculated",
      });
    }
    nearestActors.sort((a, b) => a.distance_meters - b.distance_meters);
  }

  return {
    player_location_cm: playerLocation,
    camera: interaction.camera ?? null,
    preferred_target: {
      available: Boolean(preferredTarget.available),
      selected_from: preferredTarget.selected_from ?? "none",
      actor_id: preferredTarget.actor_id ?? null,
      actor_name: preferredTarget.actor_name ?? null,
      actor_class_path: preferredTarget.actor_class_path ?? null,
      actor_owner_mod: preferredTarget.actor_owner_mod ?? null,
      actor_kind: preferredTarget.actor_kind ?? null,
      hit_location_cm: preferredTarget.hit_location ?? null,
    },
    nearest_actors: nearestActors.slice(0, 50),
  };
}

/**
 * Adds only deterministic arithmetic derived from fields already present in the
 * snapshot. It does not choose alternate recipes or interpret custom behavior.
 */
export function deriveSnapshotFacts(snapshot) {
  const recipes = snapshot?.content?.recipes ?? [];
  const recipeByClass = new Map(recipes.map((recipe) => [recipe.class_path, recipe]));
  const recipeRates = [];

  for (const recipe of recipes) {
    const duration = Number(recipe.duration_seconds);
    if (!finitePositive(duration)) continue;
    const cyclesPerMinute = 60 / duration;
    recipeRates.push({
      recipe_class: recipe.class_path,
      recipe_name: recipe.name,
      owner_mod: recipe.owner_mod,
      duration_seconds: duration,
      cycles_per_minute_at_recipe_base_time: cyclesPerMinute,
      ingredients: rateEntries(recipe.ingredients, cyclesPerMinute),
      products: rateEntries(recipe.products, cyclesPerMinute),
      produced_in: recipe.produced_in ?? [],
      source: "deterministic_arithmetic_from_registry",
      certainty: "calculated",
    });
  }

  const liveManufacturers = [];
  const unresolvedManufacturers = [];
  for (const actor of snapshot?.actors ?? []) {
    const recipeClass = actor?.manufacturer?.recipe_class;
    if (!recipeClass) continue;
    const recipe = recipeByClass.get(recipeClass);
    const cycleSeconds = Number(actor?.factory?.production_cycle_seconds);
    if (!recipe || !finitePositive(cycleSeconds)) {
      unresolvedManufacturers.push({
        actor_id: actor.actor_id,
        recipe_class: recipeClass,
        reason: !recipe
          ? "recipe_not_present_in_compacted_catalog"
          : "live_cycle_time_unavailable",
      });
      continue;
    }

    const cyclesPerMinute = 60 / cycleSeconds;
    const productionBoost = finitePositive(Number(actor?.factory?.current_production_boost))
      ? Number(actor.factory.current_production_boost)
      : 1;
    liveManufacturers.push({
      actor_id: actor.actor_id,
      class_path: actor.class_path,
      owner_mod: actor.owner_mod,
      recipe_class: recipeClass,
      cycle_seconds: cycleSeconds,
      cycles_per_minute: cyclesPerMinute,
      ingredients: rateEntries(recipe.ingredients, cyclesPerMinute),
      base_products: rateEntries(recipe.products, cyclesPerMinute),
      products_after_reported_production_boost: rateEntries(
        recipe.products,
        cyclesPerMinute,
        productionBoost,
      ),
      reported_production_boost: productionBoost,
      is_producing: actor.factory?.is_producing,
      production_status: actor.factory?.production_status,
      productivity: actor.factory?.productivity,
      source: "deterministic_arithmetic_from_live_cycle_and_registered_recipe",
      certainty: "calculated",
      caveat:
        "A custom mod can override recipe consumption/output semantics; an explicit adapter must confirm nonstandard behavior.",
    });
  }

  return {
    schema: "aifactory.derived_facts",
    schema_version: 1,
    world_revision: snapshot?.world_revision ?? null,
    recipe_rates: recipeRates,
    live_manufacturers: liveManufacturers,
    unresolved_manufacturers: unresolvedManufacturers,
    spatial_context: deriveSpatialContext(snapshot),
  };
}

/**
 * A small headline of the deterministic solver results, so the model knows what
 * is worth asking about. The full detail stays behind the solver tools; this
 * digest is deliberately bounded and never replaces a tool call.
 */
export function deriveAnalysisDigest(graph) {
  const balance = solveItemBalance(graph);
  const power = solvePowerCircuits(graph);
  const bottlenecks = solveBottlenecks(graph);
  const transport = solveTransportCapacity(graph, { only_problems: true });

  return {
    schema: "aifactory.analysis_digest",
    schema_version: 1,
    world_revision: graph.world_revision,
    usage:
      "Headline only. Call the solver tools for exact per-machine, per-item, per-segment, and per-circuit detail.",
    item_deficits: balance.items
      .filter((entry) => entry.status === "deficit")
      .slice(0, DIGEST_ROW_LIMIT)
      .map((entry) => ({
        item_class: entry.item_class,
        item_name: entry.item_name,
        net_display_units_per_minute: entry.net_display_units_per_minute,
        display_unit: entry.display_unit,
      })),
    item_balance_coverage: balance.coverage,
    power_circuits_with_findings: power.circuits
      .filter((circuit) => circuit.findings.length > 0)
      .slice(0, DIGEST_ROW_LIMIT)
      .map((circuit) => ({
        circuit_id: circuit.circuit_id,
        headroom_mw: circuit.headroom_mw,
        fuse_triggered: circuit.fuse_triggered,
        findings: circuit.findings.map((finding) => finding.finding),
      })),
    power_circuit_count: power.circuit_count,
    bottleneck_cause_counts: bottlenecks.cause_counts,
    bottleneck_machine_count: bottlenecks.reported_machine_count,
    transport_problem_counts: {
      conveyors: transport.conveyors.length,
      pipelines: transport.pipelines.length,
    },
    graph_completeness: {
      node_count: graph.nodes.size,
      unresolved_connection_count: graph.unresolvedConnections.length,
    },
    source: "deterministic_solvers_over_authoritative_snapshot",
    certainty: "calculated",
  };
}
