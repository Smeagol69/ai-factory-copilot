/**
 * Keeping the last world the game showed us, so it can be read again later.
 *
 * Every other store here keeps something *derived* - terrain readings, a
 * revision manifest, relative placements. None of them keeps the world itself,
 * and that absence has a cost: the snapshot exists only for the life of one
 * request, so nothing outside the game can look at the player's actual base.
 * Planners get tested against hand-built fixtures instead, which is how a
 * central hub shipped that could never have been stamped - the fixtures agreed
 * with it and the real world was never consulted.
 *
 * This keeps it. One file per save, written when a capture arrives.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO FILES PER SAVE
 *
 * `/ai <question>` sends a fresh *nearby* capture; `/ai all <question>` sends
 * the whole world. A nearby capture is a legitimate snapshot and worth keeping
 * as the most recent thing seen - but if it overwrote the whole-world one, a
 * planner reading the cache would conclude the base is a 250 m circle and size
 * everything to it. So the newest capture and the newest whole-world capture
 * are kept separately, and a reader asks for the one it needs.
 *
 * ---------------------------------------------------------------------------
 * SIZE
 *
 * A real whole-world capture is ~24 MB of JSON, and the actor cap allows about
 * twenty times what this save currently uses. Stored raw and per save that runs
 * to hundreds of megabytes, so it is gzipped - JSON of this shape compresses by
 * roughly an order of magnitude. Compression level 1 deliberately: this runs
 * inside the request path, and on a payload this size the difference between
 * level 1 and level 9 is seconds of the player's time for a few percent of
 * disk.
 *
 * Nothing is dropped to save space. `content` alone is 5.9 MB and it would be
 * the obvious cut, but it carries the recipes - without them the cached world
 * cannot be turned into a graph, which is the entire point of keeping it.
 *
 * ---------------------------------------------------------------------------
 * NAMING
 *
 * The filename is a digest of {map, save_session_name} and nothing else. The
 * session name is typed by the player and must never be path-joined - the same
 * rule the architect store states at its own resolver. Keyed on the save only,
 * not the chat session, so the directory has one entry per save the player has
 * actually opened rather than one per conversation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CACHE_SCHEMA = "aifactory.snapshot-cache/v1";

/** Refuse anything larger than this, compressed. A real capture is ~2 MB here. */
const MAXIMUM_STORED_BYTES = 64 * 1024 * 1024;

/** Fast, because this runs while the player waits for an answer. */
const GZIP_LEVEL = 1;

const OFF_SWITCHES = new Set(["0", "false", "off", "none"]);

/**
 * Where the cache lives, or null when it is switched off or has nowhere to go.
 *
 * Takes `env` as a parameter rather than reading `process.env` inside, because
 * the terrain cache does the opposite and the test suite consequently reads and
 * writes the player's real cache file. Threading it through is the difference.
 */
export function resolveSnapshotCacheDirectory(env = process.env) {
  const configured = String(env?.AIFACTORY_SNAPSHOT_CACHE ?? "").trim();
  if (configured) {
    return OFF_SWITCHES.has(configured.toLowerCase()) ? null : path.resolve(configured);
  }
  const localAppData = String(env?.LOCALAPPDATA ?? "").trim();
  if (!localAppData) return null;
  return path.join(localAppData, "FactoryGame", "Saved", "AIFactoryCopilot", "Snapshots");
}

function boundedText(value, limit) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : null;
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

/**
 * Which save a snapshot came from, or a reason it cannot be told.
 *
 * Absent is refused rather than treated as empty: `world.session_name` is
 * written only when the game state cast succeeds, so a missing key means "this
 * capture does not say which save it is", which is not the same as a save whose
 * name happens to be blank. Keying those together would merge two worlds into
 * one file.
 */
export function identifySave(snapshot) {
  const map = boundedText(snapshot?.world?.map, 256);
  if (!map) return { identified: false, reason: "snapshot_does_not_say_which_map_it_is" };
  const sessionName = boundedText(snapshot?.world?.session_name, 256);
  if (!sessionName) {
    return { identified: false, reason: "snapshot_does_not_say_which_save_session_it_is" };
  }
  const scope = { map, save_session_name: sessionName };
  return {
    identified: true,
    map,
    save_session_name: sessionName,
    save_id: crypto.createHash("sha256").update(stableJson(scope)).digest("hex"),
  };
}

/**
 * Whether this capture covers the whole world or a circle around the player.
 *
 * `scan_radius_meters` is request geometry: present means the mod was asked for
 * a radius. Its absence is what whole-world looks like.
 */
export function describesWholeWorld(snapshot) {
  const radius = snapshot?.world?.scan_radius_meters;
  return !(Number.isFinite(Number(radius)) && Number(radius) > 0);
}

function writeAtomically(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${buffer.length}.tmp`;
  try {
    fs.writeFileSync(temporary, buffer, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort. A stray temp file is not worth failing a request over.
    }
  }
}

export function createSnapshotCache({ directory, now = () => new Date() } = {}) {
  const root = directory ?? null;
  const configured = Boolean(root);
  // What each save looked like the last time it was written, so a live feed
  // ticking once a second does not rewrite megabytes for a world that has not
  // moved. Kept in memory deliberately: reading it back off disk would mean
  // decompressing the very file the check exists to avoid writing.
  const lastWritten = new Map();

  function pathFor(saveId, slot) {
    return path.join(root, `${saveId}-${slot}.json.gz`);
  }

  /**
   * Keep this capture. Returns what happened - never throws, because a cache
   * miss is not worth failing the player's question over.
   */
  function record(snapshot, { skipUnchanged = false } = {}) {
    if (!configured) return { stored: false, reason: "snapshot_cache_is_not_configured" };
    const save = identifySave(snapshot);
    if (!save.identified) return { stored: false, reason: save.reason };

    const wholeWorld = describesWholeWorld(snapshot);

    // `world_revision` moves whenever the world does - it is why the mod's own
    // observer can tell a changed world from a still one. A feed may therefore
    // offer the same world many times over, and rewriting it each time buys
    // nothing but disk wear.
    const revision = snapshot?.world_revision ?? null;
    if (skipUnchanged && revision !== null) {
      const previous = lastWritten.get(save.save_id);
      if (previous && previous.revision === revision && previous.whole_world === wholeWorld) {
        return {
          stored: false,
          reason: "snapshot_cache_world_is_unchanged",
          save_id: save.save_id,
          world_revision: revision,
        };
      }
    }
    const envelope = {
      schema: CACHE_SCHEMA,
      save: { map: save.map, save_session_name: save.save_session_name, save_id: save.save_id },
      stored_at_utc: now().toISOString(),
      whole_world: wholeWorld,
      world_revision: snapshot?.world_revision ?? null,
      generated_at_utc: snapshot?.generated_at_utc ?? null,
      actor_count: Array.isArray(snapshot?.actors) ? snapshot.actors.length : null,
      snapshot,
    };

    let buffer;
    try {
      buffer = zlib.gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"), { level: GZIP_LEVEL });
    } catch (error) {
      return { stored: false, reason: "snapshot_cache_could_not_compress", diagnostic: String(error?.message ?? error) };
    }
    if (buffer.length > MAXIMUM_STORED_BYTES) {
      return {
        stored: false,
        reason: "snapshot_cache_entry_exceeds_size_limit",
        bytes: buffer.length,
        limit_bytes: MAXIMUM_STORED_BYTES,
      };
    }

    // The newest capture always lands. The whole-world slot is only written by
    // a whole-world capture, so a nearby one never destroys the wide view.
    const written = [];
    try {
      writeAtomically(pathFor(save.save_id, "latest"), buffer);
      written.push("latest");
      if (wholeWorld) {
        writeAtomically(pathFor(save.save_id, "world"), buffer);
        written.push("world");
      }
    } catch (error) {
      return {
        stored: false,
        reason: "snapshot_cache_write_failed",
        diagnostic: String(error?.message ?? error),
        slots_written: written,
      };
    }

    lastWritten.set(save.save_id, { revision, whole_world: wholeWorld });
    return {
      stored: true,
      save_id: save.save_id,
      save_session_name: save.save_session_name,
      whole_world: wholeWorld,
      slots_written: written,
      bytes: buffer.length,
      actor_count: envelope.actor_count,
    };
  }

  /** Read a stored capture back. `slot` is "world" (default) or "latest". */
  function read(saveId, { slot = "world" } = {}) {
    if (!configured) return { found: false, reason: "snapshot_cache_is_not_configured" };
    const filePath = pathFor(saveId, slot);
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(filePath));
      const envelope = JSON.parse(raw.toString("utf8"));
      if (envelope?.schema !== CACHE_SCHEMA) {
        return { found: false, reason: "snapshot_cache_entry_has_unknown_schema", path: filePath };
      }
      return { found: true, path: filePath, ...envelope };
    } catch (error) {
      return {
        found: false,
        reason: error?.code === "ENOENT" ? "snapshot_cache_has_nothing_for_this_save" : "snapshot_cache_entry_is_unreadable",
        diagnostic: String(error?.message ?? error),
        path: filePath,
      };
    }
  }

  /** What is on disk, for /health and for finding a save id without the game. */
  function list() {
    if (!configured) return [];
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const match = /^([0-9a-f]{64})-(latest|world)\.json\.gz$/.exec(name);
      if (!match) continue;
      let size = null;
      let modified = null;
      try {
        const stat = fs.statSync(path.join(root, name));
        size = stat.size;
        modified = stat.mtime.toISOString();
      } catch {
        // Listing is diagnostics; a file that vanished mid-scan is not an error.
      }
      entries.push({ save_id: match[1], slot: match[2], bytes: size, modified_utc: modified });
    }
    return entries;
  }

  return { configured, directory: root, record, read, list };
}
