import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSnapshotCache,
  describesWholeWorld,
  identifySave,
  resolveSnapshotCacheDirectory,
} from "../lib/snapshot-cache.mjs";

const AT = () => new Date("2026-09-22T18:00:00Z");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-snapshot-cache-"));
}

function snapshot({ session = "chatgpt", radius = null, actors = 3, revision = 29 } = {}) {
  const world = { map: "Persistent_Level", net_mode: "NM_ListenServer" };
  if (session !== null) world.session_name = session;
  if (radius !== null) world.scan_radius_meters = radius;
  return {
    schema: "aifactory.snapshot",
    world,
    world_revision: revision,
    generated_at_utc: "2026-09-22T17:59:00Z",
    actors: Array.from({ length: actors }, (unused, index) => ({ actor_id: `actor_${index}` })),
    content: { recipes: [] },
  };
}

// --- which save is this -----------------------------------------------------

test("a save is identified by its map and session name together", () => {
  const first = identifySave(snapshot({ session: "chatgpt" }));
  const second = identifySave(snapshot({ session: "Learning the game" }));
  assert.equal(first.identified, true);
  assert.equal(first.save_session_name, "chatgpt");
  assert.notEqual(first.save_id, second.save_id, "two saves must not share a key");
});

test("the same save keeps one id across captures, radius or not", () => {
  const wide = identifySave(snapshot());
  const near = identifySave(snapshot({ radius: 250, actors: 1 }));
  assert.equal(wide.save_id, near.save_id);
});

test("a capture that does not say which save it is refuses rather than guessing", () => {
  // world.session_name is written only when the game state cast succeeds, so
  // absent means "this capture cannot say". Treating that as an empty name
  // would file two different worlds under one key.
  const missing = identifySave(snapshot({ session: null }));
  assert.equal(missing.identified, false);
  assert.match(missing.reason, /save_session/);
  const noMap = identifySave({ world: { session_name: "chatgpt" } });
  assert.equal(noMap.identified, false);
  assert.match(noMap.reason, /map/);
});

test("whole world is the absence of a scan radius", () => {
  assert.equal(describesWholeWorld(snapshot()), true);
  assert.equal(describesWholeWorld(snapshot({ radius: 250 })), false);
  assert.equal(describesWholeWorld(snapshot({ radius: 0 })), true, "a zero radius is not a circle");
});

// --- where it lives ---------------------------------------------------------

test("the directory is resolved from the env it is given, not the process", () => {
  // Deliberate: the terrain cache reads process.env inside its resolver, and
  // the test suite consequently reads and writes the player's real cache file.
  assert.equal(resolveSnapshotCacheDirectory({ AIFACTORY_SNAPSHOT_CACHE: "D:/somewhere" }), path.resolve("D:/somewhere"));
  for (const off of ["0", "false", "off", "none", "OFF"]) {
    assert.equal(resolveSnapshotCacheDirectory({ AIFACTORY_SNAPSHOT_CACHE: off }), null, off);
  }
  assert.equal(resolveSnapshotCacheDirectory({}), null, "nowhere to write means disabled, not cwd");
  assert.match(
    String(resolveSnapshotCacheDirectory({ LOCALAPPDATA: "C:/Users/x/AppData/Local" })),
    /AIFactoryCopilot[\\/]Snapshots$/,
  );
});

test("with no directory it is a no-op that says so, not a crash", () => {
  const cache = createSnapshotCache({ directory: null, now: AT });
  assert.equal(cache.configured, false);
  const result = cache.record(snapshot());
  assert.equal(result.stored, false);
  assert.match(result.reason, /not_configured/);
  assert.deepEqual(cache.list(), []);
});

// --- keeping a world --------------------------------------------------------

test("a whole-world capture is stored and reads back intact", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const stored = cache.record(snapshot({ actors: 7 }));
    assert.equal(stored.stored, true);
    assert.deepEqual(stored.slots_written, ["latest", "world"]);

    const back = cache.read(stored.save_id);
    assert.equal(back.found, true);
    assert.equal(back.save.save_session_name, "chatgpt");
    assert.equal(back.actor_count, 7);
    assert.equal(back.world_revision, 29);
    assert.equal(back.snapshot.actors.length, 7, "the world itself comes back, not a summary");
    assert.equal(back.stored_at_utc, "2026-09-22T18:00:00.000Z");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a nearby capture never destroys the whole-world one", () => {
  // The failure this exists to stop: /ai sends a 250 m circle, it overwrites
  // the wide view, and a planner reading the cache sizes the whole base to a
  // circle because that is all the world it can see.
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const wide = cache.record(snapshot({ actors: 40 }));
    const near = cache.record(snapshot({ radius: 250, actors: 2 }));

    assert.deepEqual(near.slots_written, ["latest"], "a radius capture writes only the latest slot");
    assert.equal(cache.read(wide.save_id, { slot: "world" }).actor_count, 40);
    assert.equal(cache.read(wide.save_id, { slot: "latest" }).actor_count, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("two saves do not overwrite each other", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const sandbox = cache.record(snapshot({ session: "chatgpt", actors: 5 }));
    const main = cache.record(snapshot({ session: "Learning the game", actors: 90 }));
    assert.notEqual(sandbox.save_id, main.save_id);
    assert.equal(cache.read(sandbox.save_id).actor_count, 5);
    assert.equal(cache.read(main.save_id).actor_count, 90);
    assert.equal(cache.list().length, 4, "two slots each");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a save that was never captured says so rather than throwing", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const missing = cache.read("0".repeat(64));
    assert.equal(missing.found, false);
    assert.match(missing.reason, /nothing_for_this_save/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt entry is reported, not thrown and not silently treated as empty", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const stored = cache.record(snapshot());
    fs.writeFileSync(path.join(directory, `${stored.save_id}-world.json.gz`), "not gzip at all");
    const back = cache.read(stored.save_id);
    assert.equal(back.found, false);
    assert.match(back.reason, /unreadable/);
    assert.ok(back.diagnostic, "a corrupt cache should say what went wrong");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unwritable directory is reported rather than failing the request", () => {
  const cache = createSnapshotCache({ directory: "\0invalid", now: AT });
  const result = cache.record(snapshot());
  assert.equal(result.stored, false);
  assert.match(result.reason, /write_failed/);
});

test("listing reports what is on disk without opening it", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const stored = cache.record(snapshot());
    fs.writeFileSync(path.join(directory, "not-a-cache-entry.txt"), "ignore me");
    const listed = cache.list();
    assert.equal(listed.length, 2);
    assert.ok(listed.every((entry) => entry.save_id === stored.save_id));
    assert.deepEqual([...listed.map((entry) => entry.slot)].sort(), ["latest", "world"]);
    assert.ok(listed.every((entry) => entry.bytes > 0));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A LIVE FEED OFFERS THE SAME WORLD OVER AND OVER
//
// The observer ticks once a second whether or not anything moved. Writing ~6 MB
// twice per tick for a world that has not changed buys nothing but disk wear,
// so an unchanged revision is skipped - but only when the caller asks for that,
// because a question is a deliberate moment and worth keeping either way.

test("an unchanged world is not rewritten when the caller asks to skip", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    const first = cache.record(snapshot({ revision: 7 }), { skipUnchanged: true });
    assert.equal(first.stored, true);

    const again = cache.record(snapshot({ revision: 7 }), { skipUnchanged: true });
    assert.equal(again.stored, false);
    assert.match(again.reason, /unchanged/);
    assert.equal(again.save_id, first.save_id);

    const moved = cache.record(snapshot({ revision: 8 }), { skipUnchanged: true });
    assert.equal(moved.stored, true, "a world that moved is written");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("without the flag the same world is stored again, because a question is deliberate", () => {
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    assert.equal(cache.record(snapshot({ revision: 7 })).stored, true);
    assert.equal(cache.record(snapshot({ revision: 7 })).stored, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a nearby capture at the same revision does not count as unchanged", () => {
  // Same revision, different coverage: the whole-world slot is still missing
  // this one, so skipping it would leave the wide view stale forever.
  const directory = scratch();
  try {
    const cache = createSnapshotCache({ directory, now: AT });
    cache.record(snapshot({ revision: 7, radius: 250 }), { skipUnchanged: true });
    const wide = cache.record(snapshot({ revision: 7 }), { skipUnchanged: true });
    assert.equal(wide.stored, true);
    assert.deepEqual(wide.slots_written, ["latest", "world"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
