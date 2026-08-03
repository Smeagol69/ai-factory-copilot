import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  createSessionLedger,
  estimateCost,
  formatCostFooter,
  rateFor,
} from "../lib/pricing.mjs";

const DURING_INTRO = new Date("2026-07-28T00:00:00Z");
const AFTER_INTRO = new Date("2026-09-01T00:00:00Z");

/* ---------------- rates ---------------- */

test("an introductory rate applies while it lasts and lapses afterwards", () => {
  const during = rateFor("claude-sonnet-5", DURING_INTRO);
  assert.equal(during.input, 2);
  assert.equal(during.introductory_until, "2026-08-31");

  // The point of encoding the end date is that it cannot quietly keep applying.
  const after = rateFor("claude-sonnet-5", AFTER_INTRO);
  assert.equal(after.input, 3);
  assert.equal(after.introductory_until, undefined);
});

test("GPT-5.6 models use the official standard input and output rates", () => {
  const expectedRates = {
    "gpt-5.6-sol": { input: 5, output: 30 },
    "gpt-5.6-terra": { input: 2.5, output: 15 },
    "gpt-5.6-luna": { input: 1, output: 6 },
  };

  for (const [model, expected] of Object.entries(expectedRates)) {
    assert.deepEqual(rateFor(model), expected);
    const cost = estimateCost(model, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    assert.equal(cost.usd, expected.input + expected.output);
  }
});

test("an unpriced model reports no rate rather than a guessed one", () => {
  assert.equal(rateFor("some-model-released-next-year"), null);
});

/* ---------------- cost ---------------- */

test("cached tokens are billed at their real multipliers, not face value", () => {
  const cost = estimateCost(
    "claude-opus-5",
    { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000 },
    DURING_INTRO,
  );

  // 1000 + 20000*0.1 + 10000*1.25 = 15,500 billed input tokens.
  assert.equal(cost.billed_input_tokens, 15_500);
  assert.equal(cost.total_input_tokens, 31_000);
  // Billing the 31,000 tokens at face value would have doubled the reported
  // cost of exactly the request shape caching exists to make cheap.
  assert.ok(cost.billed_input_tokens < cost.total_input_tokens);
  assert.equal(cost.billed_input_tokens / cost.total_input_tokens, 0.5);

  const expected = (15_500 * 5 + 500 * 25) / 1_000_000;
  assert.ok(Math.abs(cost.usd - expected) < 1e-9);
});

test("the multipliers are the documented ones", () => {
  assert.equal(CACHE_READ_MULTIPLIER, 0.1);
  assert.equal(CACHE_WRITE_MULTIPLIER, 1.25);
});

test("an unpriced model still reports tokens, with the cost null", () => {
  const cost = estimateCost("mystery-model", { input_tokens: 100, output_tokens: 50 });
  assert.equal(cost.usd, null);
  assert.equal(cost.input_tokens, 100);
  assert.match(cost.rate_source, /unknown rather than estimated/);
});

test("a request with no usage costs nothing rather than NaN", () => {
  const cost = estimateCost("claude-sonnet-5", {}, DURING_INTRO);
  assert.equal(cost.usd, 0);
  assert.equal(cost.billed_input_tokens, 0);
});

/* ---------------- the footer ---------------- */

test("a locally answered question is labelled free", () => {
  const footer = formatCostFooter({ answeredBy: "local_solver", cost: null, sessionUsd: 0.12, sessionAnswers: 3 });
  assert.match(footer, /\*\*free\*\*/);
  assert.match(footer, /answered locally/);
  assert.match(footer, /session \$0\.12/);
});

test("a model answer shows what it cost and how much was cached", () => {
  const cost = estimateCost(
    "claude-sonnet-5",
    { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0 },
    DURING_INTRO,
  );
  const footer = formatCostFooter({ answeredBy: "model", cost, sessionUsd: 0.05, sessionAnswers: 2 });
  assert.match(footer, /60\.0k cached/);
  assert.match(footer, /400 out/);
  assert.match(footer, /session/);
});

test("a sub-tenth-of-a-cent answer says so instead of printing noise", () => {
  const cost = estimateCost("claude-haiku-4-5", { input_tokens: 10, output_tokens: 5 });
  const footer = formatCostFooter({ answeredBy: "model", cost, sessionUsd: 0 });
  assert.match(footer, /<\$0\.001/);
});

test("an unpriced model falls back to token counts in the footer", () => {
  const cost = estimateCost("mystery-model", { input_tokens: 5000, output_tokens: 100 });
  const footer = formatCostFooter({ answeredBy: "model", cost, sessionUsd: null });
  assert.match(footer, /billed in/);
  assert.equal(footer.includes("$"), false);
});

/* ---------------- session total ---------------- */

test("the ledger accumulates per session and keeps them separate", () => {
  const ledger = createSessionLedger();
  ledger.add("a", 0.01);
  ledger.add("a", 0.02);
  ledger.add("b", 0.5);

  assert.ok(Math.abs(ledger.get("a").usd - 0.03) < 1e-9);
  assert.equal(ledger.get("a").answers, 2);
  assert.equal(ledger.get("b").usd, 0.5);
  assert.equal(ledger.get("never-seen").usd, 0);
});

test("a free answer still counts as an answer but adds no spend", () => {
  const ledger = createSessionLedger();
  ledger.add("a", 0);
  const total = ledger.add("a", 0);
  assert.equal(total.usd, 0);
  assert.equal(total.answers, 2);
});

test("a null cost does not poison the running total", () => {
  const ledger = createSessionLedger();
  ledger.add("a", 0.05);
  const total = ledger.add("a", null);
  assert.equal(total.usd, 0.05);
  assert.equal(Number.isFinite(total.usd), true);
});
