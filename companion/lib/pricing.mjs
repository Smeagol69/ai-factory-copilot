/**
 * What an answer cost.
 *
 * The bridge already knows the token counts; this turns them into the number a
 * player actually cares about, and puts it in the panel rather than a log file.
 *
 * Two honesty constraints shape this:
 *
 *   - **Rates are a local table and can go stale.** A model the table does not
 *     know reports its tokens and no dollar figure, rather than a confident
 *     wrong one. Introductory rates carry their end date so they cannot quietly
 *     keep applying after they lapse.
 *   - **Cached tokens are not billed at face value.** A read is about a tenth
 *     of the rate and a write about 1.25x, so counting raw input tokens would
 *     overstate the cost of exactly the requests caching was added to make
 *     cheap.
 */

/** USD per million tokens. Provider-specific verification dates are recorded inline. */
const RATES = {
  // OpenAI standard rates verified 2026-07-29 against the official model table:
  // https://developers.openai.com/api/docs/models/compare
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  // Anthropic rates checked against the published rates 2026-07-28.
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    // Introductory pricing, which lapses rather than lasting forever.
    introductory: { input: 2, output: 10, until: "2026-08-31" },
  },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cache reads bill at ~0.1x and writes at ~1.25x of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function rateFor(model, today = new Date()) {
  const entry = RATES[String(model ?? "").trim()];
  if (!entry) return null;
  const intro = entry.introductory;
  if (intro && today <= new Date(`${intro.until}T23:59:59Z`)) {
    return { input: intro.input, output: intro.output, introductory_until: intro.until };
  }
  return { input: entry.input, output: entry.output };
}

/**
 * Cost of one answer, in USD.
 *
 * Returns `usd: null` when the model is unpriced — the token counts are still
 * reported, because "I do not know the rate" is more useful than a guess.
 */
export function estimateCost(model, usage, today = new Date()) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const rate = rateFor(model, today);

  const billedInputTokens =
    input + cacheRead * CACHE_READ_MULTIPLIER + cacheWrite * CACHE_WRITE_MULTIPLIER;

  return {
    model: model ?? null,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_input_tokens: input + cacheRead + cacheWrite,
    billed_input_tokens: Math.round(billedInputTokens),
    usd:
      rate === null
        ? null
        : (billedInputTokens * rate.input + output * rate.output) / 1_000_000,
    rate: rate ?? null,
    rate_source:
      rate === null
        ? `No published rate is on file for "${model}", so the cost is unknown rather than estimated.`
        : rate.introductory_until
          ? `Introductory rate, through ${rate.introductory_until}.`
          : "Standard published rate.",
  };
}

function money(usd) {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd === 0) return "$0";
  // Below a tenth of a cent, four decimals is noise — say so instead.
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(usd < 0.1 ? 4 : 3)}`;
}

function compactTokens(count) {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

/**
 * The one-line footer appended to an in-game answer.
 *
 * Deliberately terse: the panel is small, and the player wants to know whether
 * that question spent money, not to read an invoice.
 */
export function formatCostFooter({ answeredBy, cost, sessionUsd, sessionAnswers }) {
  const session =
    sessionUsd === null || sessionUsd === undefined
      ? ""
      : ` · session ${money(sessionUsd) ?? "$0"}${sessionAnswers ? ` over ${sessionAnswers}` : ""}`;

  if (answeredBy === "local_solver") {
    return `\n\n— **free** (answered locally, no API call)${session}`;
  }
  if (!cost) return `\n\n— cost unknown${session}`;

  const cached =
    cost.cache_read_input_tokens > 0
      ? ` (${compactTokens(cost.cache_read_input_tokens)} cached)`
      : "";
  const price = money(cost.usd);
  const head = price === null ? `${compactTokens(cost.billed_input_tokens)} billed in` : price;

  return (
    `\n\n— ${head} · ${compactTokens(cost.total_input_tokens)} in${cached}` +
    ` · ${compactTokens(cost.output_tokens)} out${session}`
  );
}

/** Running spend for one chat session, so the panel can show a total. */
export function createSessionLedger() {
  const totals = new Map();
  return {
    add(sessionId, usd) {
      const key = String(sessionId ?? "default");
      const previous = totals.get(key) ?? { usd: 0, answers: 0 };
      totals.set(key, {
        usd: previous.usd + (Number.isFinite(usd) ? usd : 0),
        answers: previous.answers + 1,
      });
      return totals.get(key);
    },
    get(sessionId) {
      return totals.get(String(sessionId ?? "default")) ?? { usd: 0, answers: 0 };
    },
    reset(sessionId) {
      totals.delete(String(sessionId ?? "default"));
    },
  };
}

export { RATES as MODEL_RATES, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER };
