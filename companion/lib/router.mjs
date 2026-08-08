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
  solveFactorySummary,
  solveItemBalance,
  solvePowerCircuits,
  solveActorLookup,
  solveBuildRecipeLookup,
  solvePlacementTarget,
  solveProductionPlan,
  solveSiteSelection,
  solveUnlockStatus,
  solveBlueprintLibrary,
} from "./solvers.mjs";
import { validatePlan } from "./actions.mjs";
import {
  baseBuildActions,
  enclosedFactoryActions,
  findBestAvailableBelt,
  planBaseBuild,
  planEnclosedFactory,
} from "./base-build.mjs";
import {
  planStructure,
  planTower,
  structureActions,
  surveyStructuralPieces,
} from "./architecture.mjs";
import { planCoalPower } from "./power.mjs";
import { measureBuilding } from "./designer.mjs";
import {
  measureConnectors,
  solveBeltRoute,
  solveCompatibleBeltCandidates,
  solveNearestCompatibleBeltRoute,
  solveTemporaryFreeBeltRoute,
} from "./routing.mjs";

/**
 * Run locally routed actions through the same validator used for model tools.
 *
 * Local routing used to write directly to the response action sink. That
 * bypassed revision stamping and contract normalization, so every committed
 * local write was refused by the game; place_building also used field names
 * the C++ executor does not understand. One path now owns every emitted shape.
 */
/**
 * How far from the player a base may be sited.
 *
 * Not a game constant — a practical one. Satisfactory streams the world around
 * the player, and a placement trace beyond that finds no ground to build on.
 * 500 m matches the scanner's own terrain probe radius, which is the furthest
 * anything in this project has actually measured.
 */
const BUILDABLE_RANGE_METRES = 500;

function emitValidatedPlan(graph, services, proposals) {
  const emit = services?.actions?.emit;
  if (typeof emit !== "function") return null;

  const plan = validatePlan(graph, proposals);
  if (!plan.valid) {
    // Carry the refusal back rather than swallowing it.
    //
    // Returning a bare null made every rejection look identical to "this route
    // does not apply", so the request fell through to a model. A player asked
    // to build a 205-piece factory, hit the action cap, and got a provider
    // error about something else entirely. A route that knows why it failed
    // should be able to say so.
    lastPlanRejection = plan;
    return null;
  }

  lastPlanRejection = null;
  emit(plan.actions);
  return plan;
}

/**
 * Why the most recent local plan was refused, for the route that built it.
 *
 * Module-scoped and read immediately by the caller that just failed. It is not
 * state that outlives a request: every `emitValidatedPlan` either sets or
 * clears it, so a later route can never read a stale reason.
 */
let lastPlanRejection = null;

/** A readable sentence for a plan the validator would not accept. */
export function describePlanRejection(rejection = lastPlanRejection) {
  if (!rejection) return null;
  if (rejection.reason === "too_many_actions") {
    return (
      `That plan is ${rejection.requested} actions and the limit is ${rejection.limit}. ` +
      "Ask for a smaller factory, fewer storeys, or say \"just the machines\" to " +
      "skip the building."
    );
  }
  const first = rejection.rejected?.[0];
  return first ? `The plan was refused: ${first.reason} (step ${first.step}).` : null;
}

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
  // Conversational padding, harvested from the routing miss log rather than
  // imagined. Every one of these blocked a route that would have been correct:
  // "where should i build my hub on the whole map" left "whole, map"; "whats my
  // power looking like today" left "looking, today". None of them change what
  // is being asked.
  "actually", "again", "all", "already", "also", "always", "anyway", "area",
  "bit", "doing", "even", "ever", "exactly", "far", "going", "guess",
  "keep", "kind", "looking", "lot", "many", "map", "maybe", "mean",
  "much", "new", "over", "pretty", "quick", "really", "rest",
  "sort", "still", "sure", "think", "today", "total", "whole", "yet",
  // Deliberately NOT filler: make, need, next, help, time, build. Each one can
  // be the whole question ("what should I make there"), and treating them as
  // padding let a compound question take a route that answered only half of it.
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
  const reports = result.reports ?? [];
  if (reports.length === 0) {
    return "No captured production machine has a deterministic bottleneck finding in this snapshot.";
  }

  const causeLabel = (cause) => String(cause ?? "unknown cause").replaceAll("_", " ");
  const formatCause = (entry) => {
    const severityLabel = {
      invalid: "fault",
      inefficient: "inefficient",
      unknown: "unknown",
    }[entry?.severity] ?? entry?.severity;
    const severity = severityLabel ? ` [${severityLabel}]` : "";
    const evidence = entry?.evidence ? ` — ${entry.evidence}` : "";
    return `${causeLabel(entry?.cause)}${severity}${evidence}`;
  };

  const reportedCount = Number.isInteger(result.reported_machine_count)
    ? result.reported_machine_count
    : reports.length;
  const lines = [
    `**${reportedCount} captured production machine${reportedCount === 1 ? " has" : "s have"} findings.**`,
  ];

  const causeTotals = Object.entries(result.cause_counts ?? {})
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))
    .map(([cause, count]) => `${causeLabel(cause)} ${count}`);
  if (causeTotals.length > 0) lines.push(`Cause totals: ${causeTotals.join(", ")}.`);

  lines.push(
    ...reports.slice(0, 8).map((report) => {
      const status = report.production_status ? ` (status: ${report.production_status})` : "";
      const local = (report.local_causes ?? []).map(formatCause).join("; ") || "no local cause captured";
      const rootIsDifferent = report.root_cause_actor_id && report.root_cause_actor_id !== report.actor_id;
      const root = rootIsDifferent
        ? ` Root cause actor: **${report.root_cause_actor_id}** — ` +
          `${(report.root_causes ?? []).map(formatCause).join("; ") || "cause not captured"}.`
        : "";
      return `- **${report.name ?? report.actor_id}**${status} — ${local}.${root}`;
    }),
  );

  if (reports.length > 8) lines.push(`${reports.length - 8} more captured machine finding(s) are not shown here.`);
  if (reports.some((report) => (report.local_causes ?? []).some((cause) => cause.severity === "unknown"))) {
    lines.push(
      "An [unknown] cause means the snapshot did not contain enough evidence to identify why that machine is stalled.",
    );
  }
  return lines.join("\n\n");
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
  if (result.highest_available_tech_tier != null) {
    parts.push(`Tech tier **${result.highest_available_tech_tier}**`);
  }
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


/**
 * Input that cannot mean anything, answered for free.
 *
 * A stray "1" cost $0.25: the bridge sent 26k tokens of snapshot and ran solver
 * rounds so a frontier model could say it did not understand. Nothing about
 * that needed a model.
 *
 * Deliberately narrow. Short input is often perfectly actionable in context —
 * "yes", "do it", "undo" all follow a previous turn — so only input with no
 * possible meaning is caught: bare numbers, lone characters, and punctuation.
 * Anything with a real word goes through.
 */
const MEANINGLESS = [
  /^[\s\p{P}\p{S}]*$/u,        // punctuation or symbols only
  /^\s*\d+\s*$/,               // a bare number
  /^\s*\w\s*$/,                // a single character
];

export function isUnactionableInput(question) {
  const text = String(question ?? "").trim();
  if (!text) return true;
  return MEANINGLESS.some((pattern) => pattern.test(text));
}

/** What to say instead, with enough of a nudge to be useful. */
export function clarificationReply() {
  return [
    "That doesn't read as a question I can act on — could you say what you're after?",
    "",
    "Things that work well, and most of these cost nothing:",
    "- **where should I build my hub** — scores real sites from measured terrain",
    "- **show me every mercer sphere within 150 m** — draws them in-world",
    "- **what's my power situation** / **what am I short of** / **what tier am I**",
    "- **place a Mk1 Miner on BP_ResourceNode12_91** — builds it, if the game allows",
  ].join("\n");
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

/** "clear waypoints" removes map markers; "clear overlays" removes drawings. */
const CLEAR_WAYPOINTS = /\b(?:clear|remove|delete|wipe)\s+(?:(?:my|the|all|every|any)\s+)*way\s?points?\b/i;

export function parseClearWaypointRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return CLEAR_WAYPOINTS.test(text);
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
/**
 * "where is BP_ResourceNode12_91", "locate the nearest coal".
 *
 * A named lookup is the cheapest useful thing the copilot does and it was the
 * one gap that forced a paid call: the model is given a reduced view, so a name
 * it cannot see becomes "I don't know" unless something searches the complete
 * snapshot for it. Nothing here needs reasoning, so nothing here should cost.
 */
const LOCATE_VERB =
  /^(?:where\s+(?:is|are|s|was)|wheres|locate|find\s+me|find|show\s+me\s+the\s+location\s+of|coordinates?\s+(?:of|for)|coords?\s+(?:of|for)|position\s+of)\s+/i;
/** A siting question also starts with "where", and belongs to find_best_site. */
const LOCATE_DISQUALIFIER = /\b(?:should|best|good|somewhere|recommend|better)\b/i;
const LOCATE_LEADING_ARTICLE = /^(?:the|my|a|an|that|this|closest|nearest)\s+/i;

/**
 * "waypoint the best hub location", "mark BP_ResourceNode217 on my map".
 *
 * The game already has this: a map marker shows on the map and on the compass
 * with a live distance readout, exactly like the resource scanner. So a
 * waypoint request resolves a position and hands it to that system — there is
 * nothing here a model would add.
 *
 * Distinct from the drawn overlay, which stays the right answer for "show me
 * every beryl nut in 100 m": many targets, seen at once, through terrain.
 */
const WAYPOINT_VERB =
  /^(?:can you |could you |please )?(?:create |make |set |drop |add |put )?(?:me )?(?:a |an |the )?way\s?point(?:\s+(?:for|on|at|to))?\s+/i;
const WAYPOINT_ALT =
  /^(?:can you |could you |please )?(?:mark|pin|flag)\s+(?:me\s+)?(?:a\s+|the\s+)?(.+?)\s+(?:on|to)\s+(?:my\s+|the\s+)?(?:map|compass)\s*$/i;
/** Phrasings that name the siting solver's answer rather than a known place. */
const WAYPOINT_BEST_SITE = /\b(?:best|ideal|optimal|recommended)\b.*\b(?:hub|site|spot|location|place|base)\b/i;

/**
 * "belt the smelter to the constructor", "connect A to B with a mk2 belt".
 *
 * The planner and the write action both existed, and nothing connected them:
 * the only way to actually build a belt was to ask a model, which is the least
 * reliable path in the system. Every part of this is deterministic — resolve
 * two machines, let `solveBeltRoute` choose the connector pair, resolve the
 * belt recipe from the game's own catalog, emit the action.
 */
const BELT_VERB =
  /^(?:can you |could you |please )?(?:belt|connect|link|hook|run a belt from|run belt from)\s+/i;
const BELT_SEPARATOR = /\s+(?:to|into|with|and)\s+/i;
/** "with a mk2 belt" / "using a conveyor belt mk3" trailing the request. */
const BELT_TIER = /\s+(?:with|using)\s+(?:a\s+|an\s+|the\s+)?(.*?belt.*)$/i;

export function parseBeltRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || !BELT_VERB.test(text)) return null;

  let body = text.replace(BELT_VERB, "").trim();

  // An explicit tier is stripped first so it cannot be mistaken for a machine.
  let beltName = "conveyor belt mk1";
  const tier = body.match(BELT_TIER);
  if (tier) {
    beltName = tier[1].trim();
    body = body.slice(0, tier.index).trim();
  }

  const parts = body.split(BELT_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  // Exactly two endpoints. Three or more is a chain, which is a different
  // request with different failure modes, and guessing at it would build the
  // wrong thing in the player's world.
  if (parts.length !== 2) return null;

  const asTarget = (raw) => {
    let value = raw;
    while (LOCATE_LEADING_ARTICLE.test(value)) {
      value = value.replace(LOCATE_LEADING_ARTICLE, "").trim();
    }
    if (value.length < 2) return null;
    return /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(value)
      ? { actor_id: value, target: value, limit: 1 }
      : { name_contains: value, target: value, limit: 1 };
  };

  const from = asTarget(parts[0]);
  const to = asTarget(parts[1]);
  if (!from || !to) return null;
  return { from, to, belt_name: beltName };
}

/**
 * "dismantle Build_ConveyorBeltMk1_C_123", "remove that constructor".
 *
 * Deliberately narrow. Dismantling is the one write the undo journal cannot
 * always reverse — the mod runs it as a standalone committed action for exactly
 * that reason — so this only accepts a single, explicitly named target. No
 * "dismantle everything", no plurals, no "all the belts": those are the phrasings
 * where a misparse costs someone their factory, and a model asking "which one?"
 * is the correct outcome rather than a fast wrong one.
 */
const DISMANTLE_VERB =
  /^(?:can you |could you |please )?(?:dismantle|demolish|deconstruct|tear down|remove|delete)\s+/i;
const DISMANTLE_PLURAL = /\b(?:all|every|everything|these|those|both|each)\b|s\s*$/i;

export function parseDismantleRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || MULTI_CLAUSE.test(text)) return null;

  const verb = text.match(DISMANTLE_VERB);
  if (!verb) return null;

  let target = text.slice(verb[0].length).trim();
  while (LOCATE_LEADING_ARTICLE.test(target)) {
    target = target.replace(LOCATE_LEADING_ARTICLE, "").trim();
  }
  if (!target || target.length < 2) return null;
  // Anything that reads as more than one building goes to the model.
  if (DISMANTLE_PLURAL.test(target)) return null;

  return /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(target)
    ? { actor_id: target, target, limit: 1 }
    : { name_contains: target, target, limit: 1 };
}

/** "what can I undo", "what did you just do". */
const UNDO_HISTORY =
  /\b(?:what|anything)\b.*\bundo\b|\bundo\s+(?:history|list|stack)\b|\bwhat did you (?:just )?(?:do|change|build)\b/i;

export function parseUndoHistoryRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  // "undo" alone is the action; this is only the question about it.
  return Boolean(text) && UNDO_HISTORY.test(text) && !parseUndoRequest(text);
}
/**
 * "design me a base that makes 60 iron plates a minute".
 *
 * The verb carries the intent and nothing else has to: **design** previews,
 * **build** commits. That keeps the whole thing stateless — there is no
 * pending plan to remember between messages, and no way for a "yes" to be
 * matched against the wrong proposal.
 */
const BASE_DESIGN_VERB =
  /^(?:can you |could you |please )?(?:(design|plan|lay ?out)|(build|make|construct|spawn))(?:\s+me)?(?:\s+(?:a|an|the))?(?:\s+(?:new|whole|complete|full))?(?:\s+\d+[- ]?(?:storey|story|storeys|stories|floor|floors|level|levels|tier|tiers))?\s+(?:base|factory|setup|production(?:\s+line)?|line|module)\s+/i;

/**
 * The rate is found by its unit, and the number by being a number.
 *
 * They are matched separately because in real phrasing the item sits between
 * them: "60 iron plates a minute" puts two words where a tighter pattern would
 * expect "per". Requiring them adjacent silently failed every natural sentence
 * a player types.
 */
const BASE_PER_MINUTE = /(?:\/|\bper\b|\ba\b|\beach\b)\s*min(?:ute)?s?\b|\/\s*m\b|\bpm\b/i;
const BASE_NUMBER = /\b(\d+(?:\.\d+)?)\b/;
/** Words that describe the request rather than name the item. */
const BASE_FILLER =
  /\b(?:for|of|that|which|making|makes|produces|producing|produce|make|output|outputs|at|per|each|a|an|the|minute|minutes|min|mins|pm)\b/gi;

/** An item from the game's own catalog, matched by display name. */
function findItemByName(graph, name) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return null;
  const items = graph?.snapshot?.content?.items ?? [];
  // Exact first, then a singular/plural tolerant match. Ambiguity is treated as
  // no match: designing a whole factory around the wrong item is expensive.
  const exact = items.filter((item) => String(item.name ?? "").toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const singular = needle.replace(/s$/, "");
  const near = items.filter((item) => {
    const itemName = String(item.name ?? "").toLowerCase();
    return itemName === singular || itemName === `${singular}s`;
  });
  return near.length === 1 ? near[0] : null;
}

/**
 * The item a design request is about, matched against the real catalog.
 *
 * Tried in order: the phrase the parser carved out, then the longest catalog
 * name that appears anywhere in the request. The second exists because trailing
 * instructions defeat any amount of clause-splitting — a real request ended
 * "...120 Iron Plate per minute scan a 500m radius for terrain xyz and place
 * base accordingly" — and the catalog is the authority on what is an item name
 * anyway. Longest wins so "Reinforced Iron Plate" is not read as "Iron Plate".
 */
function resolveDesignItem(graph, design) {
  const direct = findItemByName(graph, design.item);
  if (direct) return direct;

  const haystack = String(design.raw_text ?? "").toLowerCase();
  let best = null;
  for (const item of graph?.snapshot?.content?.items ?? []) {
    const name = String(item.name ?? "").trim();
    if (name.length < 3 || !haystack.includes(name.toLowerCase())) continue;
    if (!best || name.length > best.name.length) best = item;
  }
  return best;
}

export function parseBaseDesignRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  const verb = text.match(BASE_DESIGN_VERB);
  if (!verb) return null;

  // Group 1 is the previewing verb, group 2 the committing one.
  const commit = Boolean(verb[2]);
  const body = text.slice(verb[0].length).trim();

  // Both a number and a per-minute unit are required. Without a rate there is
  // nothing to size the base against, and inventing one would be inventing the
  // whole factory — so that goes to the model, which can ask.
  const number = body.match(BASE_NUMBER);
  if (!number || !BASE_PER_MINUTE.test(body)) return null;
  const perMinute = Number(number[1]);
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null;

  // Stop at the first clause boundary before reading the item.
  //
  // A real request was "...120 iron plates a minute and place it at this
  // foundation im standing on please check terrain for collision", and the
  // item came out as that entire tail. Everything after "and" or "please" is
  // instruction about the request, not the name of a thing to produce.
  const clause = body.split(/\s+(?:and|then|also|plus|please|but)\s+/i)[0] ?? body;

  // Whatever is left once the rate and its scaffolding are removed is the item.
  //
  // This is a fallback, not the primary method. Carving the item out of the
  // sentence works until someone appends instructions without a conjunction —
  // "...120 Iron Plate per minute scan a 500m radius for terrain xyz and place
  // base accordingly" — and then the item becomes the whole tail. The caller
  // matches this against the real catalog and falls back to a catalog scan when
  // it does not resolve, which is robust to any amount of trailing prose.
  const item = clause
    .replace(BASE_NUMBER, " ")
    .replace(BASE_PER_MINUTE, " ")
    .replace(BASE_FILLER, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (item.length < 2) return null;

  // Site the base where the solver says, rather than under the player's feet.
  const atBestSite =
    /\b(?:best|ideal|optimal|good)\s+(?:location|place|spot|site)\b|\bbest place to (?:spawn|build|put)\b|\bfind (?:the )?best\b/i.test(
      text,
    );

  // Housed by default; these phrasings ask for the bare machines instead.
  const bare = /\b(?:no|without|skip)\s+(?:the\s+)?(?:building|shell|walls|roof)\b|\bjust\s+the\s+machines\b|\bmachines\s+only\b/i.test(text);
  // A storey count anywhere in the request. Multi-floor is the shape the
  // reference builds have and the efficient one: three decks in a footprint
  // instead of sprawling sideways.
  const levelsMatch = text.match(/(\d+)[- ]?(?:storey|story|storeys|stories|floor|floors|level|levels|tier|tiers)\b/i);
  const levels = levelsMatch ? Number(levelsMatch[1]) : 1;

  return {
    item,
    per_minute: perMinute,
    commit,
    bare,
    levels: Number.isInteger(levels) && levels >= 1 && levels <= 12 ? levels : 1,
    at_best_site: atBestSite,
    raw_text: text,
  };
}

/**
 * "build me a storage hub here", "put a platform on this foundation".
 *
 * A structure at the point the player is looking at, filled with whatever the
 * request names. Entirely mechanical — a position, a size, a piece to repeat —
 * which is why it was worth routing: the local model was asked for exactly this
 * and replied "Let me build this for you" while emitting nothing at all.
 *
 * "Same level as this foundation" is the hit point's own Z, not the player's.
 * Standing on a deck and aiming at it are different heights, and the difference
 * is the whole point of the request.
 */
const STRUCTURE_VERB =
  // "buld" and "biuld" are in the routing log as real typing, not
  // hypotheticals. A route that only fires on perfect spelling sends the
  // request to a model that then answers worse and costs more.
  /^(?:can you |could you |please )?(?:build|buld|biuld|make|construct|place|put|spawn)\s+(?:me\s+)?(?:a|an|the)?\s*/i;
const STRUCTURE_KIND =
  /\b(storage|warehouse|depot|container)?\s*(hub|building|platform|shed|warehouse|depot|deck|floor|structure)\b/i;
const STRUCTURE_HERE =
  // "im" without the apostrophe is the common case, not the exception, so the
  // bare "m" is an alternative rather than a typo to be tolerated. Same reason
  // as the verb list: this pattern is matched against what players type.
  /\b(?:here|at this|on this|same level|this foundation|where i(?:'m|m| am)?\s+(?:looking|standing|aiming|pointing)|what i(?:'m|m| am)?\s+(?:looking at|aiming at)|my crosshair)\b/i;

/**
 * "im switching to coal power i want something step 1 to end compact from this node".
 *
 * That request cost sixty-two seconds and a provider error because nothing
 * local claimed it. Every part of it is a lookup: the node is under the
 * crosshair, the miner and generator are in the save's catalog, the belts are
 * geometry. The only unknown is how many generators, and that is asked for
 * rather than guessed.
 */
const COAL_POWER_SUBJECT =
  /\b(?:coal\s*(?:power|gen(?:erator)?s?|burner)|(?:switch(?:ing)?|swap(?:ping)?)\s+to\s+coal)\b/i;
const COAL_POWER_INTENT =
  /\b(?:build|buld|biuld|make|set\s*up|setup|want|need|switch(?:ing)?|give|run|start|design|plan)\b/i;
const COAL_POWER_COUNT = /\b(\d{1,2})\s*(?:x\s*)?(?:coal\s*)?gen(?:erator)?s?\b/i;
const COAL_POWER_SOURCE =
  /\b(?:this|that|the)\s+(?:node|one|coal|deposit|resource)|\bfrom\s+(?:this|here)|\bhere\b/i;

export function parseCoalPowerRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  if (!COAL_POWER_SUBJECT.test(text)) return null;
  // A question about coal power is not a request to build one.
  if (/^(?:what|which|how much|how many|why|is|are|does|do|can)\b/i.test(text)) return null;
  const count = text.match(COAL_POWER_COUNT);
  // "coal power here with 4 generators" carries no verb, but naming a count is
  // not something anyone does idly — it is the request.
  if (!COAL_POWER_INTENT.test(text) && !count && !COAL_POWER_SOURCE.test(text)) return null;
  return {
    generator_count: count ? Number(count[1]) : null,
    // Without a source the player means wherever they are looking, which is
    // what they were doing when they asked.
    at_aim: true,
    named_source: COAL_POWER_SOURCE.test(text),
  };
}

export function parseStructureRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || !STRUCTURE_VERB.test(text)) return null;
  const kind = text.match(STRUCTURE_KIND);
  if (!kind) return null;
  // Without a "here" the request is about a factory, not a building, and the
  // production planner should own it.
  if (!STRUCTURE_HERE.test(text)) return null;

  const sizeMatch = text.match(/\b(\d+)\s*(?:x|by)\s*(\d+)\b/i);
  const fill = /\bstorage|container|warehouse|depot\b/i.test(text) ? "storage" : null;

  return {
    fills_with: fill,
    width_cells: sizeMatch ? Number(sizeMatch[1]) : null,
    depth_cells: sizeMatch ? Number(sizeMatch[2]) : null,
    at_aim: /\b(?:here|looking|aiming|this foundation|at this|on this|same level)\b/i.test(text),
  };
}

export function parseWaypointRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;

  let target = null;
  const alt = text.match(WAYPOINT_ALT);
  if (alt) target = alt[1].trim();
  else if (WAYPOINT_VERB.test(text)) target = text.replace(WAYPOINT_VERB, "").trim();
  if (!target) return null;

  // "the best hub location" is not a name to look up — it is the site solver's
  // output, which is already computed locally.
  if (WAYPOINT_BEST_SITE.test(target)) return { kind: "best_site", target };

  while (LOCATE_LEADING_ARTICLE.test(target)) {
    target = target.replace(LOCATE_LEADING_ARTICLE, "").trim();
  }
  if (target.length < 2) return null;

  return {
    kind: "named",
    target,
    lookup: /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(target)
      ? { actor_id: target, target }
      : { name_contains: target, target },
  };
}

/**
 * "undo", "undo that", "revert that".
 *
 * Nothing follows it and nothing modifies it, so anything past the verb other
 * than filler means something else was asked and the model should handle it.
 */
const UNDO_VERB = /^(?:undo|revert|rewind|take that back|put it back)\b/i;

export function parseUndoRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!UNDO_VERB.test(text)) return false;
  const residue = text.replace(UNDO_VERB, "").trim().toLowerCase();
  const words = residue.split(/\s+/).filter(Boolean);
  const allowed = new Set(["that", "it", "the", "last", "one", "thing", "please", "action", "build"]);
  return words.every((word) => allowed.has(word));
}

/** "teleport me to the pure iron node", "tp to BP_ResourceNode217". */
const TELEPORT_VERB =
  /^(?:can you |could you |please )?(?:teleport|tp|warp|take|send|move|bring)\s+(?:me\s+)?(?:back\s+)?(?:to|over to)\s+/i;

export function parseTeleportRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || MULTI_CLAUSE.test(text)) return null;

  const verb = text.match(TELEPORT_VERB);
  if (!verb) return null;

  let target = text.slice(verb[0].length).trim();

  // "teleport me to the best hub location" is the site solver's answer, not a
  // name to look up — the same case `parseWaypointRequest` already handles.
  //
  // Without this it reached a model, which answered from the snapshot without
  // calling `find_best_site`, so the grounding gate withheld the draft and the
  // whole request fell through to the paid tier. Every part of it is
  // deterministic: score the sites, take the winner, move there.
  if (WAYPOINT_BEST_SITE.test(target)) return { kind: "best_site", target };

  while (LOCATE_LEADING_ARTICLE.test(target)) {
    target = target.replace(LOCATE_LEADING_ARTICLE, "").trim();
  }
  // A raw coordinate is not a name, and deserves the plausibility conversation
  // the model gives it, so those still go to the model.
  if (!target || target.length < 2 || /[=,]|\d{4,}/.test(target)) return null;

  return /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(target)
    ? { actor_id: target, target, limit: 1 }
    : { name_contains: target, target, limit: 1 };
}

/**
 * "place a mk1 miner on this node facing north".
 *
 * There is nothing to reason about here: the building is named, the target is
 * whatever the player is aiming at, and the facing is a compass word. Every
 * part is a lookup. This was costing half a dollar a go.
 *
 * Compound requests, blueprints, and anything with a quantity or a layout are
 * deliberately excluded — those are the cases where the model earns its keep.
 */
const PLACE_VERB = /^(?:can you |could you |please )?(?:place|build|put|drop|spawn|construct|stick)\s+/i;
const PLACE_PREPOSITION = /\s+(?:on|onto|at|over|in)\s+/i;
const PLACE_FACING = /\s+(?:facing|pointing|oriented|rotated(?:\s+to)?)\s+([a-z0-9.\s-]+?)\s*$/i;
const PLACE_EXCLUDED = /\b(?:blueprint|module|layout|factory|line|belt\s+from|and|then|also|plus)\b/i;
const PLACE_AIM_TARGET = /^(?:this|that|it|the)?\s*(?:node|one|thing|spot|resource|deposit)?$/i;
const PLACE_HERE = /^(?:here|my (?:feet|position|spot)|where i am(?: standing)?)$/i;

/**
 * Yaw for a compass word.
 *
 * Unreal's yaw is measured about +X, so 0 is +X and yaw increases toward +Y.
 * Which world axis the game's compass calls north is a separate question, and
 * the one number below is where that lives — the reply always states the yaw it
 * used so a wrong convention shows up immediately rather than silently.
 */
const NORTH_IS_YAW_DEGREES = 0;
const COMPASS = {
  north: 0, n: 0, northeast: 45, ne: 45, east: 90, e: 90, southeast: 135, se: 135,
  south: 180, s: 180, southwest: 225, sw: 225, west: 270, w: 270, northwest: 315, nw: 315,
};

function parseFacing(text) {
  const cleaned = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (cleaned in COMPASS) {
    return { yaw: (COMPASS[cleaned] + NORTH_IS_YAW_DEGREES) % 360, described: cleaned };
  }
  const degrees = cleaned.match(/^(-?\d+(?:\.\d+)?)(?:deg|degrees|°)?$/);
  if (degrees) {
    return { yaw: ((Number(degrees[1]) % 360) + 360) % 360, described: `${degrees[1]}°` };
  }
  return null;
}

export function parsePlaceRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || !PLACE_VERB.test(text) || PLACE_EXCLUDED.test(text)) return null;

  let body = text.replace(PLACE_VERB, "").trim();

  // Facing is stripped first so it cannot be mistaken for part of the target.
  let facing = null;
  const facingMatch = body.match(PLACE_FACING);
  if (facingMatch) {
    facing = parseFacing(facingMatch[1]);
    if (!facing) return null; // A facing we cannot read is not one to ignore.
    body = body.slice(0, facingMatch.index).trim();
  }

  // "build a smelter here" names its target without a preposition.
  const bareHere = body.match(/^(.*?)\s+(here|at my feet|where i am(?: standing)?)$/i);

  const split = body.split(PLACE_PREPOSITION);
  if (split.length < 2 && !bareHere) return null;
  const building = (bareHere ? bareHere[1] : split[0]).trim();
  const target = bareHere ? bareHere[2].trim() : split.slice(1).join(" ").trim();
  if (!building || !target) return null;

  // A count means several buildings and a layout, which is a design question.
  if (/^\d|\b(?:two|three|four|five|couple|few)\b/i.test(building)) return null;

  if (PLACE_HERE.test(target)) return { building, target: { kind: "here" }, facing };
  if (PLACE_AIM_TARGET.test(target)) return { building, target: { kind: "aim" }, facing };
  return {
    building,
    target: {
      kind: "named",
      lookup: /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(target)
        ? { actor_id: target, target }
        : { name_contains: target, target },
    },
    facing,
  };
}

/**
 * A deliberately narrow, fully deterministic conveyor write.
 *
 * "Nearest" alone is not safe: two adjacent ports can carry unrelated items.
 * Requiring the player to say compatible makes the contract explicit, and the
 * solver then proves compatibility from the machines' captured current recipes
 * (or an extractor's captured resource node). The Mk.1 tier is also explicit so
 * this route never silently chooses a belt tier.
 */
const NEAREST_COMPATIBLE_BELT =
  /^(?:can you |could you |please )?(?:connect|link|join|belt)\s+(?:the\s+)?(?:nearest|closest)\s+(?:(?:recipe[- ]compatible|compatible)\s+)(?:(?:currently\s+)?(?:unconnected|free)\s+)?(?:(?:production|factory)\s+)?(?:machines?|machine\s+pair|pair)(?:\s+(?:near|around)\s+me)?(?:\s+within\s+(\d+)\s*(?:m|meters|metres))?\s+(?:with|using)\s+(?:a\s+|an\s+)?(?:mk\.?\s*1|mark\s*1)\s+(?:conveyor\s+)?belt$/i;

export function parseNearestCompatibleBeltRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(NEAREST_COMPATIBLE_BELT);
  if (!match) return null;
  return { radius_m: match[1] ? Number.parseInt(match[1], 10) : 100 };
}

const TEMPORARY_FREE_BELT_TEST =
  /^temporarily\s+connect\s+the\s+nearest\s+free\s+output\s+to\s+(?:the\s+)?nearest\s+free\s+input\s+within\s+(\d+)\s*(?:m|meters|metres)\s+using\s+(?:a\s+)?(?:mk\.?\s*1|mark\s*1)\s+(?:conveyor\s+)?belt\s+for\s+(?:a\s+)?live\s+(?:belt\s+)?test$/i;

export function parseTemporaryFreeBeltTestRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(TEMPORARY_FREE_BELT_TEST);
  if (!match) return null;
  return { radius_m: Number.parseInt(match[1], 10) };
}

function formatFactorySummary(result) {
  const kindCounts = new Map((result.actor_kinds ?? []).map((entry) => [entry.kind, entry.count]));
  const playerCount = kindCounts.get("player") ?? 0;
  const parts = [
    `Captured factory census at world revision **${result.world_revision ?? "unknown"}**: ` +
      `**${result.captured_actor_count ?? 0} actors** — ` +
      `${kindCounts.get("buildable") ?? 0} buildables, ` +
      `${kindCounts.get("resource_node") ?? 0} resource nodes, ` +
      `${kindCounts.get("item_pickup") ?? 0} item pickups, and ` +
      `${playerCount} ${playerCount === 1 ? "player" : "players"}.`,
  ];

  const statuses = Object.entries(result.production?.status_counts ?? {});
  if ((result.production?.machine_count ?? 0) > 0) {
    parts.push(
      `Production-capable machines: **${result.production.machine_count}** ` +
        `(${result.production.with_recipe_count} with a captured recipe). ` +
        `States: ${statuses.map(([status, count]) => `${status} ${count}`).join(", ") || "unknown"}.`,
    );
  }

  if ((result.buildable_types ?? []).length > 0) {
    parts.push(
      `Most common captured buildables:\n${result.buildable_types
        .slice(0, 12)
        .map((entry) => `- **${entry.class_name}**: ${entry.count} (${entry.owner_mod})`)
        .join("\n")}`,
    );
  }

  if ((result.transports ?? []).length > 0) {
    parts.push(
      `Transport actors: ${result.transports.map((entry) => `${entry.kind} ${entry.count}`).join(", ")}.`,
    );
  }
  if ((result.resources ?? []).length > 0) {
    parts.push(
      `Captured resources: ${result.resources
        .map((entry) => `${entry.resource_name} ${entry.count} (${entry.open_for_miner_count} open)`)
        .join(", ")}.`,
    );
  }
  if ((result.owner_mods ?? []).length > 0) {
    parts.push(
      `Actor ownership: ${result.owner_mods
        .map((entry) => `${entry.owner_mod} ${entry.count}`)
        .join(", ")}.`,
    );
  }
  parts.push(...(result.capture_scope?.notes ?? []));
  return parts.join("\n\n");
}

/**
 * Resolve the two explicitly named live actors in a plan_belt_route request.
 *
 * This is intentionally stricter than natural-language target resolution: the
 * player named the deterministic tool, so two captured instance names are the
 * complete contract. Anything ambiguous or compound still falls through.
 */
export function parseExactBeltSolverRequest(question, graph) {
  const text = String(question ?? "");
  const lowered = text.toLowerCase();
  if (!lowered.includes("plan_belt_route")) return null;

  const mentioned = [];
  for (const node of graph?.nodes?.values?.() ?? []) {
    const aliases = new Set([
      String(node?.raw?.name ?? "").trim(),
      String(node?.actor_id ?? "").split(/[.:]/).pop().trim(),
    ]);
    let first = -1;
    for (const alias of aliases) {
      if (!alias) continue;
      const candidate = alias.toLowerCase();
      let offset = lowered.indexOf(candidate);
      while (offset >= 0) {
        const before = lowered[offset - 1] ?? " ";
        const after = lowered[offset + candidate.length] ?? " ";
        if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) {
          first = first < 0 ? offset : Math.min(first, offset);
          break;
        }
        offset = lowered.indexOf(candidate, offset + 1);
      }
    }
    if (first >= 0) mentioned.push({ actor_id: node.actor_id, index: first });
  }

  if (mentioned.length !== 2) return null;
  mentioned.sort((a, b) => a.index - b.index || String(a.actor_id).localeCompare(String(b.actor_id)));
  return {
    from_actor_id: mentioned[0].actor_id,
    to_actor_id: mentioned[1].actor_id,
  };
}

/**
 * A read-only request for the complete set of captured, compatible free pairs.
 *
 * Requiring all four ideas keeps this away from write requests: list/find/show,
 * every/all, pair(s), and free/unconnected conveyor/belt endpoints.
 */
export function parseBeltCandidateListRequest(question) {
  const text = String(question ?? "").trim();
  if (!/\b(?:list|show|find)\b/i.test(text)) return null;
  if (!/\b(?:every|all)\b/i.test(text)) return null;
  if (!/\bpairs?\b/i.test(text)) return null;
  if (!/\b(?:free|unconnected)\b/i.test(text)) return null;
  if (!/\b(?:belt|belted|conveyor)\b/i.test(text)) return null;

  const radius = /\bwithin\s+(\d+)\s*(?:m|meters|metres)\b/i.exec(text);
  const compatibility = /\b(?:recipe[- ]compatible|compatible)\b/i.test(text) ? "proven" : "any";
  return {
    radius_m: radius ? Number.parseInt(radius[1], 10) : null,
    limit: 100,
    compatibility,
  };
}

function formatBeltCandidates(result) {
  if (result.reason) {
    return `I could not inspect compatible free belt pairs: ${result.reason}.`;
  }

  const candidates = result.candidates ?? [];
  const scope = result.radius_m === null
    ? "across captured buildable endpoints"
    : `within ${result.radius_m} m of the captured player position`;
  if (candidates.length === 0) {
    const kind = result.compatibility_filter === "proven"
      ? "recipe-compatible pair"
      : "geometrically routable pair";
    return (
      `No ${kind} of free conveyor ports was found ${scope}. ` +
      `${result.examined_endpoint_actors ?? 0} captured endpoint actor(s) were checked.`
    );
  }

  const resultKind = result.compatibility_filter === "proven"
    ? "recipe-compatible free belt pair(s)"
    : "geometrically routable free belt pair(s)";
  const lines = [
    `**${result.candidate_count} ${resultKind}** found ${scope}, shortest first:`,
    ...candidates.map((candidate, index) => {
      const shape = candidate.straight ? "straight" : "requires a bend";
      const compatibility = candidate.compatibility === "proven"
        ? `compatibility **proven** for ${(candidate.compatible_items ?? []).join(" / ")}`
        : candidate.compatibility === "incompatible"
          ? `compatibility **incompatible**: source outputs ${(candidate.source_output_items ?? []).join(" / ")}; ` +
            `target accepts ${(candidate.target_input_items ?? []).join(" / ")}`
          : `compatibility **unknown** (${(candidate.missing_compatibility_evidence ?? []).join(", ")})`;
      return (
        `${index + 1}. **${candidate.from.name}** → **${candidate.to.name}** — ` +
        `${candidate.length_meters} m, ${shape}; ${compatibility}. ` +
        `Endpoints: \`${candidate.from.connector}\` → \`${candidate.to.connector}\`.`
      );
    }),
  ];
  if (result.compatibility_filter !== "proven") {
    const counts = result.compatibility_counts ?? {};
    lines.splice(
      1,
      0,
      `Compatibility evidence: proven ${counts.proven ?? 0}, incompatible ${counts.incompatible ?? 0}, unknown ${counts.unknown ?? 0}.`,
    );
  }
  if (result.truncated) {
    lines.push(
      `Only ${result.returned_candidate_count} of ${result.candidate_count} candidates are shown; the rest remain unlisted.`,
    );
  }
  if ((result.actors_without_recipe_or_resource_evidence ?? 0) > 0) {
    lines.push(
      `${result.actors_without_recipe_or_resource_evidence} captured endpoint actor(s) lack current recipe or extractor-resource evidence; any candidate involving them is labeled unknown rather than guessed compatible.`,
    );
  }
  lines.push(result.unverified);
  return lines.join("\n\n");
}

function capturedUnlockedMk1BeltRecipe(graph) {
  if (graph?.snapshot?.content?.availability_known !== true) {
    return {
      recipe_class: null,
      reason: "the snapshot did not prove live recipe availability",
      missing: "content.availability_known",
    };
  }

  const candidates = [];
  for (const [classPath, recipe] of graph?.recipesByClass ?? []) {
    const short = String(classPath).split(".").pop();
    if (short === "Recipe_ConveyorBeltMk1_C" && recipe?.available === true) {
      candidates.push(String(recipe.class_path ?? classPath));
    }
  }
  if (candidates.length !== 1) {
    return {
      recipe_class: null,
      reason:
        candidates.length === 0
          ? "the captured catalog did not contain an unlocked Mk.1 conveyor belt build recipe"
          : "more than one unlocked Mk.1 conveyor belt recipe matched, so the choice is ambiguous",
      candidates,
    };
  }
  return { recipe_class: candidates[0] };
}

/**
 * "insert biomass into my inventory", "give me 50 iron plate", "spawn 20 coal".
 *
 * The player asked for exactly this and got a refusal, because no give action
 * existed. Now that it does, the request is a name and a number — the item is
 * checked against the game's own catalog by the validator, so nothing here has
 * to know what a Biomass is.
 */
const GIVE_VERB =
  /^(?:can you |could you |please )?(?:give|add|insert|put|spawn|grant|hand)\s+(?:me\s+)?/i;
const GIVE_DESTINATION =
  /\s+(?:in|into|to)\s+(?:my|the)\s+(?:inventory|inv|pockets|bag)\s*$/i;
const GIVE_TRAILING = /\s+(?:please|now|for me)\s*$/i;

export function parseGiveRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || MULTI_CLAUSE.test(text)) return null;

  const verb = text.match(GIVE_VERB);
  if (!verb) return null;

  let body = text.slice(verb[0].length).replace(GIVE_DESTINATION, "").replace(GIVE_TRAILING, "").trim();
  if (!body) return null;

  // A leading count is the common phrasing ("50 biomass"); a trailing one is
  // not, and "x50" shows up often enough to be worth reading.
  let count = 1;
  const leading = body.match(/^(\d+)\s*x?\s+(.+)$/i);
  const trailing = body.match(/^(.+?)\s+x?\s*(\d+)$/i);
  if (leading) {
    count = Number(leading[1]);
    body = leading[2].trim();
  } else if (trailing) {
    count = Number(trailing[2]);
    body = trailing[1].trim();
  }

  body = body.replace(/^(?:a|an|some|the)\s+/i, "").trim();
  if (!body || body.length < 2 || !Number.isFinite(count) || count <= 0) return null;

  // A stack count is a real request; anything with punctuation or arithmetic in
  // it is not something to guess at.
  if (/[=,;:]/.test(body)) return null;

  return { item: body, count };
}

export function parseLocateRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  if (LOCATE_DISQUALIFIER.test(text)) return null;
  if (MULTI_CLAUSE.test(text)) return null;

  const verb = text.match(LOCATE_VERB);
  if (!verb) return null;

  let target = text.slice(verb[0].length).trim();
  // "nearest"/"the" carry no search value; the solver already sorts by distance.
  while (LOCATE_LEADING_ARTICLE.test(target)) {
    target = target.replace(LOCATE_LEADING_ARTICLE, "").trim();
  }
  if (!target || target.length < 2) return null;

  // An exact actor name is worth matching as an id; anything else is a substring.
  return /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(target)
    ? { actor_id: target, target }
    : { name_contains: target, target };
}

function formatLocate(result, target) {
  const matches = result?.matches ?? [];
  if (!matches.length) {
    return `Nothing in the snapshot matches **${target}**. ${
      result?.searched ?? "The complete snapshot was searched"
    }.`;
  }
  const lines = matches.slice(0, 6).map((m) => {
    const at = `\`x=${round(m.location_cm?.x ?? 0)}, y=${round(m.location_cm?.y ?? 0)}, z=${round(m.location_cm?.z ?? 0)}\``;
    const parts = [`**${m.name ?? m.actor_id}** — ${at}`];
    if (m.distance_meters !== undefined) parts.push(`${round(m.distance_meters)} m away`);
    if (m.purity) parts.push(m.purity);
    if (m.can_host_a_miner === true) parts.push("a miner can be built here");
    if (m.can_host_a_miner === false) parts.push(`no miner: ${m.why_not}`);
    return `- ${parts.join(" · ")}`;
  });
  if (matches.length > lines.length) {
    lines.push("", `${matches.length - lines.length} further match(es) not listed.`);
  }
  return lines.join("\n");
}

/* ---------------- nearby resource nodes ---------------- */

/**
 * "What resource nodes are near me?"
 *
 * This is intentionally separate from `parseLocateRequest`: the target is not
 * one named actor, it is an ordered slice of every captured resource node.
 * With no stated radius we report the nearest eight instead of inventing what
 * "near" means. With a radius we apply exactly the distance the player gave.
 */
const NEARBY_RESOURCE_PREFIX =
  /^(?:can you |could you |please )?(?:(?:what|which)\s+(?:resource\s+nodes?|resources?)(?:\s+are)?|list(?:\s+me)?(?:\s+the)?\s+(?:resource\s+nodes?|resources?))\s+/i;
const NEARBY_RESOURCE_POSITION = /^(?:near(?:by)?|around|close\s+to)\s+(?:me|my\s+(?:position|location))(?:\s+(?:with)?in\s+(\d+)\s*(?:m|meters|metres))?$/i;
const NEARBY_RESOURCE_RADIUS = /^(?:with)?in\s+(\d+)\s*(?:m|meters|metres)\s+(?:of\s+)?(?:me|my\s+(?:position|location))$/i;

export function parseNearbyResourceRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || MULTI_CLAUSE.test(text)) return null;

  const prefix = text.match(NEARBY_RESOURCE_PREFIX);
  if (!prefix) return null;

  const position = text.slice(prefix[0].length).trim().match(NEARBY_RESOURCE_POSITION);
  const radius = position ?? text.slice(prefix[0].length).trim().match(NEARBY_RESOURCE_RADIUS);
  if (!radius) return null;

  return {
    radius_m: radius[1] ? Number.parseInt(radius[1], 10) : null,
    limit: 8,
  };
}

function formatNearbyResources(graph, request) {
  // Actor lookup already computes exact 3D distance from the captured pawn and
  // sorts by it. Ask for the full resource slice so hand-mined deposits can be
  // excluded without hiding a real node that happens to be just behind one.
  const result = solveActorLookup(graph, {
    kind: "resource_node",
    limit: Math.max(1, graph?.nodes?.size ?? 1),
  });
  const resourceNodes = (result?.matches ?? []).filter((match) => match.node_type !== "Deposit");
  const ranked = resourceNodes.filter((match) => Number.isFinite(match.distance_meters));

  if (resourceNodes.length > 0 && ranked.length === 0) {
    return (
      "I cannot rank nearby resource nodes because the snapshot is missing " +
      "`interaction_context.player.pawn_location` (and no captured player actor supplied a location)."
    );
  }

  const inScope = request.radius_m == null
    ? ranked
    : ranked.filter((match) => match.distance_meters <= request.radius_m);
  const shown = inScope.slice(0, request.limit);

  const scope = [];
  const rawScanRadius = graph?.snapshot?.world?.scan_radius_meters;
  const scanRadius = Number(rawScanRadius);
  if (rawScanRadius != null && Number.isFinite(scanRadius) && scanRadius >= 0) {
    scope.push(`The snapshot itself was limited to ${round(scanRadius)} m around its scan centre.`);
  }
  if (graph?.snapshot?.completeness?.actor_limit_reached === true) {
    scope.push("The capture hit its actor limit, so nodes beyond the captured set may be missing.");
  }

  if (shown.length === 0) {
    const headline = request.radius_m == null
      ? "No mineable resource nodes were present in the captured snapshot."
      : `No captured mineable resource node is within **${request.radius_m} m** of your exact position.`;
    return [headline, ...scope].join(" ");
  }

  const headline = request.radius_m == null
    ? `Nearest captured resource nodes to your exact position (showing ${shown.length} of ${inScope.length}):`
    : `Captured resource nodes within **${request.radius_m} m** of your exact position (showing ${shown.length} of ${inScope.length}):`;
  const lines = shown.map((match) => {
    const location = match.location_cm ?? {};
    const availability = match.can_host_a_miner === true
      ? "open for a miner"
      : match.occupied === true
        ? "occupied"
        : "miner eligibility unknown";
    return (
      `- **${match.resource_name ?? "Unknown resource"}** — ${round(match.distance_meters)} m · ` +
      `${match.purity ?? "unknown purity"} · ${availability} · ` +
      `\`${match.name ?? match.actor_id}\` at ` +
      `\`x=${round(location.x)}, y=${round(location.y)}, z=${round(location.z)}\``
    );
  });

  return [headline, ...lines, ...scope].join("\n");
}

const ROUTES = [
  {
    name: "get_factory_summary",
    patterns: [
      "what is in this factory", "what s in this factory", "what is in my factory",
      "what s in my factory", "factory summary", "factory overview", "factory census",
      "summarize my factory", "summarise my factory", "what have i built",
      "what buildings do i have",
    ],
    extraFiller: ["current", "captured", "base", "buildings", "overview", "summary", "census"],
    run: (graph) => solveFactorySummary(graph),
    format: formatFactorySummary,
  },
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
      "unlock status", "how many recipes are available", "how many recipes", "what tier", "my progress",
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
 * Why a question was not answered locally.
 *
 * Routing was tuned against phrasings I invented, which is how a session went
 * by with every question paid: the routes were fine, the guesses about how the
 * player actually types were not. This reports the near miss — which route was
 * one word away, and which word blocked it — so the logged misses can be read
 * later and turned into patterns. It costs nothing and runs only on the paid
 * path, where a few microseconds are already lost in the noise.
 */
export function explainRoutingMiss(question) {
  const normalized = normalize(question);
  if (!normalized) return "empty question";

  const candidates = [];
  for (const route of ROUTES) {
    for (const pattern of route.patterns) {
      if (normalized.includes(pattern)) candidates.push({ route, pattern });
    }
  }
  if (candidates.length === 0) return "no route pattern matched";

  const distinctRoutes = new Set(candidates.map((entry) => entry.route.name));
  if (distinctRoutes.size > 1) {
    return `compound question spanning ${[...distinctRoutes].join(" + ")}`;
  }

  candidates.sort((a, b) => b.pattern.length - a.pattern.length);
  const { route, pattern } = candidates[0];
  const consumed = new Set(normalize([pattern, ...(route.extraFiller ?? [])].join(" ")).split(" "));
  const leftover = normalized
    .split(" ")
    .filter((word) => word && !consumed.has(word) && !FILLER.has(word));
  return `${route.name} matched "${pattern}" but left: ${leftover.join(", ")}`;
}

/**
 * Answers locally when a single solver covers the question.
 *
 * Returns null when it does not — the caller then falls through to the model,
 * which is always the safe direction to fail.
 */
export function answerLocally(question, graph, services) {
  // Cheapest possible check first: input that cannot mean anything never
  // reaches a model.
  if (isUnactionableInput(question)) {
    return localAnswer(
      clarificationReply(),
      "clarify",
      Date.now(),
      "The input carried no actionable content, so no model was consulted.",
    );
  }

  // "List every pair with free conveyor ports" is a read-only census. The
  // routing solver already has the complete captured graph, so a model adds no
  // information and must not be allowed to infer item compatibility from names.
  const beltCandidateRequest = parseBeltCandidateListRequest(question);
  if (beltCandidateRequest && graph) {
    const started = Date.now();
    const candidates = solveCompatibleBeltCandidates(graph, beltCandidateRequest);
    return localAnswer(
      formatBeltCandidates(candidates),
      "find_belt_candidates",
      started,
      "Free ports, current recipes, extractor resources and connector spans were read from the captured graph; no action was emitted.",
    );
  }

  // A named deterministic tool plus two exact captured instances needs no
  // language model. The live local model took 128 seconds to narrate this call
  // and turned a zero-length refusal into "valid and direct". Dispatching the
  // solver here is both faster and the only way to preserve its polarity.
  const exactBelt = parseExactBeltSolverRequest(question, graph);
  if (exactBelt) {
    const started = Date.now();
    const route = solveBeltRoute(graph, exactBelt);
    const fromName = route.from?.name ?? exactBelt.from_actor_id;
    const toName = route.to?.name ?? exactBelt.to_actor_id;
    const endpoints =
      route.from?.connector && route.to?.connector
        ? ` Exact endpoints: \`${route.from.connector}\` → \`${route.to.connector}\`.`
        : "";

    if (!route.routed) {
      return localAnswer(
        `I did not find a usable belt span from **${fromName}** to **${toName}**: ` +
          `${route.reason}.${endpoints} No game action was emitted.`,
        "plan_belt_route",
        started,
        "The requested deterministic solver ran directly; its refusal was preserved without model interpretation.",
      );
    }

    const shape = route.straight ? "straight" : "bent";
    const notes = route.notes?.length ? ` ${route.notes.join(" ")}` : "";
    return localAnswer(
      `The captured free connectors give a **${route.length_meters} m ${shape} belt proposal** ` +
        `from **${fromName}** to **${toName}**.${endpoints}${notes} ${route.unverified}`,
      "plan_belt_route",
      started,
      "The two exact captured actors uniquely selected one deterministic belt-route solver call.",
    );
  }

  // "give me 50 biomass" is a catalog lookup and a number. The validator
  // resolves the item name against the game's own 2,405-entry item catalog and
  // refuses anything that is not in it, so there is nothing here for a model to
  // decide — and an unknown name falls through to one rather than being denied.
  const give = parseGiveRequest(question);
  if (give) {
    const started = Date.now();
    const plan = emitValidatedPlan(graph, services, [
      { action: "give_item", item_name: give.item, count: give.count, commit: true },
    ]);
    if (plan) {
      const [action] = plan.actions;
      const name = plan.steps?.[0]?.checks?.item_name ?? give.item;
      return localAnswer(
        `Adding **${action.count} × ${name}** to your inventory. ` +
          "The mod reports how many actually fitted; say \"undo\" to take them back.",
        "give_item",
        started,
        "The item was resolved from the game's own catalog; the count was stated.",
      );
    }
    // The item did not resolve. Ambiguity is the common case and the validator
    // already knows the candidates, so ask here rather than falling through:
    // "give me 64 biofuel" matches five items in a modded save, and handing
    // that to a model cost 33 seconds and returned nothing. Naming the
    // candidates instantly is both cheaper and more useful, and picking one
    // would be a guess about which fuel the player meant.
    const rejection = validatePlan(graph, [
      { action: "give_item", item_name: give.item, count: give.count, commit: true },
    ]).rejected?.[0];
    const candidates = rejection?.closest ?? [];
    if (rejection?.reason === "no_such_item" && candidates.length > 0) {
      return localAnswer(
        `**"${give.item}"** matches ${candidates.length} items, so I have not guessed:\n\n` +
          candidates.map((name) => `- ${name}`).join("\n") +
          `\n\nSay the full name — for example "give me ${give.count} ${candidates[0]}".`,
        "give_item_ambiguous",
        started,
        "The catalog had several matches; choosing one would be a guess.",
      );
    }
    // Anything else — a refused count, an item that genuinely does not exist —
    // still goes to the model, which can ask or correct a spelling.
  }

  // "Connect the nearest compatible machines with a Mk.1 belt" is fully
  // determined by captured recipes, free connector state, player position and
  // the game's captured unlock state. Keeping it local is not just cheaper: it
  // means a hosted-provider outage cannot prevent a precisely specified write.
  const nearestBelt = parseNearestCompatibleBeltRequest(question);
  if (nearestBelt) {
    const started = Date.now();
    const recipe = capturedUnlockedMk1BeltRecipe(graph);
    if (!recipe.recipe_class) {
      return localAnswer(
        `I did not place a belt: ${recipe.reason}.`,
        "place_belt",
        started,
        "The requested tier was explicit, but its live unlock could not be proven.",
      );
    }

    const route = solveNearestCompatibleBeltRoute(graph, nearestBelt);
    if (!route.routed) {
      return localAnswer(
        `I did not place a belt: ${route.reason}. ` +
          "No endpoint or item compatibility was guessed.",
        "place_belt",
        started,
        "The compatible endpoint search was completed from the authoritative snapshot.",
      );
    }

    const plan = emitValidatedPlan(graph, services, [
      {
        action: "place_belt",
        recipe_class: recipe.recipe_class,
        from_component: route.from.connector,
        to_component: route.to.connector,
        commit: true,
      },
    ]);
    if (!plan) {
      return localAnswer(
        "I found exact compatible endpoints, but the action contract refused the plan, so nothing was emitted.",
        "place_belt",
        started,
        "The route was exact; the shared action validator retained final authority.",
      );
    }

    return localAnswer(
      `Connecting **${route.from.name}** to **${route.to.name}** with an unlocked Mk.1 belt ` +
        `for **${route.compatible_items.join(" / ")}** (${route.length_meters} m). ` +
        `Exact endpoints: \`${route.from.connector}\` → \`${route.to.connector}\`. ` +
        "The game hologram still owns bend, incline, clearance, length and cost; its readback reports what actually happened.",
      "place_belt",
      started,
      "Current recipes proved item compatibility; the solver chose the shortest free connector pair near the player.",
    );
  }

  // An explicit temporary geometry test may use a pair whose item
  // compatibility is unknown, but never one the captured recipes prove wrong.
  // It is a separate phrase so the safe compatible production route above can
  // never silently degrade into this behaviour.
  const temporaryBelt = parseTemporaryFreeBeltTestRequest(question);
  if (temporaryBelt) {
    const started = Date.now();
    const recipe = capturedUnlockedMk1BeltRecipe(graph);
    if (!recipe.recipe_class) {
      return localAnswer(
        `I did not run the temporary belt test: ${recipe.reason}.`,
        "place_belt_live_test",
        started,
        "The requested belt tier must be proven unlocked even for a temporary test.",
      );
    }

    const route = solveTemporaryFreeBeltRoute(graph, temporaryBelt);
    if (!route.routed) {
      return localAnswer(
        `I did not run the temporary belt test: ${route.reason}.`,
        "place_belt_live_test",
        started,
        "Known-incompatible pairs are refused; unknown compatibility is allowed only by this explicit test phrase.",
      );
    }

    const plan = emitValidatedPlan(graph, services, [
      {
        action: "place_belt",
        recipe_class: recipe.recipe_class,
        from_component: route.from.connector,
        to_component: route.to.connector,
        commit: true,
      },
    ]);
    if (!plan) {
      return localAnswer(
        "I found exact free endpoints, but the action contract refused the temporary plan, so nothing was emitted.",
        "place_belt_live_test",
        started,
        "The shared action validator retained final authority.",
      );
    }

    const compatibility =
      route.compatibility === "proven"
        ? `Recipe compatibility is proven for **${route.compatible_items.join(" / ")}**.`
        : `Item compatibility is **unknown** because the snapshot lacks: ${route.missing_compatibility_evidence.join(", ")}.`;
    return localAnswer(
      `Temporary live test: connecting **${route.from.name}** to **${route.to.name}** ` +
        `with a Mk.1 belt (${route.length_meters} m). ${compatibility} ` +
        `Exact endpoints: \`${route.from.connector}\` → \`${route.to.connector}\`. ` +
        "The game hologram owns every geometry/cost check; say \"undo\" after verifying the readback.",
      "place_belt_live_test",
      started,
      "The player explicitly requested a temporary physical test; proven-incompatible pairs were excluded.",
    );
  }

  // Display actions need no model: the game resolves their exact targets and
  // the shared validator applies the same write/dry-run policy as every tool.
  if (parseClearWaypointRequest(question)) {
    // Saved map markers are writes, so an explicit clear request is committed
    // here and still remains gated by the mod. Preserve the explicit `all`
    // intent all the way to the game instead of relying on an empty filter.
    const action = { action: "clear_waypoints", all: true, commit: true };
    if (!emitValidatedPlan(graph, services, [action])) return null;
    return localAnswer(
      "Clearing the map waypoints created by AI Factory Copilot.",
      "clear_waypoints",
      Date.now(),
      "The command targets only the copilot's own waypoint category.",
    );
  }

  const clear = parseClearRequest(question);
  if (clear) {
    const action = { action: "clear_highlight", all: true, commit: true };
    if (!emitValidatedPlan(graph, services, [action])) return null;
    return localAnswer(
      "Clearing every overlay.",
      "clear_highlight",
      Date.now(),
      "An overlay request is a filter, not a question — nothing to reason about.",
    );
  }

  // Undo carries no argument and needs no thought — it is the one word whose
  // meaning is fixed. Paying a model to forward it was pure waste.
  if (parseUndoRequest(question)) {
    const action = { action: "undo_last", commit: true };
    if (!emitValidatedPlan(graph, services, [action])) return null;
    return localAnswer(
      "Undoing the last thing I did. The mod reports what it actually reversed.",
      "undo_last",
      Date.now(),
      "Undo has one meaning and no arguments.",
    );
  }

  // A waypoint is a position handed to the game's own marker system. The
  // position either comes from the site solver or from a name lookup; neither
  // needs a model.
  const waypoint = parseWaypointRequest(question);
  if (waypoint && graph) {
    const started = Date.now();
    let location = null;
    let label = null;

    if (waypoint.kind === "best_site") {
      const site = solveSiteSelection(graph, {});
      const best = site?.sites?.[0];
      if (best?.center_cm) {
        location = best.center_cm;
        label = "Best HUB site";
      }
    } else {
      const [match] = solveActorLookup(graph, { ...waypoint.lookup, limit: 1 })?.matches ?? [];
      if (match?.location_cm) {
        location = match.location_cm;
        label = match.name ?? match.actor_id;
      }
    }

    if (location) {
      if (
        !emitValidatedPlan(graph, services, [
          { action: "waypoint", name: label, location, commit: true },
        ])
      ) {
        return null;
      }
      return localAnswer(
        `Waypoint **${label}** set at \`x=${round(location.x)}, y=${round(location.y)}, ` +
          `z=${round(location.z)}\`. It uses the game's own map markers, so it shows on your map ` +
          "and on the compass with a live distance — same as a resource scanner ping. " +
          'Say "clear waypoints" to remove the ones I placed.',
        "waypoint",
        started,
        "A waypoint is a resolved position handed to the game's marker system.",
      );
    }
  }

  // "place a mk1 miner on this node facing north" is three lookups and no
  // judgement: name to build recipe, aim target to coordinate, compass word to
  // yaw. Every part is in the snapshot, so none of it is worth paying for.
  const place = parsePlaceRequest(question);
  if (place) {
    const started = Date.now();
    const recipe = solveBuildRecipeLookup(graph, { building: place.building });
    const target = recipe.resolved ? solvePlacementTarget(graph, place.target) : null;

    if (recipe.resolved && target?.resolved) {
      if (target.node_type === "Deposit") {
        return localAnswer(
          `I did not place **${recipe.name}**: ${target.on} is a hand-mined deposit, not a ` +
            "resource node that can host a miner. Aim at a full resource node and ask again.",
          "place_building",
          started,
          "The live target is known to reject a miner, so no action was emitted.",
        );
      }
      if (target.occupied) {
        return localAnswer(
          `I did not place **${recipe.name}**: ${target.on} is already occupied. Aim at an ` +
            "unused resource node or ask me to inspect what is using this one.",
          "place_building",
          started,
          "The live target is already occupied, so no action was emitted.",
        );
      }

      const yaw = place.facing?.yaw ?? 0;
      const action = {
        action: "place_building",
        recipe_class: recipe.recipe_class,
        location: target.location,
        yaw,
        // Name the node. Without it the mod traces downward for a surface and
        // finds the terrain mesh beside the node, so the miner is positioned
        // right and attached to a rock.
        ...(target.actor_id ? { target_actor_id: target.actor_id } : {}),
        commit: true,
      };
      if (!emitValidatedPlan(graph, services, [action])) return null;

      const notes = [];
      if (place.facing) notes.push(`facing ${place.facing.described} (yaw ${yaw}°)`);
      return localAnswer(
        `Placing a **${recipe.name}** on ${target.on}` +
          `${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}. ` +
          "The mod validates and reports what actually landed; say \"undo\" to reverse it.",
        "place_building",
        started,
        "The building, the target and the facing were all lookups.",
      );
    }
    // Anything unresolved goes to the model, which can ask or suggest. Placing
    // the wrong building, or the right one in the wrong place, is not a cheaper
    // answer — it is a building to dismantle.
  }

  // "teleport me to <thing>" is a lookup followed by a move. Both halves are
  // mechanical, so the whole request is: resolve the name against the complete
  // snapshot, then emit the move at the coordinates that came back.
  // "im switching to coal power ... from this node" — miner, generators, belts.
  const coalRequest = parseCoalPowerRequest(question);
  if (coalRequest && graph) {
    const started = Date.now();
    const target = solvePlacementTarget(graph, { kind: "aim" });
    const structural = surveyStructuralPieces(graph);
    const plan = planCoalPower(graph, {
      node: target?.resolved ? target : null,
      generator_count: coalRequest.generator_count,
      build_recipe_lookup: solveBuildRecipeLookup,
      belt: findBestAvailableBelt(graph),
      cell_size_cm: structural?.cell_size_cm ?? null,
    });

    if (!plan.planned) {
      // Older snapshots may still lack the class rates needed to answer this.
      const detail = plan.why_unknown ? ` ${plan.why_unknown}` : "";
      return localAnswer(
        `${plan.reason === "how many generators?" ? "**How many generators?**" : `I can't set that up: ${plan.reason}.`}${detail}`,
        "coal_power_refused",
        started,
        "Nothing was sent to the game.",
      );
    }

    const emitted = emitValidatedPlan(graph, services, plan.actions);
    if (emitted) {
      const sizing = plan.sizing
        ? `Captured rates: ${plan.sizing.mined_per_minute}/min from this ${plan.sizing.purity} node ` +
          `(${plan.sizing.purity_multiplier}× purity) ÷ ${plan.sizing.burn_per_minute}/min per generator ` +
          `= **${plan.generator_count} generators**.\n\n`
        : "";
      const chain =
        plan.splitter_count > 0
          ? `${plan.generator_count} × **${plan.generator}** in a row ` +
            `${plan.spacing_cm / 100} m apart, fed through ${plan.splitter_count} ` +
            `splitter(s) — a miner has one output port, so the coal is shared ` +
            `rather than belted four ways off one connector`
          : `one **${plan.generator}** belted straight off it`;
      return localAnswer(
        `Coal power off **${plan.node}**: one **${plan.miner}** on the node, ${chain}.\n\n${sizing}` +
          `**${plan.missing.water}**\n\n` +
          `Spacing is stated, not measured — no generator exists here to measure one from. ` +
          `The game refuses anything that does not fit and names it. Say "undo" to reverse it all.`,
        "coal_power",
        started,
        "Node from the crosshair, miner and generator from this save's catalog.",
      );
    }
    const refusal = describePlanRejection();
    if (refusal) {
      return localAnswer(refusal, "coal_power_refused", started, "Refused by validation before anything ran.");
    }
  }

  // "build me a storage hub here" — a structure at the point being aimed at.
  const structureRequest = parseStructureRequest(question);
  if (structureRequest && graph) {
    const started = Date.now();
    // The aim point, not the player: standing on a deck and looking at it are
    // different heights, and "same level as this foundation" means the latter.
    const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
    const origin = structureRequest.at_aim && aim
      ? aim
      : graph.snapshot?.interaction_context?.player?.pawn_location;

    if (origin) {
      const width = structureRequest.width_cells ?? 4;
      const depth = structureRequest.depth_cells ?? 4;
      const structure = planStructure(graph, {
        origin_cm: origin,
        width_cells: width,
        depth_cells: depth,
        // Level with what is being aimed at, so it joins the existing build
        // rather than hovering above it.
        height_cm: 0,
        walls: true,
        roof: true,
      });

      if (structure.planned) {
        const actions = structureActions(structure, { commit: true });

        // Fill it, when the request named something to fill it with.
        const filler = structureRequest.fills_with === "storage"
          ? solveBuildRecipeLookup(graph, { building: "storage container" })
          : null;
        const filled = [];
        if (filler?.resolved) {
          const cell = structure.grid.cell_size_cm;
          for (let column = 0; column < width; column += 1) {
            for (let row = 0; row < depth; row += 1) {
              // One per cell, inset by a cell so nothing sits in the wall line.
              if (column === 0 || row === 0 || column === width - 1 || row === depth - 1) continue;
              filled.push({
                action: "place_building",
                recipe_class: filler.recipe_class,
                location: {
                  x: structure.interior.min_x_cm + column * cell,
                  y: structure.interior.min_y_cm + row * cell,
                  z: structure.interior.floor_z_cm,
                },
                yaw: 0,
                commit: true,
              });
            }
          }
        }

        const emitted = emitValidatedPlan(graph, services, [...actions, ...filled]);
        if (emitted) {
          const counts = structure.piece_counts ?? {};
          return localAnswer(
            `Building a **${width * (structure.grid.cell_size_cm / 100)} × ` +
              `${depth * (structure.grid.cell_size_cm / 100)} m ` +
              `${structureRequest.fills_with === "storage" ? "storage hub" : "platform"}** ` +
              `level with what you are aiming at ` +
              `(z=${Math.round(origin.z)}) — ${counts.floor ?? 0} floor, ` +
              `${counts.wall ?? 0} wall and ${counts.roof ?? 0} roof pieces` +
              (filled.length > 0 ? `, plus ${filled.length} ${filler.name}(s) inside` : "") +
              '. Say "undo" to reverse the whole thing.',
            "build_structure",
            started,
            "Position came from the aim point; every piece from the unlocked catalog.",
          );
        }
        const refusal = describePlanRejection();
        if (refusal) {
          return localAnswer(refusal, "build_structure_refused", started, "Refused by validation before anything ran.");
        }
      } else if (structure.reason) {
        // The planner said exactly why -- no foundation unlocked yet, no ground
        // under the footprint. Falling through would hand a request we already
        // understand to a model, which is how "Let me build this for you"
        // happened in the first place: it cannot build either, and it does not
        // know this reason, so it invents an answer instead of reporting one.
        return localAnswer(
          `I can't build that here: ${structure.reason}.`,
          "build_structure_refused",
          started,
          "The structural planner refused; nothing was sent to the game.",
        );
      }
    } else {
      return localAnswer(
        "I don't know where to build it — the game didn't report what you're " +
          "aiming at. Look directly at the spot and ask again.",
        "build_structure_refused",
        started,
        "No aim point and no player position in the snapshot.",
      );
    }
  }
  // "design me a base that makes 60 iron plates a minute".
  const design = parseBaseDesignRequest(question);
  if (design && graph) {
    const started = Date.now();
    const item = resolveDesignItem(graph, design);
    if (item) {
      const production = solveProductionPlan(graph, {
        item_class: item.class_path,
        target_rate_per_minute: design.per_minute,
      });
      if (production?.planned) {
        // Housed by default. The owner's goal is a factory that looks like a
        // building — raised decks, walls, glass roofs, machinery inside — so
        // bare machines on open ground is the special case, not the norm.
        // "just the machines" or "no building" asks for the bare version.
        const housed = !design.bare;
        // "find the best place to spawn it" means the solver picks the site,
        // not the player's feet. The site scoring already measures terrain,
        // resources and distance, so this is one solver feeding another rather
        // than a second opinion about where to build.
        let sitedAt = null;
        if (design.at_best_site) {
          const site = solveSiteSelection(graph, {});
          const best = site?.sites?.[0];
          if (best?.center_cm) {
            sitedAt = { anchor_cm: best.center_cm, why: site.why_this_site?.headline ?? null };
          }
        }

        // A site the game cannot build on is worse than no site.
        //
        // `find_best_site` scores the whole map, and on this save the winner
        // came back 5.5 km away. Satisfactory only streams the world near the
        // player, so a downward trace out there finds nothing and the very
        // first foundation is refused for having no ground under it — after 205
        // actions had been planned, validated and sent. Distance is cheap to
        // check here, and teleporting first genuinely fixes it.
        if (sitedAt) {
          const me = graph?.snapshot?.interaction_context?.player?.pawn_location;
          const awayMetres = me
            ? Math.hypot(sitedAt.anchor_cm.x - me.x, sitedAt.anchor_cm.y - me.y) / 100
            : null;
          if (awayMetres !== null && awayMetres > BUILDABLE_RANGE_METRES) {
            return localAnswer(
              `The best site is **${Math.round(awayMetres)} m away**, which is too far to ` +
                "build. Satisfactory only loads the world around you, so every " +
                "foundation out there would be refused for having no ground under it.\n\n" +
                'Say **"teleport me to the best hub location"** first, then ask for the ' +
                "base again and it will build where you are standing.",
              "build_base_out_of_range",
              started,
              "The distance to the chosen site was checked before any action was sent.",
            );
          }
        }

        const enclosed = housed
          ? planEnclosedFactory(graph, {
              production_plan: production,
              measure_building: measureBuilding,
              measure_connectors: measureConnectors,
              plan_structure: planStructure,
              plan_tower: planTower,
              levels: design.levels,
              anchor_cm: sitedAt?.anchor_cm ?? null,
            })
          : null;
        const plan = enclosed?.planned
          ? enclosed.machines
          : planBaseBuild(graph, {
              production_plan: production,
              measure_connectors: measureConnectors,
            });

        if (plan.planned) {
          const actions = enclosed?.planned
            ? enclosedFactoryActions(enclosed, {
                commit: design.commit,
                structure_actions: structureActions,
              })
            : baseBuildActions(plan, { commit: design.commit });
          const emitted = design.commit
            ? emitValidatedPlan(graph, services, actions)
            : true;

          if (emitted) {
            const rows = plan.steps
              .map(
                (step) =>
                  `- **Row ${step.row}** — ${step.machines} × ${step.building_name} ` +
                  `→ ${step.produces} @ ${step.rate_per_minute}/min`,
              )
              .join("\n");
            const skipped = plan.unbuildable.length
              ? `\n\nCannot place: ${plan.unbuildable
                  .map((entry) => `${entry.produces ?? "?"} (${entry.reason})`)
                  .join("; ")}.`
              : "";
            const power = plan.power?.plan_draw_mw
              ? `\n\nDraws ${plan.power.plan_draw_mw} MW; ` +
                `${plan.power.fits_on_existing_power ? "your existing circuit can carry that" : "**more generation is needed**"}. ` +
                "Power is not wired by this plan."
              : "";

            // The building is the headline when there is one: it is the part
            // the owner can picture, and the part that makes this different
            // from machines standing in a field.
            const shell = enclosed?.planned
              ? (() => {
                  const structure = enclosed.structure;
                  const counts = structure.piece_counts ?? {};
                  return (
                    `\n\n**Housed in a ${structure.footprint.width_cm / 100} × ` +
                    `${structure.footprint.depth_cm / 100} m building**` +
                    (structure.raised_cm > 0
                      ? `, raised ${structure.raised_cm / 100} m on ${structure.pillars} pillars`
                      : "") +
                    ` — ${counts.floor ?? 0} floor, ${counts.wall ?? 0} wall and ` +
                    `${counts.roof ?? 0} roof pieces. The machines sit on the deck inside.` +
                    // The ground check, when it changed anything. Asked for
                    // directly, and the sort of thing that silently ruins a
                    // build if it is done and not mentioned.
                    (structure.terrain?.clearance?.adjusted
                      ? `

**Ground checked:** ${structure.terrain.clearance.reason}. ` +
                        `Measured ${structure.terrain.samples} terrain probe(s) under the ` +
                        `footprint${structure.terrain.verdicts?.length ? ` (${structure.terrain.verdicts.join(", ")})` : ""}. ` +
                        "Ground beyond the scanner's probe radius is unknown, not assumed flat."
                      : structure.terrain?.measured === false
                        ? `

**Ground not checked:** ${structure.terrain.reason}.`
                        : "")
                  );
                })()
              : "";

            return localAnswer(
              `**${design.commit ? "Building" : "Design for"} ${design.per_minute}/min ${item.name}** ` +
                `— ${plan.machines_total} machine(s) across ${plan.rows} row(s), ` +
                `${plan.belts_planned} belt leg(s).\n\n${rows}${shell}${skipped}${power}\n\n` +
                (design.commit
                  ? "Placing now. Each machine is validated by the game as it goes, and " +
                    'the whole transaction rolls back if one fails. Say "undo" to reverse it.'
                  : `Say **"build a base for ${design.per_minute} ${item.name} per minute"** to place it.`),
              design.commit ? "build_base" : "design_base",
              started,
              "Recipes, machine counts and positions all came from captured data.",
            );
          }
        }
      }
    }
    // A plan the validator refused is worth saying out loud: the player asked
    // for something specific and deserves the reason, not a fall-through.
    const rejection = describePlanRejection();
    if (rejection) {
      return localAnswer(
        rejection,
        "build_base_refused",
        started,
        "The plan was built and then refused by validation before anything ran.",
      );
    }
    // Unknown item or an unplannable goal: the model can ask which item was
    // meant, or explain why the chain cannot be built here.
  }

  // "dismantle Build_Belt_C_1" — one named building, resolved and removed.
  const dismantle = parseDismantleRequest(question);
  if (dismantle && graph) {
    const started = Date.now();
    // Keep enough matches to explain an ambiguity; the parser's limit of one
    // is sufficient for execution but would hide every candidate after the
    // nearest from the clarification.
    const lookup = solveActorLookup(graph, { ...dismantle, limit: 6 });
    const [match] = lookup?.matches ?? [];
    // Dismantle cannot always be undone. A name search may return several
    // actors sorted by proximity; choosing the first would silently turn
    // "remove the constructor" into "remove the nearest constructor". Only an
    // authoritative unique match is safe to turn into a committed action.
    if (lookup?.match_count === 1 && match?.actor_id) {
      const emitted = emitValidatedPlan(graph, services, [
        { action: "dismantle", actor_id: match.actor_id, commit: true },
      ]);
      if (emitted) {
        return localAnswer(
          `Dismantling **${match.name ?? match.actor_id}**` +
            `${match.distance_meters !== undefined ? ` (${round(match.distance_meters)} m away)` : ""}. ` +
            "The refund goes to your inventory, and anything that does not fit drops. " +
            "The mod runs this on its own so a failure cannot half-undo something else.",
          "dismantle",
          started,
          "One named building was resolved from the snapshot; nothing was inferred.",
        );
      }
    }
    if (lookup?.match_count > 1) {
      const candidates = (lookup.matches ?? [])
        .slice(0, 6)
        .map((candidate) => {
          const id = candidate.name ?? candidate.actor_id;
          const distance = candidate.distance_meters;
          return `- ${id}${distance !== null && distance !== undefined ? ` (${round(distance, 1)} m)` : ""}`;
        })
        .join("\n");
      const firstId = lookup.matches?.[0]?.name ?? lookup.matches?.[0]?.actor_id;
      return localAnswer(
        `I found **${lookup.match_count}** buildings matching **${dismantle.target}** and will not guess which one to dismantle:\n\n` +
          `${candidates}\n\n` +
          `Name one exact actor id${firstId ? ` — for example **"dismantle ${firstId}"**` : ""}. No action was emitted.`,
        "dismantle_ambiguous",
        started,
        "More than one captured actor matched; an irreversible choice requires an exact target.",
      );
    }
    // Unresolved name: the model can ask which building was meant.
  }

  // "what can I undo" — a question about the journal, not a request to use it.
  if (parseUndoHistoryRequest(question)) {
    const started = Date.now();
    // The journal lives in the mod, not here, so this cannot list its contents.
    // Saying that plainly beats a model inventing a history it also cannot see.
    return localAnswer(
      "The undo journal is kept by the mod, not the bridge, so I cannot list it " +
        'from here. Say **"undo"** and it will reverse its most recent ' +
        "transaction and tell you exactly what it reversed. Each answer that " +
        "changed something also says whether it can be undone.",
      "undo_history",
      started,
      "The journal is game-side; claiming to read it would be inventing.",
    );
  }

  // "belt the smelter to the constructor" — plan the run and build it, locally.
  const belt = parseBeltRequest(question);
  if (belt && graph) {
    const started = Date.now();
    const [fromMatch] = solveActorLookup(graph, belt.from)?.matches ?? [];
    const [toMatch] = solveActorLookup(graph, belt.to)?.matches ?? [];

    if (fromMatch && toMatch) {
      const route = solveBeltRoute(graph, {
        from_actor_id: fromMatch.actor_id,
        to_actor_id: toMatch.actor_id,
      });

      // A refusal here is the useful answer: an occupied port, a machine with
      // no output, or connectors already touching are all things the player can
      // act on, and all of them are cheaper to say than to discover.
      if (!route.routed) {
        return localAnswer(
          `I cannot run that belt: ${route.reason}.` +
            (route.likely_cause ? `\n\n${route.likely_cause}` : ""),
          "place_belt_refused",
          started,
          "The route was checked against captured connectors before proposing a build.",
        );
      }

      const recipe = solveBuildRecipeLookup(graph, { building: belt.belt_name });
      if (recipe.resolved) {
        const emitted = emitValidatedPlan(graph, services, [
          {
            action: "place_belt",
            recipe_class: recipe.recipe_class,
            from_component: route.from.connector,
            to_component: route.to.connector,
            commit: true,
          },
        ]);
        if (emitted) {
          return localAnswer(
            `Running a **${recipe.name}** from **${route.from.name}** ` +
              `(${route.from.connector.split(".").pop()}) to **${route.to.name}** ` +
              `(${route.to.connector.split(".").pop()}) — ${route.length_meters} m` +
              `${route.straight ? ", straight" : ", with a bend"}. ` +
              "The game's hologram decides length, bend radius and clearance; " +
              'the mod reports what it actually built. Say "undo" to remove it.',
            "place_belt",
            started,
            "Both endpoints and the recipe came from captured data.",
          );
        }
      }
    }
    // Unresolved machine or recipe: the model can ask which one was meant.
  }

  const teleport = parseTeleportRequest(question);
  if (teleport) {
    const started = Date.now();

    // "take me to the best hub site": the destination is computed, not named.
    if (teleport.kind === "best_site") {
      const site = solveSiteSelection(graph, {});
      const best = site?.sites?.[0];
      if (best?.center_cm) {
        const action = {
          action: "teleport_player",
          target: best.center_cm,
          snap_to_ground: true,
          commit: true,
        };
        if (emitValidatedPlan(graph, services, [action])) {
          return localAnswer(
            `Teleporting you to the best HUB site — \`x=${round(best.center_cm.x)}, ` +
              `y=${round(best.center_cm.y)}, z=${round(best.center_cm.z)}\`` +
              `${site.why_this_site?.headline ? `. ${site.why_this_site.headline}` : "."} ` +
              "Ground-snapped; the mod reports the actual landing spot.",
            "teleport_player",
            started,
            "The site was scored by the solver and the move needs no judgement.",
          );
        }
      }
      // No scoreable site: the model can explain why better than a bare refusal.
      return null;
    }

    const found = solveActorLookup(graph, teleport);
    const [match] = found?.matches ?? [];
    if (match?.location_cm) {
      const action = {
        action: "teleport_player",
        target: match.location_cm,
        snap_to_ground: true,
        commit: true,
      };
      if (!emitValidatedPlan(graph, services, [action])) return null;
      return localAnswer(
        `Teleporting you to **${match.name ?? match.actor_id}** at \`x=${round(match.location_cm.x)}, ` +
          `y=${round(match.location_cm.y)}, z=${round(match.location_cm.z)}\`` +
          `${match.distance_meters !== undefined ? ` — ${round(match.distance_meters)} m away` : ""}. ` +
          "Ground-snapped; the mod reports the actual landing spot.",
        "teleport_player",
        started,
        "The destination was found by name; moving there needs no judgement.",
      );
    }
    // The name did not resolve, so the model gets it — it may know a synonym,
    // or need to ask. Guessing a coordinate here would drop the player in rock.
  }

  const nearbyResources = parseNearbyResourceRequest(question);
  if (nearbyResources && graph) {
    const started = Date.now();
    return localAnswer(
      formatNearbyResources(graph, nearbyResources),
      "nearby_resources",
      started,
      "The complete captured resource-node set was sorted by exact distance from the captured player position.",
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
    if (!emitValidatedPlan(graph, services, [action])) return null;
    return localAnswer(
      `Marking every **${show.target}** within ${show.radius ?? 150} m (overlay "${overlayName}"). ` +
        "The mod resolves it live against the world, so check in-game for what it actually finds — " +
        "I am not guessing a count here.",
      "highlight",
      Date.now(),
      "An overlay request is a filter, not a question — nothing to reason about.",
    );
  }

  // A named lookup is answered from the snapshot. Deliberately after the
  // overlay parse, which owns the "show"/"find"/"locate" verbs: those already
  // draw a marker in-world, which beats reading coordinates off a chat panel.
  const locate = parseLocateRequest(question);
  if (locate) {
    const started = Date.now();
    const result = solveActorLookup(graph, locate);
    if ((result?.matches ?? []).length > 0) {
      return localAnswer(
        formatLocate(result, locate.target),
        "locate",
        started,
        "A lookup by name is a search of the snapshot, not a judgement.",
      );
    }
    // No match may mean the thing exists under a name this parse did not guess,
    // so an empty result falls through to the model rather than denying it.
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
    reply: route.format(result),
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
    reply: text,
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
