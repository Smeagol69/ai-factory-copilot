import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { normalizeResourcePurity, solveSiteSelection } from "../lib/solvers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const LEVEL = "/Game/FactoryMap.FactoryMap:PersistentLevel";

function node(id, resource, purity, location, overrides = {}) {
  return {
    actor_id: `${LEVEL}.BP_ResourceNode${id}`,
    name: `BP_ResourceNode${id}`,
    class_path: "/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C",
    owner_mod: "FactoryGame",
    kind: "resource_node",
    location,
    occupied: false,
    has_resources: true,
    resource_class: `Desc_${resource}`,
    resource_name: resource,
    node_type: "Node",
    purity,
    amount_type: "RA_Infinite",
    connections: [],
    inventories: [],
    ...overrides,
  };
}

/** A rich three-resource cluster at the origin and a lone node far away. */
function worldSnapshot(extraNodes = []) {
  return {
    schema: "aifactory.snapshot",
    schema_version: 1,
    data_policy: "authoritative_or_explicitly_unknown",
    world_revision: 3,
    world: { map: "FactoryMap", scan_radius_meters: -1 },
    interaction_context: { player: { pawn_location: { x: 0, y: 0, z: 0 } } },
    content: { items: [], recipes: [] },
    completeness: { actor_limit_reached: false },
    actors: [
      node(1, "Iron Ore", "RP_Pure", { x: 0, y: 0, z: 0 }),
      node(2, "Copper Ore", "RP_Normal", { x: 10000, y: 0, z: 0 }),
      node(3, "Limestone", "RP_Normal", { x: 0, y: 10000, z: 0 }),
      node(4, "Iron Ore", "RP_Normal", { x: 5000, y: 5000, z: 0 }),
      node(5, "Coal", "RP_Inpure", { x: 900000, y: 0, z: 0 }),
      ...extraNodes,
    ],
  };
}

test("normalizes the engine's misspelled purity enum", () => {
  assert.equal(normalizeResourcePurity("RP_Inpure"), "impure");
  assert.equal(normalizeResourcePurity("RP_Normal"), "normal");
  assert.equal(normalizeResourcePurity("RP_Pure"), "pure");
  assert.equal(normalizeResourcePurity(undefined), "unknown");
});

test("ranks the dense multi-resource cluster above an isolated node", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300, top: 5 });
  const best = result.sites[0];

  assert.equal(best.rank, 1);
  assert.equal(best.distinct_resources, 3);
  assert.ok(best.score > result.sites.at(-1).score);
  const names = best.resources_in_radius.map((entry) => entry.resource_name).sort();
  assert.deepEqual(names, ["Copper Ore", "Iron Ore", "Limestone"]);
});

test("weights pure nodes above normal ones", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  const iron = result.sites[0].resources_in_radius.find((entry) => entry.resource_name === "Iron Ore");

  // One pure (2.0) plus one normal (1.0).
  assert.equal(iron.node_count, 2);
  assert.equal(iron.by_purity.pure, 1);
  assert.equal(iron.by_purity.normal, 1);
  assert.equal(iron.purity_weight_total, 3);
  assert.equal(result.scoring_basis.purity_extraction_weights.pure, 2);
});

test("reports which required resources a site is missing", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), {
    radius_meters: 300,
    required_resources: ["Iron Ore", "Copper Ore", "Limestone", "Caterium"],
  });
  const best = result.sites[0];

  assert.deepEqual(best.missing_required_resources, ["Caterium"]);
  assert.equal(best.meets_all_required, false);
});

test("prefers a site meeting every requirement over a denser one that does not", () => {
  const complete = solveSiteSelection(buildGraph(worldSnapshot()), {
    radius_meters: 300,
    required_resources: ["Iron Ore", "Copper Ore", "Limestone"],
  });
  assert.equal(complete.sites[0].meets_all_required, true);
  assert.equal(complete.sites[0].score_breakdown.required_coverage, 120);
});

test("excludes occupied nodes and hand-mined deposits", () => {
  const snapshot = worldSnapshot([
    node(6, "Caterium", "RP_Pure", { x: 1000, y: 1000, z: 0 }, { occupied: true }),
    node(7, "Sulfur", "RP_Pure", { x: 1200, y: 1200, z: 0 }, { node_type: "Deposit" }),
  ]);
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  const found = result.sites[0].resources_in_radius.map((entry) => entry.resource_name);

  assert.ok(!found.includes("Caterium"), "occupied node must not be offered");
  assert.ok(!found.includes("Sulfur"), "a Deposit cannot host a miner");
  assert.equal(result.resource_node_totals.occupied, 1);
  assert.equal(result.resource_node_totals.deposits_excluded, 1);
});

test("includes deposits only when explicitly asked", () => {
  const snapshot = worldSnapshot([
    node(7, "Sulfur", "RP_Pure", { x: 1200, y: 1200, z: 0 }, { node_type: "Deposit" }),
  ]);
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300, include_deposits: true });
  const found = result.sites[0].resources_in_radius.map((entry) => entry.resource_name);
  assert.ok(found.includes("Sulfur"));
});

test("scores one caller-supplied location instead of searching", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), {
    radius_meters: 300,
    center: { x: 0, y: 0, z: 0 },
  });
  assert.equal(result.candidates_evaluated, 1);
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].candidate_origin, "caller_supplied_center");
});

test("respects the radius when deciding what is in reach", () => {
  const near = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 50 });
  const far = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  assert.ok(near.sites[0].distinct_resources < far.sites[0].distinct_resources);
});

test("exposes the full score breakdown so a ranking can be checked", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  const best = result.sites[0];
  const parts = best.score_breakdown;
  const recomputed =
    parts.resource_diversity + parts.purity_weighted_nodes + parts.required_coverage + parts.distance_penalty;

  assert.ok(Math.abs(recomputed - best.score) < 0.01);
  assert.match(parts.formula, /diversity/);
});

test("warns loudly when the snapshot was only a radius bubble", () => {
  const snapshot = worldSnapshot();
  snapshot.world.scan_radius_meters = 250;
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });

  assert.match(result.completeness_warning, /250 m scan radius/);
  assert.match(result.completeness_warning, /cannot answer a world-scale siting question/);
});

/** Measured ground, in the shape the scanner emits. */
function terrain(verdict, overrides = {}) {
  return {
    sampled: verdict !== "no_ground_found",
    verdict,
    footprint_meters: 24,
    samples_requested: 25,
    samples_with_ground: 25,
    mean_slope_degrees: 3,
    max_slope_degrees: 6,
    elevation_range_cm: 120,
    water_samples: 0,
    blocked_samples: 0,
    source: "unreal_line_traces_and_water_volumes",
    certainty: "authoritative",
    ...overrides,
  };
}

test("an unmeasured site is neutral and says unmeasured is not flat", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  const site = result.sites[0];
  assert.equal(site.terrain.measured, false);
  assert.equal(site.terrain.verdict, "not_sampled");
  assert.equal(site.score_breakdown.terrain, 0);
  assert.match(site.terrain.note, /Unmeasured ground is not flat ground/);
  assert.equal(result.terrain_coverage.measured_sites, 0);
});

test("measured ground is carried into the site report", () => {
  const snapshot = worldSnapshot();
  snapshot.actors.find((actor) => actor.name === "BP_ResourceNode1").terrain = terrain("flat_and_clear");
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  const flat = result.sites.find((site) => site.terrain.measured);

  assert.equal(flat.terrain.verdict, "flat_and_clear");
  assert.equal(flat.terrain.buildability_0_to_1, 1);
  assert.equal(flat.terrain.max_slope_degrees, 6);
  assert.ok(flat.score_breakdown.terrain > 0);
  assert.equal(result.terrain_coverage.measured_sites, 1);
});

test("flat ground outranks a steeper site with the same resources", () => {
  const snapshot = worldSnapshot();
  // Two identical clusters, differing only in measured ground.
  snapshot.actors.find((actor) => actor.name === "BP_ResourceNode1").terrain = terrain("flat_and_clear");
  snapshot.actors.find((actor) => actor.name === "BP_ResourceNode4").terrain = terrain("steep", {
    max_slope_degrees: 41,
    elevation_range_cm: 1800,
  });
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });

  const flat = result.sites.find((site) => site.terrain.verdict === "flat_and_clear");
  const steep = result.sites.find((site) => site.terrain.verdict === "steep");
  assert.ok(flat.score > steep.score, `${flat.score} should beat ${steep.score}`);
  assert.ok(steep.score_breakdown.terrain < 0);
});

test("water and obstruction are scored as unbuildable", () => {
  const snapshot = worldSnapshot();
  snapshot.actors.find((actor) => actor.name === "BP_ResourceNode1").terrain = terrain("over_water", {
    water_samples: 25,
  });
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  const wet = result.sites.find((site) => site.terrain.verdict === "over_water");
  assert.equal(wet.terrain.buildability_0_to_1, 0);
  assert.ok(wet.score_breakdown.terrain < 0);
});

test("terrain coverage explains what was measured and how", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  assert.match(result.terrain_coverage.how, /line traces/);
  assert.ok(result.terrain_coverage.measured.some((entry) => /water/.test(entry)));
  assert.ok(result.terrain_coverage.measured.some((entry) => /slope/.test(entry)));
  // Placement validity is still the game's own hologram check, not ours.
  assert.match(result.not_captured.exact_placement_validity, /hologram/);
});

test("falls back to the player actor when interaction_context is absent", () => {
  const snapshot = worldSnapshot();
  delete snapshot.interaction_context;
  snapshot.actors.push({
    actor_id: `${LEVEL}.Char_Player_C_1`,
    name: "Char_Player_C_1",
    kind: "player",
    class_path: "Char_Player_C",
    owner_mod: "FactoryGame",
    location: { x: 0, y: 0, z: 0 },
    connections: [],
    inventories: [],
  });

  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  // Every site gets a real player distance instead of null, and the node sitting
  // on the player's position measures zero.
  assert.ok(result.sites.every((site) => site.distance_to_player_meters !== null));
  assert.ok(result.sites.some((site) => site.distance_to_player_meters === 0));
});

test("reports player distance as null when no player was captured at all", () => {
  const snapshot = worldSnapshot();
  delete snapshot.interaction_context;
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  assert.equal(result.sites[0].distance_to_player_meters, null);
});

test("returns no sites rather than a fabricated one when nothing is in range", () => {
  const snapshot = worldSnapshot();
  snapshot.actors = snapshot.actors.filter((actor) => actor.kind !== "resource_node");
  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });

  assert.deepEqual(result.sites, []);
  assert.equal(result.resource_node_totals.usable, 0);
});

test("survives a snapshot with no resource data at all", () => {
  const result = solveSiteSelection(buildGraph(buildFactorySnapshot()), { radius_meters: 300 });
  assert.equal(result.solver, "site_selection");
  assert.ok(Array.isArray(result.sites));
});

test("counts existing buildings overlapping a candidate footprint", () => {
  const snapshot = worldSnapshot();
  snapshot.actors.push({
    actor_id: `${LEVEL}.Build_Smelter_C_9`,
    name: "Build_Smelter_C_9",
    class_path: "Build_SmelterMk1_C",
    owner_mod: "FactoryGame",
    kind: "buildable",
    location: { x: 0, y: 0, z: 0 },
    bounds: { origin: { x: 0, y: 0, z: 0 }, extent: { x: 400, y: 400, z: 400 } },
    connections: [],
    inventories: [],
  });

  const result = solveSiteSelection(buildGraph(snapshot), { radius_meters: 300 });
  const atOrigin = result.sites.find((site) => site.center_cm.x === 0 && site.center_cm.y === 0);
  const faraway = result.sites.find((site) => Math.abs(site.center_cm.x) > 100000);

  assert.equal(atOrigin.existing_buildings_in_footprint.count, 1);
  assert.equal(atOrigin.existing_buildings_in_footprint.examples[0].name, "Build_Smelter_C_9");
  if (faraway) assert.equal(faraway.existing_buildings_in_footprint.count, 0);
});

test("existing buildings are measured, so they leave the not-captured list", () => {
  const result = solveSiteSelection(buildGraph(worldSnapshot()), { radius_meters: 300 });
  assert.equal(result.not_captured.existing_building_overlap, undefined);
  assert.ok(
    result.terrain_coverage.measured.some((entry) => /existing buildings/.test(entry)),
  );
  // What genuinely cannot be known stays listed.
  assert.match(result.not_captured.exact_placement_validity, /hologram/);
});
