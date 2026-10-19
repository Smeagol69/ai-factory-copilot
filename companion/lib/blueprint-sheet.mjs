/**
 * A blueprint decode, rendered for reading.
 *
 * The JSON decode is complete but nobody - person or model - understands a
 * design by scrolling four hundred transform records. This renders the same
 * decode as a sheet: what it makes, how hard it is driven, what it costs, and a
 * plan view of where things actually sit.
 *
 * The plan view is the part that matters. A blueprint is a spatial object, and a
 * list of coordinates does not convey a spatial object. One character per
 * foundation cell per floor does, and it costs a few hundred tokens instead of
 * tens of thousands.
 *
 * Nothing is invented here. Every glyph comes from a decoded pivot, and cells
 * are floored to the 800 cm grid, so the map is a real projection of saved
 * positions and not a redrawing of what the design "should" look like.
 */

import { BUILDABLE_ROLES } from "./blueprint-reference.mjs";

// One glyph per role, ordered by which wins when several share a cell. A
// Constructor under a walkway inside a walled room should read as a Constructor.
const ROLE_GLYPHS = Object.freeze([
  ["production", "M"],
  ["logistics", "="],
  ["power", "+"],
  ["utility", "U"],
  ["access", "c"],
  ["signage", "s"],
  ["ambience", "*"],
  ["enclosure", "#"],
  ["unclassified", "?"],
]);

const EMPTY_CELL = "·";
const LEVEL_HEIGHT_M = 4;
const MAXIMUM_MAP_CELLS = 80;
const MAXIMUM_LEVELS_DRAWN = 8;
const MAXIMUM_BUILDING_ROWS = 400;
const MAXIMUM_TRANSPORT_ROWS = 40;

function rolePriority(role) {
  const index = ROLE_GLYPHS.findIndex(([name]) => name === role);
  return index === -1 ? ROLE_GLYPHS.length : index;
}

function glyphFor(role) {
  return ROLE_GLYPHS.find(([name]) => name === role)?.[1] ?? "?";
}

/**
 * Top-down maps, one per 4 m level band.
 *
 * Returns `{ available: false, reason }` rather than a partial picture when the
 * footprint is too large to draw - a truncated map would be read as the whole
 * design.
 */
export function renderPlanViews(buildings, { maxCells = MAXIMUM_MAP_CELLS } = {}) {
  const positioned = buildings.filter((building) => building.grid_cells && building.height_m !== null);
  if (!positioned.length) return { available: false, reason: "no positioned buildings" };

  const cellX = positioned.map((b) => Math.floor(b.grid_cells.x));
  const cellY = positioned.map((b) => Math.floor(b.grid_cells.y));
  const minX = Math.min(...cellX);
  const maxX = Math.max(...cellX);
  const minY = Math.min(...cellY);
  const maxY = Math.max(...cellY);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width > maxCells || height > maxCells) {
    return {
      available: false,
      reason: `footprint is ${width}x${height} cells, larger than the ${maxCells}-cell map limit`,
    };
  }

  const byLevel = new Map();
  for (const building of positioned) {
    const level = Math.floor(building.height_m / LEVEL_HEIGHT_M);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(building);
  }

  const levels = [...byLevel.keys()].sort((a, b) => b - a);
  const drawn = levels.slice(0, MAXIMUM_LEVELS_DRAWN);
  const maps = drawn.map((level) => {
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => null));
    for (const building of byLevel.get(level)) {
      const gx = Math.floor(building.grid_cells.x) - minX;
      const gy = Math.floor(building.grid_cells.y) - minY;
      const current = grid[gy][gx];
      if (current === null || rolePriority(building.role) < rolePriority(current)) {
        grid[gy][gx] = building.role;
      }
    }
    return {
      level,
      height_m_from: level * LEVEL_HEIGHT_M,
      height_m_to: (level + 1) * LEVEL_HEIGHT_M,
      building_count: byLevel.get(level).length,
      rows: grid.map((row) => row.map((role) => (role ? glyphFor(role) : EMPTY_CELL)).join("")),
    };
  });

  return {
    available: true,
    origin_cell: { x: minX, y: minY },
    width_cells: width,
    height_cells: height,
    levels_total: levels.length,
    levels_drawn: drawn.length,
    maps,
  };
}

function legendLine() {
  return ROLE_GLYPHS.filter(([role]) => BUILDABLE_ROLES.includes(role))
    .map(([role, glyph]) => `${glyph} ${role}`)
    .join("   ");
}

function costTable(buildCost) {
  const rows = (buildCost ?? []).filter((entry) => Number(entry?.amount) > 0);
  if (!rows.length) return "_No build cost recorded in the header._";
  return [
    "| Item | Amount |",
    "|---|---:|",
    ...rows.map((entry) => `| ${entry.item_name} | ${entry.amount} |`),
  ].join("\n");
}

function roleCensusTable(buildings) {
  const counts = new Map();
  for (const building of buildings) counts.set(building.role, (counts.get(building.role) ?? 0) + 1);
  const total = buildings.length || 1;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return [
    "| Role | Count | Share |",
    "|---|---:|---:|",
    ...rows.map(([role, count]) => `| ${role} | ${count} | ${((count / total) * 100).toFixed(1)}% |`),
  ].join("\n");
}

function machineTable(decode) {
  if (!decode.machine_groups.length) {
    return "_No production machines. This blueprint is structure only._";
  }
  return [
    "| Machine | Recipe | Clock | Count |",
    "|---|---|---:|---:|",
    ...decode.machine_groups.map(
      (group) =>
        `| ${group.class_name} | ${group.recipe ?? "_not set_"} | ${
          group.clock_percent === null ? "_unset_" : `${group.clock_percent}%`
        } | ${group.count} |`,
    ),
  ].join("\n");
}

function throughputSection(check) {
  if (check.status !== "derived") {
    return `Not derived — ${check.reason}.`;
  }
  return [
    `The author declares **${check.declared_output.amount_per_minute} ${check.declared_output.item_label}/min**.`,
    "",
    `The file contains **${check.machine_count} x ${check.machine_class}** set to **${check.recipe}** at **${check.clock_percent}%**.`,
    "",
    `That credits each machine with **${check.implied_rate_per_machine_at_full_clock}/min at 100% clock**.`,
    "",
    `_${check.caveat}_`,
  ].join("\n");
}

function buildingTable(buildings) {
  const rows = buildings.slice(0, MAXIMUM_BUILDING_ROWS);
  const lines = [
    "| # | Class | Cell x | Cell y | z (m) | Yaw | Recipe | Clock |",
    "|---:|---|---:|---:|---:|---:|---|---:|",
    ...rows.map(
      (b) =>
        `| ${b.index} | ${b.class_name} | ${b.grid_cells?.x ?? "—"} | ${b.grid_cells?.y ?? "—"} | ${
          b.height_m ?? "—"
        } | ${b.yaw_degrees}° | ${b.recipe ?? ""} | ${
          b.clock_percent === null ? "" : `${b.clock_percent}%`
        } |`,
    ),
  ];
  if (buildings.length > rows.length) {
    lines.push("");
    lines.push(
      `_${buildings.length - rows.length} further buildings are in the JSON decode beside this sheet; this table is capped at ${MAXIMUM_BUILDING_ROWS} rows._`,
    );
  }
  return lines.join("\n");
}

const observedCount = value => Number.isInteger(value) && value >= 0 ? value : "unknown";
const observedNumber = value => Number.isFinite(value) ? value : "unknown";
const transportCell = value => typeof value === "string" && value.trim()
  ? value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|") : "unknown";

function observedPoint(point) {
  return [point?.x, point?.y, point?.z].every(Number.isFinite)
    ? `(${point.x}, ${point.y}, ${point.z})` : "unknown";
}

function boundedSplinePointOmissions(topology) {
  // The shared decoders count declared-minus-returned points as truncated.
  // That includes rejected malformed points, which are not a size-bound loss.
  const total = observedCount(topology?.spline_points_truncated);
  const malformed = observedCount(topology?.malformed_spline_point_count);
  return total !== "unknown" && malformed !== "unknown" && total >= malformed ? total - malformed : "unknown";
}

function transportTable(headers, records, label, row) {
  if (!Array.isArray(records)) return `_Unknown: ${label} detail records were not recorded._`;
  if (!records.length) return `_No ${label} detail records returned._`;
  const shown = records.slice(0, MAXIMUM_TRANSPORT_ROWS);
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`,
    ...shown.map(record => `| ${row(record).join(" | ")} |`)];
  if (shown.length < records.length) {
    lines.push("", `_${records.length - shown.length} further ${label} are not shown in this sheet; see the JSON decode._`);
  }
  return lines.join("\n");
}

function transportSection(topology, kind) {
  const hyper = kind === "hypertube";
  const heading = hyper ? "Hypertubes" : "Railroad tracks";
  const scope = hyper ? "reciprocal_native_hypertube_component_references_and_saved_pipe_hyper_splines"
    : "saved_native_railroad_track_spline_records";
  const out = [`### ${heading}`, ""];
  if (topology?.status !== "decoded" || topology.scope !== scope) {
    out.push(`Unknown — ${transportCell(topology?.reason ?? (topology ? "unsupported or unavailable topology format" : "not recorded in this decode"))}.`, "");
    return out.join("\n");
  }
  if (hyper) {
    out.push(`- **${observedCount(topology.reciprocal_connection_pair_count)}** reciprocal native hypertube pairs, ` +
      `**${observedCount(topology.native_hypertube_entity_count)}** native hypertube entities, ` +
      `**${observedCount(topology.hypertube_pipe_entity_count)}** saved PipeHyper spline records`);
  } else {
    out.push(`- **${observedCount(topology.native_rail_track_entity_count)}** native railroad track records`);
  }
  out.push(`- **${observedCount(topology.total_spline_point_count)}** saved spline points`, "");
  if (hyper) {
    out.push(transportTable(["Saved component A", "Saved component B"], topology.connections, "hypertube links",
      link => [transportCell(link?.endpoint_a?.component_instance_name), transportCell(link?.endpoint_b?.component_instance_name)]), "");
  }
  const headers = [hyper ? "PipeHyper instance" : "Track instance", ...(!hyper ? ["Saved graph ID (metadata)"] : []),
    "Saved points", "Start (cm)", "End (cm)", "Chord lower bound (cm)", "Spline state", "Malformed points"];
  out.push(transportTable(headers, hyper ? topology.pipe_hyper_records : topology.rail_tracks,
    hyper ? "PipeHyper records" : "rail records", record => {
      const valid = record?.spline_data_state === "valid" && record.malformed_spline_point_count === 0;
      return [
        transportCell(hyper ? record?.pipe_instance_name : record?.track_instance_name),
        ...(!hyper ? [record?.track_graph_id_state === "valid" ? observedNumber(record.track_graph_id) : "unknown"] : []),
        observedCount(record?.spline_point_count), valid ? observedPoint(record?.blueprint_relative_endpoints_cm?.start_cm) : "unknown",
        valid ? observedPoint(record?.blueprint_relative_endpoints_cm?.end_cm) : "unknown",
        valid ? observedNumber(record?.chord_length_cm) : "unknown",
        transportCell(record?.spline_data_state), observedCount(record?.malformed_spline_point_count),
      ];
    }), "");
  out.push(`Malformed spline points: ${observedCount(topology.malformed_spline_point_count)}; ` +
    `missing spline data: ${observedCount(topology.missing_spline_data_count)}; ` +
    `malformed spline data: ${observedCount(topology.malformed_spline_data_count)}.`);
  if (hyper) {
    out.push(`Decoder bounded omissions: ${observedCount(topology.connections_truncated)} hypertube links, ` +
      `${observedCount(topology.pipe_records_truncated)} PipeHyper records, ${boundedSplinePointOmissions(topology)} spline points.`);
  } else {
    out.push(`Decoder bounded omissions: ${observedCount(topology.rail_track_records_truncated)} rail records, ` +
      `${boundedSplinePointOmissions(topology)} spline points.`);
  }
  out.push("", "Endpoints are Blueprint-relative saved observations. Chord length is a straight-line lower bound, not curved travel distance.");
  out.push("Endpoints and chord are unknown for malformed or unrecorded spline data; malformed points are separate from bounded omissions.");
  out.push("Saved links, spline endpoints and graph IDs do not certify traversal, track joins, external hookups or destination fit.");
  if (topology.caveat) out.push("", transportCell(topology.caveat));
  out.push("");
  return out.join("\n");
}

/**
 * The whole sheet as Markdown.
 */
export function renderBlueprintSheet(decode, { jsonPath = null } = {}) {
  if (!decode?.available) {
    return `# ${decode?.name ?? "unknown"}\n\nCould not decode: \`${decode?.reason ?? "unknown"}\`.\n`;
  }

  const dims = decode.header.designer_dimensions ?? {};
  const plan = renderPlanViews(decode.buildings);
  const out = [];

  out.push(`# ${decode.name}`);
  out.push("");
  out.push(
    "Generated by `scripts/ingest-blueprint-reference.mjs` from the saved file, through the pinned read-only parser. Every number below is decoded, not recalled.",
  );
  out.push("");

  out.push("## What it is");
  out.push("");
  if (decode.header.description) {
    out.push("The author's own description:");
    out.push("");
    out.push("```");
    out.push(decode.header.description);
    out.push("```");
    out.push("");
  }
  if (Number.isFinite(dims.x) && Number.isFinite(dims.y)) {
    out.push(
      `- Designer envelope: **${dims.x} x ${dims.y} x ${dims.z}** cells (${dims.x * 8} m x ${dims.y * 8} m)`,
    );
  } else {
    const extent = decode.pivot_extent;
    const span = extent
      ? `${(extent.max_cm.x / 800).toFixed(1)} x ${(extent.max_cm.y / 800).toFixed(1)} cells`
      : "unknown";
    out.push(`- No designer envelope — this is a world export. Occupied span: **${span}**`);
  }
  out.push(
    `- **${decode.totals.buildings}** buildings, **${decode.totals.distinct_classes}** distinct classes`,
  );
  if (Number.isFinite(decode.totals.blueprint_proxy_count)) {
    out.push(
      `- **${decode.totals.blueprint_proxy_count}** placed-blueprint proxies (counted, not treated as buildings) and **${decode.totals.non_buildable_actor_count}** non-buildable actors`,
    );
  }
  const pairs = decode.connection_topology?.reciprocal_connection_pair_count;
  const wires = decode.power_wire_topology?.verified_power_wire_count;
  if (Number.isFinite(pairs) || Number.isFinite(wires)) {
    out.push(
      `- **${pairs ?? "?"}** reciprocal conveyor/pipe pairs, **${wires ?? "?"}** verified power wires`,
    );
  } else {
    out.push(
      `- Connection and power topology are not available in this format: ${decode.connection_topology?.reason ?? "unknown"}`,
    );
  }
  if (decode.header.game_changelist) {
    out.push(`- Authored on game changelist **${decode.header.game_changelist}**`);
  }
  out.push("");

  out.push("## Machines");
  out.push("");
  out.push(machineTable(decode));
  out.push("");

  out.push("## Declared throughput, checked");
  out.push("");
  out.push(throughputSection(decode.throughput_check));
  out.push("");

  out.push("## What it is made of");
  out.push("");
  out.push(roleCensusTable(decode.buildings));
  out.push("");

  out.push("## Saved transport topology");
  out.push("");
  out.push(transportSection(decode.hypertube_topology, "hypertube"));
  out.push(transportSection(decode.rail_topology, "rail"));

  out.push("## Plan view");
  out.push("");
  if (!plan.available) {
    out.push(`_No map: ${plan.reason}._`);
  } else {
    out.push(
      `Top-down, one character per 8 m cell, highest floor first. Origin cell is (${plan.origin_cell.x}, ${plan.origin_cell.y}); rows run +y downward, columns +x rightward.`,
    );
    out.push("");
    out.push(`Legend: ${legendLine()}   ${EMPTY_CELL} empty`);
    out.push("");
    for (const map of plan.maps) {
      out.push(
        `**Level ${map.level}** — ${map.height_m_from} m to ${map.height_m_to} m, ${map.building_count} buildings`,
      );
      out.push("");
      out.push("```");
      for (const row of map.rows) out.push(row);
      out.push("```");
      out.push("");
    }
    if (plan.levels_drawn < plan.levels_total) {
      out.push(
        `_${plan.levels_total - plan.levels_drawn} further levels are not drawn; every building is in the JSON decode._`,
      );
      out.push("");
    }
  }

  out.push("## Build cost");
  out.push("");
  out.push(costTable(decode.header.build_cost));
  out.push("");

  out.push("## Every building");
  out.push("");
  out.push(buildingTable(decode.buildings));
  out.push("");

  out.push("---");
  out.push("");
  out.push(`_${decode.coordinate_note}_`);
  if (jsonPath) {
    out.push("");
    out.push(`_Complete machine-readable decode: \`${jsonPath}\`._`);
  }
  out.push("");
  return out.join("\n");
}
