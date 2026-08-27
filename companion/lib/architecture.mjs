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
    // Upper storeys of a tower sit on the floor below, so they must be able
    // to opt out of supports that would otherwise hang in mid-air.
    pillars: wantPillars = true,
    // Raise the deck clear of the measured ground before placing anything.
    // Off by default so callers that already know their height are not
    // second-guessed; the factory planner turns it on.
    clear_terrain: wantTerrainClearance = false,
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

  // Ground first, so the deck height accounts for what is under it.
  let heightAfterTerrain = heightNumber;
  let terrain = null;
  if (wantTerrainClearance) {
    terrain = groundUnderFootprint(graph, { centre_cm: origin });
    const adjusted = clearanceAdjustedHeight(terrain, {
      anchor_z_cm: Number(origin.z),
      requested_height_cm: heightNumber,
    });
    heightAfterTerrain = adjusted.height_cm;
    terrain = { ...terrain, clearance: adjusted };
  }

  const cell = pieces.cell_size_cm;
  const width = widthNumber;
  const depth = depthNumber;

  // The floor slab: thin when on the ground, thicker when raised, because a
  // raised platform reads as a deck rather than a sheet.
  const floorPiece = pieceForHeight(pieces.foundations, heightAfterTerrain > 0 ? 200 : 100);
  const baseX = snapToGrid(Number(origin.x), cell);
  const baseY = snapToGrid(Number(origin.y), cell);
  const baseZ = Number(origin.z) + heightAfterTerrain;

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
  if (heightAfterTerrain > 0 && pillarPiece && wantPillars) {
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
  if (heightNumber > 0 && !pillarPiece && wantPillars) {
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
    raised_cm: heightAfterTerrain,
    pillars: pillars.length,
    terrain,
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
      // Storey heights are computed as origin.z + level * storeyCm. A piece
      // that traces down for its own build surface is not on that storey.
      exact_z: true,
      yaw: part.yaw ?? 0,
      // Used only when the same deterministic plan is compiled into a native
      // Blueprint. Direct world placement ignores this metadata.
      generated_role: part.kind,
      commit,
    }));
}

/**
 * A multi-storey structure: stacked decks joined by ramps.
 *
 * `planStructure` builds one deck. The reference art the owner sent is all
 * stacked floors — two or three production levels under one roof, with ramps
 * between them — and that is also the efficient shape: it triples the machines
 * a footprint holds instead of sprawling sideways.
 *
 * Storey height is the floor slab plus the wall, both read from the pieces
 * actually being used rather than assumed, so a save whose only wall is 1 m
 * gets 1 m storeys and the ramps still land on the decks.
 *
 * Ramps are placed along one edge and are the reason this is not just
 * `planStructure` called N times: a stack of decks with no way between them is
 * a set of shelves, not a building.
 */
export function planTower(graph, args = {}) {
  const {
    levels: levelsArg = 2,
    height_cm: baseHeightCm = 0,
    ramps: wantRamps = true,
    // Cells taken off each side per tier. 0 stacks identical boxes; 1 gives
    // the stepped silhouette of the reference builds.
    inset_cells: insetArg = 1,
    ...structureArgs
  } = args;

  const levels = Number(levelsArg);
  const insetCells = Number.isInteger(Number(insetArg)) && Number(insetArg) >= 0
    ? Number(insetArg)
    : 1;
  let truncatedAt = null;
  if (!Number.isInteger(levels) || levels < 1 || levels > 12) {
    return {
      solver: "tower",
      planned: false,
      reason: "levels must be a whole number from 1 through 12",
    };
  }

  const baseWidthCells = Number(structureArgs.width_cells ?? 6);
  const baseDepthCells = Number(structureArgs.depth_cells ?? 4);

  // The ground floor decides the grid, the piece choices and the footprint;
  // every storey above reuses them so the stack lines up exactly.
  const ground = planStructure(graph, {
    ...structureArgs,
    height_cm: baseHeightCm,
    // The roof belongs on the top storey, not on every floor.
    roof: levels === 1 ? structureArgs.roof !== false : false,
  });
  if (!ground.planned) return { ...ground, solver: "tower" };

  const pieces = surveyStructuralPieces(graph);
  const floorHeight = ground.parts.find((part) => part.kind === "floor")
    ? pieceForHeight(pieces.foundations, baseHeightCm > 0 ? 200 : 100)?.height_cm ?? 100
    : 100;
  const wallHeight = pieceForHeight(pieces.walls, 400)?.height_cm ?? 400;
  const storeyCm = floorHeight + wallHeight;

  const storeys = [ground];
  for (let level = 1; level < levels; level += 1) {
    // Stepped massing: each tier is inset from the one below, so the building
    // reads as a silhouette rather than a stack of identical boxes. Every
    // reference image the owner sent is shaped this way, and the exposed ledge
    // it leaves is what the terraces and walkways sit on.
    //
    // The inset stops once a tier would be too small to be a floor — a
    // three-cell building cannot step in twice — and the tier count is capped
    // rather than the plan failing, because a shorter tower is a better answer
    // than no tower.
    const inset = insetCells * level;
    const tierWidth = baseWidthCells - inset * 2;
    const tierDepth = baseDepthCells - inset * 2;
    if (tierWidth < 1 || tierDepth < 1) {
      truncatedAt = level;
      break;
    }

    const storey = planStructure(graph, {
      ...structureArgs,
      width_cells: tierWidth,
      depth_cells: tierDepth,
      origin_cm: {
        // Keep each tier centred on the one below as it shrinks.
        x: ground.footprint.origin_cm.x + inset * ground.grid.cell_size_cm,
        y: ground.footprint.origin_cm.y + inset * ground.grid.cell_size_cm,
        // The actual raise, not the requested one: the ground floor may have
        // been lifted to clear terrain, and subtracting the request would leave
        // every storey above it offset by the difference.
        z: ground.footprint.origin_cm.z - ground.raised_cm,
      },
      height_cm: ground.raised_cm + level * storeyCm,
      // Only the top storey is roofed; the others are floors for the one above.
      roof: level === levels - 1 ? structureArgs.roof !== false : false,
      // Pillars belong under the building, not between its floors: a support
      // starting at storey three would hang in mid-air under the deck above.
      pillars: false,
      // The ground was measured once for the whole building. Re-probing per
      // storey would let floors drift apart on a slope.
      clear_terrain: false,
    });
    if (!storey.planned) return { ...storey, solver: "tower" };
    storeys.push(storey);
  }

  // A stepped tower may run out of footprint before the requested top level.
  // The prior loop only roofed the requested last level, so the shortened
  // building was left open. Roof the actual top storey exactly once.
  const topStorey = storeys.at(-1);
  if (structureArgs.roof !== false && topStorey && !topStorey.parts.some((part) => part.kind === "roof")) {
    const roofPiece = (structureArgs.glass_roof ? pieces.glass[0] : null) ?? pieces.roofs[0] ?? null;
    if (roofPiece) {
      const floorPart = topStorey.parts.find((part) => part.kind === "floor");
      const topFloorHeight = pieces.foundations.find(
        (piece) => piece.recipe_class === floorPart?.recipe_class,
      )?.height_cm ?? 0;
      const wallPart = topStorey.parts.find((part) => part.kind === "wall");
      const topWallHeight = pieces.walls.find(
        (piece) => piece.recipe_class === wallPart?.recipe_class,
      )?.height_cm ?? 400;
      const roofZ = topStorey.footprint.origin_cm.z + topFloorHeight + topWallHeight;
      for (let column = 0; column < topStorey.footprint.width_cells; column += 1) {
        for (let row = 0; row < topStorey.footprint.depth_cells; row += 1) {
          topStorey.parts.push({
            kind: "roof",
            recipe_class: roofPiece.recipe_class,
            name: roofPiece.name,
            location_cm: {
              x: topStorey.footprint.origin_cm.x + column * topStorey.grid.cell_size_cm,
              y: topStorey.footprint.origin_cm.y + row * topStorey.grid.cell_size_cm,
              z: roofZ,
            },
            yaw: 0,
          });
        }
      }
    } else {
      topStorey.notes.push("No roof is unlocked, so the platform is left uncovered.");
    }
  }

  // Ramps up the near edge, one run per storey boundary.
  const rampPiece = wantRamps
    ? pieceForHeight(pieces.ramps, storeyCm) ?? pieces.ramps[0] ?? null
    : null;
  const ramps = [];
  if (rampPiece && storeys.length > 1) {
    const cell = ground.grid.cell_size_cm;
    for (let level = 0; level < storeys.length - 1; level += 1) {
      ramps.push({
        kind: "ramp",
        recipe_class: rampPiece.recipe_class,
        name: rampPiece.name,
        location_cm: {
          // Just outside the near edge, so the run does not eat interior floor.
          x: ground.interior.min_x_cm,
          y: ground.interior.min_y_cm - cell,
          z: ground.footprint.origin_cm.z + level * storeyCm,
        },
        yaw: 0,
        connects_levels: [level + 1, level + 2],
      });
    }
  }

  const parts = [...storeys.flatMap((storey) => storey.parts), ...ramps];
  const notes = [...ground.notes];
  if (truncatedAt !== null) {
    notes.push(
      `Stepped in by ${insetCells} cell(s) a tier, the building runs out of ` +
        `floor after ${truncatedAt} storey(s) rather than the ${levels} asked ` +
        "for. Widen the base or set inset_cells to 0 for straight sides.",
    );
  }
  if (wantRamps && !rampPiece && levels > 1) {
    notes.push(
      "No ramp is unlocked, so the storeys have no way between them. They are " +
        "reachable by hypertube, lift or jetpack, but nothing walks up.",
    );
  }
  if (rampPiece && rampPiece.height_cm && rampPiece.height_cm !== storeyCm) {
    notes.push(
      `The tallest unlocked ramp rises ${rampPiece.height_cm / 100} m and a storey ` +
        `is ${storeyCm / 100} m, so the runs will not meet each deck exactly. ` +
        "The game will refuse any that do not fit, and the rest still stand.",
    );
  }

  return {
    solver: "tower",
    planned: true,
    grid: ground.grid,
    footprint: ground.footprint,
    levels: storeys.length,
    levels_requested: levels,
    inset_cells_per_tier: insetCells,
    storey_height_cm: storeyCm,
    storey_height_source: "floor slab plus wall, both measured from the pieces used",
    total_height_cm: ground.raised_cm + storeys.length * storeyCm,
    // The ground floor may have been raised to clear the terrain, so the
    // requested height is not necessarily what got built.
    raised_cm: ground.raised_cm,
    raised_requested_cm: baseHeightCm,
    terrain: ground.terrain ?? null,
    pillars: ground.pillars,
    // Every deck's interior, so machines can be spread across floors.
    interiors: storeys.map((storey, index) => ({ level: index + 1, ...storey.interior })),
    ramps: ramps.length,
    parts,
    piece_counts: parts.reduce((counts, part) => {
      counts[part.kind] = (counts[part.kind] ?? 0) + 1;
      return counts;
    }, {}),
    notes,
    unverified: ground.unverified,
  };
}

/**
 * Ground under a proposed footprint, from what the scanner actually measured.
 *
 * Asked for directly: "check terrain for collision and adjust xyz accordingly".
 * Without it a platform is placed at whatever Z the player happens to stand at,
 * which on a slope means half the foundations are buried and the other half
 * float.
 *
 * Every number here is a real line trace the mod took, never an estimate. Where
 * nothing was probed the answer is "unmeasured", because a base sunk into a
 * hill is a worse outcome than being told the ground is unknown.
 */
export function groundUnderFootprint(graph, { centre_cm: centre, radius_cm: radius = 4_000 } = {}) {
  const samples = [];

  // The scan-centre probe: a real grid of traces around the player.
  const atCentre = graph?.snapshot?.terrain?.at_scan_center;
  const scanCentre = graph?.snapshot?.world?.scan_center;
  const probeHalfCm = Number(graph?.snapshot?.terrain?.probe_footprint_meters) * 50;
  const centreUsesScanProbe = centre && scanCentre && Number.isFinite(probeHalfCm) && probeHalfCm > 0 &&
    Math.abs(Number(centre.x) - Number(scanCentre.x)) <= probeHalfCm &&
    Math.abs(Number(centre.y) - Number(scanCentre.y)) <= probeHalfCm;
  if (atCentre?.sampled && centreUsesScanProbe) {
    samples.push({
      source: "scan_centre_probe",
      min_z: atCentre.min_ground_z,
      max_z: atCentre.max_ground_z,
      mean_slope_degrees: atCentre.mean_slope_degrees,
      verdict: atCentre.verdict,
      blocked_samples: atCentre.blocked_samples ?? 0,
      water_samples: atCentre.water_samples ?? 0,
    });
  }

  // Any actor carrying its own measured terrain inside the footprint.
  for (const node of graph?.nodes?.values?.() ?? []) {
    const terrain = node.raw?.terrain;
    const location = node.raw?.location;
    if (!terrain?.sampled || !location || !centre) continue;
    const dx = Number(location.x) - Number(centre.x);
    const dy = Number(location.y) - Number(centre.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (Math.hypot(dx, dy) > radius) continue;

    samples.push({
      source: node.raw?.name ?? node.actor_id,
      min_z: terrain.min_ground_z,
      max_z: terrain.max_ground_z,
      mean_slope_degrees: terrain.mean_slope_degrees,
      verdict: terrain.verdict,
      blocked_samples: terrain.blocked_samples ?? 0,
      water_samples: terrain.water_samples ?? 0,
      from_cache: terrain.from_cache === true,
    });
  }

  if (samples.length === 0) {
    return {
      measured: false,
      reason:
        "no terrain was probed near that footprint, so the ground height there is unknown",
      samples: 0,
    };
  }

  const maximums = samples.map((sample) => sample.max_z).filter(Number.isFinite);
  const minimums = samples.map((sample) => sample.min_z).filter(Number.isFinite);
  if (maximums.length === 0 || minimums.length === 0) {
    return {
      measured: false,
      reason: "nearby terrain probes did not report finite ground heights",
      samples: samples.length,
    };
  }
  const highest = Math.max(...maximums);
  const lowest = Math.min(...minimums);
  const steepest = Math.max(
    ...samples.map((sample) => sample.mean_slope_degrees ?? 0).filter(Number.isFinite),
  );
  const blocked = samples.reduce((sum, sample) => sum + (sample.blocked_samples ?? 0), 0);
  const overWater = samples.reduce((sum, sample) => sum + (sample.water_samples ?? 0), 0);

  return {
    measured: true,
    samples: samples.length,
    highest_ground_z: highest,
    lowest_ground_z: lowest,
    elevation_range_cm: Number.isFinite(highest) && Number.isFinite(lowest) ? highest - lowest : null,
    steepest_mean_slope_degrees: steepest,
    blocked_samples: blocked,
    water_samples: overWater,
    verdicts: [...new Set(samples.map((sample) => sample.verdict).filter(Boolean))],
    // Only the probe radius was measured; a large building can easily overhang it.
    coverage_note:
      "Measured within the scanner's probe radius. Ground beyond it is unknown, " +
      "not assumed flat.",
  };
}

/**
 * A platform height that clears the measured ground.
 *
 * Returns the Z to build the deck at and why. Deliberately conservative: it
 * clears the *highest* ground found, because a foundation buried in a hill is
 * worse than one standing a metre proud. When nothing was measured it returns
 * the requested height unchanged and says the ground is unknown, rather than
 * inventing a correction.
 */
export function clearanceAdjustedHeight(ground, { anchor_z_cm: anchorZ, requested_height_cm: requested = 0, margin_cm: margin = 100 } = {}) {
  if (!ground?.measured || !Number.isFinite(ground.highest_ground_z)) {
    return {
      height_cm: requested,
      adjusted: false,
      reason: ground?.reason ?? "the ground under that footprint was never measured",
    };
  }

  const requestedZ = Number(anchorZ) + requested;
  const neededZ = ground.highest_ground_z + margin;
  if (requestedZ >= neededZ) {
    return {
      height_cm: requested,
      adjusted: false,
      reason: `the deck already clears the highest measured ground by ${Math.round(requestedZ - ground.highest_ground_z)} cm`,
    };
  }

  const corrected = Math.ceil(neededZ - Number(anchorZ));
  return {
    height_cm: corrected,
    adjusted: true,
    raised_by_cm: corrected - requested,
    reason:
      `raised ${Math.round((corrected - requested) / 100)} m so the deck clears the ` +
      `highest ground measured under it (${Math.round(ground.elevation_range_cm / 100)} m of ` +
      "fall across the footprint)",
  };
}
