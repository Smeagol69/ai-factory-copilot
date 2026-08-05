/**
 * The layer where a model gets to be creative without being trusted with numbers.
 *
 * Everything else in this project follows one rule: the model never produces a
 * value a solver could produce. Architecture is the first place that rule needed
 * a shape rather than a prohibition, because the thing the owner wants — a
 * building that looks like the reference art — genuinely requires judgement. A
 * tower offset to one side rather than centred, wings of unequal length, the
 * rhythm of solid wall against glass: no rule system invents those.
 *
 * So the split is:
 *
 *   - **The model writes a composition.** Named blocks, their size in cells,
 *     where they sit relative to each other, how many storeys, what they house,
 *     what connects to what. Judgement, expressed in whole cells and names.
 *   - **This module realises it.** Grid coordinates, terrain clearance, recipe
 *     resolution, overlap checking, ordering, validation. Arithmetic.
 *
 * The model still cannot place a foundation at a fractional coordinate, cannot
 * put two blocks in the same place, and cannot name a piece the save has not
 * unlocked. It can decide what the building should *be*.
 *
 * Positions are in **cells relative to the composition origin**, never world
 * centimetres. A model reasoning in metres about a world coordinate is a model
 * one typo away from a factory in the ocean; a model reasoning in "six cells
 * north of the tower" is checkable.
 */

const MAX_BLOCKS = 12;
const MAX_CELLS_PER_SIDE = 32;
const MAX_LEVELS = 12;

function integerInRange(value, low, high) {
  const number = Number(value);
  return Number.isInteger(number) && number >= low && number <= high ? number : null;
}

/**
 * Checks a composition before any of it is built.
 *
 * Every rejection names the block and the field, because the model that wrote
 * it may get to try again and "invalid composition" tells it nothing.
 */
export function validateComposition(composition) {
  const problems = [];
  const blocks = Array.isArray(composition?.blocks) ? composition.blocks : [];

  if (blocks.length === 0) {
    return { valid: false, problems: ["a composition needs at least one block"] };
  }
  if (blocks.length > MAX_BLOCKS) {
    problems.push(`${blocks.length} blocks exceeds the ${MAX_BLOCKS} allowed in one composition`);
  }

  const names = new Set();
  const checked = [];

  for (const [index, block] of blocks.entries()) {
    const label = block?.name ? `"${block.name}"` : `block ${index + 1}`;

    const name = String(block?.name ?? "").trim();
    if (!name) problems.push(`${label}: every block needs a name, so bridges can refer to it`);
    else if (names.has(name)) problems.push(`${label}: duplicate name`);
    else names.add(name);

    const width = integerInRange(block?.width_cells, 1, MAX_CELLS_PER_SIDE);
    const depth = integerInRange(block?.depth_cells, 1, MAX_CELLS_PER_SIDE);
    const gridX = integerInRange(block?.grid_x, -64, 64);
    const gridY = integerInRange(block?.grid_y, -64, 64);
    const levels = integerInRange(block?.levels ?? 1, 1, MAX_LEVELS);

    if (width === null) problems.push(`${label}: width_cells must be a whole number 1-${MAX_CELLS_PER_SIDE}`);
    if (depth === null) problems.push(`${label}: depth_cells must be a whole number 1-${MAX_CELLS_PER_SIDE}`);
    if (gridX === null) problems.push(`${label}: grid_x must be a whole number of cells, -64 to 64`);
    if (gridY === null) problems.push(`${label}: grid_y must be a whole number of cells, -64 to 64`);
    if (levels === null) problems.push(`${label}: levels must be a whole number 1-${MAX_LEVELS}`);

    if (width !== null && depth !== null && gridX !== null && gridY !== null && levels !== null) {
      checked.push({
        name,
        grid_x: gridX,
        grid_y: gridY,
        width_cells: width,
        depth_cells: depth,
        levels,
        inset_cells: integerInRange(block?.inset_cells ?? 0, 0, 4) ?? 0,
        raised_cells: integerInRange(block?.raised_cells ?? 0, 0, 20) ?? 0,
        glass_roof: block?.glass_roof !== false,
        houses_production: block?.houses_production === true,
        role: String(block?.role ?? "").trim() || null,
      });
    }
  }

  // Overlap is the failure a model actually makes: two blocks described
  // independently, both sounding right, occupying the same cells. The game
  // would refuse the second one's foundations piece by piece and leave a
  // half-built mess, so it is caught here instead.
  for (let a = 0; a < checked.length; a += 1) {
    for (let b = a + 1; b < checked.length; b += 1) {
      const first = checked[a];
      const second = checked[b];
      const overlapX =
        first.grid_x < second.grid_x + second.width_cells &&
        second.grid_x < first.grid_x + first.width_cells;
      const overlapY =
        first.grid_y < second.grid_y + second.depth_cells &&
        second.grid_y < first.grid_y + first.depth_cells;
      // Blocks at different heights may legitimately overlap in plan — that is
      // a cantilever — so only ground-sharing blocks conflict.
      const shareGround = first.raised_cells === second.raised_cells;
      if (overlapX && overlapY && shareGround) {
        problems.push(
          `"${first.name}" and "${second.name}" overlap on the same level; ` +
            "move one, or raise it so it cantilevers over the other",
        );
      }
    }
  }

  const bridges = [];
  for (const [index, bridge] of (composition?.bridges ?? []).entries()) {
    const from = String(bridge?.from ?? "").trim();
    const to = String(bridge?.to ?? "").trim();
    const label = `bridge ${index + 1}`;
    if (!names.has(from)) problems.push(`${label}: "${from}" is not a block in this composition`);
    if (!names.has(to)) problems.push(`${label}: "${to}" is not a block in this composition`);
    if (from && to && from === to) problems.push(`${label}: a bridge needs two different blocks`);
    if (names.has(from) && names.has(to) && from !== to) {
      bridges.push({ from, to, level: integerInRange(bridge?.level ?? 1, 1, MAX_LEVELS) ?? 1 });
    }
  }

  return problems.length > 0
    ? { valid: false, problems }
    : { valid: true, blocks: checked, bridges };
}

/**
 * Builds a validated composition into real structures.
 *
 * Each block becomes a structure or a tower at its grid offset from the
 * composition origin. Bridges become foundation runs at deck height between
 * two blocks. Production is assigned to the blocks that asked for it, in the
 * order they were named, so a model can say "production in the wings, the tower
 * is offices" and have that hold.
 */
export function planComposition(graph, args = {}) {
  const {
    composition = null,
    origin_cm: originArg = null,
    plan_structure: planStructure = null,
    plan_tower: planTower = null,
  } = args;

  if (typeof planStructure !== "function") {
    return { solver: "composition", planned: false, reason: "no structure planner was provided" };
  }

  const validation = validateComposition(composition);
  if (!validation.valid) {
    return {
      solver: "composition",
      planned: false,
      reason: "the composition is not buildable as written",
      problems: validation.problems,
    };
  }

  // A throwaway probe establishes the grid and the piece kit, so every block
  // below is measured against the same cell size.
  const probe = planStructure(graph, { width_cells: 1, depth_cells: 1, height_cm: 0 });
  if (!probe.planned) return { ...probe, solver: "composition" };
  const cell = probe.grid.cell_size_cm;

  const origin =
    originArg ?? graph?.snapshot?.interaction_context?.player?.pawn_location ?? null;
  if (!origin || !Number.isFinite(Number(origin.x))) {
    return { solver: "composition", planned: false, reason: "no origin given and no captured player position" };
  }

  const built = [];
  const failed = [];
  // The first block measures the ground; the rest inherit its height so the
  // composition sits level rather than each block finding its own footing.
  let groundClearedHeightCm = null;

  for (const block of validation.blocks) {
    const blockOrigin = {
      x: Number(origin.x) + block.grid_x * cell,
      y: Number(origin.y) + block.grid_y * cell,
      z: Number(origin.z),
    };
    const requestedRaise = block.raised_cells * cell;
    const args = {
      origin_cm: blockOrigin,
      width_cells: block.width_cells,
      depth_cells: block.depth_cells,
      height_cm: groundClearedHeightCm !== null
        ? groundClearedHeightCm + requestedRaise
        : requestedRaise,
      glass_roof: block.glass_roof,
      clear_terrain: groundClearedHeightCm === null,
    };

    const structure = block.levels > 1 && typeof planTower === "function"
      ? planTower(graph, { ...args, levels: block.levels, inset_cells: block.inset_cells })
      : planStructure(graph, args);

    if (!structure.planned) {
      failed.push({ block: block.name, reason: structure.reason });
      continue;
    }
    if (groundClearedHeightCm === null) {
      groundClearedHeightCm = structure.raised_cm - requestedRaise;
    }
    built.push({ ...block, structure });
  }

  if (built.length === 0) {
    return {
      solver: "composition",
      planned: false,
      reason: "no block in the composition could be planned",
      failed,
    };
  }

  // Bridges: a single-cell-wide foundation run between two blocks at deck
  // height. Deliberately simple — a walkway that lands on both decks is more
  // useful than a clever span that lands on neither.
  const bridgeParts = [];
  const bridgesPlanned = [];
  for (const bridge of validation.bridges) {
    const from = built.find((entry) => entry.name === bridge.from);
    const to = built.find((entry) => entry.name === bridge.to);
    if (!from || !to) continue;

    const deckOf = (entry) => {
      const decks = entry.structure.interiors ?? [{ level: 1, ...entry.structure.interior }];
      return decks[Math.min(decks.length - 1, bridge.level - 1)];
    };
    const fromDeck = deckOf(from);
    const toDeck = deckOf(to);
    const floorPiece = probe.parts.find((part) => part.kind === "floor");
    if (!floorPiece) continue;

    // Straight run along whichever axis separates them further.
    const dx = toDeck.min_x_cm - fromDeck.min_x_cm;
    const dy = toDeck.min_y_cm - fromDeck.min_y_cm;
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const spanCm = alongX ? Math.abs(dx) : Math.abs(dy);
    const steps = Math.max(0, Math.round(spanCm / cell) - 1);
    const step = alongX ? Math.sign(dx) : Math.sign(dy);

    for (let index = 1; index <= steps; index += 1) {
      bridgeParts.push({
        kind: "bridge",
        recipe_class: floorPiece.recipe_class,
        name: floorPiece.name,
        location_cm: {
          x: alongX ? fromDeck.min_x_cm + step * index * cell : fromDeck.min_x_cm,
          y: alongX ? fromDeck.min_y_cm : fromDeck.min_y_cm + step * index * cell,
          // The lower of the two decks, so the walkway meets both.
          z: Math.min(fromDeck.floor_z_cm, toDeck.floor_z_cm),
        },
        yaw: 0,
      });
    }
    bridgesPlanned.push({ ...bridge, pieces: steps, span_cm: spanCm });
  }

  const notes = [];
  if (failed.length > 0) {
    notes.push(`${failed.length} block(s) could not be planned; see failed.`);
  }
  const productionBlocks = built.filter((entry) => entry.houses_production);
  if (productionBlocks.length === 0) {
    notes.push(
      "No block is marked houses_production, so this is a shell only. Mark one " +
        "to have the machines placed inside it.",
    );
  }
  const terrain = built[0]?.structure?.terrain;
  if (terrain?.clearance?.adjusted) {
    notes.push(`Ground checked: ${terrain.clearance.reason}. Every block shares that height.`);
  }

  const parts = [...built.flatMap((entry) => entry.structure.parts), ...bridgeParts];
  return {
    solver: "composition",
    planned: true,
    grid_cell_cm: cell,
    origin_cm: origin,
    blocks: built.map((entry) => ({
      name: entry.name,
      role: entry.role,
      levels: entry.structure.levels ?? 1,
      houses_production: entry.houses_production,
      footprint: entry.structure.footprint,
      interiors: entry.structure.interiors ?? [{ level: 1, ...entry.structure.interior }],
      pieces: entry.structure.piece_counts,
    })),
    bridges: bridgesPlanned,
    failed,
    production_blocks: productionBlocks.map((entry) => entry.name),
    parts,
    piece_counts: parts.reduce((counts, part) => {
      counts[part.kind] = (counts[part.kind] ?? 0) + 1;
      return counts;
    }, {}),
    notes,
    unverified:
      "Every piece is a proposal on the game's grid. Ground, clearance, overlap " +
      "and cost are decided by the hologram as each one is placed.",
  };
}

/** The composition as ordered actions: decks, supports, shells, then bridges. */
export function compositionActions(plan, { commit = false } = {}) {
  if (!plan?.planned) return [];
  const order = { floor: 0, pillar: 1, wall: 2, roof: 3, ramp: 4, bridge: 5 };
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
