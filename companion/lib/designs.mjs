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
 * The one thing it deliberately does not do is rotate. Offsets are stored in
 * world axes and replayed by translation, so a design placed at a new node
 * comes out facing the way it was built. Re-orienting to a new approach angle
 * is a real feature and a different one; quietly rotating a saved layout is how
 * you get a factory that no longer lines up with the belts someone planned
 * around it.
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

export function findDesign(name, env = process.env) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return { matches: [] };
  const all = listDesigns(env);
  const exact = all.filter((design) => String(design.name).toLowerCase() === needle);
  if (exact.length > 0) return { matches: exact };
  return { matches: all.filter((design) => String(design.name).toLowerCase().includes(needle)) };
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
 * The header above says offsets are replayed in world axes and the design keeps
 * the facing it was saved with. That is still the default, and still for the
 * stated reason. But a vanilla blueprint turns under the build gun, the owner
 * asked for placement that works "exactly the same as default game parameters
 * for blueprint placement", and an angle the player asked for out loud is not
 * the quiet re-orientation that comment was warning about.
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

/** A saved design as placements at a new anchor. */
export function planDesignPlacement(design, { origin, commit = true, node = null, ignore_clearance: ignoreClearance = true, rotation_degrees: rotationDegrees = 0 } = {}) {
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
  const notPlaceable = [];
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
