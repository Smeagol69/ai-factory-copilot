import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { needsStrongModel } from "../lib/providers.mjs";
import { mentionsSolverPattern, routeQuestion } from "../lib/router.mjs";

test("a bare solver question still routes to the solver and never escalates", () => {
  // The whole point of the route table is that these cost nothing and are
  // exact. Escalating them would spend the paid tier on a lookup.
  for (const question of ["what tier am i", "what am i short of", "are my belts full"]) {
    assert.ok(routeQuestion(question), `${question} should route`);
    assert.equal(needsStrongModel(question, {}), false, `${question} must stay cheap`);
  }
});

test("a near miss on a solver escalates instead of falling to the weakest tier", () => {
  // The live failure. routeQuestion matches "what tier am i" but refuses the
  // question because the second clause is real content, not filler. Before
  // this fix the question was short and named no solver tool, so every
  // remaining check passed it down to the local 8B model - the weakest tier,
  // for the question whose extra clause most needed tools.
  const question = "what tier am I on and is the Dimensional Depot unlocked yet?";
  assert.equal(routeQuestion(question), null, "it must not route");
  assert.equal(mentionsSolverPattern(question), true, "but it does carry a solver phrase");
  assert.equal(needsStrongModel(question, {}), true, "so it escalates");
});

test("the escalate/never override still wins", () => {
  // An operator who has turned escalation off must not be overridden by this.
  const question = "what tier am I on and is the Dimensional Depot unlocked yet?";
  assert.equal(needsStrongModel(question, { AIFACTORY_ESCALATE: "never" }), false);
  assert.equal(needsStrongModel("what tier am i", { AIFACTORY_ESCALATE: "always" }), true);
});

test("naming a solver tool outright still stays cheap", () => {
  // A deliberate earlier decision: a long, precise request against a named
  // tool is long because it is specific, and every number in the answer comes
  // from the solver. This fix is ordered after that check so it cannot undo it.
  const question =
    "Using get_unlock_status and the live snapshot only, tell me what tier am i " +
    "and list the exact recipes that are still locked. Do not build anything.";
  assert.equal(needsStrongModel(question, {}), false);
});

test("mentionsSolverPattern is weaker than routeQuestion, which is the point", () => {
  // If these two ever agreed, the near-miss rule would be dead code.
  const nearMiss = "what tier am I on and is the Dimensional Depot unlocked yet?";
  assert.equal(mentionsSolverPattern(nearMiss), true);
  assert.equal(routeQuestion(nearMiss), null);
  // And a question with no solver phrase at all matches neither.
  assert.equal(mentionsSolverPattern("how do I build a train station"), false);
});

test("an empty or junk question does not escalate on this rule", () => {
  assert.equal(mentionsSolverPattern(""), false);
  assert.equal(mentionsSolverPattern(null), false);
  assert.equal(needsStrongModel("", {}), false);
});

test("composing something to build escalates, but named build requests stay local", () => {
  // The natural way to ask for the hub was going to the 8B model. Every simple
  // build request is claimed by a local parser before this is consulted, so
  // escalating the verb only affects the open-ended kind.
  assert.equal(needsStrongModel("build me a sorted storage hub fed from my miners", {}), true);
  assert.equal(needsStrongModel("assemble a sorting bus", {}), true);
  // Still free: a bare solver lookup must not be dragged onto the paid tier.
  assert.equal(needsStrongModel("what tier am i", {}), false);
  assert.equal(needsStrongModel("what am i short of", {}), false);
});

test("the escalate patterns use real word boundaries", () => {
  // This line was once written with literal backspace bytes instead of \\b,
  // so the regex compiled and matched nothing. od -c is what found it.
  const providers = fs
    .readFileSync(new URL("../lib/providers.mjs", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  assert.doesNotMatch(providers, /\x08/, "no literal backspace characters in the source");
  // The build pattern is spelled with real backslash-b, not a control byte.
  assert.ok(
    providers.includes("/\\bbuild\\b|\\bcompose\\b|\\bassemble\\b/i"),
    "the build escalate pattern uses real word boundaries",
  );
});
