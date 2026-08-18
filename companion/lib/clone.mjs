/**
 * Copying what is already standing, instead of describing it again.
 *
 * The owner's idea, and it is a good one: select something built, and stamp it
 * out — a row of Smelters for a manifold, a repeated module. Micro Manage did
 * this and no longer works.
 *
 * The useful realisation is that none of it needs new game code. The snapshot
 * already carries, for every buildable: its `built_with_recipe` (exactly what
 * `place_building` takes), its `rotation`, its measured `bounds`, and for a
 * manufacturer its current `recipe_class`. So "copy this and put five more in a
 * row" is a read and some arithmetic over data already on disk.
 *
 * What is not free is *mouse* selection — a drag-box in the world would be real
 * UI work inside the mod. Naming the thing instead ("this smelter", "these four
 * constructors") reaches the same place through the crosshair the game already
 * reports, and is quicker to say than a box is to drag.
 *
 * Spacing is measured, not stated. `bounds.extent` is the real half-size of the
 * source building, so the pitch is its own width plus a gap — which is why this
 * can space a Constructor and a Splitter correctly without knowing what either
 * one is.
 */

/** Gap left between copies, on top of the measured footprint. */
const DEFAULT_GAP_CM = 200;

function yawToUnitVectors(yawDegrees) {
  const radians = (Number(yawDegrees) || 0) * (Math.PI / 180);
  const forward = { x: Math.cos(radians), y: Math.sin(radians) };
  return { forward, lateral: { x: -forward.y, y: forward.x } };
}

/**
 * The source building, read straight out of the capture.
 *
 * Returns null rather than a partial answer: a copy missing its build recipe
 * would be a different building, and one missing its rotation would face the
 * wrong way, so neither is worth emitting.
 */
export function describeCloneSource(graph, actorId) {
  const node = graph?.nodes?.get(String(actorId ?? "")) ?? null;
  const raw = node?.raw ?? null;
  if (!raw || raw.kind !== "buildable") return null;

  const recipeClass = String(raw.built_with_recipe ?? "").trim();
  if (!recipeClass) return null;
  if (!raw.location) return null;

  return {
    actor_id: raw.actor_id,
    name: raw.name,
    class_path: raw.class_path,
    display_name:
      node.display_name ??
      String(raw.class_path ?? "")
        .split(".")
        .pop()
        .replace(/^Build_/, "")
        .replace(/_C$/, ""),
    recipe_class: recipeClass,
    location: raw.location,
    yaw: Number(raw.rotation?.yaw) || 0,
    // Half-extents, so a full width is twice this. Absent on some buildables,
    // which is reported rather than filled in.
    extent: raw.bounds?.extent ?? null,
    // A manufacturer's selected recipe, so a cloned Smelter still smelts the
    // same thing rather than arriving unset.
    production_recipe_class: String(raw.manufacturer?.recipe_class ?? "").trim() || null,
    production_recipe_name: raw.manufacturer?.recipe_name || null,
  };
}

/**
 * `count` more of the source building, in a row beside it.
 *
 * Copies go sideways relative to the source's own facing, which is the
 * direction a manifold grows: machines shoulder to shoulder, all fed from one
 * belt running along the row.
 */
export function planClone(graph, args = {}) {
  const {
    actor_id: actorId = null,
    count = null,
    gap_cm: gapCm = DEFAULT_GAP_CM,
    direction = "side",
    grid_cm: gridCm = 800,
  } = args;

  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 20) {
    return { solver: "clone", planned: false, reason: "say how many copies, from 1 to 20" };
  }

  const source = describeCloneSource(graph, actorId);
  if (!source) {
    return {
      solver: "clone",
      planned: false,
      reason: "that is not a captured building, or the snapshot does not say what recipe built it",
    };
  }
  // An extractor is bound to a resource node, so copies of one have nowhere to
  // stand. The game says FGCDNeedsResourceNode and refuses the whole plan;
  // saying it here costs nothing and points at what the player probably meant.
  if (/Miner|Extractor|WaterPump|OilPump|FrackingExtractor/i.test(source.recipe_class)) {
    return {
      solver: "clone",
      planned: false,
      reason:
        `a ${source.display_name} has to sit on a resource node, so copies of it ` +
        "have nowhere to go. Aim at a machine instead — a Smelter or Constructor " +
        "clones fine",
    };
  }
  if (!source.extent) {
    // Without a measured footprint the pitch would be a guess, and a guessed
    // pitch either overlaps the copies or scatters them.
    return {
      solver: "clone",
      planned: false,
      reason: `the snapshot has no measured bounds for ${source.display_name}, so the spacing between copies is unknown`,
    };
  }

  const axes = yawToUnitVectors(source.yaw);
  const along = direction === "forward" ? axes.forward : axes.lateral;
  // The footprint across the direction of travel, doubled because extent is a
  // half-size, plus the gap.
  const acrossExtent = direction === "forward"
    ? Math.abs(Number(source.extent.x))
    : Math.abs(Number(source.extent.y));

  // Snap the pitch to the building grid.
  //
  // Footprint plus a gap gave 11.04 m between Smelters, which fits but lands on
  // no particular line — the owner's word was "wonky", and it is, because
  // nothing in Satisfactory lines up with 11.04 m. Rounding up to the next half
  // foundation puts every copy on a grid line, so a row of machines reads as
  // deliberate and sits square on foundations laid later.
  //
  // Half a cell rather than a whole one: a full cell would round 11.04 m up to
  // 16 m and waste half a foundation between every pair.
  const step = Math.max(100, Math.round(Number(gridCm) / 2));
  const pitch = Math.ceil((acrossExtent * 2 + Number(gapCm)) / step) * step;

  const actions = [];
  for (let index = 1; index <= wanted; index += 1) {
    const offset = pitch * index;
    actions.push({
      action: "place_building",
      recipe_class: source.recipe_class,
      ...(source.production_recipe_class
        ? { production_recipe_class: source.production_recipe_class }
        : {}),
      location: {
        x: Math.round((source.location.x + along.x * offset) * 10) / 10,
        y: Math.round((source.location.y + along.y * offset) * 10) / 10,
        z: source.location.z,
      },
      // A copy stands at the height of the thing it copies. Without this the
      // mod traces down for a build surface and every copy settles onto its own
      // patch of ground, which turns a row of machines into a staircase.
      exact_z: true,
      yaw: source.yaw,
      commit: true,
    });
  }

  return {
    solver: "clone",
    planned: true,
    source: {
      name: source.display_name,
      actor_id: source.actor_id,
      recipe: source.production_recipe_name,
    },
    count: wanted,
    pitch_cm: pitch,
    grid_cm: gridCm,
    direction,
    measured_from_bounds: true,
    actions,
    unverified:
      "Spacing is the source building's own measured footprint plus a gap. The " +
      "game still decides whether each copy fits, and refuses the ones that do not.",
  };
}
