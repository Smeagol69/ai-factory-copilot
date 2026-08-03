/**
 * What happens when the paid tier is simply gone.
 *
 * This is not hypothetical: the owner's Anthropic balance ran out mid-session
 * and every escalated question died. The hybrid tier already fell back the
 * other way — cheap fails, use strong — but had nothing for the reverse.
 *
 * The default stays "fail loudly". This branch is only reached for causal,
 * comparative and planning questions, and the local model was benchmarked
 * failing exactly those: it asserted a causal reason as fact. A visible outage
 * beats an invisible wrong answer, so the fallback is opt-in and labelled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { askHybrid, needsStrongModel } from "../lib/providers.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const snapshot = buildFactorySnapshot();
const context = {
  question: "why is my smelter starved",
  snapshot,
  serializedSnapshot: JSON.stringify(snapshot),
  serializedDerivedFacts: "{}",
  serializedAnalysisDigest: '{"schema":"aifactory.analysis_digest"}',
  omissions: [],
  summary: { world_revision: 41, actors: 9, recipes: 5, items: 6, mods: 1, actors_by_owner_mod: {} },
  graph: buildGraph(snapshot),
  history: [],
};

test("a reasoning question escalates; a lookup does not", () => {
  assert.equal(needsStrongModel("why did we start next to coal", {}), true);
  assert.equal(needsStrongModel("should i build here", {}), true);
  assert.equal(needsStrongModel("compare mk2 and mk3 belts", {}), true);
  assert.equal(needsStrongModel("where is BP_ResourceNode12_91", {}), false);
  assert.equal(needsStrongModel("what tier am i", {}), false);
});

test("by default a dead strong tier fails loudly rather than quietly downgrading", async () => {
  const env = {
    AIFACTORY_CHEAP_PROVIDER: "mock",
    AIFACTORY_STRONG_PROVIDER: "anthropic",
    // No ANTHROPIC_API_KEY, so the strong tier cannot run.
  };
  await assert.rejects(
    () => askHybrid(context, env),
    /ANTHROPIC_API_KEY|not configured|anthropic/i,
    "an escalated question must not silently land on the weaker model",
  );
});

test("with the fallback enabled it answers, and says what answered it", async () => {
  const env = {
    AIFACTORY_CHEAP_PROVIDER: "mock",
    AIFACTORY_STRONG_PROVIDER: "anthropic",
    AIFACTORY_FALLBACK_TO_CHEAP: "true",
  };
  const answer = await askHybrid(context, env);

  assert.equal(answer.tier.used, "cheap");
  assert.equal(answer.tier.why, "strong_tier_failed_and_fallback_was_enabled");
  assert.ok(answer.tier.strong_error, "the real reason must be carried, not swallowed");
  // The label is the whole point: an unlabelled downgrade is the failure mode.
  assert.match(answer.reply, /local fallback model/i);
  assert.match(answer.reply, /unverified/i);
});

test("the cheap tier still handles what it is good at, unlabelled", async () => {
  const env = { AIFACTORY_CHEAP_PROVIDER: "mock", AIFACTORY_STRONG_PROVIDER: "anthropic" };
  const answer = await askHybrid({ ...context, question: "what tier am i" }, env);
  assert.equal(answer.tier.used, "cheap");
  assert.equal(answer.tier.why, "answered_by_the_free_tier");
  assert.doesNotMatch(answer.reply, /local fallback model/i);
});
