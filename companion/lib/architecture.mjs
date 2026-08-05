/**
 * Building a structure, not just placing machines.
 *
 * `base-build.mjs` works out which machines a factory needs and puts them in
 * rows on open ground. That is a working factory and it looks like scattered
 * machinery. What the owner actually wants is the thing in the reference art:
 * platforms on pillars, stacked floors, walls and glass roofs, with the
 * production tucked inside — the same request as the original "I want to place
 * buildings over them to hide it, I don't like the exposed machines".
 *
 * This module is the shell. It composes the game's own architectural pieces on
 * the game's own grid.
 *
 * **The grid is read, not assumed.** Satisfactory's foundation descriptors are
 * named for their dimensions — `Desc_Foundation_8x1_01_C` is 8 m square and 1 m
 * tall, `Desc_Wall_8x4_01_C` is 8 m wide and 4 m tall — so the cell size and
 * every piece height are parsed out of the catalog rather than hardcoded from
 * memory. A modded piece with different dimensions is therefore handled for
 * free, and a piece whose name does not carry dimensions is skipped rather than
 * guessed at.
 *
 * What stays the game's decision, as everywhere else: whether each piece can
 * actually be placed. Ground, clearance, overlap and cost are answered by the
 * hologram per piece and reported back. A plan from here is a proposal.
 */

/** `..._8x4_...` -> { cells: 1, heightCm: 400 }. Null when unparseable. */
export function parsePieceDimensions(descriptorOrName) {
  const match = String(descriptorOrName ?? "").match(/_(\d+)x(\d+)(?:_|$)/);
  if (!match) return null;
  const widthMetres = Number(match[1]);
  const heightMetres = Number(match[2]);
  if (!Number.isFinite(widthMetres) || !Number.isFinite(heightMetres)) return null;
  return {
    width_cm: widthMetres * 100,
    height_cm: heightMetres * 100,
    width_metres: widthMetres,
    height_metres: heightMetres,
  };
}

function buildGunRecipes(graph) {
  return (graph?.snapshot?.content?.recipes ?? []).filter(
    (recipe) =>
      recipe.available === true &&
      (recipe.produced_in ?? []).some((producer) => String(producer).includes("BP_BuildGun")),
  );
}

function descriptorOf(recipe) {
  return String((recipe.products ?? [])[0]?.item_class ?? "").split(".").pop()?.replace(/_C$/, "") ?? "";
}

/**
 * The structural pieces this save can actually build, with real dimensions.
 *
 * Every piece is chosen from the catalog and measured from its own descriptor.
 * A category with nothing unlocked comes back null, and the plan then omits
 * that part of the structure and says so — a wall-less platform is a fine
 * outcome, a plan full of pieces the player cannot build is not.
 */
export function surveyStructuralPieces(graph) {
  const recipes = buildGunRecipes(graph);

  const pick = (test) => {
    const candidates = [];
    for (const recipe of recipes) {
      const descriptor = descriptorOf(recipe);
      const dimensions = parsePieceDimensions(descriptor);
      if (!test(descriptor, recipe, dimensions)) continue;
      candidates.push({
        recipe_class: recipe.class_path,
        name: recipe.name,
        descriptor,
        ...(dimensions ?? {}),
      });
    }
    return candidates;
  };

  const foundations = pick((descriptor, _recipe, dimensions) =>
    /^Desc_Foundation_/.test(descriptor) && dimensions !== null,
  );
  const walls = pick((descriptor, _recipe, dimensions) =>
    /^Desc_(?:Steel)?Wall_/.test(descriptor) && dimensions !== null,
  );
  const ramps = pick((descriptor, _recipe, dimensions) =>
    /^Desc_Ramp_/.test(descriptor) && dimensions !== null,
  );
  // Roofs and pillars carry no dimensions in their names, so they are matched
  // by descriptor and their footprint is taken from the foundation grid.
  const roofs = pick((descriptor) => /^Desc_Roof_/.test(descriptor));
  const pillars = pick((descriptor) => /^Desc_Pillar/.test(descriptor));
  const glass = pick((descriptor) => /^Desc_FoundationGlass|Glass/.test(descriptor));

  // The cell size is whatever the foundations agree on; if they disagree, the
  // most common one wins and the disagreement is reported.
  const widths = foundations.map((piece) => piece.width_cm).filter(Boolean);
  const tally = new Map();
  for (const width of widths) tally.set(width, (tally.get(width) ?? 0) + 1);
  const cellSize = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    cell_size_cm: cellSize,
    cell_size_source: cellSize
      ? "parsed from the foundation descriptors in this save"
      : "no foundation is unlocked, so no grid could be derived",
    grid_disagreement: tally.size > 1 ? [...tally.keys()] : undefined,
    foundations,
    walls,
    roofs,
    pillars,
    ramps,
    glass,
  };
}

/** Smallest piece at or above a wanted height, else the tallest available. */
function pieceForHeight(pieces, wantedCm) {
  const sized = pieces.filter((piece) => Number.isFinite(piece.height_cm));
  if (sized.length === 0) return pieces[0] ?? null;
  const atLeast = sized.filter((piece) => piece.height_cm >= wantedCm);
  if (atLeast.length > 0) {
    return atLeast.reduce((best, piece) => (piece.height_cm < best.height_cm ? piece : best));
  }
  return sized.reduce((best, piece) => (piece.height_cm > best.height_cm ? piece : best));
}

/** Snaps a world coordinate onto the foundation grid. */
export function snapToGrid(value, cellSizeCm, originCm = 0) {
  if (!Number.isFinite(cellSizeCm) || cellSizeCm <= 0) return value;
  return originCm + Math.round((value - originCm) / cellSizeCm) * cellSizeCm;
}

/**
 * Plans one structure: a platform, optionally raised on pillars, walled and
 * roofed, with a clear interior for machines.
 *
 * Sizes are given in *cells*, not centimetres, because that is how the game
 * thinks and how a player describes a build ("six by four"). The interior is
 * reported so the machine planner can lay its rows inside the shell rather than
 * over open ground.
 */
export function planStructure(graph, args = {}) {
  const {
    origin_cm: originArg = null,
    width_cells: widthCells = 6,
    depth_cells: depthCells = 4,
    height_cm: heightCm = 0,
    walls: wantWalls = true,
    roof: wantRoof = true,
    glass_roof: wantGlassRoof = false,
  } = args;

  const pieces = surveyStructuralPieces(graph);
  if (!pieces.cell_size_cm || pieces.foundations.length === 0) {
    return {
      solver: "structure",
      planned: false,
      reason: "no foundation is unlocked in this save, so nothing can be built on a grid",
    };
  }

  const origin =
    originArg ?? graph?.snapshot?.interaction_context?.player?.pawn_location ?? null;
  if (
    !origin ||
    ![origin.x, origin.y, origin.z].every((value) => Number.isFinite(Number(value)))
  ) {
    return { solver: "structure", planned: false, reason: "no origin given and no captured player position" };
  }

  const widthNumber = Number(widthCells);
  const depthNumber = Number(depthCells);
  const heightNumber = Number(heightCm);
  if (
    !Number.isInteger(widthNumber) ||
    !Number.isInteger(depthNumber) ||
    widthNumber < 1 ||
    depthNumber < 1 ||
    widthNumber > 32 ||
    depthNumber > 32
  ) {
    return {
      solver: "structure",
      planned: false,
      reason: "width_cells and depth_cells must be whole numbers from 1 through 32",
    };
  }
  if (!Number.isFinite(heightNumber) || heightNumber < 0 || heightNumber > 100_000) {
    return {
      solver: "structure",
      planned: false,
      reason: "height_cm must be a finite non-negative value no greater than 100000",
    };
  }

  const cell = pieces.cell_size_cm;
  const width = widthNumber;
  const depth = depthNumber;

  // The floor slab: thin when on the ground, thicker when raised, because a
  // raised platform reads as a deck rather than a sheet.
  const floorPiece = pieceForHeight(pieces.foundations, heightNumber > 0 ? 200 : 100);
  const baseX = snapToGrid(Number(origin.x), cell);
  const baseY = snapToGrid(Number(origin.y), cell);
  const baseZ = Number(origin.z) + heightNumber;

  const parts = [];
  const add = (kind, piece, x, y, z, yaw = 0) => {
    if (!piece) return;
    parts.push({
      kind,
      recipe_class: piece.recipe_class,
      name: piece.name,
      location_cm: { x, y, z },
      yaw,
    });
  };

  // Floor.
  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < depth; row += 1) {
      add("floor", floorPiece, baseX + column * cell, baseY + row * cell, baseZ);
    }
  }

  // Pillars, only where the platform is actually raised. One per corner and
  // then every other cell along each edge — enough to read as supported without
  // filling the underside with a forest.
  const pillarPiece = pieces.pillars[0] ?? null;
  const pillars = [];
  if (heightNumber > 0 && pillarPiece) {
    const edgeCells = [];
    for (let column = 0; column < width; column += 2) {
      edgeCells.push([column, 0], [column, depth - 1]);
    }
    for (let row = 2; row < depth - 1; row += 2) {
      edgeCells.push([0, row], [width - 1, row]);
    }
    const seen = new Set();
    for (const [column, row] of edgeCells) {
      const key = `${column},${row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pillars.push([column, row]);
      add("pillar", pillarPiece, baseX + column * cell, baseY + row * cell, Number(origin.z));
    }
  }

  // Perimeter walls, leaving the first cell of the front edge open as a way in.
  const wallPiece = wantWalls ? pieceForHeight(pieces.walls, 400) : null;
  if (wallPiece) {
    const wallZ = baseZ + (floorPiece?.height_cm ?? 0);
    for (let column = 0; column < width; column += 1) {
      if (column !== 0) add("wall", wallPiece, baseX + column * cell, baseY - cell / 2, wallZ, 0);
      add("wall", wallPiece, baseX + column * cell, baseY + (depth - 0.5) * cell, wallZ, 180);
    }
    for (let row = 0; row < depth; row += 1) {
      add("wall", wallPiece, baseX - cell / 2, baseY + row * cell, wallZ, 90);
      add("wall", wallPiece, baseX + (width - 0.5) * cell, baseY + row * cell, wallZ, 270);
    }
  }

  // Roof, at wall height. Glass when asked for and unlocked — that is what
  // gives the reference builds their lit interiors.
  const roofPiece = wantRoof
    ? (wantGlassRoof ? pieces.glass[0] : null) ?? pieces.roofs[0] ?? null
    : null;
  if (roofPiece) {
    const roofZ = baseZ + (floorPiece?.height_cm ?? 0) + (wallPiece?.height_cm ?? 400);
    for (let column = 0; column < width; column += 1) {
      for (let row = 0; row < depth; row += 1) {
        add("roof", roofPiece, baseX + column * cell, baseY + row * cell, roofZ);
      }
    }
  }

  const notes = [];
  if (wantWalls && !wallPiece) notes.push("No wall is unlocked, so the platform is left open.");
  if (wantRoof && !roofPiece) notes.push("No roof is unlocked, so the platform is left uncovered.");
  if (wantGlassRoof && !pieces.glass.length) {
    notes.push("No glass piece is unlocked; a solid roof was used instead.");
  }
  if (heightNumber > 0 && !pillarPiece) {
    notes.push("No pillar is unlocked, so the raised platform has no visible supports.");
  }

  return {
    solver: "structure",
    planned: true,
    grid: {
      cell_size_cm: cell,
      source: pieces.cell_size_source,
      disagreement: pieces.grid_disagreement,
    },
    footprint: {
      width_cells: width,
      depth_cells: depth,
      width_cm: width * cell,
      depth_cm: depth * cell,
      origin_cm: { x: baseX, y: baseY, z: baseZ },
    },
    // Where machines can go: the deck surface, inset by half a cell so nothing
    // overhangs into the walls.
    interior: {
      floor_z_cm: baseZ + (floorPiece?.height_cm ?? 0),
      min_x_cm: baseX,
      max_x_cm: baseX + (width - 1) * cell,
      min_y_cm: baseY,
      max_y_cm: baseY + (depth - 1) * cell,
      usable_cells: width * depth,
    },
    raised_cm: heightNumber,
    pillars: pillars.length,
    parts,
    piece_counts: parts.reduce((counts, part) => {
      counts[part.kind] = (counts[part.kind] ?? 0) + 1;
      return counts;
    }, {}),
    notes,
    unverified:
      "Every piece is a proposal on the game's grid. Ground, clearance, overlap " +
      "and cost are decided by the hologram as each one is placed, and each " +
      "outcome is reported back.",
  };
}

/** The structure as ordered actions: floor, then supports, then shell. */
export function structureActions(plan, { commit = false } = {}) {
  if (!plan?.planned) return [];
  // Ordered so a partial build still stands up: deck first, then what holds it,
  // then what encloses it.
  const order = { floor: 0, pillar: 1, wall: 2, roof: 3 };
  return [...plan.parts]
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
    .map((part) => ({
      action: "place_building",
      recipe_class: part.recipe_class,
      location: part.location_cm,
      yaw: part.yaw ?? 0,
      commit,
    }));
}
