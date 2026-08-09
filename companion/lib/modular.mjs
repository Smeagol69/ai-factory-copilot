/**
 * Tiling a base out of the player's own modular blueprint set.
 *
 * The owner's library contains a deliberate tileset — `C01`/`C02` for corners,
 * `M01`–`M05` for the middles between them, `IC01` for the inner parts, all
 * 5×5 foundations. Their description of it: *"The construction is pretty
 * intuitive. The electrical connections must be made at the base, and on the
 * roof for the inner modules."*
 *
 * That changes what the creative layer has to produce. Everything so far
 * emitted individual foundations, walls and roofs — hundreds of pieces, each
 * one its own chance to hit uneven ground or refuse a snap. A blueprint is
 * placed as **one hologram**: the game resolves its internal structure itself,
 * and it carries its own foundations, so it does not care that the rock beneath
 * is at 50°.
 *
 * So the model's job shrinks to the part that is actually judgement — how big,
 * which variant where, which cells are interior — and the arithmetic here turns
 * that into blueprint placements on a fixed pitch.
 *
 * Three things this cannot know from the files, so it states them and reports
 * them rather than pretending:
 *
 *   - **Which way a corner faces.** The object graph is not decoded, so the
 *     authored orientation is unknown. A convention is assumed and named; if it
 *     is wrong every corner is wrong the same way, which is one number to fix
 *     rather than a mystery.
 *   - **Where the game anchors a blueprint** relative to the location given.
 *     Centre and corner are both plausible; the assumption is reported.
 *   - **Power.** The modules are wired at the base, and inner modules again on
 *     the roof. Nothing here runs those connections.
 */

/** A module is this many foundation cells on a side, per the set's own name. */
const MODULE_CELLS = 5;

/**
 * Yaw for each edge of the footprint, assuming a module authored facing -Y.
 *
 * Named because it is a guess. Unreal yaw increases from +X toward +Y, and
 * which way the author pointed the outside face is not in the header. Every
 * corner and edge derives from this one constant, so a wrong convention shows
 * up as a uniformly rotated shell — obvious, and fixed in one place.
 */
const OUTWARD_FACING_YAW = { south: 0, east: 90, north: 180, west: 270 };

function classifyCell(x, y, width, depth) {
  const westEdge = x === 0;
  const eastEdge = x === width - 1;
  const southEdge = y === 0;
  const northEdge = y === depth - 1;

  if ((westEdge || eastEdge) && (southEdge || northEdge)) {
    return {
      role: "corner",
      yaw: southEdge
        ? (westEdge ? OUTWARD_FACING_YAW.south : OUTWARD_FACING_YAW.east)
        : (eastEdge ? OUTWARD_FACING_YAW.north : OUTWARD_FACING_YAW.west),
    };
  }
  if (southEdge) return { role: "middle", yaw: OUTWARD_FACING_YAW.south };
  if (eastEdge) return { role: "middle", yaw: OUTWARD_FACING_YAW.east };
  if (northEdge) return { role: "middle", yaw: OUTWARD_FACING_YAW.north };
  if (westEdge) return { role: "middle", yaw: OUTWARD_FACING_YAW.west };
  return { role: "inner", yaw: OUTWARD_FACING_YAW.south };
}

/**
 * Sorts a blueprint library into the tileset's three roles.
 *
 * Matched on the name prefix the set already uses. The owner calls the third
 * kind "IN" while the files are named `IC01`, so both are accepted rather than
 * making the player rename anything.
 */
export function findModularSet(blueprints, { module_cells: moduleCells = MODULE_CELLS } = {}) {
  const set = { corner: [], middle: [], inner: [] };
  for (const entry of blueprints ?? []) {
    const name = String(entry?.name ?? "");
    if (!/modular/i.test(name)) continue;
    const dimensions = entry.designer_dimensions;
    // A tileset only tiles if every piece is the same size.
    if (dimensions && (dimensions.x !== moduleCells || dimensions.y !== moduleCells)) continue;

    const prefix = name.match(/^([A-Z]+)\s*\d/i)?.[1]?.toUpperCase();
    if (prefix === "C") set.corner.push(entry);
    else if (prefix === "M") set.middle.push(entry);
    else if (prefix === "IN" || prefix === "IC") set.inner.push(entry);
  }
  for (const list of Object.values(set)) {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return set;
}

/**
 * A W×D grid of modules as blueprint placements.
 *
 * `variety` cycles through the available blueprints for a role rather than
 * repeating one. With five middles the edges stop reading as a single stamped
 * unit, which is the whole reason the set has five.
 */
export function planModularShell(graph, args = {}) {
  const {
    width_modules: widthModules = null,
    depth_modules: depthModules = null,
    origin_cm: origin = null,
    blueprints = [],
    cell_size_cm: cellSize = null,
    module_cells: moduleCells = MODULE_CELLS,
    variety = true,
  } = args;

  const width = Number(widthModules);
  const depth = Number(depthModules);
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 2 || depth < 2) {
    return {
      solver: "modular_shell",
      planned: false,
      reason: "give a size of at least 2 x 2 modules; corners need two of each side",
    };
  }
  if (width * depth > 64) {
    return {
      solver: "modular_shell",
      planned: false,
      reason: `${width} x ${depth} is ${width * depth} modules; 64 is the most this will lay out at once`,
    };
  }
  if (!origin || ![origin.x, origin.y, origin.z].every((value) => Number.isFinite(Number(value)))) {
    return { solver: "modular_shell", planned: false, reason: "no origin with a finite x, y and z" };
  }
  if (!Number.isFinite(Number(cellSize)) || Number(cellSize) <= 0) {
    // The grid is parsed from the save's own foundation pieces. Assuming 8 m
    // would put every module off by however wrong the assumption was.
    return {
      solver: "modular_shell",
      planned: false,
      reason: "no foundation grid was derived from this save, so the module pitch is unknown",
    };
  }

  const set = findModularSet(blueprints, { module_cells: moduleCells });
  const missing = Object.entries(set)
    .filter(([, list]) => list.length === 0)
    .map(([role]) => role);
  // Inner modules are only needed once the footprint has an interior.
  const needsInner = width > 2 && depth > 2;
  const required = missing.filter((role) => role !== "inner" || needsInner);
  if (required.length > 0) {
    return {
      solver: "modular_shell",
      planned: false,
      reason: `no ${required.join(" or ")} module blueprint found in your library`,
      found: Object.fromEntries(Object.entries(set).map(([role, list]) => [role, list.map((b) => b.name)])),
    };
  }

  const pitch = Number(cellSize) * moduleCells;
  const used = { corner: 0, middle: 0, inner: 0 };
  const placements = [];

  for (let y = 0; y < depth; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { role, yaw } = classifyCell(x, y, width, depth);
      const choices = set[role];
      const chosen = variety ? choices[used[role] % choices.length] : choices[0];
      used[role] += 1;
      placements.push({
        module_x: x,
        module_y: y,
        role,
        blueprint_name: chosen.name,
        yaw,
        location: {
          x: Number(origin.x) + x * pitch,
          y: Number(origin.y) + y * pitch,
          z: Number(origin.z),
        },
      });
    }
  }

  const counts = placements.reduce((totals, placement) => {
    totals[placement.role] = (totals[placement.role] ?? 0) + 1;
    return totals;
  }, {});

  return {
    solver: "modular_shell",
    planned: true,
    width_modules: width,
    depth_modules: depth,
    module_pitch_cm: pitch,
    footprint_m: { x: (width * pitch) / 100, y: (depth * pitch) / 100 },
    counts,
    placements,
    library: Object.fromEntries(
      Object.entries(set).map(([role, list]) => [role, list.map((entry) => entry.name)]),
    ),
    assumptions: {
      rotation:
        "Corners and edges are turned outward assuming each module was authored " +
        "facing south (-Y). If the shell comes out uniformly rotated, that one " +
        "convention is wrong and every piece is wrong the same way.",
      anchor:
        "Each blueprint is placed at its grid position; where the game anchors a " +
        "blueprint relative to that point is not in the file header.",
      pitch: `${pitch / 100} m per module, from this save's own foundation grid.`,
    },
    power:
      "Nothing here wires the modules. Connect power at the base, and on the " +
      "roof for the inner modules.",
  };
}

/** The shell as ordered actions: corners first, then edges, then the interior. */
export function modularShellActions(plan, { commit = false } = {}) {
  if (!plan?.planned) return [];
  const order = { corner: 0, middle: 1, inner: 2 };
  return [...plan.placements]
    .sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9))
    .map((placement) => ({
      action: "place_blueprint",
      blueprint_name: placement.blueprint_name,
      location: placement.location,
      yaw: placement.yaw,
      commit,
    }));
}
