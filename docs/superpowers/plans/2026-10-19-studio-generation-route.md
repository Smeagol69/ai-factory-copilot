# Fixed Studio Generation Command Implementation Plan

> **For agentic workers:** Use test-driven implementation and a fresh independent exact-source review. Steps use checkbox syntax.

**Goal:** Let the conductor request native generation of precisely its agreed proposal through a deterministic companion command.

**Architecture:** The hub stages exact proposal bytes under their SHA-256 in a controlled local directory. A reserved hash-only command loads those bytes in the companion and passes one generation proposal through existing validatePlan. The hub binds native receipts to that submission and requires exact saved geometry readback. An open lease intent precedes submission, so a stopped process cannot silently free a possibly accepted request.

**Tech Stack:** Existing Node ESM companion/hub, native playtest mailbox and game action executor; no new dependency or native code.

**Spec:** Owner's forwarded request and Claude #657; exact proposal/lease contracts in baseline50191075; review #659 identifies the submission gap. Fixed command: `aifactory studio generate sha256:<64 lowercase hex digits>`; no path, coordinates or action text in command arguments. Only native generation, no placement or arbitrary actions.

## Global Constraints

- Only the game commits writes and reports saved/read-back success.
- Preserve all working routes, approved504-piece shell and18 placed props.
- Missing, malformed, oversized or hash-mismatched proposals refuse locally, never reach a provider.
- Reserved commands stay local even when ordinary local routing is disabled.
- Keep conductor OFF and no operator handoff; deployment and game verification remain separately evidenced.
- Unknown or stopped submissions retain exclusive unresolved ownership.

## Review Focus

- Tampering between staging and execution must yield no action.
- Existing blueprint names must be preserved, including unreadable library entries.
- Native failure, partial geometry, wrong name and unrelated committed actions cannot become build success.
- Process stop/expiry during mailbox submission must leave a durable unresolved intent.
- A disabled local-routing flag or malformed reserved command must never fall through to a model.

### Task1: Preserve ownership across pending submission

Files: `hub/lib/game-lease.mjs`, `hub/lib/studio-gateway.mjs` and their tests.

- [x] Write a deferred-submit regression reproducing accepted request plus stopped turn, and observe failure.
- [x] Persist an open uniquely identified generation intent before await submit; reconcile mailbox ID on return, retain unknown intent on throw/stop.
- [x] Verify stopped turn, expiry and explicit release cannot free pending generation; known completion closes normally.

### Task2: Fixed companion command

Files: new `companion/lib/studio-generation.mjs`, `companion/lib/router.mjs`, `companion/server.mjs`, new `companion/test/studio-generation.test.mjs`, `companion/test/server.test.mjs`, installer manifest if required.

Interfaces: `answerStudioGeneration(question, graph, services)` returns a local answer or null for unrelated text; proposal directory is configured by services/environment, never command text. `studioGenerationDirectory(env)` resolves the shared default under LocalAppData.

- [x] Test generation from exact staged bytes; hash mismatch, malformed prefix, unknown directory/library, invalid action and duplicate name refuse without action.
- [x] Run tests RED, then implement bounded file loading and one validatePlan call/action emission.
- [x] Integrate reserved command before the ordinary local-routing switch; prove HTTP behavior with routing disabled and an unavailable provider.

### Task3: Hub adapter, native verification and handoff

Files: new `hub/lib/studio-generation-route.mjs` and tests, `hub/scripts/studio-mcp.mjs`, relevant docs.

Interfaces: `createStudioGenerationRoute(options)` returns `{question({proposal,proposalFile,proposalHash}), verify(result,proposal)}` matching the existing gateway injection. Stage exact checked bytes; verify only the submitted terminal native generation result with matching name, expected members and exact saved geometry/readability evidence. Native topology must be empty for this structural lane.

- [x] Test wrong hash/name/count, native refusal, partial readback and unrelated action; run RED.
- [x] Implement adapter and verify against actual native result field contracts; wire into the existing MCP gateway without activating conductor.
- [x] Run companion and hub full suites, independent exact-source review, resolve material findings and document exact command/evidence limits.
- [ ] Commit reviewed source and install only the companion bundle.
- [ ] Send Claude the command, receipt contract and reviewed commit. Distinguish source-ready from deployed/live-verified.

## Verification record

Initial command tests:7 RED then7 GREEN; HTTP routing-disabled regression RED
then GREEN. Adapter5 RED then5 GREEN; malformed health capability RED then GREEN.
Pending-intent regressions:10 RED, focused27 GREEN. Actual fresh Claude
subscription session `f76ac5e8-66a0-4e43-be8f-1633c0f4666a` reviewed the seven
source files. One important name-normalization gap reproduced before repair;
the duplicate check now uses the validator's actual emitted name. The related
native-name check also follows normalization. Both regressions RED then GREEN;
focused command8/8 and adapter7/7. Claude explicitly approved the final seven
source hashes in `claude-source-review-final.json` under the task's local state.

Full companion1376 pass; full combined hub278 total,276 pass,0 fail,2 skipped.
Latest committed master `d03f79f` integrated after
reading peer commits and unfinished session-keeper work; no unfinished peer code
is packaged. Combined hub verification exposed an existing arbitrary-delay race
in backup-shift's Stop test: worktree setup could outlast300ms and its fake
runner missed an already-fired abort. A controlled400ms delay reproduced the
hang; waiting for the listener-ready barrier instead passes both that fixture
and the full suite. No product source changes were needed for that test.

Native receipt binding is causal through the fixed hash command and one validated
action. Native exact archive readback supplies class/pose/scale acceptance, but
the receipt does not independently echo the source hash or full pose list. No
native generation, placement or conductor activation is claimed by offline tests.
