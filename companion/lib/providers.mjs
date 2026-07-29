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
- rates, cycle times, or overclock effects -> get_machine_rates;
- what the factory is short of or oversupplying -> get_item_balance;
- alternate or candidate recipes -> find_recipes;
- belt or pipe throughput and saturation -> get_transport_capacity;
- power capacity, fuse, or battery questions -> get_power_circuits;
- any "why is this stopped/slow" question -> diagnose_bottlenecks;
- what a build costs and whether the player can afford it -> get_build_cost;
- where to put a HUB, base, or factory -> find_best_site;
- how to build N per minute of something, or any scale-up -> plan_production;
- what blueprints the player has, or what one costs -> list_blueprints;
- current objective, active milestone, game phase, exact recipe availability,
  tech tier, and purchased schematics -> get_unlock_status;
- a layout to actually place, not just a parts list -> design_factory_layout;
- placing, removing, moving, or teleporting -> perform_actions;
- showing the player where things are -> highlight / clear_highlight.
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
supplied that result.`;

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
${serializedDerivedFacts}${digestText}`;
}

export function providerMessages(context) {
  const history = (context.history ?? [])
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
    .map((entry) => ({ role: entry.role, content: String(entry.text ?? "") }));
  return [...history, { role: "user", content: userInput(context) }];
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

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
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

export async function askOpenAI(context, env = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured in the companion environment.");

  const model = env.OPENAI_MODEL || "gpt-5.6-sol";
  const maximumOutputTokens =
    Number.parseInt(env.OPENAI_MAX_OUTPUT_TOKENS ?? "", 10) || 2400;
  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;
  const systemInstructions = buildSystemInstructions(env);

  const tools = [];
  const policy = resolveSourcePolicy(env);
  // OPENAI_WEB_SEARCH stays honoured for compatibility with existing configs.
  const webSearchTool = envFlag(env.OPENAI_WEB_SEARCH, true)
    ? openAIWebSearchTool(policy, env)
    : null;
  if (webSearchTool) tools.push(webSearchTool);
  if (context.graph) {
    tools.push(...openAIToolDefinitions());
  }

  let input = providerMessages(context);
  const solverCalls = [];
  const sources = new Map();
  let lastResponseId = null;

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
    lastResponseId = json.id ?? lastResponseId;
    for (const source of extractOpenAISources(json)) {
      sources.set(source.url, source);
    }

    const functionCalls = (json.output ?? []).filter((item) => item?.type === "function_call");
    if (functionCalls.length === 0) {
      const reply = extractOpenAIText(json);
      if (!reply) throw new Error("OpenAI returned no output_text.");
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
      solverCalls.push({
        tool: call.name,
        arguments: parsedArguments,
        truncated: result.truncated,
        result_characters: result.serialized.length,
      });
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

  const messages = providerMessages(context);
  if (caching) markLastUserMessageCacheable(messages);
  const cacheUsage = emptyCacheUsage();
  const solverCalls = [];
  const sources = new Map();
  const searchErrors = [];
  let pauseResumes = 0;

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
      const collected = [...sources.values()].slice(0, 8);
      return {
        reply: `${reply}${formatSourceFooter(collected, searchErrors)}`,
        provider: "anthropic",
        model,
        sources: collected,
        solver_calls: solverCalls,
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
      solverCalls.push({
        tool: use.name,
        arguments: parsedArguments,
        truncated: result.truncated,
        result_characters: result.serialized.length,
      });
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

  const messages = [
    { role: "system", content: buildSystemInstructions(env) },
    ...providerMessages(context),
  ];
  const solverCalls = [];

  for (let round = 0; round <= maximumSolverRounds; round += 1) {
    const body = { model, messages, stream: false };
    if (toolsEnabled) {
      body.tools = chatCompletionsToolDefinitions();
      body.tool_choice = "auto";
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
    const message = json?.choices?.[0]?.message;
    if (!message) throw new Error("Local AI server returned no choices.");

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const reply = String(message.content ?? "").trim();
      if (!reply) throw new Error("Local AI server returned no message content.");
      return {
        reply: toolsEnabled
          ? reply
          : `${reply}\n\nNote: solver tools are disabled for this local model, so any number above that did not come from the deterministic digest is unverified.`,
        provider: "local",
        model,
        sources: [],
        solver_calls: solverCalls,
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
      const result = runSolverTool(context.graph, call.function?.name, parsedArguments, { services: context.services });
      solverCalls.push({
        tool: call.function?.name,
        arguments: parsedArguments,
        truncated: result.truncated,
        result_characters: result.serialized.length,
      });
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
      { tool: "diagnose_bottlenecks", arguments: {}, truncated: bottlenecks.truncated },
      { tool: "get_power_circuits", arguments: {}, truncated: power.truncated },
    );
    const parsedBottlenecks = JSON.parse(bottlenecks.serialized);
    const parsedPower = JSON.parse(power.serialized);
    const causes = Object.entries(parsedBottlenecks.cause_counts ?? {})
      .map(([cause, count]) => `${cause}: ${count}`)
      .join(", ");
    solverText =
      ` Deterministic solvers report ${parsedBottlenecks.reported_machine_count ?? 0} machine(s) with findings` +
      `${causes ? ` (${causes})` : ""} across ${parsedPower.circuit_count ?? 0} power circuit(s).`;
  }

  return {
    provider: "mock",
    model: "deterministic-diagnostic",
    solver_calls: solverCalls,
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
];

/** True when a question deserves the strong model rather than the cheap one. */
export function needsStrongModel(question, env = process.env) {
  const text = String(question ?? "");
  if (env.AIFACTORY_ESCALATE === "always") return true;
  if (env.AIFACTORY_ESCALATE === "never") return false;
  // A long question is usually a compound or nuanced one.
  if (text.split(/\s+/).length > 28) return true;
  return ESCALATE_PATTERNS.some((pattern) => pattern.test(text));
}

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
    const answer = await askProvider(strong, context, env);
    return { ...answer, tier: { used: "strong", provider: strong, why: "question_shape_needs_reasoning" } };
  }

  try {
    const answer = await askProvider(cheap, context, env);
    return { ...answer, tier: { used: "cheap", provider: cheap, why: "answered_by_the_free_tier" } };
  } catch (error) {
    // A dead or misconfigured free tier must not cost the player their answer.
    const answer = await askProvider(strong, context, env);
    return {
      ...answer,
      tier: {
        used: "strong",
        provider: strong,
        why: "cheap_tier_failed",
        cheap_error: error instanceof Error ? error.message : String(error),
      },
    };
  }
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
