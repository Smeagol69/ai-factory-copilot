/**
 * Saving a piece of the world by name, so it can be built again elsewhere.
 *
 * The owner's ask: select what is standing, call it "mk1 copper node
 * blueprint", and later say "place mk1 copper node blueprint on this node".
 *
 * This does not write a `.sbp`. Doing that means implementing Satisfactory's
 * save-object serialiser, which the companion does not even decode, and it
 * would buy nothing: the game's blueprint system exists to place buildings, and
 * the mod can already place buildings. What is missing is only the memory of
 * *which* buildings, where, and set to what.
 *
 * So a design is a list of placements relative to an origin, taken straight
 * from the capture: each building's `built_with_recipe`, its offset from the
 * anchor, its facing, and — for a manufacturer — the recipe it is running.
 * Replaying it is the same `place_building` path that already works.
 *
 * Offsets are stored in world axes and replayed by translation, so a design
 * placed at a new node comes out facing the way it was built. It turns only
 * when asked — `rotation_degrees`, from "rotated 90" in the phrase — because
 * *quietly* rotating a saved layout is how you get a factory that no longer
 * lines up with the belts someone planned around it. An angle the player said
 * out loud is not that.
 *
 * Two things it does not do, both recorded rather than dropped so that saying
 * so is possible:
 *
 *   Links. A belt, lift, pipe or power line is defined by two connection
 *   components, not a coordinate, so replaying one from a saved offset is a
 *   step that can only be refused. They go on `design.links`.
 *
 *   Potential. Nothing here can spend a Power Shard, so an overclocked machine
 *   rebuilds at 100%. The rate is saved on the building as `potential`, ready
 *   for whenever an action exists that can set one.
 */

import fs from "node:fs";
import path from "node:path";

const MAXIMUM_BUILDINGS = 400;

/** Where designs live. Beside the diagnostics, so everything is in one place. */
export function resolveDesignDirectory(env = process.env) {
  const configured = String(env.AIFACTORY_DESIGN_DIR ?? "").trim();
  if (configured) return path.resolve(configured);
  if (!env.LOCALAPPDATA) return null;
  return path.join(env.LOCALAPPDATA, "FactoryGame", "Saved", "AIFactoryCopilot", "Designs");
}

/** A filename that cannot escape the directory it is meant to live in. */
function designFileName(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug ? `${slug}.json` : null;
}

/**
 * Everything standing within `radius_cm` of the anchor, as relative placements.
 *
 * Only buildables the capture can fully describe are included. A building whose
 * build recipe is unknown would come back as some other building, so it is
 * reported as skipped rather than approximated.
 */
export function captureDesign(graph, { name, origin, radius_cm: radiusCm = 12_000, actor_ids: actorIds = null, exclude_extractors: excludeExtractors = false } = {}) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return { saved: false, reason: "the design needs a name" };
  if (!designFileName(trimmed)) {
    return { saved: false, reason: "that name has no letters or digits to make a filename from" };
  }
  if (!origin || ![origin.x, origin.y, origin.z].every((v) => Number.isFinite(Number(v)))) {
    return { saved: false, reason: "no anchor point with a finite x, y and z" };
  }

  // An explicit selection beats a radius. Marking things with the dismantle
  // tool is the player saying exactly which ones; a radius is a guess at the
  // same question that also sweeps up whatever happens to be standing nearby.
  const chosen = Array.isArray(actorIds) && actorIds.length > 0
    ? new Set(actorIds.map((id) => String(id)))
    : null;

  const buildings = [];
  const links = [];
  const skipped = [];
  for (const node of graph?.nodes?.values() ?? []) {
    const raw = node?.raw;
    if (!raw || raw.kind !== "buildable" || !raw.location) continue;
    if (chosen) {
      if (!chosen.has(String(raw.actor_id))) continue;
    } else {
      const distance = Math.hypot(raw.location.x - origin.x, raw.location.y - origin.y);
      if (distance > radiusCm) continue;
    }

    const recipeClass = String(raw.built_with_recipe ?? "").trim();
    // A design with no extractor is one a Blueprint Designer will accept, which
    // is the difference between a saved design and a real placeable blueprint.
    // One miner is placed on the node; everything downstream is the reusable
    // part.
    if (excludeExtractors && isExtractorRecipe(recipeClass)) {
      skipped.push({ name: raw.name, why: "left out so the design has no extractor" });
      continue;
    }
    if (!recipeClass) {
      skipped.push({ name: raw.name, why: "the capture does not say what recipe built it" });
      continue;
    }
    const placement = {
      recipe_class: recipeClass,
      class_path: raw.class_path,
      offset_cm: {
        x: Math.round((raw.location.x - origin.x) * 10) / 10,
        y: Math.round((raw.location.y - origin.y) * 10) / 10,
        z: Math.round((raw.location.z - origin.z) * 10) / 10,
      },
      yaw: Math.round((Number(raw.rotation?.yaw) || 0) * 100) / 100,
      production_recipe_class: String(raw.manufacturer?.recipe_class ?? "").trim() || null,
      // Recorded but not yet replayable: there is no action that sets a
      // machine's potential, so a design saved from overclocked machines comes
      // back at 100%. Writing it down is what lets the replay *say* so instead
      // of quietly handing back a slower factory than the one that was saved.
      ...(isOverclocked(raw) ? { potential: Number(raw.factory.current_potential) } : {}),
    };

    // Kept, but on the other list: a belt or a power line has two ends, and
    // replaying it at a coordinate is a step that can only be refused.
    const notPlaceable = describeUnplaceableByCoordinate(raw.class_path);
    if (notPlaceable) {
      links.push(placement);
      skipped.push({ name: raw.name, why: notPlaceable });
      continue;
    }

    buildings.push(placement);
    if (buildings.length > MAXIMUM_BUILDINGS) {
      return {
        saved: false,
        reason: `more than ${MAXIMUM_BUILDINGS} buildings are within ${radiusCm / 100} m; name a smaller radius`,
      };
    }
  }

  if (buildings.length === 0) {
    return {
      saved: false,
      reason: chosen
        ? "none of the selected actors is a building this capture can describe"
        : `nothing is standing within ${radiusCm / 100} m of that point`,
    };
  }

  // Sort so foundations and supports go down before whatever stands on them,
  // and so anything that mounts into a host comes after the host.
  buildings.sort(
    (left, right) =>
      placementOrder(left.class_path) - placementOrder(right.class_path) ||
      left.offset_cm.z - right.offset_cm.z,
  );

  return {
    saved: true,
    design: {
      schema: "aifactory.design/v1",
      name: trimmed,
      saved_at_utc: new Date().toISOString(),
      world_revision: graph?.world_revision ?? null,
      selected_by: chosen ? "dismantle_selection" : "radius",
      extractor_free: excludeExtractors,
      radius_cm: chosen ? null : radiusCm,
      building_count: buildings.length,
      buildings,
      // Recorded rather than discarded, so a later version that can rebuild a
      // belt or a wire from a saved design has the offsets to do it with.
      links,
    },
    skipped,
  };
}

export function writeDesign(design, env = process.env) {
  const directory = resolveDesignDirectory(env);
  if (!directory) return { written: false, reason: "no design directory is configured" };
  const file = designFileName(design.name);
  if (!file) return { written: false, reason: "the design name makes no usable filename" };
  fs.mkdirSync(directory, { recursive: true });
  const full = path.join(directory, file);
  fs.writeFileSync(full, JSON.stringify(design, null, 1));
  return { written: true, path: full };
}

/**
 * Retiring a design, without destroying it.
 *
 * A library you can only add to fills with experiments — this one already has
 * a "Smelter test" and a superseded "mk1 copper" beside its replacement. But
 * unlinking a file on a spoken request is the kind of thing that goes wrong
 * once and is unrecoverable, and a saved design can represent a real amount of
 * building.
 *
 * So it moves. The file goes to a `retired` folder beside the designs, keeps
 * its name, and stops appearing in the library. Putting it back is dragging one
 * file, and the reply says exactly where it went. Nothing here deletes.
 */
export function retireDesign(name, env = process.env) {
  const directory = resolveDesignDirectory(env);
  if (!directory) return { retired: false, reason: "no design directory is configured" };

  const { matches } = findDesign(name, env);
  if (matches.length === 0) return { retired: false, reason: `nothing saved is called "${name}"` };
  if (matches.length > 1) {
    return {
      retired: false,
      reason: `"${name}" matches ${matches.length} designs`,
      matches: matches.map((design) => design.name),
    };
  }

  const file = designFileName(matches[0].name);
  const from = path.join(directory, file);
  if (!fs.existsSync(from)) return { retired: false, reason: "the design's file is not on disk" };

  const retiredDirectory = path.join(directory, "retired");
  fs.mkdirSync(retiredDirectory, { recursive: true });
  // A name reused after retiring one would otherwise overwrite the old file,
  // which is the one outcome this whole function exists to avoid.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const to = path.join(retiredDirectory, `${path.basename(file, ".json")}--${stamp}.json`);
  fs.renameSync(from, to);
  return { retired: true, name: matches[0].name, path: to, building_count: matches[0].building_count };
}

/** Giving a saved design a different name. Same file, new name inside and out. */
export function renameDesign(from, to, env = process.env) {
  const directory = resolveDesignDirectory(env);
  if (!directory) return { renamed: false, reason: "no design directory is configured" };

  const wanted = String(to ?? "").trim();
  if (!wanted) return { renamed: false, reason: "the new name is empty" };
  const target = designFileName(wanted);
  if (!target) return { renamed: false, reason: "that name has no letters or digits to make a filename from" };

  const { matches } = findDesign(from, env);
  if (matches.length === 0) return { renamed: false, reason: `nothing saved is called "${from}"` };
  if (matches.length > 1) {
    return {
      renamed: false,
      reason: `"${from}" matches ${matches.length} designs`,
      matches: matches.map((design) => design.name),
    };
  }
  if (fs.existsSync(path.join(directory, target)) && designFileName(matches[0].name) !== target) {
    return { renamed: false, reason: `something saved is already called "${wanted}"` };
  }

  const design = { ...matches[0], name: wanted };
  const previous = path.join(directory, designFileName(matches[0].name));
  fs.writeFileSync(path.join(directory, target), JSON.stringify(design, null, 1));
  if (path.basename(previous) !== target) fs.rmSync(previous, { force: true });
  return { renamed: true, from: matches[0].name, to: wanted };
}

export function listDesigns(env = process.env) {
  const directory = resolveDesignDirectory(env);
  if (!directory || !fs.existsSync(directory)) return [];
  const designs = [];
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    try {
      const design = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      if (design?.schema === "aifactory.design/v1") designs.push(design);
    } catch {
      // A design that cannot be read is not a design. Skipping it beats
      // refusing to list the ones that are fine.
    }
  }
  return designs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * How close two short names are, as a count of edits.
 *
 * Only used to *suggest*, never to pick. "place emga base here" is in the
 * routing log — one transposition away from "mega base", and it fell through
 * to a model that could not know what was saved. Suggesting is the whole
 * benefit; placing a 389-building design because two letters were swapped is
 * exactly the guess this project does not make.
 */
function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function findDesign(name, env = process.env) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return { matches: [] };
  const all = listDesigns(env);
  const exact = all.filter((design) => String(design.name).toLowerCase() === needle);
  if (exact.length > 0) return { matches: exact, near: [] };

  const partial = all.filter((design) => String(design.name).toLowerCase().includes(needle));
  if (partial.length > 0) return { matches: partial, near: [] };

  // Nothing matched. Offer the near misses so a typo gets a name back instead
  // of silence, without ever placing one on its own.
  const near = all
    .map((design) => ({ design, distance: editDistance(needle, String(design.name).toLowerCase()) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(needle.length / 4)))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map((entry) => entry.design.name);
  return { matches: [], near };
}

/**
 * A miner in a saved design has to be told which node it is going on.
 *
 * Everything else in a design is positioned by offset, but an extractor is not
 * placed on a coordinate — it is placed *on a node*, and the game refuses it
 * otherwise. Replaying a saved miner by translation alone lands it near the new
 * node rather than attached to it, which is the failure that took several
 * builds to work out the first time.
 */
function isExtractorRecipe(recipeClass) {
  return /Miner|Extractor|WaterPump|OilPump|FrackingExtractor/i.test(String(recipeClass ?? ""));
}

/**
 * Some things are not placed at a point at all.
 *
 * A belt, a lift, a pipeline and a power line are each defined by *two* ends:
 * the action that builds one takes a pair of connection components, not a
 * coordinate. Asking `place_building` to put one at an offset cannot work no
 * matter how good the offset is, and a design that contains one spends a step
 * being refused — which, because a plan stops at its first runtime failure, can
 * take the rest of the design down with it.
 *
 * Found by reading the designs already on disk: `mk1-copper-v2` had four power
 * lines in it and `mk2` had six belts, three lifts and a splitter's worth of
 * wiring, all saved as placements.
 *
 * They are not thrown away — `captureDesign` keeps them under `links` — they
 * are just not replayed as placements.
 */
export function describeUnplaceableByCoordinate(classPath) {
  const name = String(classPath ?? "");
  if (/ConveyorBelt|ConveyorLift|Pipeline(?!Support)|PipeHyper(?!Support)/i.test(name)) {
    return "runs between two connections, so it is built as a belt or pipe rather than placed at a point";
  }
  if (/PowerLine/i.test(name)) {
    return "is a wire between two power connections, not a building with a location";
  }
  return null;
}

/**
 * What goes down before what.
 *
 * Structural pieces first, then machines, then anything that mounts into
 * something else. `Build_ConveyorWallHole_C` is why this is not a single
 * pattern: it contains "Wall", so the first version filed it as structural and
 * tried to place it *before* the wall it cuts through. That is the design that
 * refused at its very first action with `FGCDMustSnapWall`.
 *
 * Getting a piece into the wrong bucket costs an ordering, not a placement —
 * the game still decides what it accepts — so this is allowed to be a
 * judgement about names where the class list gives nothing better.
 */
function placementOrder(classPath) {
  const name = String(classPath ?? "");
  if (/WallHole|PowerPoleWall|Railing|Fence|CatwalkStairs|WalkwayRamp/i.test(name)) return 2;
  if (/Foundation|Wall|Pillar|Ramp|Beam|Floor|Catwalk|Stairs/i.test(name)) return 0;
  return 1;
}

/**
 * Turning a whole design about its anchor.
 *
 * Not turning is still the default, for the reason in the header. This is the
 * opt-in: a vanilla blueprint turns under the build gun, and the owner asked
 * for placement that works "exactly the same as default game parameters for
 * blueprint placement".
 *
 * Yaw only. UE's yaw rotation sends X to (cos, sin) and Y to (-sin, cos), so
 * this is the plain 2D rotation and the arrangement stays rigid: every offset
 * turns by the same angle about the same anchor, and each building's own facing
 * turns with it.
 */
/**
 * A machine running at anything other than its default rate.
 *
 * The snapshot reports `factory.current_potential` as a multiplier, 1 being
 * 100%. Anything else is a Power Shard the player spent, and losing it silently
 * on replay hands back a slower factory than the one that was saved.
 */
function isOverclocked(raw) {
  const potential = Number(raw?.factory?.current_potential);
  return Number.isFinite(potential) && Math.abs(potential - 1) > 0.001;
}

const normaliseYaw = (degrees) => ((Number(degrees) % 360) + 360) % 360;

function turnOffset({ x, y }, degrees) {
  if (!degrees) return { x, y };
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/**
 * Leaving a category out on request.
 *
 * "place mk1 copper v2 on this node but ignore the foundations" and "place
 * everything ignore the belts" are both in the routing log. A design is often
 * *almost* what someone wants, and rebuilding it without its floor is a
 * reasonable ask — the alternative today is placing all of it and dismantling
 * by hand.
 *
 * Matched on the class path, so it works for modded pieces too: a
 * `Build_CCFoundation8x8xhalf_C` is a foundation whoever shipped it.
 */
const OMISSION_PATTERNS = {
  foundation: /Foundation|Floor/i,
  floor: /Foundation|Floor/i,
  wall: /Wall(?!Hole)/i,
  pillar: /Pillar/i,
  ramp: /Ramp/i,
  railing: /Railing/i,
  beam: /Beam/i,
  "power pole": /PowerPole/i,
  pole: /PowerPole/i,
  storage: /Storage/i,
  "storage container": /Storage/i,
  container: /Storage/i,
};

/** A saved design as placements at a new anchor. */
export function planDesignPlacement(design, { origin, commit = true, node = null, ignore_clearance: ignoreClearance = true, rotation_degrees: rotationDegrees = 0, omit = null } = {}) {
  if (!origin || ![origin.x, origin.y, origin.z].every((v) => Number.isFinite(Number(v)))) {
    return { planned: false, reason: "no anchor point with a finite x, y and z" };
  }
  const saved = Array.isArray(design?.buildings) ? design.buildings : [];
  if (saved.length === 0) return { planned: false, reason: "that design has no buildings in it" };

  // Designs saved before the capture learned the difference still have belts
  // and power lines on the buildings list, so the filter runs here too. They
  // are reported, not dropped quietly — a plan stops at its first runtime
  // failure, and one power line at the front of the queue takes the whole
  // design with it.
  //
  // A design saved *since* that change already has them on `links`, and those
  // count too: the player placing it now is owed the same sentence whether the
  // design was saved last week or last month. Without this the message
  // appeared only for older designs, which is the sort of inconsistency nobody
  // would ever guess at from the reply.
  const notPlaceable = (Array.isArray(design?.links) ? design.links : []).map((entry) => ({
    class_path: entry.class_path,
    why: describeUnplaceableByCoordinate(entry.class_path) ?? "is a link, not a building at a point",
  }));
  const buildings = saved.filter((entry) => {
    const why = describeUnplaceableByCoordinate(entry.class_path);
    if (why) notPlaceable.push({ class_path: entry.class_path, why });
    return !why;
  });
  if (buildings.length === 0) {
    return {
      planned: false,
      reason: "everything in that design is a belt, lift or wire, and none of it is placed at a point",
    };
  }

  // A category the player asked to leave out. Counted and reported, because
  // "21 buildings" when six were dropped on request is still a wrong number.
  const omitPattern = omit ? OMISSION_PATTERNS[String(omit).toLowerCase()] ?? null : null;
  let omitted = 0;
  if (omitPattern) {
    const kept = buildings.filter((entry) => {
      const drop = omitPattern.test(String(entry.class_path ?? entry.recipe_class));
      if (drop) omitted += 1;
      return !drop;
    });
    if (kept.length === 0) {
      return {
        planned: false,
        reason: `every building in that design is a ${omit}, so leaving them out leaves nothing`,
      };
    }
    // Rewritten in place rather than reassigned, because `buildings` is sorted
    // and read below. Splice, not `length = 0` followed by a push from the same
    // array -- that emptied the source it was about to copy from, and quietly
    // wiped every design placement until the tests caught it.
    buildings.splice(0, buildings.length, ...kept);
  }

  // Re-sort on replay as well: the order a design was saved in reflects the
  // rules that were understood when it was saved.
  buildings.sort(
    (left, right) =>
      placementOrder(left.class_path) - placementOrder(right.class_path) ||
      left.offset_cm.z - right.offset_cm.z,
  );

  // Placing on a node pins the extractor to the node, so every other building
  // has to be measured from the extractor — not from whatever the design
  // happened to be anchored on when it was saved.
  //
  // Without this the layout shears: the miner jumps to the node while the rest
  // stay at offsets from the old anchor, which put a smelter far away on the
  // first live run. Re-anchoring keeps the arrangement rigid, which is the one
  // thing a saved design has to guarantee.
  const extractor = node ? buildings.find((entry) => isExtractorRecipe(entry.recipe_class)) : null;
  const shift = extractor
    ? { x: extractor.offset_cm.x, y: extractor.offset_cm.y, z: extractor.offset_cm.z }
    : { x: 0, y: 0, z: 0 };

  const turn = Number.isFinite(Number(rotationDegrees))
    ? ((Number(rotationDegrees) % 360) + 360) % 360
    : 0;

  return {
    planned: true,
    name: design.name,
    count: buildings.length,
    not_placeable: notPlaceable,
    omitted_on_request: omitted,
    omitted_kind: omitted > 0 ? omit : null,
    rotated_degrees: turn,
    // Said out loud rather than lost. Nothing here can set a potential, so an
    // overclocked design rebuilds at 100% and the player should hear that from
    // the reply, not from a production rate that does not match.
    overclocked_not_replayed: buildings.filter((entry) => Number.isFinite(entry.potential)).length,
    extractors_snapped: node ? buildings.filter((e) => isExtractorRecipe(e.recipe_class)).length : 0,
    actions: buildings.map((entry) => {
      // An extractor goes on the node, not at an offset from it. Given a node,
      // the miner is placed at its centre and told which actor it sits on --
      // the same target_actor_id that made single miner placement work.
      const onNode = node && isExtractorRecipe(entry.recipe_class);
      const turned = turnOffset(
        { x: entry.offset_cm.x - shift.x, y: entry.offset_cm.y - shift.y },
        turn,
      );
      return {
        action: "place_building",
        recipe_class: entry.recipe_class,
        // A saved design already stood somewhere. If it was built with
        // clearance off, its foundations intersect its machines on purpose,
        // and re-imposing the check here refuses a layout the player has
        // already seen work. Only overlap is waived; the game still refuses
        // no ground, water, cost and the rest.
        ...(ignoreClearance ? { ignore_clearance: true } : {}),
        // The saved heights are the arrangement. Without this each building
        // traces to its own terrain and the design comes apart vertically.
        exact_z: true,
        ...(entry.production_recipe_class
          ? { production_recipe_class: entry.production_recipe_class }
          : {}),
        ...(onNode && node.actor_id ? { target_actor_id: node.actor_id } : {}),
        location: onNode
          ? { x: node.location.x, y: node.location.y, z: node.location.z }
          : {
              x: Math.round((Number(origin.x) + turned.x) * 10) / 10,
              y: Math.round((Number(origin.y) + turned.y) * 10) / 10,
              z: Math.round((Number(origin.z) + entry.offset_cm.z - shift.z) * 10) / 10,
            },
        // Untouched when nothing was asked for, so a design placed the old way
        // comes out byte-for-byte the same.
        yaw: turn ? Math.round(normaliseYaw(entry.yaw + turn) * 100) / 100 : entry.yaw,
        commit,
      };
    }),
    unverified:
      "Offsets are replayed in world axes, so the design keeps the facing it was " +
      "saved with. The game validates every placement and refuses the ones that " +
      "do not fit.",
  };
}
