/**
 * What is actually around a point, and whether it is a good place to have built.
 *
 * This is the first piece of the assistant that offers a judgement rather than
 * answering a lookup. The owner's framing: *"I see you placed your hub here,
 * there's only 1 iron node in 300m, if you moved to these coordinates you will
 * be set up better in later game."*
 *
 * The distinction that makes the whole thing honest is **node versus deposit**.
 * A snapshot around one hub returned 35 "resource nodes". Twenty-three of those
 * were `BP_ResourceDeposit_C` -- hand-mined lumps that run out and cannot take a
 * miner. Reporting 35 would have been true and useless. Only the 12 permanent
 * nodes can carry a factory, and that is the number a site is judged on.
 *
 * Everything here is read from first-class snapshot fields -- `resource_name`,
 * `purity`, `node_type`, `occupied`, `has_resources` -- not from reflected
 * properties and not from class-name guessing.
 */
import { efficiencyData } from "./efficiency.mjs";

/** Resources a starting base genuinely needs early. Ordered by how soon. */
const EARLY_ESSENTIALS = ["Iron Ore", "Copper Ore", "Limestone", "Coal"];

function distanceMeters(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)) / 100;
}

function prettyPurity(purity) {
  // The game spells it "RP_Inpure". Repeating a typo at the player is not
  // faithfulness, it is just confusing.
  const bare = String(purity ?? "").replace(/^RP_/, "");
  return bare === "Inpure" ? "Impure" : bare || "Unknown";
}

/**
 * Yield of one node at a given miner tier, or null when it cannot be stated.
 *
 * Returns `estimated: true` whenever the purity multiplier is involved, because
 * those multipliers are not verified against the install the way the base rates
 * are. A number the caller cannot tell apart from a measured one is worse than
 * no number.
 */
export function nodeYield(purity, minerTier = 2) {
  const { extraction } = efficiencyData();
  const miner = extraction.miners.find((entry) => entry.tier === minerTier);
  const multiplier = extraction.purity_multiplier[purity];
  if (!miner || typeof multiplier !== "number") return null;
  return {
    miner: miner.name,
    per_minute: miner.base_per_min * multiplier,
    estimated: extraction.purity_multiplier.verified !== true,
  };
}

/**
 * Survey the resources around a point.
 *
 * `radiusMeters` filters further in; it cannot see past whatever radius the
 * snapshot itself was captured with, and `snapshot_radius_meters` is reported so
 * a caller never mistakes "nothing within 300 m" for "nothing captured".
 */
export function surveyResources(snapshot, { origin = null, radiusMeters = null } = {}) {
  const actors = snapshot?.actors ?? [];
  const centre =
    origin ??
    actors.find((a) => /Build_TradingPost_C/.test(a.class_path ?? ""))?.location ??
    actors.find((a) => a.kind === "player")?.location ??
    null;

  if (!centre) {
    return { ok: false, reason: "no_origin", nodes: [], deposits: [] };
  }

  const all = actors
    .filter((a) => a.kind === "resource_node" && a.location)
    .map((a) => ({
      name: a.resource_name ?? "Unknown",
      purity: prettyPurity(a.purity),
      node_type: a.node_type ?? "Unknown",
      occupied: a.occupied === true,
      has_resources: a.has_resources !== false,
      terrain: a.terrain?.verdict ?? null,
      distance_m: Math.round(distanceMeters(a.location, centre)),
      location: a.location,
      actor_id: a.actor_id,
    }))
    .filter((n) => radiusMeters === null || n.distance_m <= radiusMeters)
    .sort((a, b) => a.distance_m - b.distance_m);

  // The split that matters: only node_type "Node" is permanent and miner-able.
  const nodes = all.filter((n) => n.node_type === "Node" && n.has_resources);
  const deposits = all.filter((n) => n.node_type !== "Node");

  const byResource = new Map();
  for (const node of nodes) {
    const entry = byResource.get(node.name) ?? {
      resource: node.name,
      total: 0,
      free: 0,
      occupied: 0,
      nearest_m: Infinity,
      by_purity: {},
    };
    entry.total += 1;
    entry[node.occupied ? "occupied" : "free"] += 1;
    entry.nearest_m = Math.min(entry.nearest_m, node.distance_m);
    entry.by_purity[node.purity] = (entry.by_purity[node.purity] ?? 0) + 1;
    byResource.set(node.name, entry);
  }

  const resources = [...byResource.values()].sort((a, b) => a.nearest_m - b.nearest_m);
  const present = new Set(resources.map((r) => r.resource));
  const missing = EARLY_ESSENTIALS.filter((item) => !present.has(item));

  return {
    ok: true,
    origin: centre,
    radius_m: radiusMeters,
    snapshot_radius_meters: snapshot?.world?.scan_radius_meters ?? null,
    node_count: nodes.length,
    deposit_count: deposits.length,
    water_extractor_spots: all.filter((n) => /WaterTurbine/i.test(n.actor_id ?? "")).length,
    resources,
    missing_essentials: missing,
    nodes,
  };
}

/**
 * A short verdict on the site.
 *
 * Deliberately willing to say "this is good". An assistant that only ever finds
 * fault is one whose praise means nothing, and whose criticism gets ignored.
 */
export function judgeSite(survey, { minerTier = 2 } = {}) {
  if (!survey?.ok) return { verdict: "unknown", lines: [] };

  const lines = [];
  const strong = [];
  const weak = [];

  for (const resource of survey.resources) {
    const pure = resource.by_purity.Pure ?? 0;
    if (pure >= 2) strong.push(`${pure} Pure ${resource.resource}`);
    if (resource.free === 0 && resource.total > 0) {
      weak.push(`every ${resource.resource} node here is already taken`);
    }
  }

  for (const item of survey.missing_essentials) {
    weak.push(`no ${item} within range`);
  }

  const iron = survey.resources.find((r) => r.resource === "Iron Ore");
  if (iron) {
    const yieldInfo = iron.by_purity.Pure > 0 ? nodeYield("RP_Pure", minerTier) : null;
    if (yieldInfo) {
      lines.push(
        `${iron.total} Iron Ore node${iron.total === 1 ? "" : "s"}, nearest ${iron.nearest_m} m. ` +
          `A ${yieldInfo.miner} on a Pure one yields ${yieldInfo.per_minute}/min` +
          `${yieldInfo.estimated ? " (purity multiplier unverified)" : ""}.`,
      );
    }
  }

  const verdict =
    weak.length === 0 && strong.length > 0
      ? "strong"
      : strong.length > 0 && weak.length > 0
        ? "mixed"
        : weak.length > 0
          ? "weak"
          : "ordinary";

  return { verdict, strong, weak, lines };
}

/** Human-readable survey, for the in-game panel. */
export function formatSurvey(survey, judgement) {
  if (!survey?.ok) {
    return "I could not find a point to survey from — no HUB and no player position in the capture.";
  }

  const scope = survey.radius_m
    ? `within ${survey.radius_m} m`
    : survey.snapshot_radius_meters
      ? `within the captured ${survey.snapshot_radius_meters} m`
      : "in range";

  const out = [`**${survey.node_count} permanent nodes** ${scope}:`, ""];
  for (const resource of survey.resources) {
    const purities = Object.entries(resource.by_purity)
      .map(([purity, count]) => `${count} ${purity}`)
      .join(", ");
    const taken = resource.occupied > 0 ? `, ${resource.occupied} already mined` : "";
    out.push(`- **${resource.resource}** — ${purities}, nearest ${resource.nearest_m} m${taken}`);
  }

  if (survey.deposit_count > 0) {
    out.push(
      "",
      `Also ${survey.deposit_count} one-off deposits — hand-mined and they run out, so they do not count ` +
        `toward whether this site can carry a factory.`,
    );
  }

  if (judgement?.lines?.length) out.push("", ...judgement.lines);
  if (judgement?.strong?.length) out.push("", `**Good here:** ${judgement.strong.join(", ")}.`);
  if (judgement?.weak?.length) out.push("", `**Weak here:** ${judgement.weak.join("; ")}.`);

  if (survey.snapshot_radius_meters) {
    out.push(
      "",
      `_Nothing beyond ${survey.snapshot_radius_meters} m was captured, so absence past that is not evidence._`,
    );
  }
  return out.join("\n");
}
