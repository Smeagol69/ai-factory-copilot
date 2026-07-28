/**
 * Answering without the model.
 *
 * Most of what the copilot says is already computed before a model sees it. Ask
 * "where should I build the HUB" and `find_best_site` scores every candidate
 * from captured resource nodes, measured terrain, and real distances — in about
 * a millisecond. The model then spends ~65k input tokens turning that JSON into
 * a paragraph. The arithmetic was never the model's job; rule 1 forbids it.
 *
 * So questions that a single solver fully answers are routed straight to that
 * solver and formatted here. No API call, no cost, no wait.
 *
 * The routing is deliberately conservative, because a wrong route is worse than
 * a paid one:
 *
 *   - patterns are anchored on explicit phrasings, never fuzzy similarity;
 *   - after matching, whatever is left of the question must be filler. A
 *     question that also asks something else falls through to the model, since
 *     answering half of it locally would be answering it wrong;
 *   - anything needing judgement, comparison, outside knowledge, or more than
 *     one solver is never routed.
 *
 * The result is labelled as locally computed, so the player can tell which
 * answers cost credit and which did not.
 */

import {
  solveBottlenecks,
  solveItemBalance,
  solvePowerCircuits,
  solveSiteSelection,
  solveUnlockStatus,
  solveBlueprintLibrary,
} from "./solvers.mjs";

/** Words that carry no question meaning, so leftover ones do not block a route. */
const FILLER = new Set([
  "a", "about", "am", "an", "and", "any", "anything", "are", "around", "as", "at",
  "b", "be", "best", "büd", "can", "could", "current", "currently", "do", "does",
  "for", "from", "get", "give", "go", "good", "got", "have", "here", "hey", "how",
  "i", "id", "im", "in", "into", "is", "it", "its", "just", "know", "like", "look",
  "me", "my", "near", "nearby", "now", "of", "ok", "on", "one", "or", "our", "out",
  "place", "please", "pls", "right", "say", "see", "should", "show", "so", "some",
  "spot", "tell", "that", "the", "their", "there", "these", "they", "this", "to",
  "up", "us", "want", "was", "we", "well", "what", "whats", "when", "where", "which",
  "why", "will", "with", "would", "you", "your", "youre",
  "wheres", "hows", "whens", "whos", "whys", "theres", "thats", "lets", "ive", "ill",
  // Contraction remnants: the normaliser splits "where's" into "where" + "s",
  // so the orphaned letters must not count as meaningful leftovers.
  "s", "t", "re", "ll", "ve", "d", "dont", "cant", "wont", "isnt", "arent",
]);

function normalize(question) {
  return String(question ?? "")
    .toLowerCase()
    // Drop apostrophes rather than splitting on them: "what's" must normalise
    // to "whats", not "what s", or every contraction misses its pattern.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when everything the pattern did not consume is filler.
 *
 * This is the guard that keeps a compound question off the local path: "where
 * should I build the hub and what should I make there" leaves "make" behind,
 * so it goes to the model rather than getting a half answer.
 */
function residueIsFiller(normalized, matched) {
  const consumed = new Set(normalize(matched).split(" "));
  const leftover = normalized
    .split(" ")
    .filter((word) => word && !consumed.has(word) && !FILLER.has(word));
  return leftover.length === 0;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
}

/* ---------------- formatters ---------------- */

function formatSite(result) {
  if (!result.sites || result.sites.length === 0) {
    return [
      "No buildable site could be scored.",
      result.completeness_warning ?? "",
      `Resource nodes captured: ${result.resource_node_totals?.captured ?? 0}, usable: ${result.resource_node_totals?.usable ?? 0}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  const best = result.sites[0];
  const centre = best.center_cm ?? {};
  const terrain = best.terrain ?? {};
  const lines = [];

  lines.push(
    `Best site: **x ${Math.round(centre.x)}, y ${Math.round(centre.y)}, z ${Math.round(centre.z)}** (score ${round(best.score)}).`,
  );

  // Why it won matters more than the number it won with.
  const why = result.why_this_site;
  if (why?.headline) lines.push(why.headline);
  if (why?.resource_drivers?.length > 0) {
    lines.push(
      `What's in range: ${why.resource_drivers
        .map((entry) => `**${entry.resource}** ×${entry.nodes} (nearest ${entry.nearest_meters} m)`)
        .join(", ")}.`,
    );
  }

  // The terrain verdict is the thing most likely to change the player's mind,
  // so it leads rather than being buried under the score maths.
  if (terrain.measured) {
    const slope = round(terrain.mean_slope_degrees);
    lines.push(
      `Ground there is **${String(terrain.verdict).replace(/_/g, " ")}** — mean slope ${slope}°, ` +
        `${terrain.water_samples > 0 ? `${terrain.water_samples} sample(s) over water, ` : ""}` +
        `${terrain.blocked_samples > 0 ? `${terrain.blocked_samples} obstructed. ` : "nothing obstructing. "}` +
        (terrain.buildability_0_to_1 < 0.5
          ? "You will want foundations."
          : "It should build cleanly."),
    );
  } else {
    lines.push("Terrain there was not sampled, so buildability is unknown — inspect before committing.");
  }

  const occupied = best.existing_buildings_in_footprint?.count ?? 0;
  if (occupied > 0) lines.push(`${occupied} existing building(s) already sit inside that footprint.`);

  const breakdown = best.score_breakdown ?? {};
  lines.push(
    `Scored on resource diversity ${round(breakdown.resource_diversity)}, ` +
      `purity-weighted nodes ${round(breakdown.purity_weighted_nodes)}, ` +
      `terrain ${round(breakdown.terrain)}, distance ${round(breakdown.distance_penalty)}.`,
  );

  const runnersUp = result.sites.slice(1, 3);
  if (runnersUp.length > 0) {
    lines.push(
      `Runners-up: ${runnersUp
        .map((site) => `x ${Math.round(site.center_cm.x)}, y ${Math.round(site.center_cm.y)} (${round(site.score)})`)
        .join("; ")}.`,
    );
  }

  if (result.completeness_warning) lines.push(result.completeness_warning);
  return lines.join("\n\n");
}

function formatPower(result) {
  const circuits = result.circuits ?? [];
  if (circuits.length === 0) return "No power circuit was captured in this snapshot.";
  return circuits
    .map((circuit) => {
      const parts = [
        `Circuit ${circuit.circuit_id}: ${round(circuit.production_mw)} MW produced, ` +
          `${round(circuit.consumption_mw)} MW drawn, ${round(circuit.headroom_mw)} MW spare.`,
      ];
      if (circuit.fuse_triggered) parts.push("**The fuse has blown.**");
      if (circuit.battery_runtime_seconds != null) {
        parts.push(`Battery holds ${round(circuit.battery_runtime_seconds / 60)} min at this draw.`);
      }
      return parts.join(" ");
    })
    .join("\n\n");
}

function formatBottlenecks(result) {
  const stopped = (result.machines ?? []).filter((machine) => machine.problem);
  if (stopped.length === 0) return "Nothing is reporting a stall — every captured machine is running.";
  return stopped
    .slice(0, 8)
    .map((machine) => {
      const cause = machine.root_cause ? ` Root cause: ${machine.root_cause}.` : "";
      return `**${machine.display_name ?? machine.actor_id}** — ${machine.problem}.${cause}`;
    })
    .join("\n\n");
}

function formatBalance(result) {
  const deficits = (result.items ?? []).filter((item) => item.net_per_minute < 0);
  if (deficits.length === 0) return "Nothing is in deficit — production covers consumption for every captured item.";
  return `Short of:\n\n${deficits
    .slice(0, 10)
    .map((item) => `- **${item.item_name}**: ${round(item.net_per_minute)}/min net`)
    .join("\n")}`;
}

function formatUnlocks(result) {
  const parts = [];
  if (result.highest_tech_tier != null) parts.push(`Tech tier **${result.highest_tech_tier}**`);
  if (result.purchased_schematic_count != null) {
    parts.push(`${result.purchased_schematic_count} schematics purchased`);
  }
  if (result.available_recipe_count != null) {
    parts.push(`${result.available_recipe_count} recipes available, ${result.unavailable_recipe_count} not yet`);
  }
  return parts.length > 0 ? `${parts.join(". ")}.` : "Progression data was not captured in this snapshot.";
}

function formatBlueprints(result) {
  const blueprints = result.blueprints ?? [];
  if (blueprints.length === 0) return "No saved blueprints were found.";
  return `${blueprints.length} blueprint(s):\n\n${blueprints
    .slice(0, 15)
    .map((blueprint) => {
      const size = blueprint.designer_dimensions;
      const affordable =
        blueprint.affordable_from_captured_player_inventories === true
          ? " — affordable now"
          : blueprint.affordable_from_captured_player_inventories === false
            ? " — you are short materials"
            : "";
      return `- **${blueprint.name}**${size ? ` (${size.x}×${size.y}×${size.z})` : ""}${affordable}`;
    })
    .join("\n")}`;
}


/* ---------------- overlays ---------------- */

/**
 * "Show me every Beryl Nut within 100 m" needs no reasoning whatsoever — it is
 * a filter and a radius, and the mod resolves both against live actors anyway.
 * Sending it to a model costs a full request to have it re-typed as JSON.
 *
 * Parsed strictly: an unrecognised shape returns null and the model gets it,
 * because guessing what the player wanted highlighted is worse than paying.
 */
/** The verbs that mean "put a marker on it", and the articles that follow. */
const SHOW_VERB =
  /^(?:can you |could you |please )?(?:show|highlight|mark|find|locate|point out)\s+(?:me\s+)?(?:all\s+(?:of\s+)?(?:the\s+)?|every\s+|each\s+|the\s+|any\s+)?/i;

/** A radius clause, stripped before the target is read. */
const RADIUS = /\s*(?:with)?in\s+(\d+)\s*(?:m|meters|metres)\b.*$/i;

/** Trailing words that describe the request, not the thing being looked for. */
const SHOW_TAIL =
  /\s+(?:near(?:by| me)?|around(?: me)?|close(?: by)?|please|now|on (?:the )?map|for me)\s*$/i;

/** Words that mean this is a question, not a marker request. */
const NOT_A_TARGET = /\b(?:where|why|how|should|best|which|what|when|is|are|can)\b/i;
const MULTI_CLAUSE = /\b(?:and|then|also|plus|but)\b/i;

/**
 * Parsed in explicit steps rather than one regex, because the combined form was
 * subtly wrong: a lazy target group beside an optional trailing clause let the
 * target swallow the radius, so "within 150 m" silently became part of the item
 * name and the request was then rejected as too long. Stripping the radius
 * first removes the ambiguity instead of tuning around it.
 */
export function parseShowRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!SHOW_VERB.test(text)) return null;

  // 1. Drop the verb and any article.
  let rest = text.replace(SHOW_VERB, "").trim();

  // 2. Take the radius off the end, if one is stated.
  let radius = null;
  const radiusMatch = RADIUS.exec(rest);
  if (radiusMatch) {
    radius = Number.parseInt(radiusMatch[1], 10);
    rest = rest.slice(0, radiusMatch.index).trim();
  }

  // 3. Whatever remains, minus positional filler, is the thing to mark.
  let target = rest.replace(SHOW_TAIL, "").trim();
  if (!target) return null;

  if (NOT_A_TARGET.test(target)) return null;
  if (MULTI_CLAUSE.test(target)) return null;
  // More than four words is prose, not an item name.
  if (target.split(/\s+/).length > 4) return null;

  // Singular reads better as an overlay name; the mod matches by substring.
  if (target.length > 4 && /s$/i.test(target)) target = target.slice(0, -1);
  return { target, radius };
}

const CLEAR_PATTERNS = [
  /^(?:can you |could you |please )?(?:clear|remove|hide|delete|turn off|get rid of)\s+(?:the\s+)?(?:all\s+)?(?:overlays?|highlights?|markers?|tracers?|lines?)\b/i,
];

export function parseClearRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return CLEAR_PATTERNS.some((pattern) => pattern.test(text)) ? { all: true } : null;
}

/* ---------------- routes ---------------- */

/**
 * Each route names the phrasings it owns. They are matched against the
 * normalised question, and the pattern's own text is what `residueIsFiller`
 * treats as consumed — so a route only fires when it explains the question.
 */
const ROUTES = [
  {
    name: "find_best_site",
    patterns: [
      "where should i build",
      "where do i build",
      "where to build",
      "best place to build",
      "best spot to build",
      "best location to build",
      "where should i put",
      "where do i put",
      "where to put",
      "best site",
      "good place to build",
      "good spot to build",
      "somewhere to build",
      "place to put my",
      "site for my",
      "best place for",
      "best spot for",
      "good place for",
      "where for my",
      "location for my",
    ],
    // Building nouns are expected leftovers for a siting question.
    extraFiller: ["hub", "base", "factory", "smelter", "miner", "refinery", "plant", "build", "put"],
    run: (graph) => solveSiteSelection(graph, {}),
    format: formatSite,
  },
  {
    name: "get_power_circuits",
    patterns: [
      "power situation", "how is my power", "how s my power", "power status",
      "enough power", "short on power", "power headroom", "my power",
      "power left", "spare power", "power capacity", "fuse", "batteries",
      "how much power",
    ],
    extraFiller: ["power", "enough", "short", "headroom", "status", "situation", "much", "left", "have"],
    run: (graph) => solvePowerCircuits(graph, {}),
    format: formatPower,
  },
  {
    name: "diagnose_bottlenecks",
    patterns: [
      "what is stopped", "whats stopped", "what s stopped", "anything stopped",
      "what is broken", "whats broken", "bottleneck", "bottlenecks",
      "what is stalled", "whats stalled", "anything broken", "anything stalled",
      "not producing", "not running", "not working", "whats wrong",
      "what is wrong", "any problems", "anything idle",
    ],
    extraFiller: ["stopped", "broken", "stalled", "bottleneck", "bottlenecks", "running", "working", "problems", "issues"],
    run: (graph) => solveBottlenecks(graph, {}),
    format: formatBottlenecks,
  },
  {
    name: "get_item_balance",
    patterns: [
      "what am i short of", "what am i short on", "am i short of anything",
      "what is in deficit", "whats in deficit", "item balance",
      "running low on", "what do i need more of", "what am i missing",
      "whats my surplus", "what am i overproducing",
    ],
    extraFiller: ["short", "deficit", "balance", "item", "items", "running", "low"],
    run: (graph) => solveItemBalance(graph, {}),
    format: formatBalance,
  },
  {
    name: "get_unlock_status",
    patterns: [
      "what tier am i", "what tech tier", "my tech tier", "what have i unlocked",
      "unlock status", "how many recipes", "what tier", "my progress",
      "what phase am i", "my milestone", "current objective",
    ],
    extraFiller: ["tier", "tech", "unlocked", "unlock", "status", "recipes", "schematics", "many"],
    run: (graph) => solveUnlockStatus(graph),
    format: formatUnlocks,
  },
  {
    name: "list_blueprints",
    patterns: [
      "what blueprints do i have", "list my blueprints", "my blueprints",
      "which blueprints", "blueprints do i have", "show my blueprints",
      "what blueprints", "any blueprints",
    ],
    extraFiller: ["blueprints", "blueprint", "saved", "list", "many"],
    run: (graph, services) => solveBlueprintLibrary(graph, {}, services ?? {}),
    format: formatBlueprints,
  },
];

/**
 * Picks a route, or null when the model should handle it.
 *
 * Longest pattern first, so "where should i build" is preferred over a shorter
 * overlapping phrase and the residue check has the most text accounted for.
 */
export function routeQuestion(question) {
  const normalized = normalize(question);
  if (!normalized) return null;

  const candidates = [];
  for (const route of ROUTES) {
    for (const pattern of route.patterns) {
      if (normalized.includes(pattern)) candidates.push({ route, pattern });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.pattern.length - a.pattern.length);

  // Two different routes matching means the question spans both; that is a
  // compound question and belongs to the model.
  const distinctRoutes = new Set(candidates.map((entry) => entry.route.name));
  if (distinctRoutes.size > 1) return null;

  const { route, pattern } = candidates[0];
  const consumed = [pattern, ...(route.extraFiller ?? [])].join(" ");
  if (!residueIsFiller(normalized, consumed)) return null;
  return route;
}

/**
 * Answers locally when a single solver covers the question.
 *
 * Returns null when it does not — the caller then falls through to the model,
 * which is always the safe direction to fail.
 */
export function answerLocally(question, graph, services) {
  // Overlays are pure action: no solver, no model, just a parsed filter the mod
  // resolves live. Handled before routing because they never need either.
  const clear = parseClearRequest(question);
  if (clear) {
    const action = { action: "clear_highlight", all: true, commit: true };
    services?.actions?.emit?.([action]);
    return localAnswer(
      "Clearing every overlay.",
      "clear_highlight",
      Date.now(),
      "An overlay request is a filter, not a question — nothing to reason about.",
    );
  }

  const show = parseShowRequest(question);
  if (show) {
    const overlayName = show.target.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) || "overlay";
    const action = {
      action: "highlight",
      overlay: overlayName,
      item_name_contains: show.target,
      radius_m: show.radius ?? 150,
      commit: true,
    };
    services?.actions?.emit?.([action]);
    return localAnswer(
      `Marking every **${show.target}** within ${show.radius ?? 150} m (overlay "${overlayName}"). ` +
        "The mod resolves it live against the world, so check in-game for what it actually finds — " +
        "I am not guessing a count here.",
      "highlight",
      Date.now(),
      "An overlay request is a filter, not a question — nothing to reason about.",
    );
  }

  const route = routeQuestion(question);
  if (!route || !graph) return null;

  const started = Date.now();
  let result;
  try {
    result = route.run(graph, services);
  } catch {
    // A solver that throws is a bug, but not one worth failing the player's
    // question over — let the model answer instead.
    return null;
  }

  return {
    reply: `${route.format(result)}\n\n_Computed locally from the live snapshot — no API call, no credit used._`,
    provider: "solvers",
    model: "deterministic",
    solver_calls: [{ name: route.name, source: "local_route" }],
    sources: [],
    search_errors: [],
    cache: null,
    local: {
      routed: true,
      solver: route.name,
      elapsed_ms: Date.now() - started,
      why: "The question maps to exactly one solver, so the answer is computed rather than generated.",
    },
  };
}

function localAnswer(text, solver, started, why) {
  return {
    reply: `${text}

_Computed locally from the live snapshot — no API call, no credit used._`,
    provider: "solvers",
    model: "deterministic",
    solver_calls: [{ name: solver, source: "local_route" }],
    sources: [],
    search_errors: [],
    cache: null,
    local: { routed: true, solver, elapsed_ms: Date.now() - started, why },
  };
}

export { ROUTES as LOCAL_ROUTES };
