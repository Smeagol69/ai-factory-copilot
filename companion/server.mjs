import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WRITE_ACTION_KINDS } from "./lib/actions.mjs";
import { readBlueprint } from "./lib/blueprints.mjs";
import { deriveAnalysisDigest, deriveSnapshotFacts } from "./lib/analysis.mjs";
import { askMock, askProvider } from "./lib/providers.mjs";
import {
  createSessionLedger,
  estimateCost,
  formatCostFooter,
} from "./lib/pricing.mjs";
import { answerLocally, explainRoutingMiss } from "./lib/router.mjs";
import { createTerrainCache } from "./lib/terrain-cache.mjs";
import { buildLeanPayload, compactSnapshot, summarizeSnapshot } from "./lib/snapshot.mjs";
import { analyzeSnapshot, buildGraph } from "./lib/solvers.mjs";
import { resolveSourcePolicy } from "./lib/sources.mjs";
import { SOLVER_TOOLS } from "./lib/tools.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const BRIDGE_PACKAGE = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
export const BRIDGE_VERSION = BRIDGE_PACKAGE.version;
export const ACTION_CONTRACT_VERSION = 1;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerModel(provider, env) {
  if (provider === "openai") return env.OPENAI_MODEL || "gpt-5.6-sol";
  if (provider === "anthropic") return env.ANTHROPIC_MODEL || null;
  if (provider === "local" || provider === "ollama") return env.LOCAL_AI_MODEL || null;
  if (provider === "mock") return "deterministic-diagnostic";
  return null;
}

export function assessProviderConfiguration(provider, env = process.env, seen = new Set()) {
  const selected = String(provider || "mock").toLowerCase();
  if (seen.has(selected)) {
    return {
      ready: false,
      provider: selected,
      model: null,
      issues: [`Provider configuration recurses through "${selected}".`],
    };
  }

  if (selected === "mock") {
    return { ready: true, provider: selected, model: providerModel(selected, env), issues: [] };
  }
  if (selected === "openai") {
    const issues = env.OPENAI_API_KEY ? [] : ["OPENAI_API_KEY is not configured."];
    return {
      ready: issues.length === 0,
      provider: selected,
      model: providerModel(selected, env),
      issues,
    };
  }
  if (selected === "anthropic") {
    const issues = [];
    if (!env.ANTHROPIC_API_KEY) issues.push("ANTHROPIC_API_KEY is not configured.");
    if (!env.ANTHROPIC_MODEL) issues.push("ANTHROPIC_MODEL is not configured.");
    return {
      ready: issues.length === 0,
      provider: selected,
      model: providerModel(selected, env),
      issues,
    };
  }
  if (selected === "local" || selected === "ollama") {
    const issues = env.LOCAL_AI_MODEL ? [] : ["LOCAL_AI_MODEL is not configured."];
    return {
      ready: issues.length === 0,
      provider: selected,
      model: providerModel(selected, env),
      issues,
      endpoint: (env.LOCAL_AI_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
    };
  }
  if (selected === "hybrid") {
    const nextSeen = new Set(seen).add(selected);
    const cheapName = String(env.AIFACTORY_CHEAP_PROVIDER || "local").toLowerCase();
    const strongName = String(env.AIFACTORY_STRONG_PROVIDER || "anthropic").toLowerCase();
    const cheap = assessProviderConfiguration(cheapName, env, nextSeen);
    const strong = assessProviderConfiguration(strongName, env, nextSeen);
    const issues = [];
    if (cheapName === "hybrid" || strongName === "hybrid") {
      issues.push("A hybrid subprovider cannot itself be hybrid.");
    }
    if (!cheap.ready) issues.push(...cheap.issues.map((issue) => `cheap: ${issue}`));
    if (!strong.ready) issues.push(...strong.issues.map((issue) => `strong: ${issue}`));
    return {
      ready: issues.length === 0,
      provider: selected,
      model: null,
      issues,
      cheap,
      strong,
    };
  }

  return {
    ready: false,
    provider: selected,
    model: null,
    issues: [`Unsupported AI_PROVIDER "${selected}".`],
  };
}

function validatePostRequest(request) {
  if (request.headers.origin) {
    return { status: 403, error: "Browser-origin requests are not accepted by the loopback bridge." };
  }

  const host = String(request.headers.host ?? "").toLowerCase().split(":")[0];
  if (host && !["127.0.0.1", "localhost"].includes(host)) {
    return { status: 403, error: "The loopback bridge only accepts localhost Host headers." };
  }

  const contentType = String(request.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { status: 415, error: "Content-Type must be application/json." };
  }
  if (String(request.headers["x-aifactory-schema"] ?? "") !== "1") {
    return { status: 403, error: "X-AIFactory-Schema: 1 is required." };
  }
  return null;
}

/**
 * Collects action-tool output without allowing a model to submit one plan,
 * revise it, and accidentally execute both. Overlay-only calls may accumulate.
 */
export function createActionCollector() {
  const actions = [];
  let writePlanSeen = false;
  let conflict = null;

  return {
    actions,
    get conflict() {
      return conflict;
    },
    discard() {
      actions.splice(0, actions.length);
      writePlanSeen = false;
    },
    emit(proposed) {
      const list = Array.isArray(proposed) ? proposed : [];
      const carriesWritePlan = list.some((action) =>
        WRITE_ACTION_KINDS.includes(String(action?.action ?? "")),
      );
      if (carriesWritePlan && writePlanSeen) {
        conflict =
          "The model submitted more than one world-changing plan in one answer. All writes were removed.";
        for (let index = actions.length - 1; index >= 0; --index) {
          if (WRITE_ACTION_KINDS.includes(String(actions[index]?.action ?? ""))) {
            actions.splice(index, 1);
          }
        }
        throw new Error(conflict);
      }
      if (carriesWritePlan) writePlanSeen = true;
      if (conflict && carriesWritePlan) throw new Error(conflict);
      actions.push(...list);
    },
  };
}

/**
 * Appends one line per question describing whether it was answered free.
 *
 * Deliberately fire-and-forget: a logging failure must never cost the player an
 * answer, so every error here is swallowed. The file is JSON lines so a miss
 * report can be read straight off disk with a one-liner.
 */
const ROUTING_LOG = path.join(
  process.env.LOCALAPPDATA ?? ".",
  "FactoryGame/Saved/AIFactoryCopilot/Diagnostics/routing.jsonl",
);

function recordRoutingOutcome(entry) {
  try {
    fs.mkdirSync(path.dirname(ROUTING_LOG), { recursive: true });
    fs.appendFileSync(
      ROUTING_LOG,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics are never worth failing a request over.
  }
}

function jsonResponse(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

async function readJsonBody(request, maximumBytes) {
  let received = 0;
  const chunks = [];
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) {
      const error = new Error(`Request body exceeds ${maximumBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body is not valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

/**
 * Reads saved blueprints from one configured directory.
 *
 * Returns null when no readable directory is configured, so the solver reports
 * the capability as unavailable instead of pretending the player has none.
 */
export function makeBlueprintReader(env = process.env) {
  const configured = env.AIFACTORY_BLUEPRINT_DIR;
  const fallback = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, "FactoryGame", "Saved", "SaveGames", "blueprints")
    : null;
  const root = configured || fallback;
  if (!root || !fs.existsSync(root)) return null;

  return function listBlueprints() {
    const results = [];
    const walk = (directory, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".sbp")) continue;
        const name = entry.name.replace(/\.sbp$/i, "");
        try {
          const configPath = full.replace(/\.sbp$/i, ".sbpcfg");
          const configBuffer = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
          results.push(readBlueprint(name, fs.readFileSync(full), configBuffer));
        } catch (error) {
          results.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    walk(root, 0);
    return results;
  };
}

export function createBridgeServer({ env = process.env } = {}) {
  const provider = (env.AI_PROVIDER || "mock").toLowerCase();
  const providerConfiguration = assessProviderConfiguration(provider, env);
  const maximumBodyBytes =
    positiveInteger(env.AIFACTORY_MAX_BODY_MB, 64) * 1024 * 1024;
  const maximumQuestionCharacters = positiveInteger(
    env.AIFACTORY_MAX_QUESTION_CHARS,
    16_000,
  );
  const maximumConcurrentRequests = Math.min(
    positiveInteger(env.AIFACTORY_MAX_CONCURRENT_REQUESTS, 2),
    16,
  );
  const maximumSnapshotCharacters = positiveInteger(
    env.AIFACTORY_MAX_SNAPSHOT_CHARS,
    2_000_000,
  );
  const maximumHistoryMessages = Math.min(
    positiveInteger(env.AIFACTORY_HISTORY_MESSAGES, 24),
    100,
  );
  const maximumSessions = Math.min(positiveInteger(env.AIFACTORY_MAX_SESSIONS, 64), 1000);
  // "lean" keeps the catalog and reflection on the bridge for the solvers; "full"
  // restores the original behaviour of sending the compacted snapshot itself.
  const payloadView = String(env.AIFACTORY_PAYLOAD ?? "lean").toLowerCase();
  const leanMaxActors = positiveInteger(env.AIFACTORY_LEAN_MAX_ACTORS, 120);
  const leanMaxCharacters = positiveInteger(env.AIFACTORY_LEAN_MAX_CHARS, 200_000);
  const conveyorSpeedDivisor = Number.parseFloat(env.AIFACTORY_BELT_SPEED_DIVISOR ?? "") || 2;
  const listBlueprints = makeBlueprintReader(env);
  const solverServices = { listBlueprints };
  const graphOptions = { conveyorSpeedDivisor };
  const sessions = new Map();
  // Running spend per chat session, so the panel can show a total alongside
  // the cost of the answer the player just got.
  const ledger = createSessionLedger();
  const showCost = env.AIFACTORY_COST_FOOTER !== "false";
  // Ground measured on any earlier visit, kept because the map never changes.
  const terrainCache = createTerrainCache({
    filePath: env.AIFACTORY_TERRAIN_CACHE || undefined,
  });
  let activeAskRequests = 0;

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        const sourcePolicy = resolveSourcePolicy(env);
        const providerHasWebSearch =
          provider === "openai" ||
          provider === "anthropic" ||
          (provider === "hybrid" &&
            ["openai", "anthropic"].includes(
              String(env.AIFACTORY_STRONG_PROVIDER || "anthropic").toLowerCase(),
            ));
        return jsonResponse(response, 200, {
          status: providerConfiguration.ready ? "ok" : "degraded",
          schema: "aifactory.bridge.health",
          bridge_version: BRIDGE_VERSION,
          action_contract_version: ACTION_CONTRACT_VERSION,
          provider,
          model: providerConfiguration.model,
          readiness: providerConfiguration,
          loopback_only: true,
          solver_tools: SOLVER_TOOLS.map((tool) => tool.name),
          conveyor_speed_divisor: conveyorSpeedDivisor,
          blueprint_library: Boolean(listBlueprints),
          outside_references: {
            web_search: sourcePolicy.enabled && providerHasWebSearch,
            requested_but_unavailable:
              sourcePolicy.enabled && !providerHasWebSearch,
            restricted_to_configured_sources:
              sourcePolicy.restrictToOfficial && providerHasWebSearch,
            source_domains: sourcePolicy.domains,
            using_configured_domains: sourcePolicy.domainsAreConfigured,
          },
        });
      }

      if (request.method === "POST") {
        const requestError = validatePostRequest(request);
        if (requestError) {
          return jsonResponse(response, requestError.status, { error: requestError.error });
        }
      }

      if (request.method === "POST" && request.url === "/v1/analyze") {
        const body = await readJsonBody(request, maximumBodyBytes);
        if (body?.schema !== "aifactory.analyze" || body?.schema_version !== 1) {
          return jsonResponse(response, 400, {
            error: "Unsupported or missing aifactory.analyze schema version 1.",
          });
        }
        if (!body.world_snapshot || typeof body.world_snapshot !== "object") {
          return jsonResponse(response, 400, { error: "world_snapshot must be an object." });
        }
        if (body.world_snapshot.data_policy !== "authoritative_or_explicitly_unknown") {
          return jsonResponse(response, 400, {
            error: "Snapshot does not declare the authoritative-or-unknown data policy.",
          });
        }
        return jsonResponse(response, 200, {
          schema: "aifactory.analyze.answer",
          schema_version: 1,
          analysis: analyzeSnapshot(body.world_snapshot, graphOptions),
          bridge_answered_at_utc: new Date().toISOString(),
        });
      }

      if (request.method === "POST" && request.url === "/v1/reset") {
        const body = await readJsonBody(request, maximumBodyBytes);
        if (
          body?.schema !== "aifactory.session.reset" ||
          body?.schema_version !== 1 ||
          typeof body?.session_id !== "string" ||
          !body.session_id.trim()
        ) {
          return jsonResponse(response, 400, {
            error: "Unsupported reset request; expected aifactory.session.reset schema version 1.",
          });
        }
        const sessionId = body.session_id.trim().slice(0, 256);
        const existed = sessions.delete(sessionId);
        ledger.reset(sessionId);
        return jsonResponse(response, 200, {
          schema: "aifactory.session.reset.answer",
          schema_version: 1,
          reset: true,
          existed,
          session_id: sessionId,
        });
      }

      if (request.method !== "POST" || request.url !== "/v1/ask") {
        return jsonResponse(response, 404, { error: "Not found." });
      }

      const bridgeReceivedAtUtc = new Date().toISOString();
      const body = await readJsonBody(request, maximumBodyBytes);
      if (body?.schema !== "aifactory.ask" || body?.schema_version !== 1) {
        return jsonResponse(response, 400, {
          error: "Unsupported or missing aifactory.ask schema version 1.",
        });
      }
      if (typeof body.question !== "string" || !body.question.trim()) {
        return jsonResponse(response, 400, { error: "question must be a non-empty string." });
      }
      if (body.question.length > maximumQuestionCharacters) {
        return jsonResponse(response, 413, {
          error: `question exceeds ${maximumQuestionCharacters} characters.`,
        });
      }
      if (!body.world_snapshot || typeof body.world_snapshot !== "object") {
        return jsonResponse(response, 400, { error: "world_snapshot must be an object." });
      }
      if (body.world_snapshot.data_policy !== "authoritative_or_explicitly_unknown") {
        return jsonResponse(response, 400, {
          error: "Snapshot does not declare the authoritative-or-unknown data policy.",
        });
      }

      // Terrain measured on an earlier visit is still true — the map does not
      // change — so it is folded back in before anything reads the snapshot.
      // Without this, ground the player walked past an hour ago comes back as
      // "unmeasured" and every site beyond the probe radius scores blind.
      const harvested = terrainCache.harvest(body.world_snapshot);
      const restored = terrainCache.apply(body.world_snapshot);
      terrainCache.flush();

      // The solvers read the complete snapshot; only the model's view is reduced.
      // A whole-world content catalog runs to hundreds of thousands of tokens and
      // is answered better by a solver than by the model reading raw JSON.
      const graph = buildGraph(body.world_snapshot, graphOptions);
      const view =
        payloadView === "full"
          ? compactSnapshot(body.world_snapshot, body.question, maximumSnapshotCharacters)
          : (() => {
              const lean = buildLeanPayload(body.world_snapshot, {
                maxActors: leanMaxActors,
                maxCharacters: leanMaxCharacters,
              });
              return { snapshot: lean.payload, serialized: lean.serialized, omissions: lean.omissions };
            })();

      // Collected per request, never shared: two questions in flight must not
      // hand each other's actions to the game.
      const actionCollector = createActionCollector();
      const requestServices = {
        ...solverServices,
        actions: actionCollector,
      };

      const sessionId = String(body.session_id || "default").trim().slice(0, 256);
      const history = sessions.get(sessionId) ?? [];
      const context = {
        question: body.question.trim(),
        snapshot: view.snapshot,
        serializedSnapshot: view.serialized,
        serializedDerivedFacts: JSON.stringify(deriveSnapshotFacts(view.snapshot)),
        serializedAnalysisDigest: JSON.stringify(deriveAnalysisDigest(graph)),
        omissions: view.omissions,
        summary: summarizeSnapshot(body.world_snapshot),
        graph,
        services: requestServices,
        history,
      };
      // Questions a single solver fully answers never reach the model: the
      // arithmetic was already done, and paying to have it narrated is the
      // expensive way to read a number. Falls through when unsure.
      const localAnswer =
        env.AIFACTORY_LOCAL_ROUTING === "false"
          ? null
          : answerLocally(context.question, graph, requestServices);
      let answer = localAnswer;
      let providerFailure = null;
      if (!answer) {
        if (activeAskRequests >= maximumConcurrentRequests) {
          return jsonResponse(response, 429, {
            error:
              `The companion is already handling ${activeAskRequests} AI request(s); ` +
              "wait for one to finish before sending another.",
          });
        }
        activeAskRequests += 1;
        try {
          answer = await askProvider(provider, context, env);
        } catch (error) {
          providerFailure = error instanceof Error ? error.message : String(error);
          // A provider failure also invalidates any actions it proposed before
          // failing (for example, a tool call followed by an ungrounded final
          // answer). Never execute a plan whose accompanying answer was withheld.
          actionCollector.discard();
          const fallback = await askMock(context);
          answer = {
            ...fallback,
            provider: "fallback",
            model: "deterministic-fallback",
            provider_error: providerFailure,
            reply:
              `The configured ${provider} model is unavailable, so I answered from the live ` +
              `deterministic solvers instead of dropping your question.\n\n${fallback.reply}`,
          };
        } finally {
          activeAskRequests -= 1;
        }
      }

      if (actionCollector.conflict) {
        answer.reply += `\n\nSafety: ${actionCollector.conflict}`;
      }

      const answeredBy =
        answer.provider === "solvers"
          ? "local_solver"
          : answer.provider === "fallback"
            ? "deterministic_fallback"
            : "model";

      // Every question is recorded with why it did or did not route. Routing was
      // tuned against invented phrasings, and a whole play session went by with
      // nothing free because real questions are not phrased the way I guessed.
      // The log is what turns that from a guess into a list.
      recordRoutingOutcome({
        question: context.question,
        answeredBy,
        solver: answer.local?.solver ?? null,
        miss: answeredBy !== "local_solver" ? explainRoutingMiss(context.question) : null,
      });
      const freeAnswer =
        answeredBy === "local_solver" || answeredBy === "deterministic_fallback";
      const cost =
        freeAnswer
          ? { ...estimateCost(answer.model, {}), usd: 0 }
          : estimateCost(answer.model, answer.cache ?? {});
      const sessionTotal = ledger.add(sessionId, cost.usd ?? 0);
      const historyReply = answer.reply;
      if (showCost) {
        answer.reply += formatCostFooter({
          answeredBy: freeAnswer ? "local_solver" : answeredBy,
          cost,
          sessionUsd: sessionTotal.usd,
          sessionAnswers: sessionTotal.answers,
        });
      }

      history.push({ role: "user", text: context.question });
      history.push({ role: "assistant", text: historyReply });
      if (!sessions.has(sessionId) && sessions.size >= maximumSessions) {
        const evictedSession = sessions.keys().next().value;
        sessions.delete(evictedSession);
        ledger.reset(evictedSession);
      }
      sessions.set(sessionId, history.slice(-maximumHistoryMessages));

      return jsonResponse(response, 200, {
        schema: "aifactory.answer",
        schema_version: 1,
        bridge_version: BRIDGE_VERSION,
        action_contract_version: ACTION_CONTRACT_VERSION,
        reply: answer.reply,
        provider: answer.provider,
        model: answer.model,
        provider_error: answer.provider_error ?? null,
        provider_response_id: answer.response_id ?? null,
        external_sources: answer.sources ?? [],
        world_revision: body.world_snapshot.world_revision ?? null,
        snapshot_generated_at_utc: body.world_snapshot.generated_at_utc ?? null,
        interaction_captured_at_utc:
          body.world_snapshot.interaction_context?.captured_at_utc ?? null,
        game_question_received_at_utc: body.question_received_at_game_utc ?? null,
        bridge_received_at_utc: bridgeReceivedAtUtc,
        bridge_answered_at_utc: new Date().toISOString(),
        retained_history_messages: sessions.get(sessionId)?.length ?? 0,
        omissions: view.omissions,
        payload_view: payloadView,
        // Visible because it is the number that says whether travelling is
        // buying coverage: sites filled from cache are sites that used to score
        // blind.
        terrain_cache: {
          newly_measured: harvested.learned,
          re_measured: harvested.refreshed,
          restored_from_cache: restored.filled,
          measured_live_this_capture: restored.already_live,
          total_remembered: restored.cache_size,
        },
        solver_calls: answer.solver_calls ?? [],
        // Prompt-cache accounting for this answer, so the saving is observable
        // rather than assumed.
        cache: answer.cache ?? null,
        // Which path answered: a local solver route, or the model.
        answered_by: answeredBy,
        cost,
        session_spend: { usd: sessionTotal.usd, answers: sessionTotal.answers },
        tier: answer.tier ?? null,
        local: answer.local ?? null,
        action_plan_conflict: actionCollector.conflict,
        // The mod executes these server-side, re-validates each one, and only
        // commits those with commit:true when its own allowWriteActions is on.
        actions: actionCollector.actions,
      });
    } catch (error) {
      const status = error.statusCode || 502;
      return jsonResponse(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function startBridge({ env = process.env } = {}) {
  const port = positiveInteger(env.AIFACTORY_PORT, 8142);
  const server = createBridgeServer({ env });
  server.listen(port, LOOPBACK_HOST, () => {
    process.stdout.write(
      `AI Factory Copilot bridge listening on http://${LOOPBACK_HOST}:${port} ` +
        `(provider=${(env.AI_PROVIDER || "mock").toLowerCase()})\n`,
    );
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startBridge();
}
