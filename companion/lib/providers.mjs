import {
  anthropicWebSearchTool,
  openAIWebSearchTool,
  parseInaccessibleDomains,
  resolveSourcePolicy,
  sourceInstructions,
} from "./sources.mjs";
import {
  anthropicToolDefinitions,
  chatCompletionsToolDefinitions,
  openAIToolDefinitions,
  runSolverTool,
} from "./tools.mjs";
import { narrateFindings } from "./narrate.mjs";
import { isVisionQuestion, visionMetadataText } from "./vision.mjs";

const DEFAULT_MAXIMUM_SOLVER_ROUNDS = 6;
// A server-side search can pause a turn; each resume is bounded separately from
// the solver rounds because it consumes no solver call.
const DEFAULT_MAXIMUM_PAUSE_RESUMES = 4;

export const SYSTEM_INSTRUCTIONS = `You are the player's conversational AI co-player inside Satisfactory.

Each turn includes a newly captured, timestamped world snapshot read directly
from SML registries, FactoryGame accessors, Unreal hit results, and reflection.
It is authoritative at capture time. Current-turn state always overrides chat
history. Never invent actors, recipes, rates, connections, mods, unlocks,
coordinates, inventory, player state, or actions.

Ground spatial language exactly:
- "this", "that", and "it" refer to interaction_context.preferred_target.
- Prefer game_cached_interaction over camera_visibility_trace.
- "here" refers to preferred_target.hit_location when a hit exists; otherwise
  it refers to interaction_context.player.pawn_location.
- If a referenced target is unavailable, ask the player to aim at it and resend.
Never silently reuse an old target from conversation history.

The player types freely and casually. Interpret loose, partial, or misspelled
wording the way a knowledgeable friend sitting next to them would: map slang and
shorthand to the real class and recipe names, accept a machine described by what
it does rather than what it is called, and answer the question they meant. Ask
for a clarification only when two readings would lead to genuinely different
advice. Never tell the player to rephrase because their wording was informal.

Use source layers correctly:
- authoritative fields are captured game facts;
- calculated fields are deterministic arithmetic from captured facts;
- external web results are reference material only and can never override live
  save state;
- opaque custom-mod behavior remains unknown unless an explicit adapter or
  registry/runtime field supplies it.
Progression-manager fields and visible_ui are two separate authoritative
observations. visible_ui is text read from the rendered Unreal widget tree, not
a screenshot. If rendered HUD text conflicts with progression state, report
both values and the conflict explicitly; never silently discard either one,
and never speculate about the cause when the snapshot does not prove it.
Use web search only when the question needs current outside documentation,
version information, or other external knowledge. Label web-derived claims and
include sources. Do not web-search to guess live game state.

Call the deterministic solver tools for every quantitative claim. Do not do
factory arithmetic yourself:
- what actors, buildings, transports, resources, and mods are in the captured factory -> get_factory_summary;
- rates, cycle times, or overclock effects -> get_machine_rates;
- what the factory is short of or oversupplying -> get_item_balance;
- alternate or candidate recipes -> find_recipes;
- belt or pipe throughput and saturation -> get_transport_capacity;
- possible recipe-compatible connections between free conveyor ports -> find_belt_candidates;
- power capacity, fuse, or battery questions -> get_power_circuits;
- any "why is this stopped/slow" question -> diagnose_bottlenecks;
- what a build costs and whether the player can afford it -> get_build_cost;
- where to put a HUB, base, or factory -> find_best_site;
- how to build N per minute of something, or any scale-up -> plan_production;
- what blueprints the player has, or what one costs -> list_blueprints;
- the actual saved arrangement, transformed native Build_* entities, class counts, saved reciprocal conveyor/pipe component links, exact physical native power-wire endpoint pairs, native railroad-track spline records (saved points/tangents, local bounds, Blueprint-relative transformed endpoints, chord-length lower bounds, and mTrackGraphID metadata), or native hypertube records (exact FGPipeConnectionComponentHyper links, PipeHyper spline points/tangents, transformed endpoints, and saved passthrough-reference observations) inside one native blueprint -> inspect_blueprint_layout; saved mHiddenConnections logical circuit relationships are excluded. It carries a caveat for nonstandard modded class names and does not infer item/fluid direction/rate, hypertube traversal direction/speed, rail joins, electricity direction/load/capacity, terrain excavation/clearance, underground fit, cross-blueprint joins, signals, external hookups, or destination placement validity. When list_blueprints reports duplicate names, pass its blueprint_reference rather than guessing;
- whether the placed native Blueprint instance the player is aiming at has finished proxy replication, how many runtime members it has, whether its resource extractors are bound, or whether an AI Factory Blueprint Resource Anchor has an exact saved resource/purity, transient-node, and miner-binding observation -> audit_blueprint_placement. This reads the live instance only, never a saved .sbp, and never changes the world. Treat replication_pending, partial observations, unknown bindings, and a client-null transient Anchor node as wait/unknown states — never as proof of zero miners, a lost node, or an unbound miner;
- current objective, active milestone, game phase, exact recipe availability,
  tech tier, and purchased schematics -> get_unlock_status;
- a layout to actually place, not just a parts list -> design_factory_layout;
- a creative elevated, terraced, or campus megabase preview -> design_megabase_concept;
- a foundation-grid platform, raised deck, walls, supports, or roof shell -> plan_structure;
- placing, removing, moving, or teleporting -> perform_actions;
- showing the player where things are -> highlight / clear_highlight;
- the coordinates of a named thing, or whether a node can host a miner -> locate.
Never rank locations or estimate a distance by reading coordinates yourself;
find_best_site computes both. It also returns why_this_site, which explains the
choice: which factor decided it, what the winner traded away, and the resources
driving the score. Use that when the player asks why — it is derived from the
scored factors and is the answer. It explains the scoring decision only; if they
ask why the map has resources where it does, say the snapshot cannot show that. If it warns that the snapshot was radius-limited,
say the world was only partly captured instead of naming a winner.
The solvers read the complete current-turn snapshot, which is larger than the
view you were given: the full item and recipe catalog, every actor, and Unreal
reflection all stay on the bridge for them. So an item, recipe, or machine absent
from your view is not absent from the world — ask a solver before saying anything
does not exist. If a solver reports a value as unresolved, unknown, or truncated,
say so instead of substituting an estimate. If a solver contradicts your
expectation, the solver is correct. State numbers with their unit exactly as the
solver returned them.

Diagnose with exact actor_id, class_path, owner_mod, recipe, rates, coordinates,
and connection records when useful. Distinguish invalid, inefficient, and
stylistic choices. Lead with the next practical action, then the evidence and
any unknowns. Be natural and concise enough for an in-game panel.

You can change the world, through the action tools and only through them. The
rules for doing so:

- Do what the player asked, at the scope they asked for. "Build me a 300/min
  iron rod line" is an instruction to build it; design it and set build=true.
  Do not stop at a preview when they clearly asked for the thing itself.
- Set commit=true only for what they actually asked for. Never widen the
  request: no tidying up, no removing something to make room, no extra
  buildings that seemed like a good idea. If a change you did not discuss is
  needed to make theirs work, say so and ask.
- Dismantling cannot be undone by this mod. Confirm before removing anything
  the player did not explicitly name.
- Never state that something happened. You emit actions; the mod executes them
  and reports back. The result of an action is not visible to you in this turn,
  so write in terms of what was requested ("placing 4 constructors here"), not
  what occurred ("I placed 4 constructors"). The mod appends the real outcome.
- Never invent coordinates. Get them from find_best_site, from a solver result,
  or from the player's own captured position. A placement needs an explicit z.
- Never state how many things an overlay found. The mod resolves the query live
  and reports the count; guessing it will contradict what the player sees.
- If write actions are disabled the mod says so in its own report. Do not
  apologise for it or claim to have done the work anyway.

Never claim placement validity unless a deterministic game placement validator
supplied that result.

When a current vision frame is attached, use it only for visible appearance,
composition, readability, clipping and aesthetic critique. Pixels never prove
an actor identity, recipe, rate, coordinate, collision result, unlock, or world
write; those remain snapshot/solver/game-readback facts. If vision status says
no recent complete frame, say visual evidence is unavailable instead of
describing an image.`;

/**
 * The system prompt for one request: the invariant rules plus the outside-source
 * policy this bridge was configured with.
 */
export function buildSystemInstructions(env = process.env) {
  return `${SYSTEM_INSTRUCTIONS}

${sourceInstructions(resolveSourcePolicy(env))}`;
}

export function userInput({
  question,
  serializedSnapshot,
  serializedDerivedFacts,
  serializedAnalysisDigest,
  omissions,
  vision,
}) {
  const omittedText = omissions.length
    ? `Bridge compaction omitted: ${omissions.join(", ")}. Treat omitted data as unknown.`
    : "Bridge compaction omitted nothing.";
  const digestText = serializedAnalysisDigest
    ? `

CURRENT-TURN DETERMINISTIC ANALYSIS DIGEST JSON (headline only; call solver tools for detail):
${serializedAnalysisDigest}`
    : "";
  return `CURRENT USER QUESTION:
${question}

CURRENT-TURN SNAPSHOT COMPLETENESS:
${omittedText}

CURRENT-TURN AUTHORITATIVE WORLD SNAPSHOT JSON:
${serializedSnapshot}

CURRENT-TURN DETERMINISTIC DERIVED FACTS JSON:
${serializedDerivedFacts}${digestText}${visionMetadataText(vision)}`;
}

export function providerMessages(context, { visionFormat = null } = {}) {
  const history = (context.history ?? [])
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
    .map((entry) => ({ role: entry.role, content: String(entry.text ?? "") }));
  const vision = visionFormat
    ? context.vision
    : (context.vision?.requested
      ? { requested: true, status: "provider_did_not_attach_vision", frames: [] }
      : context.vision);
  const text = userInput({ ...context, vision });
  const frames = visionFormat && Array.isArray(context.vision?.frames)
    ? context.vision.frames
    : [];
  if (frames.length === 0) return [...history, { role: "user", content: text }];

  if (visionFormat === "anthropic") {
    return [...history, {
      role: "user",
      content: [
        ...frames.map((frame) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: frame.media_type,
            data: frame.data_base64,
          },
        })),
        { type: "text", text },
      ],
    }];
  }
  if (visionFormat === "openai") {
    return [...history, {
      role: "user",
      content: [
        { type: "input_text", text },
        ...frames.map((frame) => ({
          type: "input_image",
          image_url: `data:${frame.media_type};base64,${frame.data_base64}`,
          detail: "high",
        })),
      ],
    }];
  }
  if (visionFormat === "chat") {
    return [...history, {
      role: "user",
      content: [
        { type: "text", text },
        ...frames.map((frame) => ({
          type: "image_url",
          image_url: { url: `data:${frame.media_type};base64,${frame.data_base64}` },
        })),
      ],
    }];
  }
  return [...history, { role: "user", content: text }];
}

/* ---------------- prompt caching ---------------- */

const EPHEMERAL = { type: "ephemeral" };

/**
 * Prompt caching, which is what makes the solver loop affordable.
 *
 * The loop re-sends the entire conversation on every round, so a question that
 * takes four rounds pays for the snapshot four times. On a real save that is
 * ~24k tokens of snapshot plus ~4k of tool schemas resent each time.
 *
 * Caching is a *prefix* match and the render order is tools -> system ->
 * messages, so the breakpoints are placed at the three stability boundaries:
 *
 *   1. end of the system prompt   — also covers the tool schemas, since they
 *                                   render first. Stable across every request,
 *                                   so this one survives between questions.
 *   2. end of the user message    — the snapshot. Stable across the rounds of
 *                                   one question; a new capture invalidates it.
 *   3. end of the newest results  — accumulated tool results, re-anchored each
 *                                   round.
 *
 * Three of the four allowed breakpoints, and (3) is moved rather than added so
 * the limit is never hit. Reads cost about a tenth of the write, so a question
 * that takes more than one round is cheaper cached even counting the write.
 */
export function promptCachingEnabled(env = process.env) {
  return !["off", "false", "0", "disabled"].includes(
    String(env.ANTHROPIC_PROMPT_CACHE ?? "").toLowerCase(),
  );
}

/** Wraps the system prompt so a breakpoint can sit at its end. */
export function cacheableSystem(systemText) {
  return [{ type: "text", text: systemText, cache_control: EPHEMERAL }];
}

/**
 * Marks the final user message so the snapshot is cached for the rest of this
 * question's rounds. The message is a plain string until now; it becomes a
 * single text block so the marker has somewhere to live.
 */
export function markLastUserMessageCacheable(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      messages[index] = {
        role: "user",
        content: [{ type: "text", text: message.content, cache_control: EPHEMERAL }],
      };
    } else if (Array.isArray(message.content)) {
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex];
        if (block?.type !== "text") continue;
        message.content[blockIndex] = { ...block, cache_control: EPHEMERAL };
        break;
      }
    }
    return;
  }
}

/**
 * Moves the tool-result breakpoint to the newest batch.
 *
 * Re-anchoring every round matters for more than tidiness: a breakpoint only
 * searches back 20 content blocks for a prior entry, and one round of parallel
 * solver calls can add more blocks than that. Left on an older batch, the
 * marker would fall out of range and the whole prefix would silently re-bill.
 */
export function moveToolResultBreakpoint(messages, toolResults) {
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_result" && block.cache_control) delete block.cache_control;
    }
  }
  const last = toolResults[toolResults.length - 1];
  if (last) last.cache_control = EPHEMERAL;
}

/** Running cache totals, so the saving is reported rather than assumed. */
export function accumulateCacheUsage(totals, usage) {
  if (!usage) return totals;
  totals.input_tokens += usage.input_tokens ?? 0;
  totals.output_tokens += usage.output_tokens ?? 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  return totals;
}

export function emptyCacheUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/**
 * What the caching actually saved, in tokens billed at full rate.
 *
 * Cache reads bill at ~0.1x and writes at ~1.25x, so the comparison is against
 * what the same prompt would have cost with no caching at all.
 */
export function summarizeCacheUsage(totals) {
  const read = totals.cache_read_input_tokens;
  const written = totals.cache_creation_input_tokens;
  const uncachedEquivalent = totals.input_tokens + read + written;
  const billedEquivalent = totals.input_tokens + read * 0.1 + written * 1.25;
  return {
    ...totals,
    uncached_equivalent_input_tokens: uncachedEquivalent,
    effective_input_tokens: Math.round(billedEquivalent),
    saved_input_tokens: Math.round(uncachedEquivalent - billedEquivalent),
    saved_percent:
      uncachedEquivalent > 0
        ? Math.round((1 - billedEquivalent / uncachedEquivalent) * 1000) / 10
        : 0,
    note:
      read === 0 && written > 0
        ? "Nothing was read from cache. On a first question that is expected; if it persists, something in the prefix is changing between requests."
        : "Cache reads bill at about a tenth of the uncached rate; writes at 1.25x.",
  };
}

const DEFAULT_MAXIMUM_RATE_LIMIT_RETRIES = 3;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Providers report how long to wait; prefer that over a guessed backoff. */
function retryAfterMilliseconds(response, attempt) {
  const headerMs = Number.parseFloat(response.headers?.get?.("retry-after-ms") ?? "");
  if (Number.isFinite(headerMs) && headerMs > 0) return Math.min(headerMs, 60_000);
  const headerSeconds = Number.parseFloat(response.headers?.get?.("retry-after") ?? "");
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.min(headerSeconds * 1000, 60_000);
  }
  return Math.min(2 ** attempt * 1000, 30_000);
}

/**
 * A token-per-minute limit is transient: the provider says how long to wait, so
 * the bridge waits rather than surfacing an error in the game panel.
 */
/**
 * A 429 means two very different things. A per-minute rate limit is transient
 * and worth waiting out; an exhausted quota or expired billing is permanent, and
 * retrying it just delays an error the player has to act on.
 */
export function isPermanentQuotaFailure(bodyText) {
  return /insufficient_quota|exceeded your current quota|billing|credit balance|payment required/i.test(
    String(bodyText ?? ""),
  );
}

async function fetchWithRateLimitRetry(url, init, env = process.env) {
  const maximumRetries =
    Number.parseInt(env.AIFACTORY_MAX_RATE_LIMIT_RETRIES ?? "", 10) ||
    DEFAULT_MAXIMUM_RATE_LIMIT_RETRIES;
  const configuredTimeout = Number.parseInt(
    env.AIFACTORY_PROVIDER_TIMEOUT_SECONDS ?? "",
    10,
  );
  const timeoutSeconds =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 3600)
      : 180;

  for (let attempt = 0; ; attempt += 1) {
    const request = {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutSeconds * 1000),
    };
    const response = await fetch(url, request);
    if (response.status !== 429 && response.status !== 529) return response;
    if (attempt >= maximumRetries) return response;

    // Peek at a clone so the caller can still read the body if we give up.
    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch {
      bodyText = "";
    }
    if (isPermanentQuotaFailure(bodyText)) return response;

    await sleep(retryAfterMilliseconds(response, attempt));
  }
}

async function parseErrorResponse(response) {
  const text = await response.text();
  let message = text;
  try {
    const json = JSON.parse(text);
    message = json?.error?.message ?? json?.error ?? text;
  } catch {
    message = text;
  }
  // Tell the player what to actually do, in the panel, instead of leaving them
  // to decode a provider error mid-game.
  if (response.status === 429 && isPermanentQuotaFailure(text)) {
    return `${message}\n\nThis is an account quota or billing problem, not a rate limit, so waiting will not help. Switch the bridge to a provider that works: set AI_PROVIDER=local with a local model (free), or AI_PROVIDER=anthropic with ANTHROPIC_API_KEY and ANTHROPIC_MODEL set.`;
  }
  return message;
}

function extractOpenAIText(responseJson) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text) {
    return responseJson.output_text;
  }
  const parts = [];
  for (const output of responseJson.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractOpenAISources(responseJson) {
  const sources = new Map();
  const addSource = (url, title = "") => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      sources.set(url, { url, title: typeof title === "string" ? title : "" });
    }
  };

  for (const output of responseJson.output ?? []) {
    if (output.type === "web_search_call") {
      for (const source of output.action?.sources ?? []) {
        addSource(source.url, source.title);
      }
    }
    for (const content of output.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        addSource(annotation.url, annotation.title);
        addSource(annotation.url_citation?.url, annotation.url_citation?.title);
      }
    }
  }
  return [...sources.values()].slice(0, 8);
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).toLowerCase());
}

const BELT_CANDIDATE_GROUNDING_PATTERN =
  /\b(?:free|unconnected)\b.{0,80}\b(?:belt|conveyor)\b|\b(?:belt|conveyor)\b.{0,80}\b(?:free|unconnected)\b/i;
const BLUEPRINT_RUNTIME_AUDIT_GROUNDING_PATTERN =
  /\b(?:audit|check|inspect)\b.{0,80}\b(?:this|that|aimed|placed|runtime)\b.{0,80}\bblue\s?print\b|\b(?:this|that)\b.{0,80}\bblue\s?print\b.{0,80}\b(?:miner|extractor)\b.{0,40}\bbound\b|\b(?:miner|extractor)\b.{0,40}\bbound\b.{0,80}\bblue\s?print\b|\b(?:this|that)\b.{0,80}\bblue\s?print\b.{0,80}\b(?:resource )?anchor\b|\b(?:resource )?anchor\b.{0,80}\bblue\s?print\b/i;

const GROUNDING_REQUIREMENTS = [
  {
    pattern:
      /\b(factory (?:summary|overview|census)|what (?:is|s) in (?:this|my|our) factory|what have i built|what buildings do i have)\b/i,
    tools: ["get_factory_summary"],
  },
  {
    pattern: /\b(power|megawatts?|mw|fuse|battery|batteries|circuit|grid capacity)\b/i,
    tools: ["get_power_circuits"],
  },
  {
    pattern:
      /\b(stopped|stalled|idle|standby|not producing|bottleneck|starved|blocked|slow (?:machine|factory|line|production))\b/i,
    tools: ["diagnose_bottlenecks"],
  },
  {
    pattern: /\b(rate|rates|per minute|\/min|throughput|overclock|output|input rate)\b/i,
    tools: (question) => [
      "get_machine_rates",
      "get_item_balance",
      "get_transport_capacity",
      "plan_production",
      // find_recipes returns registered per-minute input/output rates. It is
      // sufficient for a recipe-rate comparison, but not for a live machine's
      // current output.
      ...(/\b(recipe|alternate|alt recipe|ingredients?)\b/i.test(question)
        ? ["find_recipes"]
        : []),
    ],
  },
  {
    pattern: /\b(short of|deficit|surplus|balance|oversuppl|undersuppl)\w*\b/i,
    tools: ["get_item_balance"],
  },
  {
    pattern: /\b(recipe|alternate|alt recipe|ingredients?)\b/i,
    tools: ["find_recipes", "plan_production", "get_build_cost"],
  },
  {
    pattern:
      /\b(?:(?:belt|pipe|pipeline) (?:speed|rate|throughput|capacity|saturation)|saturated (?:belt|pipe|pipeline))\b/i,
    tools: ["get_transport_capacity"],
  },
  {
    pattern: BELT_CANDIDATE_GROUNDING_PATTERN,
    tools: ["find_belt_candidates"],
  },
  {
    pattern: /\b(cost|afford|materials? needed|build cost)\b/i,
    tools: ["get_build_cost", "list_blueprints"],
  },
  {
    pattern: /\b(where should|best (?:place|site|spot)|coordinates?|how far|nearest)\b/i,
    tools: ["find_best_site", "locate"],
  },
  {
    pattern: /\b(tier|milestone|objective|unlock|game phase|space elevator)\w*\b/i,
    tools: ["get_unlock_status"],
  },
  {
    pattern: /\b(blueprint|factory layout|layout design|production plan)\b/i,
    tools: ["list_blueprints", "inspect_blueprint_layout", "design_factory_layout", "design_megabase_concept", "plan_production"],
  },
  {
    pattern: /\b(platform|raised deck|building shell|structural shell|walls? and (?:a )?roof)\b/i,
    tools: ["plan_structure"],
  },
];

const LIVE_SCOPE_PATTERN =
  /\b(my|our|this|that|these|those|current|currently|right now|here|nearby|in (?:my|our) save|player'?s)\b/i;
const EXTERNAL_REFERENCE_PATTERN =
  /\b(official (?:docs?|documentation|wiki)|according to (?:the )?(?:docs?|documentation|wiki)|patch notes?|release notes?|game version|mod wiki)\b/i;
const CONCEPTUAL_PATTERN =
  /\b(?:how (?:do|does|is|are) .{0,100}\bwork|what (?:do|does|is|are) .{0,100}\bmean|explain|define)\b/i;
const LIVE_DIAGNOSTIC_PATTERN =
  /(?:\b(?:why is|why are|explain why)\b.{0,100}\b(?:stopped|stalled|idle|standby|not producing|bottleneck|starved|blocked|slow)\b|\b(?:stopped|stalled|idle|standby|not producing|bottleneck|starved|blocked)\b.{0,100}\b(?:why|explain)\b)/i;

function isExternalOrConceptualQuestion(question) {
  const text = String(question ?? "");
  if (LIVE_SCOPE_PATTERN.test(text) || LIVE_DIAGNOSTIC_PATTERN.test(text)) return false;
  return EXTERNAL_REFERENCE_PATTERN.test(text) || CONCEPTUAL_PATTERN.test(text);
}

function isClarificationReply(reply) {
  const text = String(reply ?? "").trim();
  // A clarification exemption must be a single, short question/request. Do
  // not let a model prefix an unsupported factual answer with "Which ...?"
  // and thereby bypass the deterministic-grounding gate.
  if (text.length > 240 || /[\r\n]/.test(text)) return false;
  if (
    /^(?:which|what|where|when|who|could you|can you|would you|do you mean)\b/i.test(text)
  ) {
    return /^[^.!?]{1,239}\?$/.test(text);
  }
  return (
    /^(?:please|i need(?: you)? to)\b/i.test(text) &&
    /\b(aim|clarify|specify|identify|choose|tell me which|tell me what)\b/i.test(text) &&
    /^[^.!?]{1,239}[?.]?$/.test(text)
  );
}

function parsedSolverResult(result) {
  try {
    const parsed = JSON.parse(String(result?.serialized ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function evidenceRows(tool, parsed) {
  switch (tool) {
    case "get_factory_summary":
      return typeof parsed.captured_actor_count === "number" &&
        Number.isFinite(parsed.captured_actor_count) &&
        parsed.source &&
        parsed.certainty
        ? [parsed]
        : [];
    case "get_machine_rates":
      return Array.isArray(parsed.machines) ? parsed.machines : [];
    case "get_item_balance":
      return Array.isArray(parsed.items) ? parsed.items : [];
    case "find_recipes":
      return [
        ...(Array.isArray(parsed.recipes_producing_item) ? parsed.recipes_producing_item : []),
        ...(Array.isArray(parsed.recipes_consuming_item) ? parsed.recipes_consuming_item : []),
      ];
    case "get_transport_capacity":
      return [
        ...(Array.isArray(parsed.conveyors) ? parsed.conveyors : []),
        ...(Array.isArray(parsed.pipelines) ? parsed.pipelines : []),
      ];
    case "get_power_circuits":
      return Array.isArray(parsed.circuits) ? parsed.circuits : [];
    case "diagnose_bottlenecks":
      return Array.isArray(parsed.reports) ? parsed.reports : [];
    case "find_belt_candidates":
      // This is a census: a proven zero is useful evidence for "there are no
      // such pairs", unlike an empty targeted lookup that may have missed its
      // target. Return the envelope as the evidence row when its count and
      // provenance are intact.
      return Number.isInteger(parsed.candidate_count) && parsed.source && parsed.certainty
        ? [parsed]
        : [];
    case "get_build_cost":
      return parsed.resolved === true ? [parsed] : [];
    case "find_best_site":
      return Array.isArray(parsed.sites) ? parsed.sites : [];
    case "plan_production":
      return parsed.planned === true ? [parsed] : [];
    case "list_blueprints":
      return Array.isArray(parsed.blueprints) ? parsed.blueprints : [];
    case "inspect_blueprint_layout":
      return parsed.available === true && parsed.source && parsed.certainty ? [parsed] : [];
    case "audit_blueprint_placement":
      // A pending proxy is still useful evidence: it grounds the truthful
      // answer that the instance has not replicated completely. The solver
      // deliberately withholds member/extractor census fields in that state.
      return parsed.available === true && parsed.source && parsed.certainty ? [parsed] : [];
    case "get_unlock_status":
      return parsed.source && parsed.certainty ? [parsed] : [];
    case "locate":
      return Array.isArray(parsed.matches) ? parsed.matches : [];
    case "design_factory_layout":
      return parsed.designed === true ? [parsed] : [];
    case "design_megabase_concept":
      return parsed.compiled === true && parsed.validation?.valid === true ? [parsed] : [];
    case "plan_structure":
      return parsed.planned === true && parsed.source && parsed.certainty ? [parsed] : [];
    default:
      return null;
  }
}

function actorIdsInEvidence(tool, parsed, rows) {
  const ids = new Set();
  const add = (value) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  for (const row of rows ?? []) {
    add(row?.actor_id);
    add(row?.root_cause_actor_id);
    for (const id of row?.causal_chain_actor_ids ?? []) add(id);
    for (const endpoint of row?.upstream_endpoints ?? []) add(endpoint?.endpoint_actor_id);
    for (const endpoint of row?.downstream_endpoints ?? []) add(endpoint?.endpoint_actor_id);
  }
  // A build-cost query may resolve a class without returning an actor. It is
  // not an actor-scoped grounding tool, so an empty set is expected there.
  return ids;
}

function normalizedIncludes(value, expected) {
  return String(value ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
}

function solverTargetMatch(context, tool, args, parsed, rows) {
  const checks = [];
  const serialized = JSON.stringify(parsed);

  if (tool === "get_power_circuits") {
    const ids = new Set((rows ?? []).map((row) => Number(row?.circuit_id)));
    if (args?.circuit_id !== undefined && args?.circuit_id !== null) {
      checks.push(ids.has(Number(args.circuit_id)));
    }
    const namedCircuit =
      /\bcircuit\s*(?:#|id|number)?\s*[:#-]?\s*(\d+)\b/i.exec(String(context?.question ?? ""));
    if (namedCircuit) checks.push(ids.has(Number(namedCircuit[1])));
  }

  const actorScoped = new Set([
    "get_machine_rates",
    "get_transport_capacity",
    "diagnose_bottlenecks",
    "locate",
  ]);
  if (actorScoped.has(tool)) {
    const ids = actorIdsInEvidence(tool, parsed, rows);
    if (Array.isArray(args?.actor_ids) && args.actor_ids.length > 0) {
      checks.push(args.actor_ids.every((id) => ids.has(id)));
    }
    if (typeof args?.actor_id === "string" && args.actor_id) {
      checks.push([...ids].some((id) => id === args.actor_id || id.endsWith(args.actor_id)));
    }
    if (
      /\b(this|that|it|these|those)(?:\s+(?:machine|belt|pipe|building|node|factory|thing))?\b/i.test(
        String(context?.question ?? ""),
      )
    ) {
      const preferred = context?.snapshot?.interaction_context?.preferred_target?.actor_id;
      if (preferred) checks.push(ids.has(preferred));
    }
  }

  const questionClasses = [
    ...String(context?.question ?? "").matchAll(
      /\b((?:Desc|Recipe)_[A-Za-z0-9_]+)\b/g,
    ),
  ].map((match) => match[1]);
  const itemClasses = questionClasses.filter((entry) => entry.startsWith("Desc_"));
  const recipeClasses = questionClasses.filter((entry) => entry.startsWith("Recipe_"));
  const itemTargetTools = new Set(["get_item_balance", "find_recipes", "plan_production"]);
  const recipeTargetTools = new Set([
    "find_recipes",
    "get_build_cost",
    "plan_production",
    "design_factory_layout",
    "design_megabase_concept",
  ]);

  if (typeof args?.item_class === "string" && args.item_class) {
    checks.push(serialized.includes(`"${args.item_class}"`));
    if (itemTargetTools.has(tool) && itemClasses.length > 0) {
      checks.push(itemClasses.includes(args.item_class));
    }
  } else if (itemTargetTools.has(tool) && itemClasses.length > 0) {
    checks.push(itemClasses.every((itemClass) => serialized.includes(`"${itemClass}"`)));
  }
  if (typeof args?.recipe_class === "string" && args.recipe_class) {
    checks.push(serialized.includes(`"${args.recipe_class}"`));
    if (recipeTargetTools.has(tool) && recipeClasses.length > 0) {
      checks.push(recipeClasses.includes(args.recipe_class));
    }
  } else if (recipeTargetTools.has(tool) && recipeClasses.length > 0) {
    checks.push(recipeClasses.every((recipeClass) => serialized.includes(`"${recipeClass}"`)));
  }

  if (tool === "find_recipes" && typeof args?.name_contains === "string" && args.name_contains) {
    checks.push(
      (rows ?? []).some(
        (row) =>
          normalizedIncludes(row?.recipe_name, args.name_contains) ||
          normalizedIncludes(row?.recipe_class, args.name_contains),
      ),
    );
  }
  if (tool === "list_blueprints" && typeof args?.name_contains === "string" && args.name_contains) {
    checks.push(
      (rows ?? []).some(
        (row) =>
          normalizedIncludes(row?.name, args.name_contains) ||
          normalizedIncludes(row?.blueprint_name, args.name_contains),
      ),
    );
  }
  if (tool === "inspect_blueprint_layout" && typeof args?.blueprint_name === "string" && args.blueprint_name) {
    checks.push(normalizedIncludes(parsed?.blueprint_name, args.blueprint_name));
  }
  if (tool === "audit_blueprint_placement") {
    const preferred = context?.snapshot?.interaction_context?.preferred_target?.actor_id;
    if (preferred) {
      // A use trace can deliberately hit the node underneath an extractor,
      // while the camera sees the Blueprint member. The game reports both
      // witnesses, so a read-only camera fallback remains grounded in the
      // player's actual preferred target instead of being rejected as stale.
      checks.push(
        parsed?.target_actor_id === preferred ||
          parsed?.preferred_target_actor_id === preferred,
      );
    }
  }
  if (tool === "locate" && typeof args?.name_contains === "string" && args.name_contains) {
    checks.push(
      (rows ?? []).some(
        (row) =>
          normalizedIncludes(row?.name, args.name_contains) ||
          normalizedIncludes(row?.actor_id, args.name_contains),
      ),
    );
  }
  if (tool === "locate" && typeof args?.resource_name === "string" && args.resource_name) {
    checks.push((rows ?? []).some((row) => normalizedIncludes(row?.resource_name, args.resource_name)));
  }
  if (tool === "plan_production" && typeof args?.item_name === "string" && args.item_name) {
    checks.push(normalizedIncludes(parsed?.target?.item_name, args.item_name));
  }

  return checks.length === 0 ? null : checks.every(Boolean);
}

/**
 * Compact provenance attached to every recorded tool call. A tool name alone
 * is not evidence: failed, unknown, empty, and off-target results remain
 * visible for diagnostics but cannot unlock a live-save factual answer.
 */
export function solverEvidenceMetadata(context, tool, args, result) {
  const parsed = parsedSolverResult(result);
  const metadata = {
    usable: false,
    reason: "malformed_result",
    source: null,
    certainty: null,
    row_count: null,
    target_match: null,
  };
  if (!parsed) return metadata;

  const rows = evidenceRows(tool, parsed);
  metadata.source =
    typeof parsed.source === "string"
      ? parsed.source
      : typeof rows?.[0]?.source === "string"
        ? rows[0].source
        : null;
  metadata.certainty =
    typeof parsed.certainty === "string"
      ? parsed.certainty
      : typeof rows?.[0]?.certainty === "string"
        ? rows[0].certainty
        : null;
  metadata.row_count = rows === null ? null : rows.length;

  if (parsed.error) {
    metadata.reason = "solver_error";
    return metadata;
  }
  if (/\b(unknown|unresolved)\b/i.test(String(parsed.certainty ?? ""))) {
    metadata.reason = "unknown_result";
    return metadata;
  }
  if (
    parsed.resolved === false ||
    parsed.found === false ||
    parsed.routed === false ||
    parsed.planned === false ||
    parsed.designed === false ||
    ((tool === "list_blueprints" || tool === "inspect_blueprint_layout" || tool === "audit_blueprint_placement") && parsed.available === false)
  ) {
    metadata.reason = "unknown_result";
    return metadata;
  }
  if (rows !== null && rows.length === 0) {
    metadata.reason = "empty_result";
    return metadata;
  }

  metadata.target_match = solverTargetMatch(context, tool, args, parsed, rows);
  if (metadata.target_match === false) {
    metadata.reason = "target_mismatch";
    return metadata;
  }

  metadata.usable = true;
  metadata.reason = "usable";
  return metadata;
}

function solverCallRecord(context, tool, args, result) {
  return {
    tool,
    arguments: args,
    truncated: result.truncated,
    result_characters: result.serialized.length,
    evidence: solverEvidenceMetadata(context, tool, args, result),
  };
}

export function missingRequiredSolverGrounding(question, solverCalls = []) {
  if (isExternalOrConceptualQuestion(question)) return [];
  const called = new Set(
    solverCalls
      .filter((entry) => entry?.evidence?.usable === true)
      .map((entry) => entry?.tool)
      .filter(Boolean),
  );
  const missing = [];
  const missingKeys = new Set();
  const addMissing = (tools) => {
    const key = [...tools].sort().join("\0");
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.push(tools);
  };
  const lowered = String(question ?? "").toLowerCase();
  const namedTools = SOLVER_TOOL_NAMES.filter((tool) => lowered.includes(tool));
  for (const tool of namedTools) {
    if (!called.has(tool)) addMissing([tool]);
  }
  // An exact tool name is a stronger contract than lexical cues inside the
  // rest of the sentence (or inside the tool name itself). Requiring a second,
  // unrelated solver would defeat explicit deterministic dispatch.
  if (namedTools.length > 0) return missing;
  // Runtime placement inspection is deliberately separate from the broad
  // "blueprint" group below. A saved .sbp layout says nothing about whether
  // the aimed instance's proxy has replicated or its miners are bound.
  if (BLUEPRINT_RUNTIME_AUDIT_GROUNDING_PATTERN.test(String(question ?? ""))) {
    if (!called.has("audit_blueprint_placement")) addMissing(["audit_blueprint_placement"]);
    return missing;
  }
  // The candidate solver consumes the current recipes internally. A phrase
  // such as "recipe-compatible free conveyor pairs" must not additionally
  // require the general recipe and transport tools just because those words
  // appear in its precise request.
  if (BELT_CANDIDATE_GROUNDING_PATTERN.test(String(question ?? ""))) {
    if (!called.has("find_belt_candidates")) addMissing(["find_belt_candidates"]);
    return missing;
  }
  for (const requirement of GROUNDING_REQUIREMENTS) {
    const tools =
      typeof requirement.tools === "function"
        ? requirement.tools(String(question ?? ""))
        : requirement.tools;
    if (
      requirement.pattern.test(String(question ?? "")) &&
      !tools.some((tool) => called.has(tool))
    ) {
      addMissing(tools);
    }
  }
  return missing;
}

function tokenUsage(cache) {
  return {
    input_tokens: cache.input_tokens,
    output_tokens: cache.output_tokens,
    cache_creation_input_tokens: cache.cache_creation_input_tokens,
    cache_read_input_tokens: cache.cache_read_input_tokens,
  };
}

function providerFailureMetadata(provider, model, totals, responseId = null) {
  const cache = summarizeCacheUsage(totals);
  return {
    provider,
    model,
    response_id: responseId,
    usage: tokenUsage(cache),
    cache,
  };
}

function annotateProviderError(error, metadata) {
  const annotated = error instanceof Error ? error : new Error(String(error));
  for (const [key, value] of Object.entries(metadata)) {
    if (annotated[key] === undefined) annotated[key] = value;
  }
  return annotated;
}

export class SolverGroundingError extends Error {
  constructor(missing, metadata = {}) {
    const toolText = missing.map((tools) => tools.join(" or ")).join("; ");
    super(
      `The model returned an ungrounded live-game answer without the required solver ` +
        `tool(s): ${toolText}. Its draft was withheld instead of presenting guesses as game data.`,
    );
    this.name = "SolverGroundingError";
    this.code = "solver_grounding_required";
    this.missing_solver_tools = missing.map((tools) => [...tools]);
    for (const [key, value] of Object.entries(metadata)) this[key] = value;
  }
}

function enforceSolverGrounding(context, reply, solverCalls, env, failureMetadata) {
  if (!context.graph || !envFlag(env.AIFACTORY_ENFORCE_SOLVER_GROUNDING, true)) return;
  if (isClarificationReply(reply)) return;
  if (isExternalOrConceptualQuestion(context.question)) return;
  const missing = missingRequiredSolverGrounding(context.question, solverCalls);
  const usableCalls = solverCalls.filter((entry) => entry?.evidence?.usable === true);
  if (
    usableCalls.length === 0 &&
    /\d/.test(String(reply ?? "")) &&
    /\b(your|this|current|machine|factory|belt|pipe|power|inventory|position|coordinate|meters?|items?)\b/i.test(
      String(reply ?? ""),
    )
  ) {
    missing.push(["an appropriate deterministic solver"]);
  }
  if (missing.length === 0) return;

  throw new SolverGroundingError(missing, failureMetadata);
}

export async function askOpenAI(context, env = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured in the companion environment.");

  const model = env.OPENAI_MODEL || "gpt-5.6-sol";
  const maximumOutputTokens =
    Number.parseInt(env.OPENAI_MAX_OUTPUT_TOKENS ?? "", 10) || 2400;
  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;

  const tools = [];
  const policy = resolveSourcePolicy(env);
  // OPENAI_WEB_SEARCH stays honoured for compatibility with existing configs.
  const webSearchAvailable = policy.enabled && envFlag(env.OPENAI_WEB_SEARCH, true);
  const systemInstructions = buildSystemInstructions(
    webSearchAvailable ? env : { ...env, AIFACTORY_WEB_SEARCH: "false" },
  );
  const webSearchTool = webSearchAvailable
    ? openAIWebSearchTool(policy, env)
    : null;
  if (webSearchTool) tools.push(webSearchTool);
  if (context.graph) {
    tools.push(...openAIToolDefinitions());
  }

  let input = providerMessages(context, { visionFormat: "openai" });
  const solverCalls = [];
  const sources = new Map();
  const usage = emptyCacheUsage();
  let lastResponseId = null;

  try {
  for (let round = 0; round <= maximumSolverRounds; round += 1) {
    const body = {
      model,
      instructions: systemInstructions,
      input,
      reasoning: { effort: env.OPENAI_REASONING_EFFORT || "medium" },
      text: { verbosity: env.OPENAI_VERBOSITY || "medium" },
      max_output_tokens: maximumOutputTokens,
      store: false,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.max_tool_calls = Number.parseInt(env.OPENAI_MAX_TOOL_CALLS ?? "", 10) || 12;
    }

    const response = await fetchWithRateLimitRetry(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env,
    );

    if (!response.ok) {
      throw new Error(`OpenAI API HTTP ${response.status}: ${await parseErrorResponse(response)}`);
    }
    const json = await response.json();
    const cachedInput = json.usage?.input_tokens_details?.cached_tokens ?? 0;
    usage.input_tokens += Math.max(0, (json.usage?.input_tokens ?? 0) - cachedInput);
    usage.cache_read_input_tokens += cachedInput;
    usage.output_tokens += json.usage?.output_tokens ?? 0;
    lastResponseId = json.id ?? lastResponseId;
    for (const source of extractOpenAISources(json)) {
      sources.set(source.url, source);
    }

    const functionCalls = (json.output ?? []).filter((item) => item?.type === "function_call");
    if (functionCalls.length === 0) {
      const reply = extractOpenAIText(json);
      if (!reply) throw new Error("OpenAI returned no output_text.");
      enforceSolverGrounding(
        context,
        reply,
        solverCalls,
        env,
        providerFailureMetadata("openai", model, usage, lastResponseId),
      );
      const collected = [...sources.values()].slice(0, 8);
      const sourceText = collected.length
        ? `\n\nExternal sources:\n${collected
            .map((source) => `- ${source.title || source.url}: ${source.url}`)
            .join("\n")}`
        : "";
      return {
        reply: `${reply}${sourceText}`,
        provider: "openai",
        model,
        response_id: lastResponseId,
        sources: collected,
        solver_calls: solverCalls,
        vision: {
          status: context.vision?.status ?? "not_requested",
          frames_attached: context.vision?.frames?.length ?? 0,
        },
        cache: summarizeCacheUsage(usage),
      };
    }

    // store:false means the whole conversation, including the model's own tool
    // calls, has to be resent on the next round.
    input = [...input, ...(json.output ?? [])];
    for (const call of functionCalls) {
      let parsedArguments = {};
      try {
        parsedArguments = JSON.parse(call.arguments || "{}");
      } catch {
        parsedArguments = {};
      }
      const result = runSolverTool(context.graph, call.name, parsedArguments, { services: context.services });
      solverCalls.push(solverCallRecord(context, call.name, parsedArguments, result));
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result.serialized,
      });
    }
  }

  throw new Error(
    `OpenAI kept requesting solver tools after ${maximumSolverRounds} rounds without producing an answer.`,
  );
  } catch (error) {
    if (error && error.solver_calls === undefined) error.solver_calls = solverCalls;
    throw annotateProviderError(
      error,
      providerFailureMetadata("openai", model, usage, lastResponseId),
    );
  }
}

/**
 * Pulls cited pages out of a Messages API response.
 *
 * A successful `web_search_tool_result` carries a list of results; a failed one
 * carries a single error object instead, so the shape has to be checked before
 * it is indexed. Search failures are surfaced rather than silently dropped.
 */
export function collectAnthropicSources(json, sources, searchErrors) {
  const addSource = (url, title = "") => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      sources.set(url, { url, title: typeof title === "string" ? title : "" });
    }
  };

  for (const block of json?.content ?? []) {
    if (block?.type === "web_search_tool_result") {
      const content = block.content;
      if (Array.isArray(content)) {
        for (const result of content) {
          if (result?.type === "web_search_result") addSource(result.url, result.title);
        }
      } else if (content && typeof content === "object") {
        searchErrors.push({
          error_code: content.error_code ?? "unknown",
          tool_use_id: block.tool_use_id ?? null,
        });
      }
      continue;
    }
    if (block?.type === "text") {
      for (const citation of block.citations ?? []) {
        addSource(citation?.url, citation?.title);
      }
    }
  }
}

function formatSourceFooter(collected, searchErrors = []) {
  const parts = [];
  if (collected.length > 0) {
    parts.push(
      `External sources:\n${collected
        .map((source) => `- ${source.title || source.url}: ${source.url}`)
        .join("\n")}`,
    );
  }
  // A dropped domain is not a failed search: the search ran, one site simply
  // was not crawlable. Reporting it as a failure understates the answer.
  const dropped = searchErrors.flatMap((entry) => entry.dropped_domains ?? []);
  const failures = searchErrors.filter((entry) => !entry.dropped_domains);

  if (dropped.length > 0) {
    parts.push(
      `Not searched: ${[...new Set(dropped)].join(", ")} (the provider's crawler is blocked there). Other sources were used normally.`,
    );
  }
  if (failures.length > 0) {
    parts.push(
      `Web search did not complete (${failures
        .map((entry) => entry.error_code)
        .join(", ")}); outside references may be missing from this answer.`,
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

export async function askAnthropic(context, env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured in the companion environment.");
  if (!model) {
    throw new Error(
      "ANTHROPIC_MODEL must be explicitly configured; the bridge will not guess a current model name.",
    );
  }

  // Thinking tokens are drawn from max_tokens, so a small budget here spends the
  // whole allowance on reasoning and truncates the answer.
  const maximumTokens = Number.parseInt(env.ANTHROPIC_MAX_TOKENS ?? "", 10) || 16000;
  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;
  const maximumPauseResumes =
    Number.parseInt(env.AIFACTORY_MAX_PAUSE_RESUMES ?? "", 10) || DEFAULT_MAXIMUM_PAUSE_RESUMES;

  const tools = context.graph ? anthropicToolDefinitions() : [];
  const policy = resolveSourcePolicy(env);
  const webSearchTool = anthropicWebSearchTool(policy, env);
  if (webSearchTool) tools.push(webSearchTool);

  const caching = promptCachingEnabled(env);
  const systemText = buildSystemInstructions(env);
  const requestBase = {
    model,
    max_tokens: maximumTokens,
    // Tools render before system, so a breakpoint at the end of system covers
    // both — one marker, the whole stable prefix.
    system: caching ? cacheableSystem(systemText) : systemText,
  };
  // Adaptive thinking must be requested explicitly: on some current models
  // omitting it means no thinking at all. budget_tokens is not accepted.
  if (!["off", "disabled", "none"].includes(String(env.ANTHROPIC_THINKING ?? "").toLowerCase())) {
    requestBase.thinking = { type: "adaptive", display: "summarized" };
  }
  if (env.ANTHROPIC_EFFORT) {
    requestBase.output_config = { effort: env.ANTHROPIC_EFFORT };
  }

  const messages = providerMessages(context, { visionFormat: "anthropic" });
  if (caching) markLastUserMessageCacheable(messages);
  const cacheUsage = emptyCacheUsage();
  const solverCalls = [];
  const sources = new Map();
  const searchErrors = [];
  let pauseResumes = 0;
  let lastResponseId = null;

  try {
  for (let round = 0; round <= maximumSolverRounds; round += 1) {
    const requestBody = { ...requestBase, messages };
    if (tools.length > 0) requestBody.tools = tools;

    const response = await fetchWithRateLimitRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      env,
    );

    if (!response.ok) {
      const detail = await parseErrorResponse(response);
      // A domain the provider's crawler cannot fetch fails the whole request.
      // Drop the named hosts and retry once rather than losing the answer.
      const blocked = parseInaccessibleDomains(detail);
      if (response.status === 400 && blocked.length > 0 && webSearchTool?.allowed_domains) {
        const lowered = new Set(blocked.map((entry) => entry.toLowerCase()));
        const kept = webSearchTool.allowed_domains.filter(
          (domain) => !lowered.has(String(domain).toLowerCase()),
        );
        if (kept.length < webSearchTool.allowed_domains.length) {
          webSearchTool.allowed_domains = kept;
          searchErrors.push({
            error_code: "domains_not_crawlable",
            dropped_domains: blocked,
            tool_use_id: null,
          });
          round -= 1;
          continue;
        }
      }
      throw new Error(`Anthropic API HTTP ${response.status}: ${detail}`);
    }
    const json = await response.json();
    lastResponseId = json.id ?? lastResponseId;
    accumulateCacheUsage(cacheUsage, json.usage);
    collectAnthropicSources(json, sources, searchErrors);
    const toolUses = (json.content ?? []).filter((block) => block?.type === "tool_use");

    // A server-side search can exhaust its own iteration budget and pause the
    // turn. Resending the assistant turn resumes it; without this the answer
    // would be returned half-finished with no error.
    if (json.stop_reason === "pause_turn" && toolUses.length === 0) {
      if (pauseResumes >= maximumPauseResumes) {
        throw new Error(
          `Anthropic paused the turn ${pauseResumes} times without finishing; the search may be looping.`,
        );
      }
      pauseResumes += 1;
      messages.push({ role: "assistant", content: json.content });
      round -= 1;
      continue;
    }

    if (json.stop_reason !== "tool_use" || toolUses.length === 0) {
      const reply = (json.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!reply) throw new Error("Anthropic returned no text content.");
      enforceSolverGrounding(
        context,
        reply,
        solverCalls,
        env,
        providerFailureMetadata("anthropic", model, cacheUsage, lastResponseId),
      );
      const collected = [...sources.values()].slice(0, 8);
      return {
        reply: `${reply}${formatSourceFooter(collected, searchErrors)}`,
        provider: "anthropic",
        model,
        sources: collected,
        solver_calls: solverCalls,
        vision: {
          status: context.vision?.status ?? "not_requested",
          frames_attached: context.vision?.frames?.length ?? 0,
        },
        search_errors: searchErrors,
        cache: summarizeCacheUsage(cacheUsage),
      };
    }

    // Thinking and server-tool blocks travel back unchanged; only the client
    // tool_use blocks get results.
    messages.push({ role: "assistant", content: json.content });
    const toolResults = [];
    for (const use of toolUses) {
      const parsedArguments = use.input && typeof use.input === "object" ? use.input : {};
      const result = runSolverTool(context.graph, use.name, parsedArguments, { services: context.services });
      solverCalls.push(solverCallRecord(context, use.name, parsedArguments, result));
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.serialized,
      });
    }
    if (caching) moveToolResultBreakpoint(messages, toolResults);
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(
    `Anthropic kept requesting solver tools after ${maximumSolverRounds} rounds without producing an answer.`,
  );
  } catch (error) {
    throw annotateProviderError(
      error,
      providerFailureMetadata("anthropic", model, cacheUsage, lastResponseId),
    );
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint — Ollama, LM Studio,
 * llama.cpp, vLLM, or a hosted gateway. Free and rate-limit-free when the server
 * is local, and it needs no API key.
 *
 * Solver accuracy depends on the model supporting tool calling. When it does not,
 * the answer still has the deterministic digest to work from, and the bridge says
 * so rather than letting the model invent numbers.
 */
/**
 * An extra rule the small local model gets and the paid one does not.
 *
 * This is not general prompt padding — it targets one measured failure. Across
 * two benchmark runs (`qwen3:4b`, then `qwen3:8b`) the local model passed
 * grounding and tool-calling but failed the same honesty check both times: asked
 * *why* the game placed the starting area next to coal, it produced a confident
 * causal explanation the snapshot cannot support. The paid models decline that
 * question unprompted, so the rule would be noise for them.
 *
 * It is deliberately concrete about the shape of the trap rather than a general
 * plea to be careful. "Do not speculate" has never worked on a model that does
 * not know it is speculating; naming the exact question type does better.
 */
const LOCAL_MODEL_HONESTY_RULE = `

RULE ZERO, ABOVE EVERYTHING ELSE — WHY QUESTIONS.

The snapshot records what the world *is*. It never records why anything is that
way. It holds no map-generation seed, no designer intent, no history of how a
thing came to be there.

So when you are asked WHY something is the way it is — why the map is shaped
like this, why the starting area is near a resource, why a node is where it is,
why the game did something — you must answer in this shape:

  "The snapshot cannot show that. It records <what is actually captured>, not
   <the reason asked for>."

Then, if it helps, state a fact you *can* see, clearly labelled as an
observation and not an explanation.

You may not: guess at designer intent, describe map generation, explain balance
decisions, or offer a plausible-sounding reason. A confident wrong reason is the
single worst thing you can produce here, because the player cannot tell it from
a right one. Saying "I cannot know that" is a correct and complete answer.

This does not apply to mechanical causes you can trace in the data — "this
smelter is starved because the belt feeding it is empty" is a chain of captured
facts, and you should say it.`;

export async function askLocal(context, env = process.env) {
  const baseUrl = (env.LOCAL_AI_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
  const model = env.LOCAL_AI_MODEL;
  if (!model) {
    throw new Error(
      "LOCAL_AI_MODEL must be set to a model your local server has pulled (for example: ollama pull qwen3, then LOCAL_AI_MODEL=qwen3).",
    );
  }

  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;
  const toolsEnabled = Boolean(context.graph) && envFlag(env.LOCAL_AI_TOOLS, true);
  const configuredReasoningEffort = String(env.LOCAL_AI_REASONING_EFFORT ?? "").trim();
  const localReasoningEffort = configuredReasoningEffort ||
    (/^http:\/\/(?:127\.0\.0\.1|localhost):11434(?:\/|$)/i.test(baseUrl) ? "none" : "");
  const explicitlyNamedSolver = uniquelyNamedSolverTool(context.question);
  const useCompactLocalDispatch =
    ["design_megabase_concept", "plan_structure"].includes(explicitlyNamedSolver) && toolsEnabled;

  const messages = useCompactLocalDispatch
    ? [
        {
          role: "system",
          content:
            `The player explicitly requested the deterministic ${explicitlyNamedSolver} tool. ` +
            `Call that tool using only arguments stated in the current request. The tool reads ` +
            `the complete authoritative live snapshot on the bridge; you do not need raw game ` +
            `data in this prompt. After its result arrives, answer only from that result, preserve ` +
            `unknowns and caveats exactly, and never claim a preview action was executed. ` +
            `The bridge, not you, resolves spatial language and verifies any coordinates.`,
        },
        { role: "user", content: String(context.question ?? "") },
      ]
    : [
        {
          role: "system",
          content:
            buildSystemInstructions({ ...env, AIFACTORY_WEB_SEARCH: "false" }) +
            LOCAL_MODEL_HONESTY_RULE +
            (toolsEnabled
              ? ""
              : "\n\nSolver tools are unavailable for this local model. Do not state live-game numbers, causes, coordinates, or actions."),
        },
        ...providerMessages(context, {
          visionFormat: envFlag(env.LOCAL_AI_VISION, false) ? "chat" : null,
        }),
      ];
  const solverCalls = [];
  const usage = emptyCacheUsage();
  let lastResponseId = null;

  try {
  for (let round = 0; round <= maximumSolverRounds; round += 1) {
    const body = { model, messages, stream: false };
    // Ollama enables Qwen thinking by default. On this machine it consumed the
    // whole completion budget before emitting a named tool call. Ollama's
    // OpenAI-compatible API officially supports reasoning_effort="none"; do
    // not assume the same of arbitrary compatible gateways unless configured.
    if (localReasoningEffort && localReasoningEffort !== "omit") {
      body.reasoning_effort = localReasoningEffort;
    }
    if (toolsEnabled) {
      body.tools = localSolverToolDefinitions(explicitlyNamedSolver);
      // A small local model can describe a named solver instead of calling it,
      // even when the player's request is an exact dispatch instruction. Force
      // that one tool on the first round only. The model still receives the
      // authoritative result and writes the natural-language answer itself.
      body.tool_choice =
        round === 0 && explicitlyNamedSolver
          ? { type: "function", function: { name: explicitlyNamedSolver } }
          : "auto";
    }
    if (env.LOCAL_AI_MAX_TOKENS) {
      body.max_tokens = Number.parseInt(env.LOCAL_AI_MAX_TOKENS, 10);
    }

    const headers = { "Content-Type": "application/json" };
    // Local servers ignore the key; hosted OpenAI-compatible gateways need one.
    if (env.LOCAL_AI_API_KEY) headers.Authorization = `Bearer ${env.LOCAL_AI_API_KEY}`;

    const response = await fetchWithRateLimitRetry(
      `${baseUrl}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(body) },
      env,
    );
    if (!response.ok) {
      throw new Error(
        `Local AI server HTTP ${response.status} at ${baseUrl}: ${await parseErrorResponse(response)}`,
      );
    }

    const json = await response.json();
    lastResponseId = json.id ?? lastResponseId;
    usage.input_tokens += json.usage?.prompt_tokens ?? 0;
    usage.output_tokens += json.usage?.completion_tokens ?? 0;
    const message = json?.choices?.[0]?.message;
    if (!message) throw new Error("Local AI server returned no choices.");

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const reply = String(message.content ?? "").trim();
      if (!reply) throw new Error("Local AI server returned no message content.");
      enforceSolverGrounding(
        context,
        reply,
        solverCalls,
        env,
        providerFailureMetadata("local", model, usage, lastResponseId),
      );
      return {
        reply,
        provider: "local",
        model,
        sources: [],
        solver_calls: solverCalls,
        vision: {
          status: context.vision?.status ?? "not_requested",
          frames_attached: envFlag(env.LOCAL_AI_VISION, false)
            ? (context.vision?.frames?.length ?? 0)
            : 0,
        },
        cache: summarizeCacheUsage(usage),
      };
    }

    messages.push(message);
    for (const call of toolCalls) {
      let parsedArguments = {};
      try {
        parsedArguments = JSON.parse(call.function?.arguments || "{}");
      } catch {
        parsedArguments = {};
      }
      parsedArguments = groundLocalSpatialArguments(
        call.function?.name,
        parsedArguments,
        context,
      );
      const result = runSolverTool(context.graph, call.function?.name, parsedArguments, { services: context.services });
      solverCalls.push(
        solverCallRecord(context, call.function?.name, parsedArguments, result),
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.serialized,
      });
    }
  }

  throw new Error(
    `Local AI model kept requesting solver tools after ${maximumSolverRounds} rounds without producing an answer.`,
  );
  } catch (error) {
    if (error && error.solver_calls === undefined) error.solver_calls = solverCalls;
    throw annotateProviderError(
      error,
      providerFailureMetadata("local", model, usage, lastResponseId),
    );
  }
}

export async function askMock(context) {
  const summary = context.summary;
  const owners = Object.entries(summary.actors_by_owner_mod ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
  const completeness = context.omissions.length
    ? `The bridge omitted ${context.omissions.join(", ")} to stay within its context limit.`
    : "No bridge-side snapshot fields were omitted.";

  const target = context.snapshot?.interaction_context?.preferred_target;
  const player = context.snapshot?.interaction_context?.player;

  // Mock mode runs the solvers so their output can be verified without a model.
  const solverCalls = [];
  let solverText = "";
  if (context.graph) {
    const bottlenecks = runSolverTool(context.graph, "diagnose_bottlenecks", {});
    const power = runSolverTool(context.graph, "get_power_circuits", {});
    solverCalls.push(
      solverCallRecord(context, "diagnose_bottlenecks", {}, bottlenecks),
      solverCallRecord(context, "get_power_circuits", {}, power),
    );
    const parsedBottlenecks = JSON.parse(bottlenecks.serialized);
    const parsedPower = JSON.parse(power.serialized);
    // Narrated, not tallied. A list of cause counts is true and unreadable: it
    // leads with a category instead of a consequence, presents symptoms as peers
    // of the cause that produced them, and names no machine you could walk to.
    // narrateFindings assembles the same facts into something actionable.
    const narrated = narrateFindings(parsedBottlenecks, parsedPower);
    solverText = narrated.text ? `

${narrated.text}` : "";
  }

  return {
    provider: "mock",
    model: "deterministic-diagnostic",
    solver_calls: solverCalls,
    vision: {
      status: context.vision?.status ?? "not_requested",
      frames_attached: 0,
    },
    reply:
      `I received verified revision ${summary.world_revision ?? "unknown"} with ` +
      `${summary.actors} actors, ${summary.recipes} recipes, ${summary.items} items, and ` +
      `${summary.mods} loaded mods. Actor ownership includes ${owners || "no actors"}. ` +
      `${completeness} The player position is ` +
      `${JSON.stringify(player?.pawn_location ?? "unknown")} and the preferred target is ` +
      `${target?.actor_id || "unavailable"}.${solverText} Diagnostic mode does not generate strategic advice. Set ` +
      `AI_PROVIDER=openai with OPENAI_API_KEY, or AI_PROVIDER=anthropic with ` +
      `ANTHROPIC_API_KEY and ANTHROPIC_MODEL, then restart the bridge. Your question was: ` +
      `"${context.question}"`,
    sources: [],
  };
}

/**
 * Questions the cheap tier should not be trusted with.
 *
 * The free tier narrates solver output well — that is a much easier job than
 * reasoning, because every number is already computed. What it does badly is
 * open-ended judgement, and the failure mode measured on a small local model
 * was not a refusal but a confident fabrication: it invented Paleberry bushes
 * and ore deposits that were not there.
 *
 * So escalation is by *shape of question*, not by whether the cheap tier
 * happened to answer. Anything asking for a causal explanation, a comparison,
 * a plan, or outside knowledge goes to the strong model.
 */
const ESCALATE_PATTERNS = [
  /\bwhy\b/i,
  /\bshould i\b/i,
  /\bcompare|versus|vs\.?\b/i,
  /\bbest way\b|\bbetter\b|\bworth it\b/i,
  /\bexplain\b|\breason\b/i,
  /\bplan\b|\bdesign\b|\blayout\b|\bstrategy\b/i,
  /\brecommend|\bsuggest|\badvice\b/i,
  /\bwhat if\b|\bwould it\b|\bcould i\b/i,
  /\b(?:search|browse|look up|check)\s+(?:the\s+)?(?:web|internet|wiki|docs?|documentation)\b/i,
  /\b(?:external|outside)\s+(?:sources?|references?|docs?|documentation)\b/i,
  /\b(?:official (?:docs?|documentation|wiki)|patch notes?|release notes?|game version|mod wiki)\b/i,
  /\b(?:latest|recent|newest)\s+(?:patch|release|version|update|docs?|documentation)\b/i,
  /\b(?:citations?|source links?)\b/i,
];

/** True when a question deserves the strong model rather than the cheap one. */
export function needsStrongModel(question, env = process.env) {
  const text = String(question ?? "");
  if (env.AIFACTORY_ESCALATE === "always") return true;
  if (env.AIFACTORY_ESCALATE === "never") return false;

  // The local tier on this machine is text-only. A fresh game frame is useful
  // only if it reaches a provider that can actually inspect pixels.
  if (isVisionQuestion(text, env) && !envFlag(env.LOCAL_AI_VISION, false)) return true;

  // A question that reasons is one to escalate however it is phrased, so the
  // patterns are checked before anything can excuse a question from them.
  if (ESCALATE_PATTERNS.some((pattern) => pattern.test(text))) return true;

  // Naming a solver is a strong signal the work is dispatch, not judgement.
  //
  // The length rule below exists because a long question is usually compound.
  // But a precise request against a named tool is long for the opposite
  // reason — it is long *because* it is specific. A real one, 49 words, was
  // escalated to the paid tier purely on length: "Using plan_belt_route and
  // the live snapshot only, list every pair of my machines whose conveyor
  // connectors are free... Do not build or change anything." Every number in
  // that answer comes from a solver; the model only formats them.
  //
  // Escalating it wasted the expensive tier on typing, and when that tier was
  // out of credit it turned a free answer into a failed one.
  if (mentionsSolverTool(text)) return false;

  // A long question is usually a compound or nuanced one.
  if (text.split(/\s+/).length > 28) return true;
  return false;
}

/** True when the question names one of the solver tools by its exact name. */
function mentionsSolverTool(text) {
  return namedSolverTools(text).length > 0;
}

function groundLocalSpatialArguments(toolName, args, context) {
  if (!["design_megabase_concept", "plan_structure"].includes(toolName)) return args;

  const grounded = { ...(args ?? {}) };
  const originKey = toolName === "design_megabase_concept" ? "origin" : "origin_cm";
  const question = String(context?.question ?? "");
  const explicit = explicitXyzFromQuestion(question);
  if (explicit) {
    grounded[originKey] = explicit;
    return grounded;
  }

  if (/\b(?:here|my (?:captured )?(?:position|location)|player(?:'s)? (?:captured )?(?:position|location))\b/i.test(question)) {
    const player = context?.snapshot?.interaction_context?.player?.pawn_location;
    if (player && [player.x, player.y, player.z].every(Number.isFinite)) {
      grounded[originKey] = { x: player.x, y: player.y, z: player.z };
      return grounded;
    }
  }

  // The model may not create a site merely because the schema has an origin
  // field. Without labeled XYZ or a captured-position reference, let the
  // solver use its documented default or refuse the required field.
  delete grounded[originKey];
  return grounded;
}

function explicitXyzFromQuestion(question) {
  const read = (axis) => {
    const match = String(question).match(
      new RegExp(`\\b${axis}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    );
    return match ? Number(match[1]) : null;
  };
  const x = read("x");
  const y = read("y");
  const z = read("z");
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

/** Returns one forced tool only when the player named exactly one solver. */
function uniquelyNamedSolverTool(text) {
  const matches = namedSolverTools(text);
  return matches.length === 1 ? matches[0] : null;
}

function namedSolverTools(text) {
  const lowered = String(text ?? "").toLowerCase();
  return SOLVER_TOOL_NAMES.filter((name) => lowered.includes(name));
}

/**
 * Qwen 3 through Ollama emits an empty stop turn for the megabase tool's full
 * deeply nested schema, even with an explicit tool_choice. Its four required
 * inputs plus the shallow design-family/commissioning controls are enough
 * for the deterministic compiler; deeply nested optional selections retain
 * their safe defaults. Strong providers still receive the full schema.
 */
function localSolverToolDefinitions(explicitlyNamedSolver) {
  const definitions = chatCompletionsToolDefinitions();
  const selected = explicitlyNamedSolver
    ? definitions.filter((tool) => tool.function?.name === explicitlyNamedSolver)
    : definitions;
  if (explicitlyNamedSolver !== "design_megabase_concept") return selected;

  return selected.map((tool) => {
    const parameters = tool.function.parameters;
    const requiredNames = ["item_name", "target_rate_per_minute", "origin", "style"];
    const compactNames = [
      ...requiredNames,
      "design_family_id",
      "match_design_family_fingerprint",
      "commissioning_phases",
    ];
    return {
      ...tool,
      function: {
        ...tool.function,
        description:
          "Preview an architectural megabase from live measured factory data. " +
          "Returns exact transforms, footprint, blockers and mod-aware part candidates; never emits actions.",
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            compactNames.map((name) => [name, parameters.properties[name]]),
          ),
          required: requiredNames,
          additionalProperties: false,
        },
      },
    };
  });
}

/**
 * Solver names, listed rather than imported from `tools.mjs`.
 *
 * The import would be circular — `tools.mjs` pulls in the action layer, which
 * pulls in this module. The cost of the duplication is that a renamed tool
 * silently stops de-escalating, so the list is asserted against the real one in
 * `companion/test/hybrid-fallback.test.mjs`.
 */
const SOLVER_TOOL_NAMES = [
  "design_base",
  "design_composition",
  "design_factory_layout",
  "design_megabase_concept",
  "diagnose_bottlenecks",
  "find_belt_candidates",
  "find_best_site",
  "find_recipes",
  "get_build_cost",
  "get_factory_summary",
  "get_item_balance",
  "get_machine_rates",
  "get_power_circuits",
  "get_transport_capacity",
  "get_unlock_status",
  "audit_blueprint_placement",
  "inspect_blueprint_layout",
  "list_blueprints",
  "locate",
  "plan_belt_route",
  "plan_belted_module",
  "plan_production",
  "plan_splitter_fan_out",
  "plan_structure",
];

/**
 * Free tier first, paid tier when the question earns it.
 *
 * Set AI_PROVIDER=hybrid with AIFACTORY_CHEAP_PROVIDER (default "local") and
 * AIFACTORY_STRONG_PROVIDER (default "anthropic"). Escalation happens for two
 * reasons, and both are reported on the answer so the choice is never silent:
 *
 *   - the question looks like one the cheap tier answers badly, or
 *   - the cheap tier failed outright, in which case falling back is strictly
 *     better than surfacing an error the player cannot act on.
 */
export async function askHybrid(context, env = process.env) {
  const cheap = env.AIFACTORY_CHEAP_PROVIDER || "local";
  const strong = env.AIFACTORY_STRONG_PROVIDER || "anthropic";

  if (needsStrongModel(context.question, env)) {
    try {
      const answer = await askProvider(strong, context, env);
      return { ...answer, tier: { used: "strong", provider: strong, why: "question_shape_needs_reasoning" } };
    } catch (error) {
      // The strong tier can fail for reasons that have nothing to do with the
      // question — an exhausted credit balance is the one that actually
      // happened here, and it returns 400 before a single token is billed.
      //
      // Falling back to the cheap tier is **off by default and deliberately
      // so**. This branch is reached only for causal, comparative and planning
      // questions, and the small local model was measured on exactly those:
      // it asserted a causal reason as fact where the data cannot show one.
      // Silently answering a "why" with a model that fabricates would trade a
      // visible outage for an invisible wrong answer, which is the worse of
      // the two. So the caller has to ask for it, and when they do the answer
      // says plainly what produced it.
      if (env.AIFACTORY_FALLBACK_TO_CHEAP !== "true") throw error;

      const answer = await askProvider(cheap, context, env);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...answer,
        reply:
          `${answer.reply}\n\n---\n**Answered by the local fallback model, not the main one.** ` +
          `The configured ${strong} tier was unavailable (${reason}). This question is the ` +
          `kind that needs reasoning, and the local model has been measured asserting causes ` +
          `it cannot know — treat anything here that is not a solver number as unverified.`,
        tier: {
          used: "cheap",
          provider: cheap,
          why: "strong_tier_failed_and_fallback_was_enabled",
          strong_error: reason,
          caveat: "escalated question answered by the weaker model",
        },
      };
    }
  }

  try {
    const answer = await askProvider(cheap, context, env);
    return { ...answer, tier: { used: "cheap", provider: cheap, why: "answered_by_the_free_tier" } };
  } catch (cheapError) {
    // A dead or misconfigured free tier must not cost the player their answer.
    try {
      const answer = await askProvider(strong, context, env);
      return {
        ...answer,
        tier: {
          used: "strong",
          provider: strong,
          why: "cheap_tier_failed",
          cheap_error: cheapError instanceof Error ? cheapError.message : String(cheapError),
        },
      };
    } catch (strongError) {
      // Preserve both attempts. Without this, a depleted paid account masks a
      // correctable local grounding/tool error and the operator sees only the
      // second failure.
      const annotated = strongError instanceof Error
        ? strongError
        : new Error(String(strongError));
      annotated.attempts = [
        providerAttemptFailure(cheapError, cheap),
        providerAttemptFailure(strongError, strong),
      ];
      throw annotated;
    }
  }
}

function providerAttemptFailure(error, fallbackProvider) {
  return {
    kind: error?.code ?? "provider_error",
    provider: error?.provider ?? fallbackProvider,
    model: error?.model ?? null,
    response_id: error?.response_id ?? null,
    message: String(error?.message ?? error ?? "unknown provider failure"),
    solver_calls: Array.isArray(error?.solver_calls) ? error.solver_calls : [],
  };
}

export async function askProvider(provider, context, env = process.env) {
  if (provider === "openai") return askOpenAI(context, env);
  if (provider === "anthropic") return askAnthropic(context, env);
  if (provider === "local" || provider === "ollama") return askLocal(context, env);
  if (provider === "mock") return askMock(context);
  if (provider === "hybrid") return askHybrid(context, env);
  throw new Error(
    `Unsupported AI_PROVIDER "${provider}". Use mock, local, openai, anthropic, or hybrid.`,
  );
}
