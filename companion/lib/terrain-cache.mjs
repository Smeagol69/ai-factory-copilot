/**
 * Remembering ground that was already measured.
 *
 * The mod probes terrain with line traces, which only hit geometry the engine
 * has streamed in — so it probes within a radius of the player, capped at a
 * fixed number of probes per capture. On a real save that is a small slice: 996
 * resource nodes, at most 150 measured, and every capture threw the results
 * away and started over. `find_best_site` then reported most of the map as
 * unmeasured, which was honest and useless in equal measure.
 *
 * The thing that makes this fixable is that Satisfactory's terrain is a fixed,
 * handcrafted map. Ground height, slope and water at a coordinate are the same
 * this session as last session, so a measurement taken once stays true. Caching
 * them means coverage grows monotonically as the player travels, and each
 * capture's probe budget goes to new ground instead of re-measuring the ground
 * underfoot.
 *
 * Two rules keep this from turning into invention:
 *
 *   1. Only real measurements are ever stored. A `no_ground_found` result means
 *      the traces hit nothing — usually unstreamed terrain — and is not a fact
 *      about the ground, so it is not cached.
 *   2. A cached reading is labelled as cached, with its age, and never presented
 *      as a live measurement. Obstruction is the one component that genuinely
 *      changes, because the player builds and dismantles, so it is marked stale
 *      rather than trusted.
 */

import fs from "node:fs";
import path from "node:path";

/** Terrain readings worth keeping. Anything else is an absence, not a fact. */
const MEASURED_VERDICTS = new Set([
  "flat_and_clear",
  "usable_with_foundations",
  "steep",
  "over_water",
  "obstructed",
]);

const CACHE_SCHEMA = 1;

export function defaultCachePath(env = process.env) {
  return path.join(
    env.LOCALAPPDATA ?? ".",
    "FactoryGame/Saved/AIFactoryCopilot/terrain-cache.json",
  );
}

/**
 * A cache entry is keyed by actor id, because a resource node's coordinate is
 * fixed by the map and its id is stable across sessions. Coordinates are stored
 * alongside so a key that somehow moves can be detected rather than trusted.
 */
export function createTerrainCache(options = {}) {
  const filePath = options.filePath ?? defaultCachePath();
  const now = options.now ?? (() => Date.now());
  let entries = new Map();
  let loadError = null;

  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed?.schema === CACHE_SCHEMA && parsed.entries && typeof parsed.entries === "object") {
        entries = new Map(Object.entries(parsed.entries));
      }
    }
  } catch (error) {
    // A corrupt cache must not cost the player an answer; it is rebuilt by
    // playing. The reason is reported rather than swallowed silently.
    loadError = error instanceof Error ? error.message : String(error);
    entries = new Map();
  }

  let dirty = false;

  return {
    filePath,
    loadError,
    get size() {
      return entries.size;
    },

    /**
     * Stores every live measurement in a snapshot.
     *
     * Returns how many readings were new, which is the only number that says
     * whether travelling actually taught us anything.
     */
    harvest(snapshot) {
      let learned = 0;
      let refreshed = 0;
      for (const actor of iterateTerrainBearingActors(snapshot)) {
        const terrain = actor.terrain;
        if (!terrain?.sampled || !MEASURED_VERDICTS.has(String(terrain.verdict))) continue;
        if (terrain.from_cache) continue; // Never re-store what we just injected.

        const key = String(actor.actor_id ?? "");
        if (!key) continue;

        const existed = entries.has(key);
        entries.set(key, {
          location: actor.location ?? null,
          measured_at: new Date(now()).toISOString(),
          terrain: stripInjectedFields(terrain),
        });
        dirty = true;
        if (existed) refreshed += 1;
        else learned += 1;
      }
      return { learned, refreshed, total: entries.size };
    },

    /**
     * Fills in terrain the current capture did not measure.
     *
     * Mutates the snapshot in place, which is deliberate: the graph, the solvers
     * and the model payload are all built from it downstream, and a cached
     * reading is worth exactly as much to each of them.
     */
    apply(snapshot) {
      let filled = 0;
      let alreadyLive = 0;
      for (const actor of iterateTerrainBearingActors(snapshot)) {
        if (actor.terrain?.sampled) {
          alreadyLive += 1;
          continue;
        }
        const cached = entries.get(String(actor.actor_id ?? ""));
        if (!cached?.terrain) continue;

        actor.terrain = {
          ...cached.terrain,
          from_cache: true,
          measured_at: cached.measured_at,
          measured_hours_ago: hoursBetween(cached.measured_at, now()),
          certainty: "measured_previously",
          source: "unreal_line_traces_and_water_volumes, cached from an earlier visit",
          // Ground does not move; what is standing on it does. Saying so is the
          // difference between a cache and a claim.
          cache_caveat:
            "Ground height, slope and water are fixed by the map and still hold. " +
            "Obstruction counts are from that earlier visit and may be stale if " +
            "anything has been built or dismantled here since.",
        };
        filled += 1;
      }
      return { filled, already_live: alreadyLive, cache_size: entries.size };
    },

    /** Writes only when something changed, so an idle session touches no disk. */
    flush() {
      if (!dirty) return false;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify({ schema: CACHE_SCHEMA, entries: Object.fromEntries(entries) }),
          "utf8",
        );
        dirty = false;
        return true;
      } catch {
        // Losing the write means re-measuring later, which is a slower session,
        // not a wrong answer.
        return false;
      }
    },
  };
}

/**
 * Every actor in a snapshot that can carry a terrain reading.
 *
 * Resource nodes are where the mod attaches them today, but the shape is not
 * node-specific and the scan-centre reading has no actor id, so this walks the
 * actor collections rather than assuming one.
 */
function* iterateTerrainBearingActors(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const collections = [
    snapshot.resource_nodes,
    snapshot.actors,
    snapshot.buildables,
  ];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const actor of collection) {
      if (actor && typeof actor === "object" && actor.actor_id) yield actor;
    }
  }
}

/** Fields added on the way out must not be stored on the way in. */
function stripInjectedFields(terrain) {
  const {
    from_cache: _fromCache,
    measured_at: _measuredAt,
    measured_hours_ago: _age,
    cache_caveat: _caveat,
    ...rest
  } = terrain;
  return rest;
}

function hoursBetween(isoTimestamp, nowMs) {
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) return null;
  return Math.round(((nowMs - then) / 3_600_000) * 10) / 10;
}
