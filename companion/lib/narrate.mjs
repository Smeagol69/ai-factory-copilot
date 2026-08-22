/**
 * Turn deterministic findings into something worth reading.
 *
 * The solvers already know everything. What they printed was a tally:
 *
 *   Deterministic solvers report 10 machine(s) with findings
 *   (power_fuse_triggered: 7, machine_reports_error_status: 6,
 *    output_port_not_connected: 1, producing_below_full_productivity: 2)
 *
 * Every number there is true and the whole line is close to useless. Three
 * things are wrong with it, and this module fixes each:
 *
 * 1. It leads with a category, not a consequence. "Your power has tripped" is
 *    the same fact, and it is actionable on sight.
 *
 * 2. It lists symptoms as peers of their cause. A tripped fuse is *why* six
 *    machines report an error status and two produce below rate. Presenting
 *    four findings side by side implies four problems when there is one.
 *
 * 3. It names no machines, so there is nowhere to walk to.
 *
 * Nothing here invents game state. Every sentence is assembled from fields the
 * solvers already computed, which is what lets it be this confident.
 */

/**
 * What each cause means, and which downstream symptoms it accounts for.
 *
 * `explains` is the load-bearing field: when a cause is present, the symptoms
 * it explains are demoted to consequences rather than reported as separate
 * problems. Get this wrong in the generous direction and you hide a real second
 * fault, so it lists only symptoms that genuinely cannot occur independently
 * once the parent is true.
 */
const CAUSES = {
  power_fuse_triggered: {
    rank: 0,
    severity: "invalid",
    headline: (n) => `Your power has tripped — ${n} machine${n === 1 ? "" : "s"} are dead on a blown circuit.`,
    why: "A fuse trips when draw exceeds generation. Everything on that circuit stops at once, which is why the count is high.",
    fix: "Restore generation or cut draw, then reset the fuse from any power pole or switch on that circuit.",
    explains: [
      "machine_reports_error_status",
      "producing_below_full_productivity",
      "standby_without_captured_reason",
      "not_producing",
    ],
  },
  power_capacity_deficit: {
    rank: 1,
    severity: "invalid",
    headline: (n) => `Your circuit is over capacity — ${n} machine${n === 1 ? "" : "s"} affected.`,
    why: "Consumption exceeds generation. It has not tripped yet, but it will the moment demand rises.",
    fix: "Add generation before this becomes a trip.",
    explains: ["producing_below_full_productivity", "standby_without_captured_reason"],
  },
  no_recipe_selected: {
    rank: 2,
    severity: "invalid",
    headline: (n) => `${n} machine${n === 1 ? " has" : "s have"} no recipe set.`,
    why: "A machine with no recipe consumes nothing and produces nothing. It is built but idle.",
    fix: "Open each one and pick a recipe.",
    explains: ["not_producing", "standby_without_captured_reason"],
  },
  input_port_not_connected: {
    rank: 3,
    severity: "invalid",
    headline: (n) => `${n} machine${n === 1 ? "" : "s"} have an input with nothing feeding it.`,
    why: "An unfed input starves the machine no matter what else is correct.",
    fix: "Belt or pipe the missing input.",
    explains: ["not_producing", "producing_below_full_productivity"],
  },
  output_port_not_connected: {
    rank: 4,
    severity: "invalid",
    headline: (n) => `${n} machine${n === 1 ? " has" : "s have"} an output going nowhere.`,
    why: "Output backs up into the machine's own buffer, then the machine halts. It looks like a supply problem and is not.",
    fix: "Belt the output away, or add a container to absorb it.",
    explains: ["not_producing", "producing_below_full_productivity"],
  },
  producing_below_full_productivity: {
    rank: 5,
    severity: "inefficient",
    headline: (n) => `${n} machine${n === 1 ? " is" : "s are"} running below full rate.`,
    why: "The machine works but is idle part of every cycle — normally an input arriving slower than it is consumed.",
    fix: "Check the slowest input's belt tier and the rate feeding it.",
    explains: [],
  },
  machine_reports_error_status: {
    rank: 6,
    severity: "invalid",
    headline: (n) => `${n} machine${n === 1 ? "" : "s"} report an error status.`,
    why: "The game flagged these itself.",
    fix: "Look at each one in game; the machine states its own complaint.",
    explains: [],
  },
  standby_without_captured_reason: {
    rank: 7,
    severity: "unknown",
    headline: (n) => `${n} machine${n === 1 ? " is" : "s are"} in standby with no reason captured.`,
    why: "The snapshot did not carry enough state to say why. This is a gap in what was captured, not a diagnosis.",
    fix: "Worth a look in game — the capture cannot answer it.",
    explains: [],
  },
};

const shortName = (report) =>
  String(report?.name ?? report?.class_path ?? "unnamed")
    .replace(/^.*[./]/, "")
    .replace(/_C_\d+$/, "")
    .replace(/^Build_/, "");

/** "a Smelter", "3 Smelters and a Constructor" — machines, grouped and counted. */
function nameMachines(reports, limit = 4) {
  const tally = new Map();
  for (const report of reports) {
    const name = shortName(report);
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => (count === 1 ? name : `${count}x ${name}`));
  const hidden = tally.size - Math.min(tally.size, limit);
  if (hidden > 0) parts.push(`and ${hidden} other kind${hidden === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Write the findings up.
 *
 * @param bottlenecks  parsed `diagnose_bottlenecks` output
 * @param power        parsed `get_power_circuits` output
 * @returns {{text: string, leading: string|null, problem_count: number}}
 */
export function narrateFindings(bottlenecks, power = null) {
  const reports = (bottlenecks?.reports ?? []).filter((r) => r && r.healthy === false);
  if (reports.length === 0) {
    const circuits = power?.circuit_count ?? 0;
    return {
      text:
        `Nothing is stalled. Every machine the capture could see is producing, across ` +
        `${circuits} power circuit${circuits === 1 ? "" : "s"}.`,
      leading: null,
      problem_count: 0,
    };
  }

  // Bucket machines by each cause they carry.
  const byCause = new Map();
  for (const report of reports) {
    for (const cause of report.local_causes ?? []) {
      const key = cause.cause;
      if (!byCause.has(key)) byCause.set(key, []);
      byCause.get(key).push(report);
    }
  }

  const present = [...byCause.keys()].filter((k) => CAUSES[k]);
  const unknown = [...byCause.keys()].filter((k) => !CAUSES[k]);
  present.sort((a, b) => CAUSES[a].rank - CAUSES[b].rank);

  // Demote symptoms that a higher-ranked cause already accounts for. Only
  // exact-cause coverage counts -- a symptom on a machine the parent cause does
  // not touch is a separate fault and must survive.
  const explained = new Set();
  for (const cause of present) {
    const affected = new Set(byCause.get(cause).map((r) => r.actor_id));
    for (const symptom of CAUSES[cause].explains) {
      const carriers = byCause.get(symptom);
      if (!carriers) continue;
      if (carriers.every((r) => affected.has(r.actor_id))) explained.add(symptom);
    }
  }

  const primary = present.filter((c) => !explained.has(c));
  const consequences = present.filter((c) => explained.has(c));

  const lines = [];
  const leading = primary[0] ?? null;

  for (const cause of primary) {
    const spec = CAUSES[cause];
    const machines = byCause.get(cause);
    lines.push(`**${spec.headline(machines.length)}**`);
    lines.push(`${spec.why} ${spec.fix}`);
    lines.push(`Affected: ${nameMachines(machines)}.`);
    lines.push("");
  }

  if (consequences.length > 0) {
    const named = consequences
      .map((c) => `${byCause.get(c).length} ${c.replace(/_/g, " ")}`)
      .join(", ");
    lines.push(
      `The other findings — ${named} — are downstream of the above, not separate faults. ` +
        `Expect them to clear when it does.`,
    );
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(
      `Also reported, with no interpretation available: ${unknown.join(", ")}. ` +
        `The solvers found these; nothing here knows what they mean yet.`,
    );
    lines.push("");
  }

  const circuits = power?.circuit_count ?? null;
  if (circuits !== null) {
    lines.push(
      `Read from ${reports.length} stalled machine${reports.length === 1 ? "" : "s"} across ` +
        `${circuits} power circuit${circuits === 1 ? "" : "s"}, from captured state — not estimated.`,
    );
  }

  return { text: lines.join("\n").trim(), leading, problem_count: primary.length };
}
