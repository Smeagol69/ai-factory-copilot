import {
  anthropicToolDefinitions,
  openAIToolDefinitions,
  runSolverTool,
} from "./tools.mjs";

const DEFAULT_MAXIMUM_SOLVER_ROUNDS = 6;

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
The solvers read the same current-turn snapshot you were given. If a solver
reports a value as unresolved, unknown, or truncated, say so instead of
substituting an estimate. If a solver contradicts your expectation, the solver
is correct. State numbers with their unit exactly as the solver returned them.

Diagnose with exact actor_id, class_path, owner_mod, recipe, rates, coordinates,
and connection records when useful. Distinguish invalid, inefficient, and
stylistic choices. Lead with the next practical action, then the evidence and
any unknowns. Be natural and concise enough for an in-game panel.

The current release is advisory and read-only. Never claim you placed, removed,
configured, or otherwise executed anything in the game. Never claim placement
validity unless a deterministic game placement validator supplied that result.`;

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

async function parseErrorResponse(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json?.error?.message ?? json?.error ?? text;
  } catch {
    return text;
  }
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
  const webSearchEnabled = envFlag(env.OPENAI_WEB_SEARCH, true);
  const webSearchContext = ["low", "medium", "high"].includes(env.OPENAI_WEB_SEARCH_CONTEXT)
    ? env.OPENAI_WEB_SEARCH_CONTEXT
    : "low";
  const maximumOutputTokens =
    Number.parseInt(env.OPENAI_MAX_OUTPUT_TOKENS ?? "", 10) || 2400;
  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;

  const tools = [];
  if (webSearchEnabled) {
    tools.push({ type: "web_search", search_context_size: webSearchContext });
  }
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
      instructions: SYSTEM_INSTRUCTIONS,
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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

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
      const result = runSolverTool(context.graph, call.name, parsedArguments);
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

export async function askAnthropic(context, env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured in the companion environment.");
  if (!model) {
    throw new Error(
      "ANTHROPIC_MODEL must be explicitly configured; the bridge will not guess a current model name.",
    );
  }

  const maximumTokens = Number.parseInt(env.ANTHROPIC_MAX_TOKENS ?? "", 10) || 1800;
  const maximumSolverRounds =
    Number.parseInt(env.AIFACTORY_MAX_SOLVER_ROUNDS ?? "", 10) || DEFAULT_MAXIMUM_SOLVER_ROUNDS;
  const tools = context.graph ? anthropicToolDefinitions() : [];

  const messages = providerMessages(context);
  const solverCalls = [];

  for (let round = 0; round <= maximumSolverRounds; round += 1) {
    const requestBody = {
      model,
      max_tokens: maximumTokens,
      system: SYSTEM_INSTRUCTIONS,
      messages,
    };
    if (tools.length > 0) requestBody.tools = tools;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API HTTP ${response.status}: ${await parseErrorResponse(response)}`);
    }
    const json = await response.json();
    const toolUses = (json.content ?? []).filter((block) => block?.type === "tool_use");

    if (json.stop_reason !== "tool_use" || toolUses.length === 0) {
      const reply = (json.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!reply) throw new Error("Anthropic returned no text content.");
      return { reply, provider: "anthropic", model, sources: [], solver_calls: solverCalls };
    }

    messages.push({ role: "assistant", content: json.content });
    const toolResults = [];
    for (const use of toolUses) {
      const parsedArguments = use.input && typeof use.input === "object" ? use.input : {};
      const result = runSolverTool(context.graph, use.name, parsedArguments);
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
  if (provider === "mock") return askMock(context);
  throw new Error(`Unsupported AI_PROVIDER "${provider}". Use mock, openai, or anthropic.`);
}
