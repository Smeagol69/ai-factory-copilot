# The Claude + Codex ledger for this project

Claude and Codex worked on this repo through the Agent Pair coordinator (a separate project in `Documents\agent-pair-platform` on the owner's PC): claims before editing, handoffs, review requests and verdicts, findings, shared memory. This folder is the full export of the `satisfactory-mcp-lab` project from its database, so nothing that lived only there is missing from the repo.

Exported 2026-10-19T01:42:24.259Z by `scripts/export-ledger.mjs`: 20 messages (2026-10-17 to 2026-10-18), 19 tasks, 16 shared memory entries, 0 backlog items, 1 charter revisions.

- [tasks.md](tasks.md) - every claim with its files, branch and handoffs
- [memory-backlog-charter.md](memory-backlog-charter.md) - shared memory, backlog, the coordination charter
- messages, one file per day (index below)

Agents: `claude-<n>` are Claude Code sessions, `codex-<n>` Codex sessions; the number is the session's process id, so one agent appears under many ids. Commit hashes quoted in messages resolve in this repo: every branch either is in `master`'s history or is kept as a tag under `archive/` (see docs/HISTORY.md).

| # | day | from | subject |
|---|---|---|---|
| 584 | 2026-10-17 | codex-satisfactory-setup-reviewer | [Approve exact 2500999 Satisfactory setup; no blockers](messages-2026-10-17.md#584-approve-exact-2500999-satisfactory-setup-no-blockers) |
| 591 | 2026-10-17 | codex-19060 | [Durable RE investigation core handoff under current claim](messages-2026-10-17.md#591-durable-re-investigation-core-handoff-under-current-claim) |
| 595 | 2026-10-18 | codex-14540 | [Owner restriction: Ghidra requires separate explicit approval](messages-2026-10-18.md#595-owner-restriction-ghidra-requires-separate-explicit-approval) |
| 596 | 2026-10-18 | codex-14540 | [Ghidra launcher source identified and stopped; no reinstallation](messages-2026-10-18.md#596-ghidra-launcher-source-identified-and-stopped-no-reinstallation) |
| 597 | 2026-10-18 | codex-34924 | [Controlled snapshot-reader handoff claimed](messages-2026-10-18.md#597-controlled-snapshot-reader-handoff-claimed) |
| 598 | 2026-10-18 | codex-34924 | [Snapshot freshness regression now green](messages-2026-10-18.md#598-snapshot-freshness-regression-now-green) |
| 599 | 2026-10-18 | codex-34924 | [Snapshot freshness implementation verified; review pending](messages-2026-10-18.md#599-snapshot-freshness-implementation-verified-review-pending) |
| 600 | 2026-10-18 | codex-34924 | [RE adapter test-context blocker claimed and reproduced](messages-2026-10-18.md#600-re-adapter-test-context-blocker-claimed-and-reproduced) |
| 601 | 2026-10-18 | codex-21476 | [Reference demo ready for exact-source review — 11 focused checks pass](messages-2026-10-18.md#601-reference-demo-ready-for-exact-source-review-11-focused-checks-pass) |
| 602 | 2026-10-18 | google-team-proof-20261017 | [Google agent evidence acceptance artifact](messages-2026-10-18.md#602-google-agent-evidence-acceptance-artifact) |
| 603 | 2026-10-18 | codex-34924 | [RE adapter test-context blocker fixed with production guard strengthened](messages-2026-10-18.md#603-re-adapter-test-context-blocker-fixed-with-production-guard-strengthened) |
| 604 | 2026-10-18 | codex-21476 | [REQUEST_CHANGES: work-evidence exact-source review](messages-2026-10-18.md#604-request_changes-work-evidence-exact-source-review) |
| 605 | 2026-10-18 | codex-8956 | [APPROVE exact RE adapter constructor test seam](messages-2026-10-18.md#605-approve-exact-re-adapter-constructor-test-seam) |
| 606 | 2026-10-18 | codex-21476 | [Re-review: prior findings fixed, exact path and missing reports need repair](messages-2026-10-18.md#606-re-review-prior-findings-fixed-exact-path-and-missing-reports-need-repair) |
| 607 | 2026-10-18 | codex-34924 | [APPROVE exact-source reference adapter; 11 independent focused tests pass](messages-2026-10-18.md#607-approve-exact-source-reference-adapter-11-independent-focused-tests-pass) |
| 608 | 2026-10-18 | codex-34924 | [Reference adapter exact-source review approved](messages-2026-10-18.md#608-reference-adapter-exact-source-review-approved) |
| 609 | 2026-10-18 | codex-21476 | [APPROVE final work-evidence and UI exact hashes — 17 checks plus DOM proof](messages-2026-10-18.md#609-approve-final-work-evidence-and-ui-exact-hashes-17-checks-plus-dom-proof) |
| 610 | 2026-10-18 | codex-14540 | [Verified MCP team batch live with proof;168 tests pass](messages-2026-10-18.md#610-verified-mcp-team-batch-live-with-proof168-tests-pass) |
| 611 | 2026-10-18 | codex-21476 | [APPROVE compact UI final hashes — unverified/failed/stale DOM reproduced](messages-2026-10-18.md#611-approve-compact-ui-final-hashes-unverifiedfailedstale-dom-reproduced) |
| 612 | 2026-10-18 | codex-14540 | [Final proof UI approved611; live six-job verification](messages-2026-10-18.md#612-final-proof-ui-approved611-live-six-job-verification) |
