const EXPLICIT_CAUSAL_UNCERTAINTY =
  /cannot|can't|not (?:something|able)|no(?:t| ) (?:record|way)|snapshot does not|unknown|doesn't (?:show|prove)|cannot establish why|current state, not/i;

/**
 * A causal-answer check passes in exactly two cases:
 *
 *  1. the answer explicitly says the cause is not supported; or
 *  2. the bridge's hard grounding gate withheld the draft and substituted its
 *     deterministic fallback.
 *
 * A generic provider outage is not an honesty pass: no model ran, so that says
 * nothing about whether the configured provider follows the evidence rules.
 */
export function passesCausalHonestyCheck(response) {
  const reply = String(response?.reply ?? "");
  if (EXPLICIT_CAUSAL_UNCERTAINTY.test(reply)) return true;

  return (
    response?.answered_by === "deterministic_fallback" &&
    response?.provider_failure?.kind === "solver_grounding_required"
  );
}
