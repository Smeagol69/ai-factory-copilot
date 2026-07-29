import assert from "node:assert/strict";
import test from "node:test";
import { needsStrongModel } from "../lib/providers.mjs";

test("causal, comparative, and planning questions escalate", () => {
  for (const question of [
    "why did we start next to coal",
    "what should I prioritise next",
    "design me a 300/min iron rod line",
    "is coal better than biomass here",
    "explain how the power grid works",
    "recommend a layout for this area",
  ]) {
    assert.equal(needsStrongModel(question, {}), true, question);
  }
});

test("plain lookups stay on the free tier", () => {
  for (const question of [
    "what tier am I",
    "how much power do I have",
    "is the smelter running",
    "list my blueprints",
  ]) {
    assert.equal(needsStrongModel(question, {}), false, question);
  }
});

test("a long question escalates even without a trigger word", () => {
  // Length is a decent proxy for compound or nuanced asks.
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  assert.equal(needsStrongModel(long, {}), true);
});

test("escalation can be forced or disabled outright", () => {
  assert.equal(needsStrongModel("what tier am I", { AIFACTORY_ESCALATE: "always" }), true);
  assert.equal(needsStrongModel("why did we start next to coal", { AIFACTORY_ESCALATE: "never" }), false);
});
