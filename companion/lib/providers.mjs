import {
  anthropicWebSearchTool,
  openAIWebSearchTool,
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
- tech tier and purchased schematics -> get_unlock_status.
Never rank locations or estimate a distance by reading coordinates yourself;
find_best_site computes both. If it warns that the snapshot was radius-limited,
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

The current release is advisory and read-only. Never claim you placed, removed,
configured, or otherwise executed anything in the game. Never claim placement
validity unless a deterministic game placement validator supplied that result.`;

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
  if (searchErrors.length > 0) {
    parts.push(
      `Web search did not complete (${searchErrors
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

  const requestBase = {
    model,
    max_tokens: maximumTokens,
    system: buildSystemInstructions(env),
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
      throw new Error(`Anthropic API HTTP ${response.status}: ${await parseErrorResponse(response)}`);
    }
    const json = await response.json();
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

export async function askProvider(provider, context, env = process.env) {
  if (provider === "openai") return askOpenAI(context, env);
  if (provider === "anthropic") return askAnthropic(context, env);
  if (provider === "local" || provider === "ollama") return askLocal(context, env);
  if (provider === "mock") return askMock(context);
  throw new Error(
    `Unsupported AI_PROVIDER "${provider}". Use mock, local, openai, or anthropic.`,
  );
}
