import http from "node:http";
import { pathToFileURL } from "node:url";
import { deriveAnalysisDigest, deriveSnapshotFacts } from "./lib/analysis.mjs";
import { askProvider } from "./lib/providers.mjs";
import { compactSnapshot, summarizeSnapshot } from "./lib/snapshot.mjs";
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
  const conveyorSpeedDivisor = Number.parseFloat(env.AIFACTORY_BELT_SPEED_DIVISOR ?? "") || 2;
  const graphOptions = { conveyorSpeedDivisor };
  const sessions = new Map();

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

      const compacted = compactSnapshot(
        body.world_snapshot,
        body.question,
        maximumSnapshotCharacters,
      );
      const sessionId = String(body.session_id || "default").trim().slice(0, 256);
      const history = sessions.get(sessionId) ?? [];

      // The solvers run on the same compacted snapshot the model is shown, so a
      // tool result can never describe data the model was not given.
      const graph = buildGraph(compacted.snapshot, graphOptions);
      const context = {
        question: body.question.trim(),
        snapshot: compacted.snapshot,
        serializedSnapshot: compacted.serialized,
        serializedDerivedFacts: JSON.stringify(deriveSnapshotFacts(compacted.snapshot)),
        serializedAnalysisDigest: JSON.stringify(deriveAnalysisDigest(graph)),
        omissions: compacted.omissions,
        summary: summarizeSnapshot(compacted.snapshot),
        graph,
        history,
      };
      const answer = await askProvider(provider, context, env);

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
        omissions: compacted.omissions,
        solver_calls: answer.solver_calls ?? [],
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
