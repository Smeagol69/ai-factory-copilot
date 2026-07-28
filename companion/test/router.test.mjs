import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildGraph } from "../lib/graph.mjs";
import { answerLocally, parseClearRequest, parseShowRequest, routeQuestion } from "../lib/router.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const graphOf = () => buildGraph(buildFactorySnapshot());

/* ---------------- what routes locally ---------------- */

test("siting questions are answered by the solver, not the model", () => {
  for (const question of [
    "where should I build my hub",
    "where's the best place to build a base?",
    "best spot to build a factory",
    "where do I put the smelter",
  ]) {
    assert.equal(routeQuestion(question)?.name, "find_best_site", question);
  }
});

test("each single-solver question reaches its own solver", () => {
  const expected = {
    "what's my power situation": "get_power_circuits",
    "anything stopped?": "diagnose_bottlenecks",
    "what am I short of": "get_item_balance",
    "what tier am I": "get_unlock_status",
    "what blueprints do I have": "list_blueprints",
  };
  for (const [question, solver] of Object.entries(expected)) {
    assert.equal(routeQuestion(question)?.name, solver, question);
  }
});

/* ---------------- what must not ---------------- */

test("a compound question goes to the model rather than getting half an answer", () => {
  // Answering only the siting half locally would be answering it wrong.
  assert.equal(routeQuestion("where should I build the hub and what should I make there"), null);
  assert.equal(routeQuestion("what's my power situation and what is stopped"), null);
});

test("anything needing judgement or outside knowledge goes to the model", () => {
  for (const question of [
    "where should I build compared to what reddit recommends",
    "why did we start next to coal",
    "design me a 300/min iron rod line",
    "teleport me to the nearest slug",
    "is this a good base layout",
  ]) {
    assert.equal(routeQuestion(question), null, question);
  }
});

/* ---------------- overlays parse, they do not reason ---------------- */

test("a show request yields a target and radius", () => {
  assert.deepEqual(parseShowRequest("show me every mercer sphere within 150 m"), {
    target: "mercer sphere",
    radius: 150,
  });
  assert.deepEqual(parseShowRequest("highlight all beryl nuts within 100m"), {
    target: "beryl nut",
    radius: 100,
  });
});

test("a show request without a radius leaves it unset rather than inventing one", () => {
  assert.deepEqual(parseShowRequest("mark the blue power slugs"), {
    target: "blue power slug",
    radius: null,
  });
});

test("the radius never leaks into the item name", () => {
  // The original single-regex parser let the target swallow "within 150 m",
  // which then failed the length check and silently fell through to the model.
  const parsed = parseShowRequest("show me every mercer sphere within 150 m");
  assert.equal(parsed.target.includes("within"), false);
  assert.equal(parsed.target.includes("150"), false);
});

test("a question dressed as a show request is not one", () => {
  assert.equal(parseShowRequest("show me where to build"), null);
  assert.equal(parseShowRequest("show me why my factory is slow"), null);
  assert.equal(parseShowRequest("show me every slug and tell me which is closest"), null);
});

test("clear requests are recognised, and questions about overlays are not", () => {
  for (const question of ["clear all overlays", "remove highlights", "hide the markers"]) {
    assert.deepEqual(parseClearRequest(question), { all: true }, question);
  }
  assert.equal(parseClearRequest("what is an overlay"), null);
});

/* ---------------- the local answer ---------------- */

function sink() {
  const emitted = [];
  return { emitted, actions: { emit: (actions) => emitted.push(...actions) } };
}

test("a show request emits the overlay action without any model call", () => {
  const services = sink();
  const answer = answerLocally("show me every mercer sphere within 150 m", graphOf(), services);

  assert.equal(answer.provider, "solvers");
  assert.equal(services.emitted[0].action, "highlight");
  assert.equal(services.emitted[0].item_name_contains, "mercer sphere");
  assert.equal(services.emitted[0].radius_m, 150);
  assert.equal(services.emitted[0].commit, true);
});

test("a local answer says it cost nothing, and refuses to guess a count", () => {
  const answer = answerLocally("show me every paleberry", graphOf(), sink());
  assert.match(answer.reply, /no API call, no credit used/);
  assert.match(answer.reply, /not guessing a count/);
});

test("an unroutable question returns null so the caller falls through to the model", () => {
  assert.equal(answerLocally("why did we start next to coal", graphOf(), sink()), null);
});

test("a siting answer leads with why it won, not just the score", () => {
  const answer = answerLocally("where should I build my hub", graphOf(), sink());
  assert.equal(answer.provider, "solvers");
  assert.equal(answer.local.solver, "find_best_site");
  assert.ok(answer.local.elapsed_ms < 500, "a local answer should be effectively instant");
});

/* ---------------- guard against the bug that caused all this ---------------- */

test("no source file carries a stray control character", () => {
  // A `\b` written through a shell heredoc became a literal backspace (0x08)
  // inside a regex, which then matched nothing. It printed identically to the
  // correct pattern, so it was invisible in every diff and log. Cheap to guard.
  const roots = ["lib", "test", "."];
  const seen = new Set();
  const offenders = [];

  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const file = path.join(root, entry.name);
      if (seen.has(file)) continue;
      seen.add(file);

      // Split on either ending — these files are CRLF on Windows, and a
      // carriage return is not the kind of stray character this guards against.
      const text = fs.readFileSync(file, "utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        for (const character of line) {
          const code = character.codePointAt(0);
          if (code < 32 && character !== "\t") {
            offenders.push(`${file}:${index + 1} contains U+${code.toString(16).padStart(4, "0")}`);
          }
        }
      }
    }
  }

  assert.deepEqual(offenders, []);
});
