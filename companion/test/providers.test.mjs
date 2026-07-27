import assert from "node:assert/strict";
import test from "node:test";
import {
  providerMessages,
  SYSTEM_INSTRUCTIONS,
  userInput,
} from "../lib/providers.mjs";

const context = {
  question: "Is this aligned?",
  serializedSnapshot: '{"interaction_context":{"preferred_target":{"actor_id":"A"}}}',
  serializedDerivedFacts: "{}",
  omissions: [],
  history: [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
  ],
};

test("provider input uses native chat roles and a fresh current-turn snapshot", () => {
  const messages = providerMessages(context);
  assert.deepEqual(messages.slice(0, 2), [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
  ]);
  assert.match(messages[2].content, /CURRENT-TURN AUTHORITATIVE WORLD SNAPSHOT/);
  assert.doesNotMatch(userInput(context), /Earlier question/);
});

test("system instructions ground pronouns and separate web facts from game facts", () => {
  assert.match(SYSTEM_INSTRUCTIONS, /interaction_context\.preferred_target/);
  assert.match(SYSTEM_INSTRUCTIONS, /external web results are reference material only/i);
});
