/**
 * Understanding what is already built, as surfaces rather than as boxes.
 *
 * The snapshot captures every lightweight instance with full 3D bounds, so a
 * planner can already see two thousand foundation pieces. What it cannot see
 * is a *deck*: "there is a 40 x 60 m surface at Z 8100 with room on it". A list
 * of boxes is not somewhere to build, and choosing where a hub goes needs the
 * surface, its height, and what already stands on it.
 *
 * This clusters deck-like pieces into contiguous surfaces and reports each one
 * with what occupies it.
 *
 * Two independent rules decide what counts as a deck, and the result says which
 * one matched so the classification stays auditable:
 *
 *   - **By name**, for the obvious cases: foundation, platform, floor.
 *   - **By geometry**, for everything else: thin in Z relative to its footprint
 *     and roughly level. This is what makes modded pieces work - the owner's
 *     save is built from `DodNFPiece4m` and ConcreteConstruction parts that no
 *     vanilla name test would catch, and a survey that missed them would report
 *     an empty site on top of their base.
 *
 * A wall fails both rules: it is tall relative to its footprint, so it stays an
 * obstruction, which is what the collision test wants it to be.
 */

/** One 8 m build grid cell, in centimetres. */
const GRID_CELL_CM = 800;

/** A deck piece is at most this tall. Taller is a wall, a pillar or a machine. */
const MAX_DECK_THICKNESS_CM = 260;

/** Two pieces join into one deck when their tops are within this of each other. */
const SAME_LEVEL_TOLERANCE_CM = 30;

/** Footprints touching within this distance are treated as adjacent. */
const ADJACENCY_TOLERANCE_CM = 60;

const DECK_NAME = /foundation|platform|floor|deck|walkway|catwalk/i;

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function boxOf(node) {
  const origin = node?.raw?.bounds?.origin;
  const extent = node?.raw?.bounds?.extent;
  const ox = finite(origin?.x);
  const oy = finite(origin?.y);
  const oz = finite(origin?.z);
  const ex = finite(extent?.x);
  const ey = finite(extent?.y);
  const ez = finite(extent?.z);
  if ([ox, oy, oz, ex, ey, ez].some((value) => value === null)) return null;
  if (ex <= 0 || ey <= 0) return null;
  return {
    minX: ox - ex, maxX: ox + ex,
    minY: oy - ey, maxY: oy + ey,
    minZ: oz - ez, maxZ: oz + ez,
    width: ex * 2, depth: ey * 2, thickness: ez * 2,
  };
}

/**
 * Is this piece a surface someone could build on?
 *
 * Returns the rule that matched, or null. Reporting the rule matters: a
 * geometry match on something unexpected is a thing a person should be able to
 * see and argue with, rather than a silent classification.
 */
export function deckRule(node, box) {
  if (!box) return null;
  const name = String(node?.class_path ?? node?.name ?? "");
  if (box.thickness > MAX_DECK_THICKNESS_CM) return null;
  if (DECK_NAME.test(name)) return "class_name";
  // Thin and broad: at least one grid cell across, and far wider than it is
  // tall. A wall is the opposite of this and stays an obstruction.
  const broadest = Math.max(box.width, box.depth);
  if (broadest >= GRID_CELL_CM * 0.9 && box.thickness > 0 && broadest / box.thickness >= 3) {
    return "thin_and_broad_geometry";
  }
  return null;
}

/**
 * What stands on a deck, counted by class rather than listed one by one.
 *
 * A real base puts hundreds of buildings on one deck, and enumerating every
 * actor_id made a single survey large enough to crowd out the rest of a
 * conversation - one request spent 568k input tokens across tool rounds and ran
 * out of rounds before it could answer. A count per class says the same thing
 * about whether there is room, at a fraction of the size. A handful of ids are
 * kept so a specific occupant can still be looked up with `locate`.
 */
function summariseOccupants(entries) {
  const byClass = new Map();
  for (const entry of entries) {
    const classPath = entry.node.class_path ?? "unknown";
    if (!byClass.has(classPath)) byClass.set(classPath, { class_path: classPath, count: 0, example_actor_ids: [] });
    const row = byClass.get(classPath);
    row.count += 1;
    if (row.example_actor_ids.length < 3) row.example_actor_ids.push(entry.node.actor_id);
  }
  const rows = [...byClass.values()].sort((a, b) => b.count - a.count);
  return {
    total: entries.length,
    distinct_classes: rows.length,
    by_class: rows.slice(0, 12),
    ...(rows.length > 12 ? { classes_not_listed: rows.length - 12 } : {}),
  };
}

const overlapsXY = (a, b, pad = ADJACENCY_TOLERANCE_CM) =>
  a.minX - pad <= b.maxX && a.maxX + pad >= b.minX &&
  a.minY - pad <= b.maxY && a.maxY + pad >= b.minY;

/**
 * What is under a deck, and how much of it is open.
 *
 * The owner builds belts in a service layer beneath the foundation so the
 * walking surface stays clean. Nothing downstream could plan that, because the
 * survey reported only a deck's top and discarded its underside entirely.
 *
 * Two different facts, kept apart on purpose:
 *
 *   - **Structural clearance is measured.** The highest built thing under the
 *     footprint is in the snapshot, so "nothing built below for N metres" is
 *     something this can assert.
 *   - **Ground height is not known.** Terrain is probed only for site
 *     candidates and that probing is bounded per capture, so a deck floating
 *     over open desert and one sitting flat on rock look identical here.
 *
 * Conflating them would let a service level be planned into solid rock because
 * "nothing was below", which is exactly the confident wrong answer this project
 * refuses everywhere else. So the open space is reported as open *of
 * structures*, and the ground is reported as unknown.
 */
function describeUnderside(bottomZ, bounds, occupants, decks) {
  let highestBelow = null;
  let blockedBy = null;
  const under = [
    ...occupants.map((entry) => ({ box: entry.box, node: entry.node })),
    ...decks.map((entry) => ({ box: entry.box, node: entry.node })),
  ];
  for (const entry of under) {
    if (!overlapsXY(entry.box, bounds, 0)) continue;
    if (entry.box.maxZ >= bottomZ - 1) continue;
    if (highestBelow === null || entry.box.maxZ > highestBelow) {
      highestBelow = entry.box.maxZ;
      blockedBy = entry.node;
    }
  }

  return {
    bottom_z_cm: Math.round(bottomZ),
    structural_clearance_cm: highestBelow === null ? null : Math.round(bottomZ - highestBelow),
    structural_clearance_m:
      highestBelow === null ? null : Math.round((bottomZ - highestBelow) / 100),
    nearest_structure_below: blockedBy
      ? { actor_id: blockedBy.actor_id, class_path: blockedBy.class_path ?? null }
      : null,
    clear_of_structures_below: highestBelow === null,
    ground_below:
      "unknown: terrain is probed only for site candidates, so this cannot tell open air from rock",
    usable_for_a_service_level:
      highestBelow === null
        ? "no structure is below; whether there is open air or ground here is unknown"
        : `${Math.round((bottomZ - highestBelow) / 100)} m of space before the next structure below`,
  };
}

/**
 * Contiguous build surfaces in the world, largest first.
 *
 * Clustering is by top height first, then XY adjacency, so a deck and the
 * balcony above it are two surfaces rather than one merged blob.
 */
export function surveyDecks(graph, args = {}) {
  const {
    center_cm: center = null,
    radius_m: radiusMeters = null,
    min_cells: minCells = 4,
  } = args;

  const radiusCm = finite(radiusMeters) === null ? null : finite(radiusMeters) * 100;
  const cx = finite(center?.x);
  const cy = finite(center?.y);
  const hasCentre = cx !== null && cy !== null;

  const pieces = [];
  const occupants = [];
  let skippedNoBounds = 0;

  for (const node of graph?.nodes?.values?.() ?? []) {
    const box = boxOf(node);
    if (!box) {
      if (node?.kind === "lightweight_buildable") skippedNoBounds += 1;
      continue;
    }
    if (hasCentre && radiusCm !== null) {
      const nearestX = Math.max(box.minX, Math.min(cx, box.maxX));
      const nearestY = Math.max(box.minY, Math.min(cy, box.maxY));
      if (Math.hypot(nearestX - cx, nearestY - cy) > radiusCm) continue;
    }
    const rule = deckRule(node, box);
    if (rule) pieces.push({ node, box, rule });
    else occupants.push({ node, box });
  }

  // Bucket by top height, then union adjacent footprints inside each bucket.
  const byLevel = new Map();
  for (const piece of pieces) {
    const key = Math.round(piece.box.maxZ / SAME_LEVEL_TOLERANCE_CM);
    if (!byLevel.has(key)) byLevel.set(key, []);
    byLevel.get(key).push(piece);
  }

  const decks = [];
  for (const group of byLevel.values()) {
    const unassigned = [...group];
    while (unassigned.length > 0) {
      const cluster = [unassigned.pop()];
      let grew = true;
      while (grew) {
        grew = false;
        for (let index = unassigned.length - 1; index >= 0; index -= 1) {
          if (cluster.some((member) => overlapsXY(member.box, unassigned[index].box))) {
            cluster.push(unassigned.splice(index, 1)[0]);
            grew = true;
          }
        }
      }

      const bounds = cluster.reduce(
        (acc, member) => ({
          minX: Math.min(acc.minX, member.box.minX),
          maxX: Math.max(acc.maxX, member.box.maxX),
          minY: Math.min(acc.minY, member.box.minY),
          maxY: Math.max(acc.maxY, member.box.maxY),
          topZ: Math.max(acc.topZ, member.box.maxZ),
          bottomZ: Math.min(acc.bottomZ, member.box.minZ),
        }),
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, topZ: -Infinity, bottomZ: Infinity },
      );
      const widthCells = Math.round(((bounds.maxX - bounds.minX) / GRID_CELL_CM) * 10) / 10;
      const depthCells = Math.round(((bounds.maxY - bounds.minY) / GRID_CELL_CM) * 10) / 10;
      if (widthCells * depthCells < minCells) continue;

      const rules = {};
      for (const member of cluster) rules[member.rule] = (rules[member.rule] ?? 0) + 1;

      decks.push({
        deck_id: `deck_${decks.length + 1}`,
        pieces: cluster.length,
        classified_by: rules,
        top_z_cm: Math.round(bounds.topZ),
        underside: describeUnderside(bounds.bottomZ, bounds, occupants, pieces),
        bounds_cm: {
          min_x: Math.round(bounds.minX), max_x: Math.round(bounds.maxX),
          min_y: Math.round(bounds.minY), max_y: Math.round(bounds.maxY),
        },
        size_m: {
          x: Math.round((bounds.maxX - bounds.minX) / 100),
          y: Math.round((bounds.maxY - bounds.minY) / 100),
        },
        size_cells: { x: widthCells, y: depthCells },
        centre_cm: {
          x: Math.round((bounds.minX + bounds.maxX) / 2),
          y: Math.round((bounds.minY + bounds.maxY) / 2),
          z: Math.round(bounds.topZ),
        },
        // What stands on this deck, so "is there room" is answerable. An
        // occupant counts when it sits at or above the surface, not merely
        // within the footprint - the deck below a deck is not an occupant.
        standing_on_it: summariseOccupants(
          occupants.filter(
            (entry) =>
              overlapsXY(entry.box, bounds, 0) &&
              entry.box.maxZ > bounds.topZ + SAME_LEVEL_TOLERANCE_CM,
          ),
        ),
      });
    }
  }

  decks.sort((a, b) => b.size_cells.x * b.size_cells.y - a.size_cells.x * a.size_cells.y);
  for (const [index, deck] of decks.entries()) deck.deck_id = `deck_${index + 1}`;

  return {
    solver: "site_survey",
    decks,
    deck_count: decks.length,
    deck_pieces_considered: pieces.length,
    other_buildings_considered: occupants.length,
    lightweight_without_bounds: skippedNoBounds,
    scope: hasCentre && radiusCm !== null
      ? { center_cm: { x: cx, y: cy }, radius_m: finite(radiusMeters) }
      : "whole_world",
    how_decks_were_identified: {
      class_name: `class path or name matching ${DECK_NAME}`,
      thin_and_broad_geometry:
        `at most ${MAX_DECK_THICKNESS_CM} cm thick, at least ${GRID_CELL_CM * 0.9} cm across, ` +
        "and at least three times wider than it is thick",
      why_two_rules:
        "a name test alone misses modded foundations; this world is built from pieces no vanilla " +
        "name would match, and a survey that missed them would report empty ground on top of a base",
    },
    caveats: [
      "a deck is a surface, not a claim that the game will accept a build there - clearance is the hologram's decision",
      "clusters are grouped by top height, so a balcony above a deck is reported separately",
      "anything thicker than a foundation is treated as an obstruction, including machines already placed",
    ],
  };
}
