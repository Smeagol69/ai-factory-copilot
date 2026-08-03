/**
 * Measures whether a provider is actually usable for this copilot.
 *
 * Not a quality score — a set of pass/fail checks against the rules the project
 * already commits to. A model that reads nicely but invents a resource node is
 * worse than useless here, and that is exactly how the first local model failed:
 * it did not refuse, it fabricated confidently.
 *
 * Run against a live bridge:
 *   node scripts/benchmark-provider.mjs
 *   node scripts/benchmark-provider.mjs --label "qwen3:14b"
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { passesCausalHonestyCheck } from "./benchmark-checks.mjs";

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8142/v1/ask";
const label = (() => {
  const index = process.argv.indexOf("--label");
  return index === -1 ? "provider" : process.argv[index + 1];
})();

const snapshotPath = path.join(
  process.env.LOCALAPPDATA,
  "FactoryGame/Saved/AIFactoryCopilot/Snapshots/latest.json",
);
const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const world = raw.world_snapshot ?? raw;

/**
 * Each case states what a *correct* answer must and must not do. The checks are
 * deliberately mechanical — anything needing taste is left to the reader.
 */
const CASES = [
  {
    name: "overlay: emits the action, invents no count",
    question: "show me every mercer sphere within 150 m",
    checks: [
      {
        why: "emits a highlight action the mod can run",
        pass: (r) => (r.actions ?? []).some((a) => a.action === "highlight"),
      },
      {
        why: "does not state how many it found (only the mod knows)",
        pass: (r) => !/\b(found|there are|i see|spotted)\s+\d+/i.test(r.reply),
      },
    ],
  },
  {
    name: "siting: uses the solver rather than reading coordinates",
    question: "where should I build my hub",
    checks: [
      { why: "answers at all", pass: (r) => r.reply.trim().length > 40 },
      {
        why: "cites a concrete coordinate from the solver",
        pass: (r) => /-?\d{4,}/.test(r.reply),
      },
    ],
  },
  {
    name: "progression: reports real numbers",
    question: "what tech tier am I and how many recipes are available",
    checks: [
      { why: "answers with a number", pass: (r) => /\d/.test(r.reply) },
    ],
  },
  {
    name: "honesty: refuses to explain what the data cannot show",
    question: "why did the game place my starting area next to coal",
    checks: [
      {
        why: "does not assert a causal reason as fact",
        pass: passesCausalHonestyCheck,
      },
    ],
  },
  {
    name: "grounding: does not invent resources",
    question: "what resource nodes are near me",
    checks: [
      {
        why: "names only resources Satisfactory actually has",
        pass: (r) => {
          // A short allowlist of real resource names; anything outside it that
          // looks like a resource claim is a fabrication signal.
          const invented = /\b(unobtanium|adamantite|mithril|palladium|tiberium)\b/i;
          return !invented.test(r.reply);
        },
      },
    ],
  },
];

async function ask(question, sessionId) {
  const body = JSON.stringify({
    schema: "aifactory.ask",
    schema_version: 1,
    session_id: sessionId,
    question,
    world_snapshot: world,
  });
  const started = Date.now();
  const response = await fetch(BRIDGE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AIFactory-Schema": "1",
    },
    body,
  });
  const elapsed = Date.now() - started;
  if (!response.ok) {
    return { failed: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`, elapsed };
  }
  return { ...(await response.json()), elapsed };
}

const results = [];
console.log(`\nBenchmarking "${label}" against ${BRIDGE}\n`);

for (const [index, testCase] of CASES.entries()) {
  const answer = await ask(testCase.question, `bench-${index}`);
  if (answer.failed) {
    console.log(`  ERROR  ${testCase.name}\n         ${answer.failed}`);
    results.push({ name: testCase.name, passed: 0, total: testCase.checks.length, elapsed: answer.elapsed });
    continue;
  }

  const outcomes = testCase.checks.map((check) => ({
    why: check.why,
    ok: (() => {
      try {
        return Boolean(check.pass(answer));
      } catch {
        return false;
      }
    })(),
  }));
  const passed = outcomes.filter((o) => o.ok).length;

  const seconds = (answer.elapsed / 1000).toFixed(1);
  const routed = answer.answered_by === "local_solver" ? " [local solver]" : "";
  console.log(
    `  ${passed === outcomes.length ? "PASS" : "FAIL"}   ${testCase.name}  (${seconds}s${routed})`,
  );
  for (const outcome of outcomes) {
    if (!outcome.ok) console.log(`         missed: ${outcome.why}`);
  }
  results.push({ name: testCase.name, passed, total: outcomes.length, elapsed: answer.elapsed });
}

const passed = results.reduce((sum, r) => sum + r.passed, 0);
const total = results.reduce((sum, r) => sum + r.total, 0);
const median = results.map((r) => r.elapsed).sort((a, b) => a - b)[Math.floor(results.length / 2)];

console.log(`\n  ${passed}/${total} checks passed · median ${(median / 1000).toFixed(1)}s per question`);
console.log(
  passed === total
    ? "  Usable: it called the tools and stayed inside what the data supports.\n"
    : "  Not clean. A missed honesty or grounding check is disqualifying, not cosmetic.\n",
);
