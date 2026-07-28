import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateCacheUsage,
  cacheableSystem,
  emptyCacheUsage,
  markLastUserMessageCacheable,
  moveToolResultBreakpoint,
  promptCachingEnabled,
  providerMessages,
  summarizeCacheUsage,
} from "../lib/providers.mjs";

const context = {
  question: "where should I build?",
  serializedSnapshot: '{"actors":[]}',
  serializedDerivedFacts: "{}",
  serializedAnalysisDigest: "{}",
  omissions: [],
  history: [],
};

/* ---------------- breakpoint placement ---------------- */

test("the system prompt carries the breakpoint that also covers the tools", () => {
  const system = cacheableSystem("rules");
  // Tools render before system, so this single marker caches both.
  assert.equal(system.length, 1);
  assert.equal(system[0].type, "text");
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
});

test("the snapshot message becomes a cacheable block", () => {
  const messages = providerMessages(context);
  assert.equal(typeof messages.at(-1).content, "string");

  markLastUserMessageCacheable(messages);
  const content = messages.at(-1).content;
  assert.ok(Array.isArray(content), "a string cannot carry cache_control");
  assert.deepEqual(content[0].cache_control, { type: "ephemeral" });
  // The text itself must survive the rewrite untouched.
  assert.match(content[0].text, /where should I build\?/);
  assert.match(content[0].text, /AUTHORITATIVE WORLD SNAPSHOT/);
});

test("marking is idempotent, so a re-entered loop cannot double-wrap", () => {
  const messages = providerMessages(context);
  markLastUserMessageCacheable(messages);
  const first = messages.at(-1).content;
  markLastUserMessageCacheable(messages);
  assert.deepEqual(messages.at(-1).content, first);
});

test("history entries are left alone; only the current turn is marked", () => {
  const messages = providerMessages({
    ...context,
    history: [
      { role: "user", text: "earlier question" },
      { role: "assistant", text: "earlier answer" },
    ],
  });
  markLastUserMessageCacheable(messages);
  assert.equal(typeof messages[0].content, "string", "the older user turn stays a plain string");
  assert.ok(Array.isArray(messages.at(-1).content));
});

/* ---------------- the tool-result breakpoint moves ---------------- */

function toolResultMessage(ids) {
  return {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "{}" })),
  };
}

test("only the newest batch of tool results holds a breakpoint", () => {
  const messages = [toolResultMessage(["a", "b"])];
  moveToolResultBreakpoint(messages, messages[0].content);
  assert.equal(messages[0].content[1].cache_control?.type, "ephemeral");

  // Next round: the marker must move, not accumulate. Four breakpoints is the
  // hard limit, and a stale marker also falls outside the 20-block lookback.
  const second = toolResultMessage(["c", "d"]);
  moveToolResultBreakpoint(messages, second.content);
  messages.push(second);

  const marked = messages.flatMap((message) =>
    message.content.filter((block) => block.cache_control),
  );
  assert.equal(marked.length, 1, "exactly one tool-result breakpoint at a time");
  assert.equal(marked[0].tool_use_id, "d");
});

test("many rounds never exceed the four-breakpoint limit", () => {
  const messages = providerMessages(context);
  markLastUserMessageCacheable(messages);

  for (let round = 0; round < 10; round += 1) {
    const results = toolResultMessage([`r${round}-1`, `r${round}-2`]);
    moveToolResultBreakpoint(messages, results.content);
    messages.push(results);
  }

  const total = messages
    .filter((message) => Array.isArray(message.content))
    .flatMap((message) => message.content.filter((block) => block.cache_control)).length;
  // 1 snapshot + 1 tool-result marker; the system block is the third, counted
  // separately because it is not in messages.
  assert.equal(total, 2);
  assert.ok(total + 1 <= 4, "must stay within the API's four-breakpoint limit");
});

/* ---------------- accounting ---------------- */

test("usage accumulates across every round, not just the last", () => {
  const totals = emptyCacheUsage();
  accumulateCacheUsage(totals, { input_tokens: 100, cache_creation_input_tokens: 20000 });
  accumulateCacheUsage(totals, { input_tokens: 50, cache_read_input_tokens: 20000 });
  accumulateCacheUsage(totals, { input_tokens: 50, cache_read_input_tokens: 20000 });

  assert.equal(totals.input_tokens, 200);
  assert.equal(totals.cache_creation_input_tokens, 20000);
  assert.equal(totals.cache_read_input_tokens, 40000);
});

test("a missing usage object is survivable", () => {
  const totals = emptyCacheUsage();
  accumulateCacheUsage(totals, undefined);
  assert.deepEqual(totals, emptyCacheUsage());
});

test("reports the saving against what the same prompt would have cost uncached", () => {
  const totals = emptyCacheUsage();
  // One write then two reads of a 20k prefix — a three-round question.
  accumulateCacheUsage(totals, { input_tokens: 100, cache_creation_input_tokens: 20000 });
  accumulateCacheUsage(totals, { input_tokens: 100, cache_read_input_tokens: 20000 });
  accumulateCacheUsage(totals, { input_tokens: 100, cache_read_input_tokens: 20000 });

  const summary = summarizeCacheUsage(totals);
  // Uncached: 300 + 60000 = 60300. Billed: 300 + 40000*0.1 + 20000*1.25 = 29300.
  assert.equal(summary.uncached_equivalent_input_tokens, 60300);
  assert.equal(summary.effective_input_tokens, 29300);
  assert.equal(summary.saved_input_tokens, 31000);
  assert.ok(summary.saved_percent > 50);
});

test("a cold first question is not reported as a failure", () => {
  const totals = emptyCacheUsage();
  accumulateCacheUsage(totals, { input_tokens: 100, cache_creation_input_tokens: 20000 });
  const summary = summarizeCacheUsage(totals);
  // Writing without reading costs more than not caching — true, and expected
  // on the first question. The note has to say which case this is.
  assert.ok(summary.saved_input_tokens < 0);
  assert.match(summary.note, /first question that is expected/);
});

test("no usage at all summarises to zero rather than dividing by zero", () => {
  const summary = summarizeCacheUsage(emptyCacheUsage());
  assert.equal(summary.saved_percent, 0);
  assert.equal(summary.effective_input_tokens, 0);
});

/* ---------------- the switch ---------------- */

test("caching is on by default and can be turned off", () => {
  assert.equal(promptCachingEnabled({}), true);
  assert.equal(promptCachingEnabled({ ANTHROPIC_PROMPT_CACHE: "true" }), true);
  for (const value of ["off", "false", "0", "disabled", "OFF"]) {
    assert.equal(promptCachingEnabled({ ANTHROPIC_PROMPT_CACHE: value }), false, value);
  }
});
