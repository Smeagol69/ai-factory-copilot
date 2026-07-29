import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readBlueprint } from "./lib/blueprints.mjs";
import { deriveAnalysisDigest, deriveSnapshotFacts } from "./lib/analysis.mjs";
import { askProvider } from "./lib/providers.mjs";
import {
  createSessionLedger,
  estimateCost,
  formatCostFooter,
} from "./lib/pricing.mjs";
import { answerLocally } from "./lib/router.mjs";
import { buildLeanPayload, compactSnapshot, summarizeSnapshot } from "./lib/snapshot.mjs";
import { analyzeSnapshot, buildGraph } from "./lib/solvers.mjs";
import { resolveSourcePolicy } from "./lib/sources.mjs";
import { SOLVER_TOOLS } from "./lib/tools.mjs";

const LOOPBACK_HOST = "127.0.0.1";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const maximumBodyBytes =
    positiveInteger(env.AIFACTORY_MAX_BODY_MB, 64) * 1024 * 1024;
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

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return jsonResponse(response, 200, {
          status: "ok",
          schema: "aifactory.bridge.health",
          provider,
          loopback_only: true,
          solver_tools: SOLVER_TOOLS.map((tool) => tool.name),
          conveyor_speed_divisor: conveyorSpeedDivisor,
          blueprint_library: Boolean(listBlueprints),
          outside_references: (() => {
            const policy = resolveSourcePolicy(env);
            return {
              web_search: policy.enabled,
              restricted_to_official_sources: policy.restrictToOfficial,
              source_domains: policy.domains,
              using_configured_domains: policy.domainsAreConfigured,
            };
          })(),
        });
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
      if (!body.world_snapshot || typeof body.world_snapshot !== "object") {
        return jsonResponse(response, 400, { error: "world_snapshot must be an object." });
      }
      if (body.world_snapshot.data_policy !== "authoritative_or_explicitly_unknown") {
        return jsonResponse(response, 400, {
          error: "Snapshot does not declare the authoritative-or-unknown data policy.",
        });
      }

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
      const collectedActions = [];
      const requestServices = {
        ...solverServices,
        actions: {
          emit(actions) {
            for (const action of actions ?? []) collectedActions.push(action);
          },
        },
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
      const answer = localAnswer ?? (await askProvider(provider, context, env));

      const answeredBy = answer.provider === "solvers" ? "local_solver" : "model";
      const cost =
        answeredBy === "local_solver"
          ? { ...estimateCost(answer.model, {}), usd: 0 }
          : estimateCost(answer.model, answer.cache ?? {});
      const sessionTotal = ledger.add(sessionId, cost.usd ?? 0);
      if (showCost) {
        answer.reply += formatCostFooter({
          answeredBy,
          cost,
          sessionUsd: sessionTotal.usd,
          sessionAnswers: sessionTotal.answers,
        });
      }

      history.push({ role: "user", text: context.question });
      history.push({ role: "assistant", text: answer.reply });
      if (!sessions.has(sessionId) && sessions.size >= maximumSessions) {
        sessions.delete(sessions.keys().next().value);
      }
      sessions.set(sessionId, history.slice(-maximumHistoryMessages));

      return jsonResponse(response, 200, {
        schema: "aifactory.answer",
        schema_version: 1,
        reply: answer.reply,
        provider: answer.provider,
        model: answer.model,
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
        // The mod executes these server-side, re-validates each one, and only
        // commits those with commit:true when its own allowWriteActions is on.
        actions: collectedActions,
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
