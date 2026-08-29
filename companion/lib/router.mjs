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
  solveBuildCost,
  solveFactorySummary,
  solveItemBalance,
  solveMachineRates,
  solvePowerCircuits,
  solveBlueprintPlacementAudit,
  solveRecipeOptions,
  solveActorLookup,
  solveBuildRecipeLookup,
  solvePlacementTarget,
  solveProductionPlan,
  solveSiteSelection,
  solveTransportCapacity,
  solveUnlockStatus,
  solveBlueprintLayout,
  solveBlueprintComparison,
  solveBlueprintLibrary,
} from "./solvers.mjs";
import { resolveCurrentSessionBlueprint } from "./blueprint-session.mjs";
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
import { compileGeneratedBlueprint, generatedBlueprintAction } from "./generated-blueprints.mjs";
import { planGeneratedBlueprintPower } from "./generated-power.mjs";
import { modularShellActions, planModularShell } from "./modular.mjs";
import { describeCloneSource, planClone } from "./clone.mjs";
import {
  captureDesign,
  findDesign,
  listDesigns,
  planDesignPlacement,
  renameDesign,
  summariseDesign,
  retireDesign,
  writeDesign,
} from "./designs.mjs";
import {
  clearPreview,
  describeSelection,
  lastPreview,
  makeSelectionBox,
  rememberPreview,
  selectionBounds,
  selectionContents,
} from "./selection.mjs";
import { findResourceNodeUnderPlan, planAimedMk1WireFactory } from "./resource-factory.mjs";
import { measureBuilding } from "./designer.mjs";
import { formatSurvey, judgeSite, surveyResources } from "./survey.mjs";
import {
  assessBlueprintSite,
  formatSiteAssessment,
  judgeSite as judgeBlueprintSite,
} from "./siting.mjs";
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
  const rejected = rejection.rejected ?? [];
  const first = rejected[0];
  if (!first) return null;

  // Name the building, not just the step number.
  //
  // A 389-building design refused at step 214 with "recipe_not_in_catalog" told
  // the player nothing they could act on, while the rejection object was
  // already carrying the building name and the class path. A design saved on a
  // save with a mod that is no longer loaded is exactly this case, and the
  // useful sentence is "you no longer have the Curved Ceiling Wall".
  const named = first.building_name || shortRecipeName(first.recipe_class);
  const what = named ? ` on ${named}` : "";

  // How many, because one missing mod takes out hundreds of steps and "step
  // 214" reads like a single unlucky piece.
  const more = rejected.length > 1
    ? ` ${rejected.length} of the steps were refused; this is the first.`
    : "";

  const suggestion = Array.isArray(first.did_you_mean) && first.did_you_mean.length > 0
    ? ` Closest names in your catalogue: ${first.did_you_mean.slice(0, 3).join(", ")}.`
    : "";

  return `The plan was refused: ${first.reason}${what} (step ${first.step}).${more}${suggestion}`;
}

/** "Build_CCWall8x8_C" out of a full class path, for a readable refusal. */
function shortRecipeName(classPath) {
  const tail = String(classPath ?? "").split(/[./]/).filter(Boolean).pop() ?? "";
  return tail.replace(/_C$/, "") || null;
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

/**
 * Belts and pipes that are struggling. Nothing else.
 *
 * The solver is called with `only_problems`, so an empty result genuinely
 * means nothing is backed up — worth saying plainly rather than listing a
 * hundred healthy segments.
 */
function formatTransport(result) {
  const conveyors = result.conveyors ?? [];
  const pipelines = result.pipelines ?? [];
  if (conveyors.length === 0 && pipelines.length === 0) {
    return (
      "No captured belt or pipe is backed up or over capacity. The capture is radius-limited, " +
      "so this covers what was scanned."
    );
  }

  const describe = (entry) => {
    const notes = [
      // The game's own word for a full belt, not an inference from throughput.
      entry.backed_up_evidence ? "backed up at capture" : null,
      Number.isFinite(entry.capacity_items_per_minute)
        ? `capacity ${entry.capacity_items_per_minute}/min`
        : null,
      Number.isFinite(entry.supply_items_per_minute)
        ? `fed ${entry.supply_items_per_minute}/min`
        : null,
      ...(entry.findings ?? []).map((finding) =>
        String(finding.finding ?? finding).replaceAll("_", " "),
      ),
    ].filter(Boolean);
    return `- **${entry.name ?? entry.actor_id}**${notes.length ? ` — ${notes.join(", ")}` : ""}`;
  };

  const section = (heading, list) =>
    list.length === 0 ? "" : `\n\n**${heading}**\n${list.slice(0, 8).map(describe).join("\n")}` +
      (list.length > 8 ? `\n- …and ${list.length - 8} more` : "");

  return (
    `${conveyors.length + pipelines.length} transport segment(s) have a finding:` +
    section("Belts", conveyors) +
    section("Pipes", pipelines) +
    (pipelines.length > 0
      ? "\n\nPipeline head lift and pressure are not in the capture, so elevation problems " +
        "can be neither confirmed nor ruled out."
      : "")
  );
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
  const names = new Map();
  for (const blueprint of blueprints) {
    const key = String(blueprint.name ?? "").toLocaleLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
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
      const duplicate = (names.get(String(blueprint.name ?? "").toLocaleLowerCase()) ?? 0) > 1;
      const reference = blueprint.blueprint_reference ?? blueprint.relative_path;
      const disambiguator = duplicate && reference ? ` — reference \`${reference}\`` : "";
      const registration = blueprint.registered_in_current_session === false
        ? " — not registered for this save's Build Gun"
        : blueprint.registered_in_current_session === null
          ? " — current-session Build Gun registration unknown"
          : "";
      return `- **${blueprint.name}**${size ? ` (${size.x}×${size.y}×${size.z})` : ""}${affordable}${disambiguator}${registration}`;
    })
    .join("\n")}`;
}

function formatBlueprintLayout(result) {
  if (!result.available) {
    if (result.reason === "blueprint_name_ambiguous" && Array.isArray(result.candidates)) {
      const references = result.candidates
        .map((entry) => `\`${entry.relative_path}\``)
        .join(", ");
      return `I found more than one saved blueprint with that name. Use one exact library reference: ${references}.`;
    }
    const detail = result.diagnostic ? ` ${result.diagnostic}` : "";
    return `I can't inspect that saved blueprint: **${result.reason ?? "unknown"}**.${detail}`;
  }
  const decoded = result.decoded ?? {};
  const classes = (result.buildable_classes ?? [])
    .slice(0, 6)
    .map((entry) => `${entry.count} ${entry.class_name}`)
    .join(", ");
  const bounds = result.pivot_bounds_cm;
  const span = bounds?.span_cm
    ? ` Its saved buildable pivots span ${round(bounds.span_cm.x / 100)} × ` +
      `${round(bounds.span_cm.y / 100)} × ${round(bounds.span_cm.z / 100)} m.`
    : " Its buildable pivot bounds were not available.";
  const listed = result.buildables_returned ?? 0;
  const omitted = result.buildables_truncated ?? 0;
  const topology = result.connection_topology;
  let topologyText = " Internal conveyor/pipe topology was not decoded.";
  if (topology?.status === "decoded") {
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
    const pairs = count(topology.reciprocal_connection_pair_count) ?? 0;
    const kinds = topology.reciprocal_connection_pairs_by_kind ?? {};
    const conveyorPairs = count(kinds.conveyor) ?? 0;
    const pipePairs = count(kinds.pipe) ?? 0;
    const mixedPairs = count(kinds.mixed) ?? 0;
    const supportedRecords = count(topology.supported_connection_reference_record_count) ?? 0;
    const incomplete = [
      topology.malformed_component_reference_count,
      topology.unresolved_component_reference_count,
      topology.ambiguous_component_reference_count,
      topology.nonreciprocal_component_reference_count,
      topology.unsupported_target_component_reference_count,
      topology.self_component_reference_count,
    ].reduce((total, value) => total + (count(value) ?? 0), 0);
    const returned = count(topology.connections_returned) ?? 0;
    const truncated = count(topology.connections_truncated) ?? 0;
    const kindText = [
      conveyorPairs > 0 ? `${conveyorPairs} conveyor` : null,
      pipePairs > 0 ? `${pipePairs} pipe` : null,
      mixedPairs > 0 ? `${mixedPairs} mixed-kind` : null,
    ].filter(Boolean).join(", ");
    if (pairs > 0) {
      topologyText = ` It records **${pairs}** reciprocal internal conveyor/pipe connection pair${pairs === 1 ? "" : "s"}` +
        (kindText ? ` (${kindText})` : "") + ".";
    } else if (supportedRecords > 0) {
      topologyText = " It has no verified reciprocal internal conveyor/pipe connection pairs.";
    } else {
      topologyText = " It has no saved conveyor/pipe component references to decode.";
    }
    if (incomplete > 0) {
      topologyText += ` **${incomplete}** saved connection reference${incomplete === 1 ? " is" : "s are"} malformed, unresolved, ambiguous, self-referential, one-way, or an unsupported component type, so this is not a complete internal-route proof.`;
    } else if (supportedRecords > 0) {
      topologyText += ` All **${supportedRecords}** supported saved reference record${supportedRecords === 1 ? "" : "s"} resolved reciprocally.`;
    }
    if (truncated > 0) {
      topologyText += ` I returned ${returned} individual connection pair${returned === 1 ? "" : "s"} and left ${truncated} out of this compact reply.`;
    }
    topologyText += " Item/fluid flow direction, rate, and external conveyor/pipe hookups are not inferred.";
  }
  const powerWireTopology = result.power_wire_topology;
  let powerWireText = " Internal native power-wire topology was not decoded.";
  if (powerWireTopology?.status === "decoded") {
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
    const nativeComponents = count(powerWireTopology.native_power_connection_component_count) ?? 0;
    const savedReferences = count(powerWireTopology.saved_power_wire_reference_count) ?? 0;
    const verifiedWires = count(powerWireTopology.verified_power_wire_count) ?? 0;
    const incomplete = [
      powerWireTopology.malformed_power_wire_entity_record_count,
      powerWireTopology.malformed_power_connection_component_record_count,
      powerWireTopology.ambiguous_power_connection_component_record_count,
      powerWireTopology.malformed_m_wires_property_count,
      powerWireTopology.malformed_m_wires_reference_count,
      powerWireTopology.duplicate_m_wires_reference_count,
      powerWireTopology.unresolved_power_wire_reference_count,
      powerWireTopology.ambiguous_power_wire_reference_count,
      powerWireTopology.unsupported_power_wire_target_count,
      powerWireTopology.duplicate_power_wire_entity_name_count,
      powerWireTopology.duplicate_power_wire_endpoint_reference_count,
      powerWireTopology.incomplete_power_wire_endpoint_count,
      powerWireTopology.overconnected_power_wire_endpoint_count,
      powerWireTopology.unreferenced_power_wire_entity_count,
      powerWireTopology.unresolved_power_wire_endpoint_owner_count,
      powerWireTopology.unsupported_m_wires_property_record_count,
    ].reduce((total, value) => total + (count(value) ?? 0), 0);
    const returned = count(powerWireTopology.power_wires_returned) ?? 0;
    const truncated = count(powerWireTopology.power_wires_truncated) ?? 0;
    if (verifiedWires > 0) {
      powerWireText = ` It records **${verifiedWires}** verified internal native power-wire edge${verifiedWires === 1 ? "" : "s"}.`;
    } else if (nativeComponents > 0 || savedReferences > 0) {
      powerWireText = " It has no verified internal native power-wire edges.";
    } else {
      powerWireText = " It has no saved native power-connection components or physical power-wire references.";
    }
    if (incomplete > 0) {
      powerWireText += ` **${incomplete}** saved power-wire observation${incomplete === 1 ? " is" : "s are"} malformed, unresolved, ambiguous, incomplete, overconnected, unsupported, unreferenced, or missing an owner, so this is not a complete physical-wire proof.`;
    } else if (savedReferences > 0) {
      powerWireText += ` All **${savedReferences}** saved mWires reference${savedReferences === 1 ? "" : "s"} resolved into exact native physical endpoints.`;
    }
    if (truncated > 0) {
      powerWireText += ` I returned ${returned} individual power-wire edge${returned === 1 ? "" : "s"} and left ${truncated} out of this compact reply.`;
    }
    powerWireText += " Saved hidden circuit connections are deliberately excluded. Electricity direction, load, capacity, and external power hookups are not inferred.";
  }
  const railTopology = result.rail_topology;
  let railText = " Native railroad-track spline topology was not decoded.";
  if (railTopology?.status === "decoded") {
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
    const trackCount = count(railTopology.native_rail_track_entity_count) ?? 0;
    const pointCount = count(railTopology.total_spline_point_count) ?? 0;
    const returned = count(railTopology.rail_track_records_returned) ?? 0;
    const truncatedTracks = count(railTopology.rail_track_records_truncated) ?? 0;
    const malformed = [
      railTopology.malformed_rail_track_entity_record_count,
      railTopology.missing_track_graph_id_count,
      railTopology.malformed_track_graph_id_count,
      railTopology.missing_spline_data_count,
      railTopology.malformed_spline_data_count,
      railTopology.malformed_spline_point_count,
    ].reduce((total, value) => total + (count(value) ?? 0), 0);
    if (trackCount > 0) {
      railText = ` It records **${trackCount}** native railroad track segment${trackCount === 1 ? "" : "s"} with **${pointCount}** saved spline point${pointCount === 1 ? "" : "s"}.`;
    } else {
      railText = " It has no saved native railroad track entities.";
    }
    if (malformed > 0) {
      railText += ` **${malformed}** rail record${malformed === 1 ? " is" : "s are"} missing or malformed, so this is not a complete spline-data proof.`;
    }
    if (truncatedTracks > 0) {
      railText += ` I returned ${returned} individual rail segment${returned === 1 ? "" : "s"} and left ${truncatedTracks} out of this compact reply.`;
    }
    railText += " Saved local spline points, tangents, and graph IDs do not prove that segments will join after placement, clear mountain terrain, satisfy collision/Build Gun checks, carry signals or power, or connect to external rail.";
  }
  const hypertubeTopology = result.hypertube_topology;
  let hypertubeText = " Native hypertube topology was not decoded.";
  if (hypertubeTopology?.status === "decoded") {
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
    const nativeComponents = count(hypertubeTopology.native_hypertube_connection_component_count) ?? 0;
    const supportedRecords = count(hypertubeTopology.supported_connection_reference_record_count) ?? 0;
    const pairs = count(hypertubeTopology.reciprocal_connection_pair_count) ?? 0;
    const pipeCount = count(hypertubeTopology.hypertube_pipe_entity_count) ?? 0;
    const pointCount = count(hypertubeTopology.total_spline_point_count) ?? 0;
    const incomplete = [
      hypertubeTopology.malformed_component_reference_count,
      hypertubeTopology.unresolved_component_reference_count,
      hypertubeTopology.ambiguous_component_reference_count,
      hypertubeTopology.nonreciprocal_component_reference_count,
      hypertubeTopology.unsupported_target_component_reference_count,
      hypertubeTopology.self_component_reference_count,
      hypertubeTopology.malformed_pipe_entity_record_count,
      hypertubeTopology.missing_spline_data_count,
      hypertubeTopology.malformed_spline_data_count,
      hypertubeTopology.malformed_spline_point_count,
      hypertubeTopology.malformed_passthrough_property_count,
      hypertubeTopology.malformed_passthrough_reference_count,
    ].reduce((total, value) => total + (count(value) ?? 0), 0);
    const returnedConnections = count(hypertubeTopology.connections_returned) ?? 0;
    const truncatedConnections = count(hypertubeTopology.connections_truncated) ?? 0;
    const returnedPipes = count(hypertubeTopology.pipe_records_returned) ?? 0;
    const truncatedPipes = count(hypertubeTopology.pipe_records_truncated) ?? 0;
    if (pairs > 0) {
      hypertubeText = ` It records **${pairs}** reciprocal internal native hypertube connection pair${pairs === 1 ? "" : "s"}.`;
    } else if (nativeComponents > 0 || pipeCount > 0) {
      hypertubeText = " It has native hypertube records but no verified reciprocal internal connection pair.";
    } else {
      hypertubeText = " It has no saved native hypertube connection components or PipeHyper spline entities.";
    }
    if (pipeCount > 0) {
      hypertubeText += ` The saved PipeHyper records contain **${pointCount}** spline point${pointCount === 1 ? "" : "s"}.`;
    }
    if (incomplete > 0) {
      hypertubeText += ` **${incomplete}** hypertube observation${incomplete === 1 ? " is" : "s are"} malformed, unresolved, ambiguous, one-way, self-referential, or missing required spline data, so this is not a complete internal-travel proof.`;
    } else if (supportedRecords > 0) {
      hypertubeText += ` All **${supportedRecords}** supported Hyper connection reference record${supportedRecords === 1 ? "" : "s"} resolved reciprocally.`;
    }
    if (truncatedConnections > 0) {
      hypertubeText += ` I returned ${returnedConnections} individual hypertube connection pair${returnedConnections === 1 ? "" : "s"} and left ${truncatedConnections} out of this compact reply.`;
    }
    if (truncatedPipes > 0) {
      hypertubeText += ` I returned ${returnedPipes} PipeHyper spline record${returnedPipes === 1 ? "" : "s"} and left ${truncatedPipes} out of this compact reply.`;
    }
    hypertubeText += " Saved spline order does not prove traversal direction, speed, throughput, junction behavior, underground excavation, collision/Build Gun clearance, cross-blueprint joins, or external hookups.";
  }
  return `**${result.blueprint_name}** decodes to **${decoded.buildable_count ?? 0} Build_* entities** ` +
    `(${decoded.component_count ?? 0} components).${span}` +
    (classes ? ` Most common classes: ${classes}.` : "") +
    ` I returned ${listed} saved transform${listed === 1 ? "" : "s"}` +
    (omitted > 0 ? ` and left ${omitted} out of this compact reply.` : ".") +
    topologyText +
    powerWireText +
    railText +
    hypertubeText +
    " These are native saved transforms and saved component references, not proof that the blueprint will clear terrain or fit at a new location.";
}

function comparisonDisplayName(value) {
  return String(value ?? "unknown").split(/[\\/]/).pop()?.replace(/\.sbp$/i, "") || "unknown";
}

function formatBlueprintComparison(result) {
  if (!result.available) {
    const unavailable = [result.left, result.right]
      .filter((side) => side && side.available === false)
      .map((side) => `**${side.blueprint_name ?? "blueprint"}**: ${side.reason ?? "unknown"}`)
      .join("; ");
    return `I can't compare those saved blueprints: **${result.reason ?? "unknown"}**.` +
      (unavailable ? ` ${unavailable}.` : "") +
      " Nothing was changed in the world.";
  }
  const left = result.left ?? {};
  const right = result.right ?? {};
  const comparison = result.comparison ?? {};
  const side = (value) => value === null || value === undefined ? "unknown" : String(value);
  const dimensions = (value) => value && [value.x, value.y, value.z].every(Number.isFinite)
    ? `${value.x}×${value.y}×${value.z}`
    : "unknown";
  const span = (value) => value && [value.x, value.y, value.z].every(Number.isFinite)
    ? `${round(value.x / 100)}×${round(value.y / 100)}×${round(value.z / 100)} m`
    : "unknown";
  const changedClasses = (comparison.class_differences ?? []).slice(0, 8)
    .map((entry) => `${comparisonDisplayName(entry.class_path)} ${entry.left}→${entry.right}`)
    .join(", ");
  const changedRecipes = (comparison.recipe_differences ?? []).slice(0, 8)
    .map((entry) => comparisonDisplayName(entry.recipe_class))
    .join(", ");
  const changedCosts = (comparison.cost_differences ?? []).slice(0, 8)
    .map((entry) => `${comparisonDisplayName(entry.item_class)} ${entry.left}→${entry.right}`)
    .join(", ");
  const topology = comparison.topology_delta ?? {};
  const topologyLine = Object.entries(topology)
    .map(([key, value]) => value?.status === "exact" && value.delta !== 0
      ? `${key.replaceAll("_", " ")} ${value.left}→${value.right}`
      : null)
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");
  const warnings = [];
  if (comparison.class_differences_complete === false) warnings.push(`class differences are incomplete (${comparison.class_differences_reason ?? "unknown reason"})`);
  if (comparison.recipe_differences_complete === false) warnings.push(`recipe differences are incomplete (${comparison.recipe_differences_reason ?? "unknown reason"})`);
  if (comparison.cost_differences_complete === false) warnings.push(`cost differences are incomplete (${comparison.cost_differences_reason ?? "unknown reason"})`);
  return `**Blueprint comparison** — **${left.blueprint_name ?? "left"}** vs **${right.blueprint_name ?? "right"}**\n\n` +
    `- Header CL: ${side(left.header?.game_changelist)} vs ${side(right.header?.game_changelist)}; ` +
      `Designer: ${dimensions(left.header?.designer_dimensions)} vs ${dimensions(right.header?.designer_dimensions)}\n` +
    `- Decoded buildables: ${side(left.decoded?.buildable_count)} vs ${side(right.decoded?.buildable_count)}; ` +
      `saved pivot spans: ${span(left.pivot_span_cm)} vs ${span(right.pivot_span_cm)}\n` +
    `- Changed buildable classes: ${changedClasses || (comparison.class_differences_complete ? "none" : "unknown")}\n` +
    `- Changed recipe references: ${changedRecipes || (comparison.recipe_differences_complete ? "none" : "unknown")}\n` +
    `- Changed build cost: ${changedCosts || (comparison.cost_differences_complete ? "none" : "unknown")}\n` +
    `- Topology deltas: ${topologyLine || "none or unknown"}.` +
    (warnings.length > 0 ? `\n\n**Evidence limits:** ${warnings.join("; ")}.` : "") +
    "\n\nThis is serialized native evidence only; it does not prove visual style, snap compatibility, terrain/collision fit, cross-blueprint joins, flow, or destination Build Gun validity. Nothing was changed in the world.";
}

function auditWholeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * An extractor's generic audit record can name an anchor only after the
 * bounded Anchor census independently returns the same exact extractor ID.
 * Do not turn an unverified string from either source into a relationship.
 */
function extractorHasReturnedExactResourceAnchorBinding(extractor, anchorAudit) {
  if (!extractor || typeof extractor !== "object" || !anchorAudit || typeof anchorAudit !== "object") return false;
  if (!["complete", "complete_with_configuration_mismatch"].includes(anchorAudit.status)) return false;
  const extractorId = typeof extractor.actor_id === "string" && extractor.actor_id ? extractor.actor_id : null;
  const requestedAnchorId =
    typeof extractor.resource_anchor_actor_id === "string" && extractor.resource_anchor_actor_id
      ? extractor.resource_anchor_actor_id
      : null;
  if (!extractorId || !requestedAnchorId) return false;
  for (const anchor of Array.isArray(anchorAudit.anchors) ? anchorAudit.anchors : []) {
    if (!anchor || typeof anchor !== "object" || anchor.anchor_actor_id !== requestedAnchorId) continue;
    if (![
      "complete",
      "complete_with_configuration_mismatch",
    ].includes(anchor.binding_census_state)) return false;
    if (anchor.binding_counts_complete !== true) return false;
    if (Array.isArray(anchor.bound_extractor_actor_ids) && anchor.bound_extractor_actor_ids.includes(extractorId)) {
      return true;
    }
  }
  return false;
}

/** Format exact Resource Anchor observations without promoting a client-null transient node to a failure. */
function formatBlueprintResourceAnchorAudit(anchorAudit) {
  if (!anchorAudit || typeof anchorAudit !== "object") return "";
  if (
    anchorAudit.status === "not_captured" ||
    anchorAudit.status === "not_inspected_until_blueprint_proxy_ready" ||
    anchorAudit.status === "not_inspected_until_extractor_counts_complete"
  ) {
    return "";
  }
  const anchorCount = auditWholeCount(anchorAudit.anchor_count);
  if (anchorCount === 0 && anchorAudit.status === "complete") {
    return "\n\nThe game reports **0 Blueprint Resource Anchors** on this runtime instance.";
  }
  if (anchorAudit.status === "inconsistent_duplicate_bound_extractor") {
    const duplicateIds = Array.isArray(anchorAudit.duplicate_bound_extractor_actor_ids)
      ? anchorAudit.duplicate_bound_extractor_actor_ids.filter((value) => typeof value === "string").slice(0, 3)
      : [];
    return "\n\n**Resource Anchor audit is inconsistent:** more than one anchor claims the same exact miner " +
      "identity, so I will not call any anchor binding healthy." +
      (duplicateIds.length > 0 ? ` Conflicting miner${duplicateIds.length === 1 ? "" : "s"}: ${duplicateIds.join(", ")}.` : "");
  }
  if (anchorAudit.status === "partial" || anchorAudit.status === "partial_or_inconsistent") {
    return "\n\n**Resource Anchor audit is partial**, so the anchor list is not proof that all anchors or miner bindings were captured.";
  }

  const lines = [];
  for (const anchor of Array.isArray(anchorAudit.anchors) ? anchorAudit.anchors.slice(0, 4) : []) {
    if (!anchor || typeof anchor !== "object") continue;
    const name = anchor.anchor_actor_name ?? anchor.anchor_actor_id ?? "Unnamed Resource Anchor";
    const configuration = anchor.configuration ?? {};
    const configuredResource = configuration.resource_name ?? configuration.resource_class;
    const configuredPurity = configuration.purity;
    const configured = configuredResource
      ? `configured **${configuredResource}**${configuredPurity ? ` (${configuredPurity})` : ""}`
      : configuration.state === "invalid_or_unsupported"
        ? "has an invalid or unsupported saved configuration"
        : "has no captured resource configuration";
    const runtime = anchor.runtime_node ?? {};
    let runtimeText;
    if (runtime.state === "observed") {
      const resource = runtime.resource_name ?? runtime.resource_class ?? "captured resource";
      runtimeText = `runtime node observed as ${resource}${runtime.purity ? ` (${runtime.purity})` : ""}` +
        (runtime.occupied === true ? ", occupied" : runtime.occupied === false ? ", unoccupied" : "");
    } else if (runtime.state === "configuration_mismatch") {
      runtimeText = "runtime node differs from the saved resource/purity configuration";
    } else if (runtime.state === "unknown_on_client") {
      runtimeText = "runtime node is unknown on this client (it is transient, not proof of failure)";
    } else if (runtime.state === "missing_on_authority") {
      runtimeText = "runtime node is missing on the authority";
    } else if (runtime.state === "owner_mismatch") {
      runtimeText = "runtime node ownership does not match this anchor";
    } else {
      runtimeText = "runtime node state was not captured";
    }
    const bound = auditWholeCount(anchor.bound_extractor_count_observed);
    const census = anchor.binding_census_state;
    const bindingText = census === "complete" || census === "complete_with_configuration_mismatch"
      ? `${bound ?? 0} exact-bound miner${bound === 1 ? "" : "s"} observed`
      : census === "unknown_on_client"
        ? "miner binding is unknown on this client"
        : census === "partial_proxy_replication" || census === "incomplete_lightweight_extractors"
          ? "miner binding census is incomplete"
          : "miner binding census is unknown";
    lines.push(`- **${name}** — ${configured}; ${runtimeText}; ${bindingText}.`);
  }
  if (lines.length === 0) {
    return anchorCount === 0
      ? "\n\nThe game reports **0 Blueprint Resource Anchors** on this runtime instance."
      : "\n\nResource Anchor details were not returned, so their live node and miner state remain unknown.";
  }
  const omitted = auditWholeCount(anchorAudit.details_capped_omitted);
  const suffix = omitted && omitted > 0
    ? ` ${omitted} additional anchor${omitted === 1 ? " was" : "s were"} compacted; the captured total is ${anchorCount ?? "unknown"}.`
    : "";
  return `\n\n**Blueprint Resource Anchors**\n${lines.join("\n")}${suffix}`;
}

/** Format a runtime proxy audit without turning a partial replication sample into a census. */
function formatBlueprintPlacementAudit(result) {
  const subject = result.blueprint_name
    ? `**${result.blueprint_name}**`
    : "the aimed native Blueprint instance";

  if (!result.available) {
    const reason = result.reason ?? "unknown";
    return `I can't audit ${subject}: **${reason}**. ` +
      "Aim at the placed native Blueprint proxy or one of its actor-backed members and ask again. " +
      "This did not read a saved .sbp file or change the world.";
  }

  if (!result.inspection_complete) {
    const observed = result.observed ?? {};
    const members = auditWholeCount(observed.member_count_observed);
    const extractors = auditWholeCount(observed.extractor_count_observed);
    const lightweightExtractors = auditWholeCount(observed.lightweight_extractor_count_uninspected);
    const observedText = [
      members === null ? null : `${members} member${members === 1 ? "" : "s"} observed`,
      extractors === null ? null : `${extractors} resource extractor${extractors === 1 ? "" : "s"} observed`,
    ].filter(Boolean).join(", ");
    if (result.replication_state !== "replication_pending" && lightweightExtractors !== null && lightweightExtractors > 0) {
      return `${subject} is fully registered, but ${lightweightExtractors} resource extractor` +
        `${lightweightExtractors === 1 ? " is" : "s are"} stored as lightweight Blueprint members. ` +
        "The game's public aim API cannot resolve those bindings, so they remain unknown — not unbound. " +
        (observedText ? `The partial observation contains ${observedText}. ` : "") +
        "This was read-only; nothing changed in the world.";
    }
    const state = result.replication_state === "replication_pending"
      ? "is still replicating"
      : "is not yet complete";
    return `${subject} ${state}.` +
      (observedText ? ` The game has only a partial observation (${observedText}),` : "") +
      " so that is not proof of zero miners or an unbound miner. Wait for the Blueprint to settle, aim at it again, and re-run the audit. " +
      "This was read-only; nothing changed in the world.";
  }

  const total = auditWholeCount(result.extractor_count);
  const counts = result.extractor_binding_counts ?? {};
  const bound = auditWholeCount(counts.bound);
  const unbound = auditWholeCount(counts.unbound);
  const pending = auditWholeCount(counts.replication_pending);
  const unknown = auditWholeCount(counts.unknown);
  if (total === null || bound === null || unbound === null || pending === null || unknown === null) {
    return `${subject} is registered and ready, but the captured extractor totals are incomplete. ` +
      "I cannot prove whether its miners are bound from this snapshot. This was read-only; nothing changed.";
  }
  const resourceAnchorText = formatBlueprintResourceAnchorAudit(result.resource_anchor_audit);
  if (total === 0) {
    return `${subject} is fully registered and contains **0 resource extractors**. ` +
      "There are no miner bindings to inspect on this runtime instance." + resourceAnchorText +
      "\n\nThis inspected the placed runtime Blueprint only; it did not change the world.";
  }

  const summary = [
    `${bound} bound`,
    `${unbound} unbound`,
    `${pending} replication-pending`,
    `${unknown} unknown`,
  ].join(", ");
  const detailLines = (result.extractors ?? [])
    .filter((extractor) => extractor && typeof extractor === "object")
    .slice(0, 6)
    .map((extractor) => {
      const name = extractor.actor_name ?? extractor.actor_id ?? "Unnamed extractor";
      if (extractor.binding_state === "bound") {
        const resource = extractor.resource_name ?? extractor.resource_class;
        const anchor = extractorHasReturnedExactResourceAnchorBinding(
          extractor,
          result.resource_anchor_audit,
        ) ? " via its exact Resource Anchor" : "";
        return resource
          ? `- **${name}** → **${resource}**${anchor}`
          : `- **${name}** → bound resource${anchor} (resource class was not captured)`;
      }
      if (extractor.binding_state === "unbound") return `- **${name}** → unbound`;
      if (extractor.binding_state === "replication_pending") return `- **${name}** → replication pending (not a failure)`;
      return `- **${name}** → unknown${extractor.reason ? ` (${extractor.reason})` : ""}`;
    });
  const detailsReturned = auditWholeCount(result.extractor_details_returned);
  const omitted = auditWholeCount(result.extractor_details_capped_omitted);
  const detailCaveat =
    omitted && omitted > 0
      ? ` The game returned details for ${detailsReturned ?? detailLines.length} and compacted ${omitted}; the totals above still cover all ${total}.`
      : "";
  const pendingCaveat = pending > 0 || unknown > 0
    ? " Pending or unknown bindings are not treated as unbound."
    : "";
  return `${subject} is fully registered with **${total} resource extractor${total === 1 ? "" : "s"}**: ${summary}.` +
    detailCaveat + pendingCaveat + resourceAnchorText +
    (detailLines.length > 0 ? `\n\n${detailLines.join("\n")}` : "") +
    "\n\nThis inspected the placed runtime Blueprint only; it did not change the world.";
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

// Qualifiers stack in real speech, so they repeat here rather than being
// listed as two optional slots. "clear my overlays" and "clear all my
// highlights" both failed on `(?:the\s+)?(?:all\s+)?`, which is the same fault
// CLEAR_WAYPOINTS above was already fixed for -- it was fixed in one place and
// not the other.
const CLEAR_PATTERNS = [
  /^(?:can you |could you |please )?(?:clear|remove|hide|delete|turn off|get rid of)\s+(?:(?:my|the|all|every|any)\s+)*(?:overlays?|highlights?|markers?|tracers?|lines?)\b/i,
];

export function parseClearRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return CLEAR_PATTERNS.some((pattern) => pattern.test(text)) ? { all: true } : null;
}

/**
 * "clear holograms", "get rid of the stuck hologram".
 *
 * A preview left in the world after a refused placement, which the owner met as
 * a hologram stuck to the cursor. Its own parser now, rather than an inline
 * regex in the route, so it can be tested without driving the whole router.
 */
const CLEAR_HOLOGRAMS =
  /^(?:can you |could you |please )?(?:clear|remove|delete|get rid of|sweep(?:\s+up)?)\s+(?:(?:my|the|all|every|any|stuck|stray|leftover)\s+)*holo(?:gram)?s?\b/i;

export function parseClearHologramRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return CLEAR_HOLOGRAMS.test(text);
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
 * "waypoint here", "mark this spot", "drop a pin where I'm standing".
 *
 * The most obvious waypoint request there is, and it was the one thing the
 * route could not do. "put a waypoint here" fell through to a model — which is
 * how the owner ended up with a copilot transcript flatly denying that
 * waypoints were possible — and "mark this spot" was claimed by the overlay
 * route, which went looking for buildings *named* "this spot" and found none.
 *
 * There is nothing to look up: the position is the aim point, or the player's
 * feet when they are not aiming at anything.
 */
const WAYPOINT_HERE =
  /^(?:this|here|it|that)?\s*(?:spot|place|position|location|point)?\s*$|^(?:where|wherever)\s+i(?:'m|m| am)?\s*(?:standing|looking|aiming|at)?\s*$|^my\s+(?:position|location|feet|spot)\s*$/i;

/**
 * "place waypoint and name it concrete", "waypoint here called coal".
 *
 * One request, not two — the marker has always had a name field. Checked
 * before the multi-clause guard would otherwise hand the "and" to a model.
 */
const WAYPOINT_NAMED_HERE =
  /^(?:can you |could you |please )?(?:place|drop|add|set|put|create|make)?\s*(?:a\s+|an\s+|the\s+)?way\s?point\s*(?:here|at this spot|on this spot)?\s*(?:,\s*)?(?:and\s+)?(?:name|call|label)\s+(?:it|this|that)\s+(.+?)\s*$/i;

/** "mark this spot", "drop a pin here" — the same request, other words. */
const WAYPOINT_HERE_PHRASE =
  /^(?:can you |could you |please )?(?:mark|pin|flag|note|remember|save|drop a pin(?:\s+(?:on|at|in))?|put a pin(?:\s+(?:on|at|in))?|set a marker(?:\s+(?:on|at|in))?)\s+(?:me\s+)?(this|here|this spot|this place|this position|my position|where i(?:'m|m| am)?(?:\s+(?:standing|looking|aiming))?)\s*$/i;

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

/**
 * "what can I undo", "what did you just do", "what have you built".
 *
 * The last two are the same question asked about the other party: the journal
 * is the only record of what this copilot changed, so "what did I just do" and
 * "show me what you did" want exactly what "what can I undo" returns. They
 * were reaching a model, which has no journal to read and would answer from
 * the chat transcript instead — plausible, and not the same thing.
 */
const UNDO_HISTORY =
  /\b(?:what|anything)\b.*\bundo\b|\bundo\s+(?:history|list|stack)\b|\bwhat did (?:you|i|we)\s+(?:just\s+)?(?:do|change|build|place)\b|\bwhat have (?:you|we)\s+(?:just\s+)?(?:done|built|changed|placed)\b|\bshow me what (?:you|we)\s+(?:did|built|changed)\b/i;

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
  /^(?:can you |could you |please )?(?:(design|plan|lay ?out)|(build|make|construct|spawn|create))(?:\s+me)?(?:\s+(?:a|an|the))?(?:\s+(?:new|whole|complete|full))?(?:\s+\d+[- ]?(?:storey|story|storeys|stories|floor|floors|level|levels|tier|tiers))?\s+(?:factory\s+blueprint|base\s+blueprint|blue\s?print|base|factory|setup|production(?:\s+line)?|line|module)\s+/i;

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
    ...(/\bblue\s?print\b/i.test(text) ? { as_blueprint: true } : {}),
    raw_text: text,
  };
}

/**
 * "build a wire factory using all mk1 parts on this node".
 *
 * Both the tier and aimed-node phrase are mandatory. Without either, choosing
 * a source rate or transport tier would be an assumption, so the general
 * planner/model keeps the request. The pattern is fully anchored so a second
 * instruction cannot be silently ignored after an expensive write.
 */
const AIMED_MK1_FACTORY =
  /^(?:can you |could you |please )?(?:build|make|construct|spawn)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(.+?)\s+factory\s+using\s+(?:all\s+)?(?:mk\.?\s*1|mark\s*1)\s+parts\s+(?:on|from)\s+this\s+node$/i;

/**
 * The same request without the tier spelled out: "build me a wire factory from
 * this node".
 *
 * The anchored pattern above requires "using mk1 parts", and the owner does not
 * type that. The strict form stays exactly as it is; this is a second, wider
 * door onto the same planner.
 *
 * Leaving the tier unsaid is not the same as the tier being unknown. There is
 * only one factory planner and it builds the Mk.1 chain, so the honest handling
 * is to build that and *say* it was Mk.1 — the reply names the tier, which is
 * what "do not assume" actually requires. Silently picking a tier the player
 * cannot see would be the thing to avoid.
 */
const AIMED_FACTORY_LOOSE =
  /^(?:can you |could you |please )?(?:build|buld|biuld|make|construct|spawn|set\s*up)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(.+?)\s+(?:factory|plant|line)\s+(?:on|from|at|off(?:\s+of)?|using)\s+(?:this|the|that)\s+(?:node|resource|ore|deposit|one)$/i;

export function parseAimedMk1FactoryRequest(question) {
  const rawText = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const text = stripBeltClause(rawText);
  const match = text.match(AIMED_MK1_FACTORY);
  if (!match) return null;
  const item = match[1].replace(/\s+/g, " ").trim();
  return item.length >= 2
    ? { item, commit: true, skip_belts: NO_BELTS.test(rawText), raw_text: rawText }
    : null;
}

/**
 * "...without belts", "no belts", "skip the belts", "i'll belt it myself".
 *
 * The belt executor has never once committed, and a whole-plan rollback means
 * one refused belt takes 29 correctly-placed buildings with it. The machines
 * and their recipes are the part worth having; dragging a belt is ten seconds
 * of play. So let the player say so and keep the rest.
 */
const NO_BELTS =
  /\b(?:no|without|skip|omit|exclude|minus)\s+(?:the\s+)?(?:belts?|conveyors?)\b|\bbelts?\s+(?:myself|by hand|manually)\b|\bi(?:'ll|ll| will)\s+(?:do|place|add|run)\s+(?:the\s+)?belts?\b/i;

function stripBeltClause(text) {
  return text
    .replace(NO_BELTS, "")
    // "I'll do the belts myself" leaves a trailing "myself" that breaks the
    // anchored tail, so the leftovers of the clause go with it.
    .replace(/\b(?:myself|by hand|manually|later|after)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[,;]+\s*$/, "")
    .trim();
}

export function parseAimedFactoryRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  // The strict route owns anything that already names the tier.
  if (parseAimedMk1FactoryRequest(text)) return null;
  // Strip the belt clause before matching, so the anchored tail still lines up.
  const withoutBeltClause = stripBeltClause(text);
  const match = withoutBeltClause.match(AIMED_FACTORY_LOOSE);
  if (!match) return null;

  const item = match[1].replace(/\s+/g, " ").replace(/\b(?:mk\.?\s*\d|mark\s*\d)\b/gi, "").trim();
  if (item.length < 2) return null;
  // "modular" belongs to the blueprint tiler, not the production planner.
  if (/\bmodular\b/i.test(item)) return null;
  return {
    item,
    commit: true,
    tier_was_stated: false,
    skip_belts: NO_BELTS.test(text),
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
 * "build me a 4x3 modular base here".
 *
 * The owner's library holds a real tileset — C corners, M middles, IN/IC inner
 * parts, all 5x5 — and each piece is a blueprint. A blueprint is placed as one
 * hologram, so the game resolves its internals itself and it brings its own
 * foundations. That is why this route exists: the piece-by-piece path loses to
 * uneven ground, and this one does not care what the rock underneath looks
 * like.
 */
const MODULAR_VERB = /\b(?:build|buld|biuld|make|lay|place|put|start|design)\b/i;
const MODULAR_SUBJECT = /\bmodular\b|\bmodules?\b/i;
const MODULAR_SIZE = /\b(\d{1,2})\s*(?:x|by)\s*(\d{1,2})\b/i;
const MODULAR_HERE =
  /\b(?:here|at this|on this|where i(?:'m|m| am)?\s+(?:looking|standing|aiming)|my crosshair)\b/i;

export function parseModularShellRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  if (!MODULAR_SUBJECT.test(text)) return null;
  if (/^(?:what|which|how|why|is|are|does|do|can)\b/i.test(text)) return null;
  if (!MODULAR_VERB.test(text)) return null;

  const size = text.match(MODULAR_SIZE);
  return {
    width_modules: size ? Number(size[1]) : null,
    depth_modules: size ? Number(size[2]) : null,
    at_aim: MODULAR_HERE.test(text),
  };
}

/**
 * "save this as mk1 copper node blueprint", "place mk1 copper node here".
 *
 * A design is what is standing near the crosshair, remembered by name and
 * replayable somewhere else. Not a `.sbp` — see designs.mjs for why that would
 * be more work for less.
 */
const DESIGN_SAVE =
  /^(?:can you |could you |please )?(?:save|remember|store|record)\s+(?:this|these|it|everything(?:\s+here)?|the\s+\w+)?\s*(?:as|called|named)\s+(?:a\s+|the\s+)?["']?(.+?)["']?(?:\s+blue\s?print)?$/i;
const DESIGN_PLACE =
  /^(?:can you |could you |please )?(?:place|build|put|spawn|stamp|drop)\s+(?:down\s+)?(?:the\s+|a\s+|my\s+)?["']?(.+?)["']?(?:\s+design|\s+blue\s?print)?\s+(?:here|down|on this (?:node|spot|foundation)|at this|where i(?:'m|m| am)?\s+(?:looking|standing|aiming))$/i;
const DESIGN_LIST = /\b(?:list|show|what)\b[^?]*\b(?:designs?|saved builds?)\b/i;
const DESIGN_RADIUS = /\bwithin\s+(\d{1,4})\s*m\b/i;

/**
 * "rotated 90", "turned right", "half turn" — turning a design as it goes down.
 *
 * Stripped out of the phrase before the place pattern runs, the same way the
 * radius is, because that pattern anchors on the phrase ending in "here" or
 * "on this node".
 *
 * Relative turns only, which is why the COMPASS table further down is not
 * reused here. A single building has one facing, so "facing north" names an
 * absolute yaw for it. A design has as many facings as it has buildings, and
 * there is no honest answer to which one the compass word is about — so a
 * design is turned *by* an angle, never *to* a bearing.
 *
 * "Right" is a quarter turn clockwise seen from above, the direction UE's yaw
 * increases in. The reply states the angle it used, so a wrong reading of the
 * phrase shows up on the first placement rather than silently.
 */
const DESIGN_TURN =
  /\b(?:rotate[d]?|turn(?:ed)?|facing|spun)\s+(?:it\s+|by\s+)?(-?\d{1,3})\s*(?:deg(?:ree)?s?|°)?\b/i;
const DESIGN_TURN_WORDS =
  /\b(?:(quarter|half|three[- ]quarter)\s+turn|(?:rotate[d]?|turn(?:ed)?|spun)\s+(?:it\s+)?(right|left|around|clockwise|anti[- ]?clockwise|counter[- ]?clockwise))\b/i;

function designTurnDegrees(text) {
  const numeric = text.match(DESIGN_TURN);
  if (numeric) return { degrees: Number(numeric[1]), phrase: numeric[0] };

  const words = text.match(DESIGN_TURN_WORDS);
  if (!words) return null;
  const amount = String(words[1] ?? "").toLowerCase();
  const direction = String(words[2] ?? "").toLowerCase();
  if (amount === "quarter") return { degrees: 90, phrase: words[0] };
  if (amount === "half") return { degrees: 180, phrase: words[0] };
  if (amount === "three quarter" || amount === "three-quarter") return { degrees: 270, phrase: words[0] };
  if (direction === "right" || direction === "clockwise") return { degrees: 90, phrase: words[0] };
  if (direction === "left" || /clockwise$/.test(direction)) return { degrees: 270, phrase: words[0] };
  if (direction === "around") return { degrees: 180, phrase: words[0] };
  return null;
}

export function parseDesignSaveRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const radius = text.match(DESIGN_RADIUS);
  const withoutRadius = text.replace(DESIGN_RADIUS, "").replace(/\s{2,}/g, " ").trim();
  const match = withoutRadius.match(DESIGN_SAVE);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, " ").trim();
  if (name.length < 2) return null;
  return { name, radius_cm: radius ? Number(radius[1]) * 100 : null };
}

/**
 * "…but ignore the foundations", "…without the walls".
 *
 * Asked twice in the routing log — "place mk1 copper v2 on this node but
 * ignore the foundations" and "place everything ignore the belts" — and both
 * went to a model, which cannot place anything. Belts are excluded already
 * because they cannot be replayed at all; this is the player choosing to leave
 * out something that *could* be.
 *
 * Stripped before the place pattern runs, like the turn clause, because that
 * pattern anchors on the phrase ending in a location.
 */
const DESIGN_WITHOUT =
  /\s*(?:,\s*)?(?:but\s+)?(?:without|ignore|skip|omit|leave out|no)\s+(?:the\s+|any\s+|all\s+)?(foundations?|walls?|pillars?|ramps?|floors?|railings?|beams?|power poles?|poles?|storage(?:\s+containers?)?|containers?)\b/i;

export function parseDesignPlaceRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const omit = text.match(DESIGN_WITHOUT);
  const withoutOmission = omit ? text.replace(omit[0], " ").replace(/\s{2,}/g, " ").trim() : text;

  const turn = designTurnDegrees(withoutOmission);
  const withoutTurn = turn
    ? withoutOmission.replace(turn.phrase, "").replace(/\s{2,}/g, " ").trim()
    : withoutOmission;
  const match = withoutTurn.match(DESIGN_PLACE);
  if (!match) return null;
  const name = match[1]
    .replace(/\s+/g, " ")
    .replace(/\b(?:design|blue\s?print)\b/i, "")
    // "place mk1 copper here on this node" is in the routing log. The pattern
    // anchors on the phrase *ending* in a location, so a second location word
    // in the middle stayed in the name and "mk1 copper here" matched nothing.
    // People say it twice; the name is what is left after both.
    .replace(/\s+(?:here|down|at this|on this (?:node|spot|foundation))\s*$/i, "")
    .trim();
  if (name.length < 2) return null;
  return {
    name,
    rotation_degrees: turn ? turn.degrees : 0,
    // Singularised, so "foundations" and "foundation" are the same request.
    omit: omit ? omit[1].toLowerCase().replace(/s$/, "") : null,
  };
}

/**
 * "delete the mk2 design", "rename mk1 copper to copper starter".
 *
 * Housekeeping for a library that only ever grew. Nothing is destroyed —
 * see `retireDesign` — so the verb the player used is honoured while the file
 * is only moved, and the reply says where it went.
 *
 * Both patterns require the word "design" or "blueprint" somewhere, because
 * "delete the smelter" is a dismantle and mistaking one for the other is the
 * kind of error the dismantle route is deliberately paranoid about.
 */
const DESIGN_RETIRE =
  /^(?:can you |could you |please )?(?:delete|remove|retire|forget|drop|get rid of)\s+(?:the\s+|my\s+|that\s+)?["']?(.+?)["']?\s*(?:design|blue\s?print|saved build)\s*$/i;
const DESIGN_RENAME =
  /^(?:can you |could you |please )?(?:rename|call)\s+(?:the\s+|my\s+)?["']?(.+?)["']?\s*(?:design|blue\s?print|saved build)?\s+(?:to|as)\s+["']?(.+?)["']?\s*$/i;

export function parseDesignRetireRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(DESIGN_RETIRE);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, " ").trim();
  return name.length >= 2 ? { name } : null;
}

export function parseDesignRenameRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(DESIGN_RENAME);
  if (!match) return null;
  const from = match[1].replace(/\s+/g, " ").trim();
  const to = match[2].replace(/\s+/g, " ").replace(/\b(?:design|blue\s?print)\b/i, "").trim();
  return from.length >= 2 && to.length >= 2 ? { from, to } : null;
}

export function parseDesignListRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return DESIGN_LIST.test(text) ? {} : null;
}


/**
 * "clone this 5 times", "copy this smelter 3 more times".
 *
 * Stamping out what is already built, which is how a manifold gets made. The
 * crosshair is the selection: the snapshot reports what the player is aiming
 * at, and that building's own capture supplies the recipe, the facing, and the
 * measured footprint the copies are spaced by.
 */
const CLONE_VERB = /\b(?:clone|copy|duplicate|repeat|stamp|mirror)\b/i;
const CLONE_COUNT = /\b(\d{1,2})\s*(?:more\s*)?(?:times|copies|more|x)\b|\bx\s*(\d{1,2})\b/i;
const CLONE_FORWARD = /\b(?:in front|forward|ahead|in a line forward|behind)\b/i;

export function parseCloneRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  if (!CLONE_VERB.test(text)) return null;
  if (/^(?:what|which|how|why|is|are|does|do|can)\b/i.test(text)) return null;
  // A blueprint is copied by placing it, not by cloning an actor.
  if (/\bblue\s?print\b/i.test(text)) return null;

  const count = text.match(CLONE_COUNT);
  return {
    count: count ? Number(count[1] ?? count[2]) : null,
    direction: CLONE_FORWARD.test(text) ? "forward" : "side",
  };
}

/**
 * "place the coal power plant blueprint here".
 *
 * The mod has had `place_blueprint` all along and nothing could reach it: the
 * same gap that made "list blueprints" answer from a model rather than from the
 * folder on disk.
 *
 * This matters more than a convenience route. A blueprint is placed as one
 * hologram, so the game resolves every belt and pipe inside it and it carries
 * its own foundations — which is the way past both live blockers at once, the
 * conveyor aim refusal and uneven ground.
 */
// "build" is deliberately absent. "build me a storage hub here" is a builder
// route, and a verb list that swallows it turns a working request into a
// blueprint lookup that was never going to match.
const BLUEPRINT_PLACE =
  /^(?:can you |could you |please )?(?:place|put|drop|spawn|stamp)\s+(?:down\s+)?(?:the\s+|a\s+|an\s+|my\s+)?(.+?)(?:\s+blue\s?print)?\s+(?:here|down|at this|on this|where i(?:'m|m| am)?\s+(?:looking|standing|aiming))$/i;

const BLUEPRINT_PREVIEW =
  /^(?:can you |could you |please )?(?:preview|arm|select)\s+(?:the\s+|a\s+|an\s+|my\s+)?(.+?)(?:\s+blue\s?print)?(?:\s+(?:in|with)\s+(?:my\s+)?build\s?gun)?$/i;
export function parseBlueprintPreviewRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || !/\b(?:blue\s?print|build\s?gun)\b/i.test(text)) return null;
  const match = text.match(BLUEPRINT_PREVIEW);
  if (!match) return null;
  const name = match[1]
    .replace(/\bblue\s?print\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return name.length >= 2 ? { name } : null;
}

// This is a runtime-instance audit, not a saved-blueprint lookup. Keep the
// phrasings anchored so "inspect blueprint Coal Plant" remains a disk layout
// request and never gets silently redirected to the thing under the crosshair.
const BLUEPRINT_PLACEMENT_AUDIT_REQUEST = [
  /^(?:can you |could you |please )?audit (?:this|that) (?:native )?blue\s?print(?: placement)?$/i,
  /^(?:can you |could you |please )?audit (?:this|that) (?:native )?blue\s?print(?:['’]s)? (?:resource )?anchor$/i,
  /^(?:can you |could you |please )?check (?:this|that) (?:native )?blue\s?print placement$/i,
  /^(?:can you |could you |please )?check (?:this|that) (?:native )?blue\s?print(?:['’]s)? (?:resource )?anchor$/i,
  /^(?:can you |could you |please )?is (?:this|that) (?:native )?blue\s?print(?:['’]s)? (?:miner|extractor) bound$/i,
  /^(?:can you |could you |please )?is (?:this|that) (?:native )?blue\s?print(?:['’]s)? (?:resource )?anchor (?:valid|configured|bound)$/i,
];

export function parseBlueprintPlacementAuditRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  return BLUEPRINT_PLACEMENT_AUDIT_REQUEST.some((pattern) => pattern.test(text)) ? {} : null;
}

export function parseBlueprintPlaceRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  // A real blueprint turns too, and it costs nothing to support: the action
  // has carried a yaw all along -- the validator emits it and the mod builds
  // FRotator(0, Yaw, 0) from it -- the router simply never set it. Same
  // stripping as the design route, and for the same reason: the pattern below
  // anchors on the phrase ending in "here".
  const turn = designTurnDegrees(text);
  const withoutTurn = turn
    ? text.replace(turn.phrase, "").replace(/\s{2,}/g, " ").trim()
    : text;
  const match = withoutTurn.match(BLUEPRINT_PLACE);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, " ").replace(/\bblue\s?print\b/i, "").trim();
  // No keyword blocklist. A blocklist here would have to guess which words can
  // appear in a saved blueprint's name, and it guessed wrong immediately: the
  // owner's file really is called "Coal power plant 2700MW v1.1". The library
  // is the authority instead — the route falls through when nothing matches, so
  // a phrase that belongs to another planner reaches it untouched.
  return name.length >= 2 ? { name, rotation_degrees: turn ? turn.degrees : 0 } : null;
}


/**
 * "select 120 m around me", "make it 200 wide", "select 150 x 80 x 60 here".
 *
 * The owner asked for something like SMART!'s preview: set a size, see what
 * would be caught, adjust, then commit. Clicking every piece of a megabase
 * with the dismantle tool is not a workflow.
 *
 * Two shapes. The first sets a box; the second resizes the one already shown,
 * which is the slider without a slider -- say a number, look, say another.
 */
const SELECT_BOX =
  /^(?:can you |could you |please )?(?:select|preview|show|mark|box)\s+(?:everything\s+)?(?:within\s+|inside\s+|in\s+)?(\d{1,4})\s*m?\b(?:\s*(?:x|by|\*)\s*(\d{1,4})\s*m?\b)?(?:\s*(?:x|by|\*)\s*(\d{1,4})\s*m?\b)?/i;
const SELECT_RESIZE =
  /^(?:can you |could you |please )?(?:make it|resize(?:\s+it)?|set(?:\s+it)?(?:\s+to)?|now)\s+(\d{1,4})\s*m?\b|^(\d{1,4})\s*m?$/i;
const SELECT_GROW =
  /^(?:can you |could you |please )?(bigger|wider|larger|smaller|tighter|narrower|taller|shorter)\b/i;

export function parseSelectBoxRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(SELECT_BOX);
  if (!match) return null;
  const width = Number(match[1]);
  if (!Number.isFinite(width) || width <= 0) return null;
  return {
    width_m: width,
    depth_m: match[2] ? Number(match[2]) : null,
    height_m: match[3] ? Number(match[3]) : null,
  };
}

export function parseSelectResizeRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const exact = text.match(SELECT_RESIZE);
  if (exact) {
    const width = Number(exact[1] ?? exact[2]);
    return Number.isFinite(width) && width > 0 ? { width_m: width } : null;
  }
  const relative = text.match(SELECT_GROW);
  if (!relative) return null;
  const word = relative[1].toLowerCase();
  // A step, not a jump: the point is to converge on a size by looking.
  if (/bigger|wider|larger/.test(word)) return { scale: 1.5 };
  if (/smaller|tighter|narrower/.test(word)) return { scale: 1 / 1.5 };
  if (word === "taller") return { height_scale: 1.5 };
  return { height_scale: 1 / 1.5 };
}
/**
 * "export this factory as blueprint Northern Steel Works".
 *
 * This is intentionally not another spelling of "save this as a design".
 * A saved design is a bridge-side replay list; this asks the game to make a
 * native `.sbp` through its own BlueprintSubsystem. The source is deliberately
 * strict as well: the player must mark every member with Satisfactory's
 * dismantle multi-select first. A radius is a guess at the factory boundary,
 * and an enormous factory makes that guess more dangerous, not less.
 */
// Widened from the original, which only accepted "export this factory as
// blueprint X". "save this selection as a blueprint called Mega Base" and
// "export selected as blueprint MegaBase" both failed -- the same narrowness
// the routing log kept exposing elsewhere. The noun is optional now, "save" is
// accepted alongside "export", and the article before "blueprint" may be there
// or not.
//
// "save" is the risky addition, because "save this as mk1 copper" is the
// *design* route. The word "blueprint" is what separates them and is required
// here; parseDesignSaveRequest strips a trailing "blueprint" and would
// otherwise claim these. Route order puts this first, and the design tests pin
// that their phrasings still reach them.
const NATIVE_BLUEPRINT_EXPORT =
  /^(?:can you |could you |please )?(?:export|package|save)\s+(?:this|the|my|these|selected|current)?\s*(?:factory|base|build|selection|megabase|mega\s?base|it)?\s*(?:as)?\s*(?:a\s+|an\s+)?(?:new\s+)?(?:native\s+|real\s+|game\s+)?blue\s?print(?:\s+(?:called|named|as))?\s+["']?(.+?)["']?$/i;

export function parseNativeBlueprintExportRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(NATIVE_BLUEPRINT_EXPORT);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, " ").trim();
  return name ? { name } : null;
}

/**
 * "list blueprints", "what blueprints do i have".
 *
 * Asked this with 55 blueprints on disk, the local model answered "the player
 * has not saved any blueprints yet" and explained how to save one. Nothing had
 * looked at the folder: no route matched, so the question reached a model that
 * cannot read files and answered from nothing.
 *
 * The solver already existed and works. Only the route was missing, which is
 * the worst version of this failure -- the right answer was one function call
 * away and the player was told the opposite.
 */
const BLUEPRINT_LIST =
  /\b(?:list|show|what|which|any|see|got|have)\b[^?]*\bblue\s?prints?\b|\bblue\s?prints?\b[^?]*\b(?:do i have|available|saved|list|named|called|with|containing|matching)\b/i;
const BLUEPRINT_LIST_EXCLUDED =
  // Placing, building or costing one is a different request with its own route.
  /\b(?:place|build|put|spawn|drop|construct|cost|price|delete|remove|save)\b/i;

export function parseBlueprintListRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  if (!BLUEPRINT_LIST.test(text)) return null;
  if (BLUEPRINT_LIST_EXCLUDED.test(text)) return null;

  // "blueprints with coal in the name" narrows the list rather than dumping it.
  const filter = text.match(/\b(?:named|called|with|containing|matching|for)\s+"?([a-z0-9 _-]{2,40}?)"?\s*(?:in (?:the|its) name)?$/i);
  return { name_contains: filter ? filter[1].trim() : null };
}

// This is deliberately narrower than the list route. It reads one exact saved
// name, never a disk path, and has no placement/export verb; all build actions
// retain their own confirmation and validation paths.
const BLUEPRINT_LAYOUT_REQUEST = [
  /^(?:please\s+)?(?:inspect|analyse|analyze|read)\s+(?:the\s+)?(?:layout|structure|contents)?\s*(?:of\s+)?(?:the\s+)?blue\s?print\s+["']?(.+?)["']?$/i,
  /^(?:please\s+)?(?:show|what(?:'s| is))\s+(?:the\s+)?(?:layout|structure|contents|inside)\s+(?:of\s+)?(?:the\s+)?blue\s?print\s+["']?(.+?)["']?$/i,
];

export function parseBlueprintLayoutRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  const match = BLUEPRINT_LAYOUT_REQUEST.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const blueprintName = match[1].replace(/\s+/g, " ").trim();
  // A returned library reference may contain forward slashes, but it is never
  // resolved as a path. Block absolute and dot-segment spellings anyway so the
  // local route cannot even express a traversal-shaped request.
  const unsafeReference =
    /(^|[\\/])\.\.?(?:[\\/]|$)/.test(blueprintName) ||
    /^[\\/]/.test(blueprintName) ||
    /^[A-Za-z]:[\\/]/.test(blueprintName) ||
    blueprintName.includes("\\");
  if (!blueprintName || blueprintName.length > 240 || unsafeReference) return null;
  return { blueprint_name: blueprintName };
}

// "compare blueprint <left> with blueprint <right>" — a deliberately
// explicit local route. Blueprint names are matched by the read-only library
// adapter; this parser never accepts paths or turns an arbitrary comparison
// question into a style judgement.
const BLUEPRINT_COMPARISON_REQUEST = [
  /^(?:please\s+)?compare\s+(?:the\s+)?blue\s?print\s+["']?(.+?)["']?\s+(?:with|against|to|and)\s+(?:the\s+)?blue\s?print\s+["']?(.+?)["']?$/i,
  /^(?:please\s+)?compare\s+["']?(.+?)["']?\s+blue\s?print\s+(?:with|against|to|and)\s+["']?(.+?)["']?\s+blue\s?print$/i,
];

function cleanBlueprintComparisonName(value) {
  const name = String(value ?? "").replace(/["']+$/g, "").replace(/^["']+/g, "").replace(/\s+/g, " ").trim();
  const unsafeReference =
    /(^|[\\/])\.\.?([\\/]|$)/.test(name) ||
    /^[\\/]/.test(name) ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.includes("\\");
  return name && name.length <= 240 && !unsafeReference ? name : null;
}

export function parseBlueprintComparisonRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  const match = BLUEPRINT_COMPARISON_REQUEST.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const left = cleanBlueprintComparisonName(match[1]);
  const right = cleanBlueprintComparisonName(match[2]);
  return left && right ? { left_blueprint_name: left, right_blueprint_name: right } : null;
}

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

  // "place waypoint and name it concrete" is in the routing log, answered by a
  // model because MULTI_CLAUSE sees the "and" and steps aside. It is not two
  // requests: it is one waypoint with a label, and the map marker has carried
  // a name field the whole time.
  const named = text.match(WAYPOINT_NAMED_HERE);
  if (named) {
    const label = named[1].replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
    if (label.length >= 2) return { kind: "here", target: "here", name: label };
  }

  // "mark this spot" and friends, before anything tries to look up a building
  // called "this spot".
  if (WAYPOINT_HERE_PHRASE.test(text)) return { kind: "here", target: "here" };

  let target = null;
  const alt = text.match(WAYPOINT_ALT);
  if (alt) target = alt[1].trim();
  else if (WAYPOINT_VERB.test(text)) target = text.replace(WAYPOINT_VERB, "").trim();
  // "waypoint" on its own, or "waypoint here": the verb consumed the whole
  // phrase, which means the player is asking about where they already are.
  if (WAYPOINT_VERB.test(text) && WAYPOINT_HERE.test(target ?? "")) {
    return { kind: "here", target: "here" };
  }
  if (!target) return null;

  // "the best hub location" is not a name to look up — it is the site solver's
  // output, which is already computed locally.
  if (WAYPOINT_BEST_SITE.test(target)) return { kind: "best_site", target };

  while (LOCATE_LEADING_ARTICLE.test(target)) {
    target = target.replace(LOCATE_LEADING_ARTICLE, "").trim();
  }
  // "waypoint nearest source of biomass" is in the routing log, answered by a
  // model. "source of" carries no search value -- the thing being looked for
  // is what follows it -- and leaving it in made the lookup search for a
  // building called "source of biomass".
  target = target.replace(/^(?:source|supply|deposit)\s+of\s+/i, "").trim();
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
 * "what can you do", "help".
 *
 * The first thing anyone asks, and it was reaching a model — which has to
 * guess at its own capabilities and gets it wrong in the expensive direction.
 * That is not hypothetical: the owner's waypoint complaint was a transcript of
 * this copilot flatly denying it could place waypoints, while the action to do
 * it had been shipped for weeks.
 *
 * So the answer is a fixed list, and `test/capabilities.test.mjs` runs every
 * example in it back through the router. A phrase listed here that no parser
 * accepts fails the suite. The list cannot promise something the copilot will
 * not do, which is the only way a hand-written list is worth having.
 */
const WHAT_CAN_YOU_DO =
  /^(?:can you |could you |please )?(?:help|halp|\?+|what can (?:you|u) do|what do you do|what can i (?:ask|say|do)|what are (?:you|your) (?:able to do|capable of|abilities|commands|features)|what commands|list (?:your )?commands|how do i use (?:you|this)|what is this)\s*\??$/i;

export function parseCapabilityRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return WHAT_CAN_YOU_DO.test(text) ? {} : null;
}

/**
 * Grouped so the answer reads as a menu rather than a wall.
 *
 * Every phrase is exercised by the test. Adding one here without making it
 * work is a failing build, not a disappointed player.
 */
export const CAPABILITY_EXAMPLES = [
  ["Look at your world", [
    "what have i built",
    "how many smelters do i have",
    "what am i looking at",
    "what is this making",
    "where am i",
    "what tier am i",
    "what is my bottleneck",
    "is anything backed up",
  ]],
  ["Ask about recipes and costs", [
    "how much does a smelter cost",
    "what uses iron ore",
    "how do i make steel ingot",
  ]],
  ["Find and mark things", [
    "show me every coal node within 200 m",
    "how far is the coal node",
    "waypoint here",
    "where should i put my hub",
    "clear my overlays",
  ]],
  ["Build", [
    "place a mk1 miner on this node facing north",
    "build a wire factory on this node",
    "belt the smelter to the constructor",
    "clone this 5 times",
  ]],
  ["Save and stamp a layout", [
    "save this as mk1 copper",
    "place mk1 copper on this node rotated 90",
    "list designs",
    "rename mk1 copper to copper starter",
    "delete the mk1 copper design",
  ]],
  ["Fix and reverse", [
    "undo",
    "what can i undo",
    "clear holograms",
    "dismantle Build_SmelterMk1_C_9",
  ]],
];

/**
 * "where am I", "what am I looking at", "how many smelters do I have".
 *
 * Three questions a player asks constantly, and all three were reaching a
 * model. None of them contains anything to reason about: the player's position
 * and the crosshair target are fields in the snapshot, and a count is a count.
 * Paying per request to have the capture read back is the exact thing the
 * deterministic routes exist to stop.
 */
// "whats" and "wheres" without the apostrophe are how people actually type,
// so the apostrophe is optional rather than required.
const WHERE_AM_I =
  /^(?:can you |could you |please )?(?:where(?:'?s| is| am)?\s+(?:i|me|my\s+(?:position|location))|what(?:'?s| is| are)?\s+my\s+(?:position|location|co-?ordinates|coords)|my\s+(?:position|location|co-?ordinates|coords))\b/i;

const WHAT_AM_I_LOOKING_AT =
  /^(?:can you |could you |please )?(?:what(?:'?s| is| am)?\s+(?:i\s+)?(?:looking at|aiming at|pointing at|under (?:my|the) (?:crosshair|cursor|reticle))|what(?:'?s| is)?\s+(?:this|that)\s*(?:thing)?)\s*\??$/i;

const HOW_MANY =
  /^(?:can you |could you |please )?(?:how many|count(?:\s+(?:my|the|all))?)\s+(.+?)(?:\s+(?:do|have)\s+i\s+(?:have|own|got)|\s+do\s+i\s+have|\s+i\s+have)?\s*$/i;

export function parseWhereAmIRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return WHERE_AM_I.test(text) ? {} : null;
}

/**
 * "what resources are near me", "is my hub well placed", "survey this site".
 *
 * A radius may be given ("within 300m") and is honoured, but it can never
 * see further than the capture itself -- surveyResources reports the capture
 * radius so a caller cannot mistake "nothing captured" for "nothing there".
 */
const SITE_SURVEY =
  /^(?:can you |could you |please )?(?:(?:survey|assess|scout|check|rate|judge)\s+(?:this\s+|my\s+|the\s+)?(?:site|spot|location|area|base|hub|place)|(?:what|which)\s+(?:resources|nodes|ore|ores)\s+(?:are\s+)?(?:near|nearby|around|close to)\s*(?:me|here|us|my hub|the hub)?|(?:is|was)\s+(?:this|my|the)\s+(?:hub|base|site|spot|location)\s+(?:a\s+)?(?:good|bad|well|badly|poorly)\s*(?:place|placed|spot|choice|located)?|what(?:'s| is)\s+(?:around|near)\s+(?:me|here))\s*$/i;

const SURVEY_RADIUS = /(?:within|in|inside|under)\s+(\d{2,5})\s*(?:m|metres|meters)\b/i;

/**
 * "will the coal plant fit here", "can I build X here", "does X fit rotated 90".
 *
 * The blueprint name is taken verbatim from the question, because a library
 * reference can contain spaces and folders. Resolution is the inspector's job;
 * this only decides that the question is a fit question and pulls out a name
 * and an optional rotation.
 */
const SITE_FIT =
  /^(?:can you |could you |please )?(?:(?:will|would|does|can)\s+(?:the\s+|my\s+|a\s+)?(.+?)\s+fit(?:\s+here)?|(?:can|could)\s+i\s+(?:build|place|put)\s+(?:the\s+|my\s+|a\s+)?(.+?)\s+here)\s*$/i;

const FIT_ROTATION = /\b(?:rotated|turned|at)\s+(0|90|180|270)\s*(?:deg|degrees|°)?\b/i;

export function parseSiteFitRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const rotation = text.match(FIT_ROTATION);
  const bare = text.replace(FIT_ROTATION, "").replace(/\s{2,}/g, " ").trim();
  const match = bare.match(SITE_FIT);
  if (!match) return null;
  const name = (match[1] ?? match[2] ?? "").trim();
  if (name.length === 0) return null;
  // A pronoun means the name is in the conversation, which a model can resolve
  // and this route cannot. Declining sends it onward; answering "there is no
  // blueprint called it" would be true and useless.
  if (/^(?:it|this|that|the one|mine)$/i.test(name)) return null;
  return { blueprint: name, rotation_deg: rotation ? Number(rotation[1]) : 0 };
}

export function parseSiteSurveyRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const radius = text.match(SURVEY_RADIUS);
  // Strip the radius before matching the shape, so "what resources are near
  // me within 300m" routes the same as the bare question.
  const bare = text.replace(SURVEY_RADIUS, "").replace(/\s{2,}/g, " ").trim();
  if (!SITE_SURVEY.test(bare)) return null;
  return { radius_meters: radius ? Number(radius[1]) : null };
}

export function parseLookingAtRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return WHAT_AM_I_LOOKING_AT.test(text) ? {} : null;
}

/**
 * "how much does a smelter cost", "what does a constructor cost".
 *
 * `solveBuildCost` has existed the whole time and had no route to it, so the
 * question was going to a model that would answer from training — which is how
 * you get a confident cost for a building a mod changed. The catalogue in the
 * capture is the authority.
 */
const BUILD_COST =
  /^(?:can you |could you |please )?(?:how much (?:does|do|is|are)\s+|what (?:does|do)\s+|cost (?:of|for)\s+)(?:a\s+|an\s+|the\s+)?(?:(\d{1,3})\s+)?(.+?)(?:\s+cost)?\s*$/i;

export function parseBuildCostRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  // "cost" has to appear, or "how much is my power" becomes a build cost.
  if (!/\bcosts?\b/i.test(text)) return null;
  const match = text.match(BUILD_COST);
  if (!match) return null;

  let thing = match[2].replace(/\s+/g, " ").replace(/\bcosts?\b/gi, "").trim();
  while (LOCATE_LEADING_ARTICLE.test(thing)) thing = thing.replace(LOCATE_LEADING_ARTICLE, "").trim();
  thing = thing.replace(/\b(\w{4,})s\b/g, "$1");
  if (thing.length < 3) return null;
  return { thing, count: match[1] ? Number(match[1]) : 1 };
}

/**
 * "what can I make with iron", "what uses copper ore", "how do I make steel".
 *
 * `solveRecipeOptions` was in the same position: written, exposed to the model
 * as a tool, and unreachable by asking in words.
 */
const RECIPE_OPTIONS =
  /^(?:can you |could you |please )?(?:what (?:can i (?:make|craft|build)|recipes?)\s+(?:with|from|use[sd]?|need)\s+|what (?:uses|needs)\s+|how (?:do|can) i (?:make|craft|smelt)\s+|what (?:do i need|is needed) (?:for|to make)\s+|recipes? for\s+)(?:a\s+|an\s+|the\s+|some\s+)?(.+?)\s*$/i;

export function parseRecipeOptionsRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(RECIPE_OPTIONS);
  if (!match) return null;
  let thing = match[1].replace(/\s+/g, " ").trim();
  while (LOCATE_LEADING_ARTICLE.test(thing)) thing = thing.replace(LOCATE_LEADING_ARTICLE, "").trim();
  return thing.length >= 3 ? { thing } : null;
}

/**
 * "what is this making", "what is this machine producing".
 *
 * About the thing under the crosshair, so it needs no name — and the capture
 * already carries the recipe and the measured rate.
 */
const WHAT_IS_THIS_MAKING =
  /^(?:can you |could you |please )?what(?:'?s| is| are)?\s+(?:this|that|it)\s*(?:machine|building|one)?\s+(?:making|producing|running|on|set to|building|doing)\s*\??$/i;

export function parseWhatIsThisMakingRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  return WHAT_IS_THIS_MAKING.test(text) ? {} : null;
}

/**
 * "how far is the coal node", "distance to my hub".
 *
 * Pythagoras on two points the capture already holds. `solveActorLookup`
 * even computes the metres for us; this was only ever a routing gap.
 */
const HOW_FAR =
  /^(?:can you |could you |please )?(?:how far(?:\s+away)?\s+(?:is|are)\s+|how far\s+to\s+|distance\s+(?:to|from me to)\s+)(.+?)(?:\s+from\s+(?:me|here))?\s*$/i;

export function parseHowFarRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(HOW_FAR);
  if (!match) return null;

  let thing = match[1].replace(/\s+/g, " ").trim();
  while (LOCATE_LEADING_ARTICLE.test(thing)) thing = thing.replace(LOCATE_LEADING_ARTICLE, "").trim();
  return thing.length >= 2 ? { thing } : null;
}

export function parseHowManyRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  const match = text.match(HOW_MANY);
  if (!match) return null;

  let thing = match[1].replace(/\s+/g, " ").trim();
  while (LOCATE_LEADING_ARTICLE.test(thing)) thing = thing.replace(LOCATE_LEADING_ARTICLE, "").trim();
  // Trailing plural is dropped so "smelters" finds "Smelter". Only the simple
  // -s; anything cleverer starts mangling names like "Mk1 Bus".
  thing = thing.replace(/\b(\w{4,})s\b/g, "$1");
  if (thing.length < 3) return null;

  // A question about rates, power or the best of something is not a count, and
  // guessing that it is would answer confidently with a number nobody asked
  // for.
  if (/\b(?:power|mw|watt|item|per minute|ppm|resource|ore|point|ticket|coupon|slot|hour)\b/i.test(thing)) {
    return null;
  }
  return { thing };
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

/**
 * "x=372373.7, y=-153420.9, z=4006.0", or the same numbers bare.
 *
 * Both orders appear in the routing log because the owner tried the coordinate
 * first and the verb first, on separate attempts, when neither worked. Z is
 * optional: without it the teleport ground-snaps, which is what someone
 * copying a pair of numbers off a map wants.
 */
const LABELLED_COORDINATE = /\bx\s*[=:]\s*(-?\d+(?:\.\d+)?)[\s,]+y\s*[=:]\s*(-?\d+(?:\.\d+)?)(?:[\s,]+z\s*[=:]\s*(-?\d+(?:\.\d+)?))?/i;
const BARE_COORDINATE = /^(-?\d{3,}(?:\.\d+)?)[\s,]+(-?\d{3,}(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?$/;

export function parseCoordinateTriple(text) {
  const source = String(text ?? "");
  const match = source.match(LABELLED_COORDINATE) ?? source.trim().match(BARE_COORDINATE);
  if (!match) return null;

  const x = Number(match[1]);
  const y = Number(match[2]);
  const z = match[3] === undefined ? null : Number(match[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (z !== null && !Number.isFinite(z)) return null;
  return { target: { x, y, z: z ?? 0 }, had_z: z !== null };
}

export function parseTeleportRequest(question) {
  const text = String(question ?? "").trim().replace(/[?!.]+$/, "");
  if (!text || MULTI_CLAUSE.test(text)) return null;

  // The coordinate can come before the verb — "x=…, y=… teleport me here" is
  // in the log twice — so the whole phrase is checked before the verb is
  // required to lead.
  if (/\b(?:teleport|tp|warp)\b/i.test(text)) {
    const anywhere = parseCoordinateTriple(text);
    if (anywhere) return { kind: "coordinates", ...anywhere };
  }

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
  // A raw coordinate used to be sent to a model, on the reasoning that it
  // "deserves the plausibility conversation". The routing log says otherwise:
  // the owner asked three times in a row, phrased three different ways, and
  // never arrived. The conversation the model was supposed to add never
  // happened; the request just failed.
  //
  // The plausibility check is deterministic anyway — `validateAction` already
  // refuses a teleport beyond MAX_TELEPORT_METERS and warns when ground
  // snapping is off. So the coordinate is parsed here and the existing gate
  // does the judging.
  const coordinates = parseCoordinateTriple(target);
  if (coordinates) return { kind: "coordinates", ...coordinates };

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
      // "whats my tier" reached a model while "what tier am i" did not, which
      // is the sort of gap only trying the phrasings finds.
      "my tier", "which tier", "what milestone", "what phase", "my phase",
    ],
    extraFiller: ["tier", "tech", "unlocked", "unlock", "status", "recipes", "schematics", "many"],
    run: (graph) => solveUnlockStatus(graph),
    format: formatUnlocks,
  },
  {
    // The last solver with no way in. "Are my belts backed up" is a question
    // about measured segment occupancy, and the capture already carries it --
    // `available_space <= 0` is the game's own word for a full belt, not an
    // inference from throughput.
    name: "get_transport_capacity",
    patterns: [
      "are my belts full", "are my belts saturated", "is anything backed up",
      "is anything backing up", "which belts are saturated", "belt capacity",
      "are any belts at capacity", "is anything clogged", "belt saturation",
      "are my pipes full", "transport capacity", "are my belts keeping up",
    ],
    extraFiller: ["belt", "belts", "pipe", "pipes", "saturated", "capacity", "full", "clogged", "backed", "backing"],
    // Problems only. A hundred healthy belts is not an answer to "is anything
    // backed up", and the tool layer already defaults the same way.
    run: (graph) => solveTransportCapacity(graph, { only_problems: true }),
    format: formatTransport,
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

  // The exact live request that previously missed every route and spent 1.2M
  // tokens before returning a generic diagnostic. This is a fixed arithmetic
  // and topology problem: aimed node + explicit Mk.1 tier + catalog item.
  // The same planner, reached by the phrasing players actually use. The strict
  // route above keeps anything that already names a tier; this catches the rest
  // and the reply states the tier it built rather than leaving it implied.
  const aimedMk1Factory = parseAimedMk1FactoryRequest(question)
    ?? parseAimedFactoryRequest(question);
  if (aimedMk1Factory && graph) {
    const started = Date.now();
    const item = findItemByName(graph, aimedMk1Factory.item);
    if (!item) {
      return localAnswer(
        `I can't build that: **${aimedMk1Factory.item}** does not resolve to one unique item in the captured catalog.`,
        "aimed_mk1_wire_factory_refused",
        started,
        "The understood local route refused before any action was sent.",
      );
    }

    const target = solvePlacementTarget(graph, { kind: "aim" });
    const plan = planAimedMk1WireFactory(graph, {
      target,
      item,
      build_recipe_lookup: solveBuildRecipeLookup,
    });
    if (!plan.planned) {
      return localAnswer(
        `I can't build that Mk.1 factory: ${plan.reason}.`,
        "aimed_mk1_wire_factory_refused",
        started,
        "The understood local route refused before any action was sent.",
      );
    }

    // Drop the belts when asked. One refused belt rolls back every building
    // with it, and the machines with their recipes set are the part that is
    // hard to do by hand.
    const beltCount = plan.actions.filter((action) => action.action === "place_belt").length;
    const requestedActions = aimedMk1Factory.skip_belts
      ? plan.actions.filter((action) => action.action !== "place_belt")
      : plan.actions;

    const emitted = emitValidatedPlan(graph, services, requestedActions);
    if (emitted && aimedMk1Factory.skip_belts) {
      return localAnswer(
        `Building the **${plan.output_per_minute} Wire/min Mk.1 factory** from ` +
          `**${plan.node}** without belts: 1 Miner Mk.1, ${plan.smelters} Smelters, ` +
          `${plan.constructors} Constructors, splitters and mergers, and ` +
          `${plan.storage_lanes} storage lanes, each with its recipe set. ` +
          `Recipe: **${plan.recipe}**.\n\n` +
          `**${beltCount} belts left to you**, and power. Everything is positioned ` +
          `so the runs are short. Say "undo" to reverse the whole placement.`,
        "aimed_mk1_wire_factory",
        started,
        "Belts omitted at your request; every machine still validated by the game.",
      );
    }
    if (emitted) {
      const capped = plan.extracted_per_minute > plan.line_input_per_minute
        ? ` The ${plan.purity} node and Miner Mk.1 can supply ${plan.extracted_per_minute}/min, ` +
          `but Mk.1 belt capacity is ${plan.belt_capacity_per_minute}/min, so the ` +
          `line uses ${plan.node_utilisation_percent}% of the node and the miner will back up.`
        : "";
      const partialMachine = plan.last_constructor_utilisation_percent < 100
        ? ` The last Constructor is supply-limited to ${plan.last_constructor_utilisation_percent}% utilisation.`
        : "";
      return localAnswer(
        `Building a deterministic **${plan.output_per_minute} Wire/min Mk.1 factory** ` +
          `from **${plan.node}**: 1 Miner Mk.1, ${plan.smelters} Smelters, ` +
          `${plan.constructors} Constructors, splitter/merger fan-out, and ` +
          `${plan.storage_lanes} separate Mk.1 output storage lanes, with ${plan.foundations} Foundation (1 m) supports. Recipe: **${plan.recipe}**.${capped}${partialMachine}\n\n` +
          "Each support is checked by Satisfactory's real hologram against the terrain first. " +
          "Each dependent machine is then checked against the foundation that was actually created; any refusal rolls the whole transaction back.\n\n" +
          "Every Smelter and Constructor receives its captured selected recipe during placement, " +
          "and the game reads it back before accepting the action. The complete transaction rolls " +
          "back if any building, recipe, or belt fails.\n\n" +
          "**Power is not wired yet**, so this builds and configures the material line but does not " +
          `claim it is running. Connect the ${plan.smelters + plan.constructors} machines to your circuit; say undo to reverse ` +
          "the whole placement.",
        "aimed_mk1_wire_factory",
        started,
        "Node, tier, recipes, rates, machine counts, and belt capacity came from the live snapshot.",
      );
    }
    const refusal = describePlanRejection();
    return localAnswer(
      refusal ?? "I could not validate the Mk.1 factory action plan, so nothing was sent to the game.",
      "aimed_mk1_wire_factory_refused",
      started,
      "The whole plan was refused before any action was sent.",
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

    if (waypoint.kind === "here") {
      // Where they are looking, or where they are standing when they are not
      // looking at anything. No lookup: the position is already in the
      // snapshot, which is the whole reason this never needed a model.
      const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
      const feet = graph.snapshot?.interaction_context?.player?.pawn_location;
      location = aim ?? feet ?? null;
      // A name the player gave wins over the default, which is the whole point
      // of "name it concrete" -- a map with six markers all called "Copilot
      // waypoint" is no better than none.
      label = waypoint.name
        ?? (aim ? "Copilot waypoint" : "Copilot waypoint (your position)");
    } else if (waypoint.kind === "best_site") {
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
  // "build me a 4x3 modular base here" — tile the player's own blueprint set.
  const modularRequest = parseModularShellRequest(question);
  if (modularRequest && graph) {
    const started = Date.now();
    const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
    const origin = (modularRequest.at_aim && aim)
      ? aim
      : graph.snapshot?.interaction_context?.player?.pawn_location;
    const structural = surveyStructuralPieces(graph);
    const library = typeof services?.listBlueprints === "function" ? services.listBlueprints() : [];

    if (!modularRequest.width_modules) {
      return localAnswer(
        "**How many modules across and deep?** Say it like \"build a 4x3 modular " +
          "base here\". Each module is 5 foundations square, so 4x3 is 160 m x 120 m.",
        "modular_shell_refused",
        started,
        "Size is the player's call; nothing else here is.",
      );
    }

    const shell = planModularShell(graph, {
      width_modules: modularRequest.width_modules,
      depth_modules: modularRequest.depth_modules,
      origin_cm: origin,
      blueprints: library,
      cell_size_cm: structural?.cell_size_cm ?? null,
    });

    if (!shell.planned) {
      return localAnswer(
        `I can't lay that out: ${shell.reason}.`,
        "modular_shell_refused",
        started,
        "Nothing was sent to the game.",
      );
    }

    const emitted = emitValidatedPlan(graph, services, modularShellActions(shell, { commit: true }));
    if (emitted) {
      const counts = shell.counts;
      return localAnswer(
        `Laying out a **${shell.width_modules} × ${shell.depth_modules} modular base** ` +
          `(${shell.footprint_m.x} m × ${shell.footprint_m.y} m) from your own tileset: ` +
          `${counts.corner ?? 0} corner, ${counts.middle ?? 0} middle and ` +
          `${counts.inner ?? 0} inner module(s), each placed as a whole blueprint.\n\n` +
          `**${shell.power}**\n\n` +
          `${shell.assumptions.rotation} Say "undo" to reverse it.`,
        "modular_shell",
        started,
        "Modules came from your blueprint folder; the pitch from this save's foundation grid.",
      );
    }
    const refusal = describePlanRejection();
    if (refusal) {
      return localAnswer(refusal, "modular_shell_refused", started, "Refused by validation before anything ran.");
    }
  }

  // "what can you do" — answered from a list that is tested, not guessed at.
  if (parseCapabilityRequest(question)) {
    const started = Date.now();
    return localAnswer(
      "Ask in plain words. Everything below is answered or built without sending your " +
        "question anywhere:\n\n" +
        CAPABILITY_EXAMPLES.map(([heading, examples]) =>
          `**${heading}**\n` + examples.map((example) => `- \`${example}\``).join("\n"),
        ).join("\n\n") +
        "\n\nAnything I actually change is previewed, validated by the game, and reversible " +
        'with "undo". Anything I cannot work out, I say so rather than guessing.',
      "capabilities",
      started,
      "A fixed list; every example here is exercised by the test suite.",
    );
  }

  // "where am I" — a field in the snapshot, read back.
  if (parseWhereAmIRequest(question) && graph) {
    const started = Date.now();
    const at = graph.snapshot?.interaction_context?.player?.pawn_location;
    if (at) {
      return localAnswer(
        `You are at \`x=${round(at.x)}, y=${round(at.y)}, z=${round(at.z)}\`, which is ` +
          `${round(at.z / 100)} m above sea level.\n\nSay "waypoint here" and I will drop a ` +
          "map marker on it.",
        "where_am_i",
        started,
        "Straight from the capture's player position.",
      );
    }
  }

  // "what am I looking at" — the crosshair target, which the capture already
  // resolves for placement.
  // "will this blueprint fit here" -- a decoded footprint crossed with a probed
  // terrain grid. Neither half can answer it alone, and a model asked this would
  // answer from the blueprint's name and the general look of the landscape.
  {
    const fit = parseSiteFitRequest(question);
    if (fit && graph) {
      const started = Date.now();
      // Same accessors the blueprint-layout route uses; the bridge owns all
      // filesystem reads and the router only ever consumes what it is handed.
      const inspection =
        typeof services?.inspectBlueprint === "function"
          ? services.inspectBlueprint(fit.blueprint)
          : null;
      const scan =
        typeof services?.readTerrainScan === "function" ? services.readTerrainScan() : null;
      if (!inspection?.available || scan === null) {
        return localAnswer(
          inspection === null
            ? `I could not read a blueprint called "${fit.blueprint}". Ask me to list blueprints to see the exact names.`
            : "There is no terrain scan yet. Run `/ai terrain` standing where you want to build, then ask again.",
          "blueprint_site_fit",
          started,
          "A fit answer needs both a decoded blueprint and a probed site.",
        );
      }
      const site = assessBlueprintSite(inspection, scan, { rotationDeg: fit.rotation_deg });
      return localAnswer(
        formatSiteAssessment(site, judgeBlueprintSite(site)),
        "blueprint_site_fit",
        started,
        "Footprint from the decoded blueprint, ground from the terrain scan.",
      );
    }
  }

  // "what's around me", "is my hub well placed" -- read from the capture's
  // resource nodes, never from a model. Node layout is exactly the kind of
  // thing a model will answer confidently and wrongly.
  {
    const survey = parseSiteSurveyRequest(question);
    if (survey && graph) {
      const started = Date.now();
      const result = surveyResources(graph.snapshot, {
        radiusMeters: survey.radius_meters,
      });
      if (result.ok) {
        const judgement = judgeSite(result);
        return localAnswer(
          formatSurvey(result, judgement),
          "site_survey",
          started,
          "Resource nodes come from the capture; a model would invent them.",
        );
      }
      return localAnswer(
        "I could not find a point to survey from — the capture has no HUB and no player position.",
        "site_survey",
        started,
        "No origin in the capture.",
      );
    }
  }

  if (parseLookingAtRequest(question) && graph) {
    const started = Date.now();
    const target = graph.snapshot?.interaction_context?.preferred_target;
    if (target?.available) {
      const aimed = solvePlacementTarget(graph, { kind: "aim" });
      const name = aimed?.on ?? target.actor_name ?? target.actor_id ?? "something the capture could not name";
      const extra = [
        // "Coal node — a Node" says nothing. Only the node types that are not
        // the ordinary one are worth naming.
        aimed?.node_type && aimed.node_type !== "Node" ? aimed.node_type : null,
        aimed?.purity ? `${aimed.purity} purity` : null,
        aimed?.occupied === true ? "already occupied" : null,
        aimed?.occupied === false && aimed?.node_type ? "free for a miner" : null,
      ].filter(Boolean);
      return localAnswer(
        `**${name}**${extra.length > 0 ? ` — ${extra.join(", ")}` : ""}.` +
          (target.hit_location
            ? `\n\nThe point under your crosshair is \`x=${round(target.hit_location.x)}, ` +
              `y=${round(target.hit_location.y)}, z=${round(target.hit_location.z)}\`.`
            : ""),
        "looking_at",
        started,
        "The capture's own crosshair target; nothing was inferred.",
      );
    }
    return localAnswer(
      "Nothing the capture could identify is under your crosshair — you are looking at " +
        "terrain, at the sky, or at something too far away for the scan radius.",
      "looking_at",
      started,
      "The capture reports no preferred target.",
    );
  }

  // "what is this making" — the crosshair target's own recipe and rate.
  if (parseWhatIsThisMakingRequest(question) && graph) {
    const started = Date.now();
    const aimedId = graph.snapshot?.interaction_context?.preferred_target?.actor_id;
    const [machine] = aimedId
      ? solveMachineRates(graph, { actor_ids: [aimedId] })?.machines ?? []
      : [];
    if (machine) {
      const products = (machine.products ?? [])
        .map((entry) => `${entry.per_minute ?? "?"}/min ${entry.item_name ?? entry.item_class}`)
        .join(", ");
      return localAnswer(
        `**${machine.name}** is set to **${machine.recipe_name ?? "no recipe"}**` +
          (products ? `, making ${products}` : "") +
          (machine.production_status ? `. Status: ${machine.production_status}.` : ".") +
          (Number.isFinite(machine.current_potential) && machine.current_potential !== 1
            ? ` Overclocked to ${Math.round(machine.current_potential * 100)}%.`
            : ""),
        "what_is_this_making",
        started,
        "Read from the capture's own factory state for the actor you are aiming at.",
      );
    }
    return localAnswer(
      aimedId
        ? "What you are aiming at is not a machine with a recipe — the capture reports no " +
          "production state for it."
        : "You are not aiming at anything the capture could identify.",
      "what_is_this_making",
      started,
      "No production state in the capture for that target.",
    );
  }

  // "how much does a smelter cost" — the catalogue, not a memory of the wiki.
  const buildCost = parseBuildCostRequest(question);
  if (buildCost && graph) {
    const started = Date.now();
    const recipe = solveBuildRecipeLookup(graph, { building: buildCost.thing });
    // A locked building still has a cost, and wanting to know it before
    // committing to the milestone is most of why anyone asks. The lookup
    // refuses on unlock grounds but hands back the class anyway, so the price
    // is answerable — with the lock stated rather than hidden.
    const recipeClass = recipe?.recipe_class ?? null;
    if (recipeClass) {
      const cost = solveBuildCost(graph, {
        recipe_class: recipeClass,
        count: buildCost.count,
      });
      // `required_display_units` is the number a player reads on a build menu;
      // the registry units beside it are the raw integers. Field names taken
      // from the solver rather than assumed -- the first draft of this route
      // said `entry.amount`, which does not exist, and printed nothing.
      const lines = (cost?.ingredients ?? [])
        .map((entry) =>
          `- ${entry.required_display_units ?? entry.required_registry_units} × ` +
          `${entry.item_name ?? entry.item_class}` +
          (Number.isFinite(entry.shortfall_display_units) && entry.shortfall_display_units > 0
            ? ` (${entry.shortfall_display_units} short)`
            : ""))
        .join("\n");
      if (lines) {
        return localAnswer(
          `**${buildCost.count} × ${cost.recipe_name ?? recipe.name ?? buildCost.thing}** costs:\n\n${lines}` +
            (recipe.resolved === false && recipe.reason
              ? `\n\nNote: ${recipe.reason}.`
              : "") +
            (cost.affordable_from_captured_player_inventories === true
              ? "\n\nYou are carrying enough."
              : cost.affordable_from_captured_player_inventories === false
                ? "\n\nNot all of that is in your inventory."
                : ""),
          "build_cost",
          started,
          "From the recipe catalogue in the capture, not from memory.",
        );
      }
    }
  }

  // "what can I make with iron" — the recipe catalogue, filtered.
  const recipeOptions = parseRecipeOptionsRequest(question);
  if (recipeOptions && graph) {
    const started = Date.now();
    // The player names an *item*, but `name_contains` filters *recipe names*.
    // "what uses iron ore" found nothing, because no recipe is called that.
    // Resolving the item first is the difference between a useful answer and
    // silence, and the name filter stays as the fallback for "recipes for
    // alternate" and the like.
    const needle = recipeOptions.thing.toLowerCase();
    let itemClass = null;
    for (const item of graph.itemsByClass?.values() ?? []) {
      const name = String(item?.name ?? "").toLowerCase();
      if (!name) continue;
      if (name === needle) { itemClass = item.class_path; break; }
      if (!itemClass && name.includes(needle)) itemClass = item.class_path;
    }
    const found = solveRecipeOptions(
      graph,
      itemClass ? { item_class: itemClass } : { name_contains: recipeOptions.thing },
    );
    // The solver splits by direction, which is the distinction the question is
    // actually about: "how do I make steel" wants the producers, "what uses
    // iron ore" wants the consumers. Both are shown, labelled.
    const producing = found?.recipes_producing_item ?? [];
    const consuming = found?.recipes_consuming_item ?? [];
    if (producing.length + consuming.length > 0) {
      // Per minute when the catalogue gave a duration, per cycle when it did
      // not. `inputs`/`outputs` come back empty rather than wrong if the recipe
      // has no cycle time, which is why the fallback reads the raw entry.
      const quantity = (item) =>
        Number.isFinite(item.display_units_per_minute)
          ? `${item.display_units_per_minute}/min`
          : `${item.amount_per_cycle ?? item.amount ?? "?"}`;
      const describe = (entry) => {
        const inputs = (entry.inputs ?? [])
          .map((item) => `${quantity(item)} ${item.item_name ?? item.item_class}`)
          .join(" + ");
        const outputs = (entry.outputs ?? [])
          .map((item) => `${quantity(item)} ${item.item_name ?? item.item_class}`)
          .join(" + ");
        return `- **${entry.recipe_name ?? entry.recipe_class}**` +
          (inputs ? ` — ${inputs}` : "") + (outputs ? ` → ${outputs}` : "") +
          (entry.machines_currently_using_it > 0
            ? ` *(${entry.machines_currently_using_it} running)*`
            : "");
      };
      const section = (heading, list) =>
        list.length === 0
          ? ""
          : `\n\n**${heading}**\n` + list.slice(0, 6).map(describe).join("\n") +
            (list.length > 6 ? `\n- …and ${list.length - 6} more` : "");

      return localAnswer(
        `Matching **${recipeOptions.thing}** in your recipe catalogue:` +
          section("Makes it", producing) + section("Uses it", consuming),
        "recipe_options",
        started,
        "Filtered from the recipe catalogue in the capture, not from memory.",
      );
    }
  }

  // "how far is the coal node" — two points the capture already holds.
  const howFar = parseHowFarRequest(question);
  if (howFar && graph) {
    const started = Date.now();
    const found = solveActorLookup(graph, { name_contains: howFar.thing, limit: 1 });
    const nearest = found?.matches?.[0];
    if (nearest && Number.isFinite(nearest.distance_meters)) {
      const others = (found.match_count ?? 1) - 1;
      return localAnswer(
        `**${nearest.name ?? nearest.actor_id}** is **${nearest.distance_meters} m** away, at ` +
          `\`x=${round(nearest.location_cm.x)}, y=${round(nearest.location_cm.y)}, ` +
          `z=${round(nearest.location_cm.z)}\`.` +
          (others > 0 ? ` That is the closest of ${others + 1} matching.` : "") +
          `\n\nSay "teleport me to ${howFar.thing}" to go there, or "waypoint ${howFar.thing}" ` +
          "to put it on your compass.",
        "how_far",
        started,
        "Measured between two positions in the capture.",
      );
    }
    if (found?.match_count === 0) {
      return localAnswer(
        `Nothing matching **${howFar.thing}** is in the current capture, so there is no ` +
          "distance to give. The panel scans a radius around you unless you ask for the whole world.",
        "how_far",
        started,
        "Nothing matched; no distance was invented.",
      );
    }
  }

  // "how many smelters do I have" — a count, not a judgement.
  const howMany = parseHowManyRequest(question);
  if (howMany && graph) {
    const started = Date.now();
    const found = solveActorLookup(graph, { name_contains: howMany.thing, limit: 1 });
    // `match_count` is everything that matched; `matches` is capped by `limit`
    // and is only there to name the nearest one. Reading the count off the
    // capped list answered "how many smelters" with 1 when there were 2 --
    // caught before this shipped, and exactly the kind of confidently wrong
    // number that is worse than paying a model.
    const total = Number.isFinite(found?.match_count) ? found.match_count : 0;
    const nearest = found?.matches?.[0];
    return localAnswer(
      total === 0
        ? `Nothing matching **${howMany.thing}** is in the current capture. The panel scans a ` +
          "radius around you unless you ask for the whole world, so it may exist and simply not " +
          "have been looked at."
        : `**${total}** matching **${howMany.thing}**` +
          (Number.isFinite(nearest?.distance_meters)
            ? `, nearest ${nearest.distance_meters} m away.`
            : "."),
      "how_many",
      started,
      "Counted from the capture; it only knows what was scanned.",
    );
  }


  // "delete the mk2 design" — moved to a retired folder, never unlinked.
  const designRetire = parseDesignRetireRequest(question);
  if (designRetire) {
    const started = Date.now();
    const result = retireDesign(designRetire.name);
    if (result.retired) {
      return localAnswer(
        `**${result.name}** (${result.building_count} buildings) is out of the library.\n\n` +
          `It was moved, not deleted — the file is at \`${result.path}\`, so drag it back up ` +
          "one folder if you want it again.",
        "design_retire",
        started,
        "The file was moved to a retired folder; nothing was destroyed.",
      );
    }
    if (result.matches) {
      return localAnswer(
        `${result.reason}:\n\n${result.matches.map((name) => `- ${name}`).join("\n")}\n\nSay the full name.`,
        "design_retire_refused",
        started,
        "Ambiguous name; nothing was moved.",
      );
    }
    // A name that matches nothing was probably never a design request at all,
    // so it falls through rather than refusing on another planner's behalf.
    if (!/nothing saved is called/i.test(result.reason ?? "")) {
      return localAnswer(
        `I could not retire that: ${result.reason}.`,
        "design_retire_refused",
        started,
        "Nothing was moved.",
      );
    }
  }

  // "rename mk1 copper to copper starter".
  const designRename = parseDesignRenameRequest(question);
  if (designRename) {
    const started = Date.now();
    const result = renameDesign(designRename.from, designRename.to);
    if (result.renamed) {
      return localAnswer(
        `**${result.from}** is now **${result.to}**. Say "place ${result.to} here" to build it.`,
        "design_rename",
        started,
        "The saved file was rewritten under the new name.",
      );
    }
    if (result.matches) {
      return localAnswer(
        `${result.reason}:\n\n${result.matches.map((name) => `- ${name}`).join("\n")}\n\nSay the full name.`,
        "design_rename_refused",
        started,
        "Ambiguous name; nothing was renamed.",
      );
    }
    if (!/nothing saved is called/i.test(result.reason ?? "")) {
      return localAnswer(
        `I could not rename that: ${result.reason}.`,
        "design_rename_refused",
        started,
        "Nothing was renamed.",
      );
    }
  }

  // "list designs" / "save this as X" / "place X here" — remembered builds.
  if (parseDesignListRequest(question)) {
    const started = Date.now();
    const designs = listDesigns();
    if (designs.length === 0) {
      return localAnswer(
        'You have no saved designs. Stand by something you have built and say ' +
          '"save this as <name>" to remember it.',
        "design_library",
        started,
        "Read from the design folder on disk.",
      );
    }
    // Counted through the library model rather than from building_count, so
    // the number here is the number that will actually go down. A design saved
    // before the capture separated links from buildings still carries its
    // belts and power lines on the buildings list.
    const listed = designs.map(summariseDesign);
    return localAnswer(
      `You have **${designs.length}** saved design(s):\n\n` +
        listed
          .map((design) =>
            `- **${design.name}** — ${design.count} buildings` +
            (design.links > 0 ? ` (${design.links} belt/wire link(s) not replayed)` : ""))
          .join("\n") +
        '\n\nSay "place <name> here" to build one, or add "rotated 90" to turn it.',
      "design_library",
      started,
      "Read from the design folder on disk.",
    );
  }

  // A box you set and can see before anything is written.
  const selectBox = parseSelectBoxRequest(question);
  const selectResize = lastPreview() ? parseSelectResizeRequest(question) : null;
  if ((selectBox || selectResize) && graph) {
    const started = Date.now();
    const previous = lastPreview();

    // Resizing keeps the centre it was already anchored on, so the box does
    // not walk across the map every time the size changes.
    const centre = previous?.box?.centre
      ?? graph.snapshot?.interaction_context?.preferred_target?.hit_location
      ?? graph.snapshot?.interaction_context?.player?.pawn_location;
    if (!centre) {
      return localAnswer(
        "I do not know where to centre the selection — the capture reported no aim point and no player position.",
        "selection_refused",
        started,
        "No anchor in the snapshot.",
      );
    }

    const sizes = selectBox
      ? selectBox
      : {
          width_m: Math.round((previous.box.size_m.width) * (selectResize.scale ?? 1)),
          depth_m: Math.round((previous.box.size_m.depth) * (selectResize.scale ?? 1)),
          height_m: Math.round((previous.box.size_m.height) * (selectResize.height_scale ?? 1)),
        };
    if (selectResize?.width_m) {
      sizes.width_m = selectResize.width_m;
      sizes.depth_m = selectResize.width_m;
    }

    const box = makeSelectionBox({ centre, ...sizes });
    if (!box) {
      return localAnswer("That is not a size I can make a box from.", "selection_refused", started, "Bad extents.");
    }

    const { buildings, skipped } = selectionContents(graph, box);
    if (buildings.length === 0) {
      rememberPreview(box, [], graph.world_revision);
      return localAnswer(
        `Nothing is inside a ${box.size_m.width} × ${box.size_m.depth} × ${box.size_m.height} m box there. ` +
          "Say a bigger number, or stand somewhere else and try again.",
        "selection_preview",
        started,
        "Counted from the capture, which only knows what was scanned.",
      );
    }

    rememberPreview(box, buildings, graph.world_revision);
    const bounds = selectionBounds(buildings);

    // The preview is the consent: these exact ids are lit up, and these exact
    // ids are what an export would serialise.
    emitValidatedPlan(graph, services, [{
      action: "highlight",
      overlay: "selection",
      actor_ids: buildings.map((entry) => entry.actor_id),
      radius_m: 1,
      commit: true,
    }]);

    return localAnswer(
      `**${buildings.length}** buildings inside a ${box.size_m.width} × ${box.size_m.depth} × ` +
        `${box.size_m.height} m box, lit up in the world now.` +
        (bounds ? ` They actually span ${bounds.span_m.x} × ${bounds.span_m.y} × ${bounds.span_m.z} m.` : "") +
        `\n\n${describeSelection(buildings)}` +
        (skipped.length > 0 ? `\n\n${skipped.length} left out: ${skipped[0].why}.` : "") +
        '\n\nSay a number to resize, "bigger"/"smaller"/"taller", or ' +
        '"export this selection as blueprint <name>" when it looks right.',
      "selection_preview",
      started,
      "The highlight shows exactly the set an export would serialise.",
    );
  }

  // "export this factory as blueprint X" — unlike a saved design, this asks
  // the game to write a native .sbp. Exact dismantle-tool membership is the
  // boundary; never substitute the crosshair or a radius for a whole factory.
  const nativeBlueprintExport = parseNativeBlueprintExportRequest(question);
  if (nativeBlueprintExport && graph) {
    const started = Date.now();
    // A previewed box wins over the dismantle tool when one is live: the
    // player just looked at it, so it is the more recent statement of intent.
    const preview = lastPreview();
    if (preview && preview.actor_ids.length > 0) {
      const emittedBox = emitValidatedPlan(graph, services, [{
        action: "export_native_blueprint",
        blueprint_name: nativeBlueprintExport.name,
        selection_source: "box_selection",
        selected_actor_ids: preview.actor_ids,
        commit: true,
      }]);
      if (emittedBox) {
        const size = preview.box.size_m;
        const count = preview.actor_ids.length;
        clearPreview();
        return localAnswer(
          `Exporting the **${count}** buildings you previewed ` +
            `(${size.width} × ${size.depth} × ${size.height} m) as **${nativeBlueprintExport.name}**. ` +
            "Only the game can say whether an .sbp was written; its action result will.",
          "native_blueprint_export",
          started,
          "Exactly the set that was highlighted; nothing was added to it.",
        );
      }
      const refusedBox = describePlanRejection();
      if (refusedBox) {
        return localAnswer(refusedBox, "native_blueprint_export_refused", started, "Refused before anything ran.");
      }
    }

    const selection = graph.snapshot?.interaction_context?.dismantle_selection;
    if (selection?.available !== true) {
      return localAnswer(
        "I need Satisfactory's dismantle selection to export a native blueprint. " +
          "Switch to the dismantle tool, mark every factory member you want included, then ask again.",
        "native_blueprint_export_refused",
        started,
        "The capture did not expose the game's multi-selection state, so no region was guessed.",
      );
    }

    const selectedActorIds = Array.isArray(selection.actor_ids)
      ? selection.actor_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    if (selectedActorIds.length === 0) {
      return localAnswer(
        "Mark the factory members with the dismantle tool first. I will export exactly that marked set, " +
          "not everything near your crosshair.",
        "native_blueprint_export_refused",
        started,
        "The authoritative dismantle selection was empty; no action was emitted.",
      );
    }

    const emitted = emitValidatedPlan(graph, services, [{
      action: "export_native_blueprint",
      blueprint_name: nativeBlueprintExport.name,
      selection_source: "dismantle_selection",
      selected_actor_ids: selectedActorIds,
      commit: true,
    }]);
    if (emitted) {
      return localAnswer(
        `Submitted a native blueprint export request for **${nativeBlueprintExport.name}** from ` +
          `the exact **${selectedActorIds.length}** actor(s) you marked. It has **not** been claimed as ` +
          "saved yet: only the game-side exporter can re-check the live selection, proxy/lightweight " +
          "members, resource anchors, and archive write. Its action result will say whether an `.sbp` was written or why it refused.",
        "native_blueprint_export",
        started,
        "Dismantle-tool actor ids and their captured bounds were attached as evidence; the native executor remains authoritative.",
      );
    }
    const refusal = describePlanRejection();
    if (refusal) {
      return localAnswer(
        `I can't submit that native blueprint export: ${refusal}`,
        "native_blueprint_export_refused",
        started,
        "No export action was sent to the game.",
      );
    }
  }

  const designSave = parseDesignSaveRequest(question);
  if (designSave && graph) {
    const started = Date.now();
    const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
    const origin = aim ?? graph.snapshot?.interaction_context?.player?.pawn_location;
    if (!origin) {
      return localAnswer(
        "I don't know what to save — the game didn't report where you are or what you're aiming at.",
        "design_save_refused",
        started,
        "No anchor in the snapshot.",
      );
    }

    // What the player marked with the dismantle tool, if anything. That is an
    // explicit selection and beats a radius, which only guesses at the same
    // question and sweeps up whatever else is standing nearby.
    const selection = graph.snapshot?.interaction_context?.dismantle_selection;
    const selectedIds = Array.isArray(selection?.actor_ids) ? selection.actor_ids : [];
    const aimedSelected = selection?.aimed_actor_id;
    const chosenIds = selectedIds.length > 0
      ? selectedIds
      : (aimedSelected ? [aimedSelected] : []);

    // Anchor on the selection's own first building rather than the crosshair,
    // so the saved offsets are relative to the thing being saved.
    const anchorNode = chosenIds.length > 0 ? graph.nodes?.get(String(chosenIds[0])) : null;
    const anchor = anchorNode?.raw?.location ?? origin;

    const captured = captureDesign(graph, {
      name: designSave.name,
      origin: anchor,
      ...(chosenIds.length > 0 ? { actor_ids: chosenIds } : {}),
      ...(designSave.exclude_extractors ? { exclude_extractors: true } : {}),
      ...(designSave.radius_cm ? { radius_cm: designSave.radius_cm } : {}),
    });
    if (!captured.saved) {
      return localAnswer(
        `I can't save that: ${captured.reason}.`,
        "design_save_refused",
        started,
        "Nothing was written.",
      );
    }
    const written = writeDesign(captured.design);
    if (!written.written) {
      return localAnswer(
        `I captured it but could not write it: ${written.reason}.`,
        "design_save_refused",
        started,
        "Nothing was written.",
      );
    }

    // Each skipped entry carries its own reason now -- a belt is left off the
    // placement list for a completely different cause than a building whose
    // recipe is unknown -- so group by reason instead of asserting one.
    const byReason = new Map();
    for (const entry of captured.skipped) {
      byReason.set(entry.why, (byReason.get(entry.why) ?? 0) + 1);
    }
    const skipped = byReason.size > 0
      ? "\n\n" +
        [...byReason].map(([why, count]) => `${count} left out: ${why}.`).join("\n")
      : "";

    // A Power Shard is something the player spent. Saying it here means they
    // find out at save time, not when the rebuilt factory runs slower.
    const overclockedCount = captured.design.buildings.filter(
      (entry) => Number.isFinite(entry.potential),
    ).length;
    const overclocked = overclockedCount > 0
      ? `\n\n${overclockedCount} of them are overclocked. The rate is recorded, but nothing ` +
        "here can set a potential, so they will rebuild at 100%."
      : "";
    const how = captured.design.selected_by === "dismantle_selection"
      ? "the ones you marked with the dismantle tool"
      : `everything within ${captured.design.radius_cm / 100} m`;
    return localAnswer(
      `Saved **${captured.design.name}** — ${captured.design.building_count} buildings ` +
        `(${how}), with the exact distances between them, their facings, and their ` +
        `recipes.${skipped}${overclocked}\n\n` +
        `Say "place ${captured.design.name} here" anywhere to build it again. ` +
        "It keeps the spacing and the direction it was saved with.",
      "design_save",
      started,
      captured.design.selected_by === "dismantle_selection"
        ? "Selection read from the dismantle tool; nothing was dismantled."
        : "Read from the capture and written to the design folder.",
    );
  }

  const designPlace = parseDesignPlaceRequest(question);
  if (designPlace && graph) {
    const started = Date.now();
    const { matches, near } = findDesign(designPlace.name);
    // No match usually means this was never a design request, so the phrase
    // falls through to the planner that owns it. But a name one or two letters
    // off a saved design almost certainly *was* one -- "place emga base here"
    // is in the routing log -- and saying so beats silence. The name is
    // offered, never chosen.
    if (matches.length === 0 && near?.length > 0) {
      return localAnswer(
        `Nothing is saved as **${designPlace.name}**. Did you mean:\n` +
          near.map((name) => `- \`place ${name} here\``).join("\n") +
          '\n\nSay "list designs" for all of them.',
        "design_place_refused",
        started,
        "Close names only; nothing was placed.",
      );
    }
    if (matches.length > 1) {
      return localAnswer(
        `"${designPlace.name}" matches ${matches.length} designs:\n` +
          matches.slice(0, 6).map((design) => `- ${design.name}`).join("\n") +
          "\n\nSay the full name.",
        "design_place_refused",
        started,
        "Ambiguous name; nothing was sent to the game.",
      );
    }
    if (matches.length === 1) {
      const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
      const origin = aim ?? graph.snapshot?.interaction_context?.player?.pawn_location;

      // Aiming at a resource node means the design goes *on* that node: any
      // extractor in it attaches to this one, and the rest of the layout is
      // anchored on the node's centre so the offsets still line up.
      const aimedTarget = solvePlacementTarget(graph, { kind: "aim" });
      const aimedNode = aimedTarget?.resolved && aimedTarget.actor_id && aimedTarget.node_type
        && aimedTarget.node_type !== "Deposit"
        ? { actor_id: aimedTarget.actor_id, location: aimedTarget.location }
        : null;

      const plan = planDesignPlacement(matches[0], {
        origin: aimedNode?.location ?? origin,
        node: aimedNode,
        commit: true,
        rotation_degrees: designPlace.rotation_degrees,
        omit: designPlace.omit,
      });

      // A nearby node is worth mentioning and is NOT worth refusing over.
      //
      // I added a hard refusal here after a foundation failed 7.3 m from a
      // node, and the owner then pointed out they had built foundations near
      // that node by hand — so the game plainly permits it and my rule was
      // inferred from one failure I had misread. An 8x4 foundation reaches 4 m
      // from its centre, so a node 7.3 m away is not even underneath it.
      //
      // The game is the authority on what it will accept. Guessing its rules
      // and refusing first turns a buildable design into an unbuildable one and
      // hides the real cause. Say what is nearby, then let it decide.
      const nearbyNode = plan.planned
        ? findResourceNodeUnderPlan(graph, plan.actions, aimedNode ?? {})
        : null;
      if (!plan.planned) {
        return localAnswer(
          `I can't place that design: ${plan.reason}.`,
          "design_place_refused",
          started,
          "Nothing was sent to the game.",
        );
      }
      const emitted = emitValidatedPlan(graph, services, plan.actions);
      if (emitted) {
        const snapped = plan.extractors_snapped > 0
          ? ` The ${plan.extractors_snapped} extractor(s) in it are attached to the node ` +
            `you are aiming at, not just placed near it.`
          : "";
        // Say what is not going down, rather than letting the count quietly
        // disagree with what appears. A belt joins two ends, so it is not
        // replayed from a saved offset.
        const dropped = plan.not_placeable.length > 0
          ? ` ${plan.not_placeable.length} belt(s), lift(s) or power line(s) in the design ` +
            `are not placed — they connect two ends rather than sitting at a spot, so run those yourself.`
          : "";
        const overclocked = plan.overclocked_not_replayed > 0
          ? ` ${plan.overclocked_not_replayed} of them were overclocked when the design was ` +
            `saved and rebuild at 100% — nothing here can spend a Power Shard for you.`
          : "";
        const left_out = plan.omitted_on_request > 0
          ? ` ${plan.omitted_on_request} ${plan.omitted_kind}(s) left out because you asked.`
          : "";
        const facing = plan.rotated_degrees
          ? `turned ${plan.rotated_degrees}° from how it was saved`
          : `keeping the spacing and facing it was saved at`;
        return localAnswer(
          `Building **${plan.name}** — ${plan.count} buildings, each with the recipe ` +
            `it was saved with, ${facing}.${left_out}${snapped}${dropped}${overclocked} ` +
            `Say "undo" to reverse the whole thing.`,
          "design_place",
          started,
          "Replayed from the saved design; the game validates every placement.",
        );
      }
      const refusal = describePlanRejection();
      if (refusal) {
        return localAnswer(refusal, "design_place_refused", started, "Refused by validation before anything ran.");
      }
    }
  }

  // "clear holograms" — sweep up any preview left stuck to the cursor.
  //
  // This route has never once fired. Every `\s+` in its pattern had lost its
  // backslash, so it demanded "clear   holograms" spelled "clearsss" — it only
  // ever matched literal s characters. The escape-collapse trap that keeps
  // eating backslashes in this file leaves ordinary letters behind here rather
  // than the 0x08 the repo already guards against, so nothing caught it.
  // `test/collapsed-escapes.test.mjs` now does.
  if (parseClearHologramRequest(question)) {
    const started = Date.now();
    if (emitValidatedPlan(graph, services, [{ action: "clear_holograms", commit: true }])) {
      return localAnswer(
        "Clearing any hologram left in the world. They are previews, so nothing built is touched.",
        "clear_holograms",
        started,
        "Holograms only; no buildable is affected.",
      );
    }
  }

  // "clone this 5 times" — stamp out what is already standing.
  const cloneRequest = parseCloneRequest(question);
  if (cloneRequest && graph) {
    const started = Date.now();
    const aimedId = graph.snapshot?.interaction_context?.preferred_target?.actor_id;
    if (!aimedId) {
      return localAnswer(
        "Aim at the building you want copied and say it again — the crosshair is the selection.",
        "clone_refused",
        started,
        "The game reported nothing under the crosshair.",
      );
    }
    if (!cloneRequest.count) {
      const source = describeCloneSource(graph, aimedId);
      return localAnswer(
        `**How many copies?** Say "clone this 5 times". ` +
          (source ? `You are aiming at a **${source.display_name}**.` : ""),
        "clone_refused",
        started,
        "Count is the player's call.",
      );
    }

    const plan = planClone(graph, {
      actor_id: aimedId,
      count: cloneRequest.count,
      direction: cloneRequest.direction,
    });
    if (!plan.planned) {
      return localAnswer(`I can't copy that: ${plan.reason}.`, "clone_refused", started, "Nothing was sent to the game.");
    }

    const emitted = emitValidatedPlan(graph, services, plan.actions);
    if (emitted) {
      return localAnswer(
        `Placing **${plan.count} more ${plan.source.name}**` +
          (plan.source.recipe ? ` set to **${plan.source.recipe}**` : "") +
          `, in a row ${plan.pitch_cm / 100} m apart` +
          `${plan.direction === "forward" ? " ahead of" : " beside"} the one you are aiming at.\n\n` +
          `The spacing is that building's own measured footprint plus a gap, not a guess. ` +
          `The game refuses any copy that does not fit. Say "undo" to reverse it.`,
        "clone",
        started,
        "Recipe, facing and footprint all read from the captured building.",
      );
    }
    const refusal = describePlanRejection();
    if (refusal) {
      return localAnswer(refusal, "clone_refused", started, "Refused by validation before anything ran.");
    }
  }

  // "audit this blueprint" — inspect the aimed *placed* runtime proxy. This
  // remains before preview and saved-file routes because it names no library
  // entry and must never emit a Build Gun handoff or any world action.
  const blueprintPlacementAudit = parseBlueprintPlacementAuditRequest(question);
  if (blueprintPlacementAudit && graph) {
    const started = Date.now();
    const audit = solveBlueprintPlacementAudit(graph);
    return localAnswer(
      formatBlueprintPlacementAudit(audit),
      "audit_blueprint_placement",
      started,
      "Read the authoritative runtime Blueprint proxy observation from the aimed target; no action was emitted.",
    );
  }

  // "preview <name> blueprint" — hand a saved blueprint to the requesting
  // player's real Build Gun. This is deliberately before direct placement:
  // preview is a local, non-writing choice and must never be mistaken for
  // permission to stamp a whole module into the world.
  const blueprintPreview = parseBlueprintPreviewRequest(question);
  if (blueprintPreview && graph) {
    const started = Date.now();
    const library = typeof services?.listBlueprints === "function" ? services.listBlueprints() : [];
    const needle = blueprintPreview.name.toLowerCase();
    const exact = library.filter((entry) => String(entry.name).toLowerCase() === needle);
    const partial = library.filter((entry) => String(entry.name).toLowerCase().includes(needle));
    const matches = exact.length > 0 ? exact : partial;

    if (matches.length > 1) {
      return localAnswer(
        `"${blueprintPreview.name}" matches ${matches.length} blueprints, so I have not guessed:\n` +
          matches.slice(0, 6).map((entry) => `- ${entry.name}`).join("\n") +
          "\n\nSay the full name.",
        "blueprint_preview_refused",
        started,
        "Ambiguous saved-blueprint name; nothing was sent to the Build Gun.",
      );
    }

    if (matches.length === 1) {
      const chosen = matches[0];
      const activeDescriptor = resolveCurrentSessionBlueprint(graph, chosen.name);
      if (!activeDescriptor.registered) {
        const reference = chosen.blueprint_reference ?? chosen.relative_path;
        const diskReference = reference ? ` (disk reference \`${reference}\`)` : "";
        const session = activeDescriptor.session_name
          ? ` for the current **${activeDescriptor.session_name}** session`
          : " for the current session";
        const reason = activeDescriptor.reason === "blueprint_not_registered_for_current_session"
          ? `Satisfactory has not registered it${session}`
          : `the active Satisfactory Blueprint library was not proven complete${session}`;
        return localAnswer(
          `I found **${chosen.name}**${diskReference}, but ${reason}. ` +
            "I did not send it to the Build Gun, so nothing was placed or charged. " +
            "A blueprint in another save folder remains inspectable, but it must be registered in this save before native preview is safe.",
          "blueprint_preview_refused",
          started,
          `Disk discovery and the active game-session descriptor registry disagree: ${activeDescriptor.reason}.`,
        );
      }
      const emitted = emitValidatedPlan(graph, services, [
        { action: "preview_blueprint", blueprint_name: activeDescriptor.blueprint_name },
      ]);
      if (emitted) {
        const dimensions = chosen.designer_dimensions;
        const size = dimensions ? ` (${dimensions.x}×${dimensions.y}×${dimensions.z})` : "";
        return localAnswer(
          `Requesting the native Build Gun preview for **${activeDescriptor.blueprint_name}**${size}. ` +
            "Nothing is being placed or charged: move, rotate, snap, inspect, and click to construct it with Satisfactory's normal hologram.",
          "blueprint_preview",
          started,
          "The saved-blueprint name was resolved from the local library; the game owns the hologram and eventual construction.",
        );
      }
      const refusal = describePlanRejection();
      if (refusal) {
        return localAnswer(refusal, "blueprint_preview_refused", started, "Refused by validation before the client handoff.");
      }
    }
  }

  // "place <name> here" — one hologram, and the game wires its insides itself.
  const blueprintPlace = parseBlueprintPlaceRequest(question);
  if (blueprintPlace && graph) {
    const started = Date.now();
    const library = typeof services?.listBlueprints === "function" ? services.listBlueprints() : [];
    const needle = blueprintPlace.name.toLowerCase();
    const exact = library.filter((entry) => String(entry.name).toLowerCase() === needle);
    const partial = library.filter((entry) => String(entry.name).toLowerCase().includes(needle));
    const matches = exact.length > 0 ? exact : partial;

    // Nothing matched, so this was never a blueprint request. Fall through and
    // let the planner that owns the phrase have it, rather than refusing on its
    // behalf.
    if (matches.length > 1) {
      // Placing the wrong 12x12 factory is expensive to undo by hand.
      return localAnswer(
        `"${blueprintPlace.name}" matches ${matches.length} blueprints, so I have not guessed:\n` +
          matches.slice(0, 6).map((entry) => `- ${entry.name}`).join("\n") +
          "\n\nSay the full name.",
        "blueprint_place_refused",
        started,
        "Ambiguous name; nothing was sent to the game.",
      );
    }

    if (matches.length === 1) {
    const chosen = matches[0];
    const aim = graph.snapshot?.interaction_context?.preferred_target?.hit_location;
    const origin = aim ?? graph.snapshot?.interaction_context?.player?.pawn_location;
    if (!origin) {
      return localAnswer(
        "I don't know where to put it — the game didn't report what you're aiming at.",
        "blueprint_place_refused",
        started,
        "No aim point and no player position in the snapshot.",
      );
    }

    const emitted = emitValidatedPlan(graph, services, [
      {
        action: "place_blueprint",
        blueprint_name: chosen.name,
        location: origin,
        yaw: blueprintPlace.rotation_degrees,
        commit: true,
      },
    ]);
    if (emitted) {
      const dimensions = chosen.designer_dimensions;
      const size = dimensions ? ` (${dimensions.x}×${dimensions.y} foundations)` : "";
      return localAnswer(
        `Placing **${chosen.name}**${size} where you are aiming` +
          (blueprintPlace.rotation_degrees ? `, turned ${blueprintPlace.rotation_degrees}°` : "") +
          `. The game builds it as ` +
          `one piece, so every belt and pipe inside it is its own to resolve — nothing ` +
          `here places them individually. Say "undo" to reverse it.`,
        "blueprint_place",
        started,
        "Name resolved against the blueprint folder; position from the aim point.",
      );
    }
    const refusal = describePlanRejection();
    if (refusal) {
      return localAnswer(refusal, "blueprint_place_refused", started, "Refused by validation before anything ran.");
    }
    }
  }

  // "compare blueprint <left> with blueprint <right>" — join two exact saved
  // native inspections locally. This is read-only and keeps all the evidence
  // boundaries of the model-facing comparison tool.
  const blueprintComparison = parseBlueprintComparisonRequest(question);
  if (blueprintComparison && graph) {
    const started = Date.now();
    const comparison = solveBlueprintComparison(
      graph,
      blueprintComparison,
      { inspectBlueprint: services?.inspectBlueprint },
    );
    return localAnswer(
      formatBlueprintComparison(comparison),
      "compare_blueprint_layouts",
      started,
      comparison.available
        ? "Compared exact serialized records from two saved native blueprints."
        : "The native Blueprint comparison stayed read-only and refused unavailable evidence.",
    );
  }

  // "inspect blueprint <exact name>" — decode its saved transforms without a
  // model. This remains read-only; it cannot turn into a placement request.
  const blueprintLayout = parseBlueprintLayoutRequest(question);
  if (blueprintLayout && graph) {
    const started = Date.now();
    const layout = solveBlueprintLayout(
      graph,
      blueprintLayout,
      { inspectBlueprint: services?.inspectBlueprint },
    );
    return localAnswer(
      formatBlueprintLayout(layout),
      "inspect_blueprint_layout",
      started,
      layout.available
        ? "Decoded the selected saved blueprint through the read-only native structural parser."
        : "The native blueprint reader refused to infer data from an unavailable or unreadable file.",
    );
  }

  // "list blueprints" — read the folder rather than asking a model about it.
  const blueprintList = parseBlueprintListRequest(question);
  if (blueprintList && graph) {
    const started = Date.now();
    const library = solveBlueprintLibrary(
      graph,
      { name_contains: blueprintList.name_contains },
      { listBlueprints: services?.listBlueprints },
    );

    if (!library.available) {
      return localAnswer(
        `I can't read your blueprint folder: ${library.reason}. ${library.note ?? ""}`.trim(),
        "blueprint_library_unavailable",
        started,
        "The bridge has no blueprint directory configured.",
      );
    }

    const found = library.blueprints ?? [];
    if (found.length === 0) {
      return localAnswer(
        blueprintList.name_contains
          ? `No saved blueprint matches "${blueprintList.name_contains}". ` +
            `You have ${library.total_files_seen ?? 0} in total.`
          : "You have no saved blueprints. Build something in a Blueprint " +
            'Designer and hit "Save Blueprint", and it will show up here.',
        "blueprint_library",
        started,
        "Read from the blueprint folder on disk.",
      );
    }

    const names = new Map();
    for (const entry of found) {
      const key = String(entry.name ?? "").toLocaleLowerCase();
      names.set(key, (names.get(key) ?? 0) + 1);
    }
    const hasDuplicates = [...names.values()].some((count) => count > 1);
    const lines = found.slice(0, 15).map((entry) => {
      const dimensions = entry.designer_dimensions;
      const size = dimensions ? ` — ${dimensions.x}×${dimensions.y} foundations` : "";
      const built = entry.game_changelist ? `, built on CL ${entry.game_changelist}` : "";
      const duplicate = (names.get(String(entry.name ?? "").toLocaleLowerCase()) ?? 0) > 1;
      const reference = entry.blueprint_reference ?? entry.relative_path;
      const disambiguator = duplicate && reference ? ` — reference \`${reference}\`` : "";
      const registration = entry.registered_in_current_session === false
        ? " — not registered for this save's Build Gun"
        : entry.registered_in_current_session === null
          ? " — current-session Build Gun registration unknown"
          : "";
      return `- **${entry.name}**${size}${built}${disambiguator}${registration}`;
    });
    const more = found.length > lines.length ? `\n…and ${found.length - lines.length} more.` : "";
    const hint = hasDuplicates
      ? 'For a duplicate, say "inspect blueprint <reference>" using the listed reference; it is not a filesystem path.'
      : 'Say "place <name> here" to put one down.';

    return localAnswer(
      `You have **${library.blueprint_count ?? found.length}** saved blueprint(s)` +
        (blueprintList.name_contains ? ` matching "${blueprintList.name_contains}"` : "") +
        `:\n\n${lines.join("\n")}${more}\n\n` +
        hint,
      "blueprint_library",
      started,
      "Read from the blueprint folder on disk, not from a model.",
    );
  }

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
        ? `Captured rates: ${plan.sizing.mined_per_minute}/min ` +
          `${plan.sizing.rate_source === "authoritative_live_extractor_rate"
            ? "from the existing extractor"
            : `from this ${plan.sizing.purity} node (${plan.sizing.purity_multiplier}× purity)`} ` +
          `÷ ${plan.sizing.burn_per_minute}/min per generator ` +
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
        `Coal power off **${plan.node}**: ` +
          `${plan.reused_existing_extractor ? `reusing your existing **${plan.miner}**` : `one **${plan.miner}** on the node`}, ` +
          `${chain}.\n\n${sizing}` +
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
        // A generated Blueprint must have the requested standalone capacity;
        // existing surplus elsewhere in the save cannot make its machines
        // disappear. Prefer the ordinary product-named recipe recursively and
        // stop at exact extracted resources, which are external belt/pipe
        // inputs until miner and fluid topology are supported.
        use_existing_surplus: !design.as_blueprint,
        prefer_standard_recipes: design.as_blueprint === true,
        stop_at_extracted_resources: design.as_blueprint === true,
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
        if (design.at_best_site && !design.as_blueprint) {
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
          let generated = null;
          let generatedPower = null;
          let emitted = true;
          if (design.as_blueprint) {
            const revision = String(graph.world_revision ?? "draft").replace(/[^A-Za-z0-9_-]+/g, "-");
            const rate = String(design.per_minute).replace(/[^0-9]+/g, "-");
            const blueprintName = `AI ${item.name} ${rate}pm r${revision}`.slice(0, 240);
            generatedPower = planGeneratedBlueprintPower(graph, actions, {
              shell_footprint: enclosed?.structure?.footprint ?? null,
            });
            const generatedActions = generatedPower.planned
              ? generatedPower.actions
              : actions;
            generated = compileGeneratedBlueprint({
              blueprint_name: blueprintName,
              actions: generatedActions,
              power_connections: generatedPower.planned
                ? generatedPower.power_connections
                : [],
              description:
                `${design.per_minute}/min ${item.name} factory designed from revision ` +
                `${graph.world_revision ?? "unknown"}. Native shell, configured machines, and ` +
                `${generatedActions.filter((action) => action.action === "place_belt").length} ` +
                `explicit conveyor link(s), ${generatedPower.planned ? generatedPower.wires : 0} ` +
                "captured-capacity physical power wire(s).",
            });
            if (!generated.compiled) {
              return localAnswer(
                `I couldn't compile that native Blueprint: ${generated.reason}.`,
                "generate_blueprint_refused",
                started,
                "No file or world action was emitted.",
              );
            }
            const proposal = generatedBlueprintAction(generated, { commit: design.commit });
            emitted = design.commit
              ? emitValidatedPlan(graph, services, [proposal])
              : true;
          } else {
            emitted = design.commit
              ? emitValidatedPlan(graph, services, actions)
              : true;
          }

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
            const generatedPowerText = generated
              ? generatedPower?.planned
                ? generatedPower.mode === "single_external_machine_endpoint"
                  ? " This Blueprint has one powered machine, so its exact native connector is reserved for the external grid; no internal wire is necessary."
                  : ` Internal power is wired with ${generatedPower.wires} native Power Line(s)` +
                    `${generatedPower.poles > 0 ? ` through ${generatedPower.poles} captured-capacity pole(s)` : " as a captured-capacity machine daisy chain"}; one exact connector remains reserved for the external grid.`
                : ` Internal power was not generated: ${generatedPower?.reason ?? "native connector capability was unavailable"}.`
              : " Power is not wired by this plan.";
            const power = plan.power?.plan_draw_mw
              ? `\n\nDraws ${plan.power.plan_draw_mw} MW; ` +
                `${plan.power.fits_on_existing_power ? "your existing circuit can carry that" : "**more generation is needed**"}.` +
                generatedPowerText
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

            const blueprintIntro = generated
              ? `**${design.commit ? "Generating native Blueprint" : "Blueprint design for"} ` +
                `${design.per_minute}/min ${item.name} — ${generated.blueprint_name}** `
              : `**${design.commit ? "Building" : "Design for"} ${design.per_minute}/min ${item.name}** `;
            return localAnswer(
              blueprintIntro +
                `— ${plan.machines_total} machine(s) across ${plan.rows} row(s), ` +
                `${plan.belts_planned} planned belt leg(s).\n\n${rows}${shell}${skipped}${power}\n\n` +
                (generated && design.commit
                  ? `The game is now resolving ${generated.counts.buildables} exact native parts, ` +
                    `${generated.counts.conveyors} conveyor link(s), and ` +
                    `${generated.counts.power_wires} physical power wire(s), ` +
                    "measuring their native hologram-clearance data (with registered primitive bounds as a fallback), refusing internal overlap, " +
                    "serialising them through the real Designer, loading the saved .sbp into Satisfactory's isolated Blueprint world, and requiring reciprocal native endpoint readback. " +
                    `If that result commits, say **"preview blueprint ${generated.blueprint_name}"** ` +
                    "and place it with the vanilla Build Gun. Straight planned belts are included; any reported internal power topology is included too. " +
                    "Pipes, miners/resource anchors, and conveyor lifts/poles remain explicit follow-up work; no missing topology is silently claimed."
                  : design.commit
                  ? "Placing now. Each machine is validated by the game as it goes, and " +
                    'the whole transaction rolls back if one fails. Say "undo" to reverse it.'
                  : `Say **"build a base for ${design.per_minute} ${item.name} per minute"** to place it.`),
              generated
                ? (design.commit ? "generate_native_blueprint" : "design_native_blueprint")
                : (design.commit ? "build_base" : "design_base"),
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
    if (teleport.kind === "coordinates") {
      const action = {
        action: "teleport_player",
        target: teleport.target,
        // Without a stated Z the numbers are a map reference, not a height.
        // Snapping is on either way: the validator warns that turning it off
        // drops the player through the world, and nobody asking this wants that.
        snap_to_ground: true,
        commit: true,
      };
      if (emitValidatedPlan(graph, services, [action])) {
        return localAnswer(
          `Teleporting to \`x=${round(teleport.target.x)}, y=${round(teleport.target.y)}` +
            (teleport.had_z ? `, z=${round(teleport.target.z)}` : "") + "`" +
            (teleport.had_z ? "" : " — no height given, so you land on the ground there") +
            ". The mod reports where you actually arrive.",
          "teleport_player",
          started,
          "Coordinates read from the request; the distance gate still applies.",
        );
      }
      const refusal = describePlanRejection();
      if (refusal) {
        return localAnswer(refusal, "teleport_refused", started, "Refused before anything ran.");
      }
    }

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
