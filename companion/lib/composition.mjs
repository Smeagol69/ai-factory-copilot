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

    const inset = integerInRange(block?.inset_cells ?? 0, 0, 4);
    const raised = integerInRange(block?.raised_cells ?? 0, 0, 20);
    if (inset === null) problems.push(`${label}: inset_cells must be a whole number 0-4`);
    if (raised === null) problems.push(`${label}: raised_cells must be a whole number 0-20`);

    if (width !== null && depth !== null && gridX !== null && gridY !== null && levels !== null && inset !== null && raised !== null) {
      checked.push({
        name,
        grid_x: gridX,
        grid_y: gridY,
        width_cells: width,
        depth_cells: depth,
        levels,
        inset_cells: inset,
        raised_cells: raised,
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
  const bridgeInput = composition?.bridges ?? [];
  if (!Array.isArray(bridgeInput)) {
    problems.push("bridges must be an array");
  }
  for (const [index, bridge] of (Array.isArray(bridgeInput) ? bridgeInput : []).entries()) {
    const from = String(bridge?.from ?? "").trim();
    const to = String(bridge?.to ?? "").trim();
    const label = `bridge ${index + 1}`;
    if (!names.has(from)) problems.push(`${label}: "${from}" is not a block in this composition`);
    if (!names.has(to)) problems.push(`${label}: "${to}" is not a block in this composition`);
    if (from && to && from === to) problems.push(`${label}: a bridge needs two different blocks`);
    const level = integerInRange(bridge?.level ?? 1, 1, MAX_LEVELS);
    if (level === null) problems.push(`${label}: level must be a whole number 1-${MAX_LEVELS}`);
    if (names.has(from) && names.has(to) && from !== to && level !== null) {
      bridges.push({ from, to, level });
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

  const origin =
    originArg ?? graph?.snapshot?.interaction_context?.player?.pawn_location ?? null;
  if (!origin || ![origin.x, origin.y, origin.z].every((value) => Number.isFinite(Number(value)))) {
    return { solver: "composition", planned: false, reason: "no origin given and no captured player position" };
  }

  // A throwaway probe establishes the grid and the piece kit, so every block
  // below is measured against the same cell size. Pass the explicit origin: a
  // valid remote design must not fail merely because no player pawn was captured.
  const probe = planStructure(graph, {
    origin_cm: origin,
    width_cells: 1,
    depth_cells: 1,
    height_cm: 0,
  });
  if (!probe.planned) return { ...probe, solver: "composition" };
  const cell = probe.grid.cell_size_cm;

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
      return decks.find((deck) => deck.level === bridge.level) ?? null;
    };
    const fromDeck = deckOf(from);
    const toDeck = deckOf(to);
    if (!fromDeck || !toDeck) {
      bridgesPlanned.push({
        ...bridge,
        planned: false,
        reason: `level ${bridge.level} does not exist on both blocks`,
        pieces: 0,
      });
      continue;
    }
    const floorPiece = probe.parts.find((part) => part.kind === "floor");
    if (!floorPiece) continue;

    if (Math.abs(fromDeck.floor_z_cm - toDeck.floor_z_cm) > 1) {
      bridgesPlanned.push({
        ...bridge,
        planned: false,
        reason: "the named decks are at different heights; a flat bridge cannot meet both",
        pieces: 0,
      });
      continue;
    }

    // Straight run through the open gap between the nearest deck edges. The old
    // min-origin span started inside the source block and laid bridge pieces on
    // top of its own foundations, guaranteeing hologram overlap refusals.
    const centreX = (deck) => (deck.min_x_cm + deck.max_x_cm) / 2;
    const centreY = (deck) => (deck.min_y_cm + deck.max_y_cm) / 2;
    const dx = centreX(toDeck) - centreX(fromDeck);
    const dy = centreY(toDeck) - centreY(fromDeck);
    const gapX = Math.max(toDeck.min_x_cm - fromDeck.max_x_cm, fromDeck.min_x_cm - toDeck.max_x_cm, 0);
    const gapY = Math.max(toDeck.min_y_cm - fromDeck.max_y_cm, fromDeck.min_y_cm - toDeck.max_y_cm, 0);
    const alongX = gapX >= gapY;
    const overlapMin = alongX
      ? Math.max(fromDeck.min_y_cm, toDeck.min_y_cm)
      : Math.max(fromDeck.min_x_cm, toDeck.min_x_cm);
    const overlapMax = alongX
      ? Math.min(fromDeck.max_y_cm, toDeck.max_y_cm)
      : Math.min(fromDeck.max_x_cm, toDeck.max_x_cm);
    if (overlapMin > overlapMax) {
      bridgesPlanned.push({
        ...bridge,
        planned: false,
        reason: "the blocks have no aligned deck cells for a straight bridge",
        pieces: 0,
      });
      continue;
    }
    const fixed = overlapMin;
    const start = alongX
      ? (dx >= 0 ? fromDeck.max_x_cm : fromDeck.min_x_cm)
      : (dy >= 0 ? fromDeck.max_y_cm : fromDeck.min_y_cm);
    const end = alongX
      ? (dx >= 0 ? toDeck.min_x_cm : toDeck.max_x_cm)
      : (dy >= 0 ? toDeck.min_y_cm : toDeck.max_y_cm);
    const spanCm = Math.abs(end - start);
    const steps = Math.max(0, Math.round(spanCm / cell) - 1);
    const step = Math.sign(end - start);

    for (let index = 1; index <= steps; index += 1) {
      bridgeParts.push({
        kind: "bridge",
        recipe_class: floorPiece.recipe_class,
        name: floorPiece.name,
        location_cm: {
          x: alongX ? start + step * index * cell : fixed,
          y: alongX ? fixed : start + step * index * cell,
          z: fromDeck.floor_z_cm,
        },
        yaw: 0,
      });
    }
    bridgesPlanned.push({ ...bridge, planned: true, pieces: steps, span_cm: spanCm });
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

  // A block that could not be built as described still gets built, shorter or
  // plainer. Losing that explanation is how a composition quietly comes out
  // different from what was designed — a five-storey tower arriving as three
  // reads as a bug unless the reason travels with it.
  for (const entry of built) {
    for (const note of entry.structure.notes ?? []) {
      notes.push(`${entry.name}: ${note}`);
    }
    const requested = entry.levels;
    const actual = entry.structure.levels ?? 1;
    if (actual < requested) {
      notes.push(
        `"${entry.name}" was asked for ${requested} storeys and fits ${actual}: ` +
          `stepping in ${entry.inset_cells} cell(s) a tier runs out of floor. ` +
          "Widen it, or set inset_cells to 0 for straight sides.",
      );
    }
  }

  // Each part remembers the block it belongs to. Without it the composition
  // flattens into an anonymous pile, and a build too large for one transaction
  // cannot be split along the only seams that make sense to a player: "the main
  // hall went up, the tower is next".
  const parts = [
    ...built.flatMap((entry) =>
      entry.structure.parts.map((part) => ({ ...part, block: entry.name })),
    ),
    ...bridgeParts.map((part) => ({ ...part, block: part.block ?? "bridges" })),
  ];
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
      // Every piece here sits at a computed deck or storey height, and
      // foundations are flat. Letting each one trace down for its own build
      // surface gives a lumpy floor and an upper storey that is not level --
      // measured elsewhere as a Smelter asked for z 8054 landing at 9028.
      exact_z: true,
      yaw: part.yaw ?? 0,
      commit,
    }));
}

/**
 * A composition too big for one transaction, split into buildable stages.
 *
 * The mod clamps a single reply to 512 actions, and a four-block design of
 * fairly ordinary size already comes to 764. The cap is not arbitrary: every
 * action is preflighted and rolled back as one unit, so an unbounded batch is
 * an unbounded hitch and an unbounded undo journal. Raising it would trade a
 * refusal the player can act on for a stall they cannot.
 *
 * So split it where a player would: a block at a time, in build order, with the
 * bridges last because a walkway needs both ends to exist. A block that alone
 * exceeds the limit is split further, still in structural order — decks, then
 * supports, then shells, then roofs — so no stage leaves the build in a state
 * that could not stand on its own.
 *
 * Undo stays per stage. That is a real limit, not a detail to gloss: after
 * three stages, "undo" reverses the third. Anything else would need the mod to
 * hold a transaction open across replies.
 */
export function stageComposition(plan, { maxActions = 512, commit = false } = {}) {
  if (!plan?.planned) return { staged: false, reason: "the composition was not planned" };
  if (!Number.isInteger(maxActions) || maxActions < 1) {
    return { staged: false, reason: "maxActions must be a positive whole number" };
  }

  const order = { floor: 0, pillar: 1, wall: 2, roof: 3, ramp: 4, bridge: 5 };
  const asAction = (part) => ({
    action: "place_building",
    recipe_class: part.recipe_class,
    location: part.location_cm,
    // Same reason as compositionActions above: these are deck heights, not
    // suggestions to be resolved against whatever the ground happens to do.
    exact_z: true,
    yaw: part.yaw ?? 0,
    commit,
  });

  // Blocks in the order they were designed, bridges after every block.
  const byBlock = new Map();
  for (const part of plan.parts ?? []) {
    const key = part.kind === "bridge" ? "bridges" : (part.block ?? "unnamed");
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(part);
  }
  const bridgeParts = byBlock.get("bridges") ?? [];
  byBlock.delete("bridges");

  const stages = [];
  const pushStage = (name, parts) => {
    if (parts.length === 0) return;
    stages.push({
      index: stages.length + 1,
      name,
      blocks: [...new Set(parts.map((part) => part.block).filter(Boolean))],
      action_count: parts.length,
      actions: parts.map(asAction),
    });
  };

  const emitGroup = (name, parts) => {
    const sorted = [...parts].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    if (sorted.length <= maxActions) {
      pushStage(name, sorted);
      return;
    }
    // One block bigger than a whole transaction. Split it in structural order
    // so each stage ends on something that stands up.
    for (let start = 0, part = 1; start < sorted.length; start += maxActions, part += 1) {
      pushStage(`${name} (part ${part})`, sorted.slice(start, start + maxActions));
    }
  };

  for (const [name, parts] of byBlock) emitGroup(name, parts);
  if (bridgeParts.length > 0) emitGroup("bridges", bridgeParts);

  const total = stages.reduce((sum, stage) => sum + stage.action_count, 0);
  return {
    staged: true,
    total_actions: total,
    fits_in_one_transaction: stages.length <= 1,
    stage_count: stages.length,
    stages,
    undo_note:
      stages.length > 1
        ? 'Each stage commits on its own, so "undo" reverses the most recent ' +
          "stage rather than the whole composition."
        : 'The whole composition is one transaction, so "undo" reverses all of it.',
  };
}
