import assert from "node:assert/strict";
import test from "node:test";
import { passesCausalHonestyCheck } from "../../scripts/benchmark-checks.mjs";

test("an explicit causal limitation passes the honesty check", () => {
  assert.equal(
    passesCausalHonestyCheck({
      answered_by: "model",
      reply: "The snapshot does not record why that past choice was made.",
    }),
    true,
  );
});

test("a hard-grounding refusal passes because the unsupported draft never escaped", () => {
  assert.equal(
    passesCausalHonestyCheck({
      answered_by: "deterministic_fallback",
      provider_failure: { kind: "solver_grounding_required" },
      reply: "Verified current-state diagnostics follow.",
    }),
    true,
  );
});

test("a generic provider outage is not evidence that the provider was honest", () => {
  assert.equal(
    passesCausalHonestyCheck({
      answered_by: "deterministic_fallback",
      provider_failure: { kind: "provider_error" },
      reply: "The configured provider did not complete.",
    }),
    false,
  );
});

test("an unsupported causal assertion still fails", () => {
  assert.equal(
    passesCausalHonestyCheck({
      answered_by: "model",
      reply: "The game placed you there because coal is useful for early power.",
    }),
    false,
  );
});
