# Conductor and Design studio design

Date: 2026-10-18 · Milestone: "Full automation between agents: the hub starts
Claude and Codex turns itself"

## Why

The owner: "I want full automation between agents, the only thing stopping our
progress is usage." Today Claude and Codex only act when the owner types into
their chat apps. A message one of them leaves for the other waits in the Agent
Pair mailbox until the owner nudges the other app. The owner also wants design
to be a team effort: "I prompt a design and you both get to work together …
start with a render and a critique, then the other renders and you critique it,
and when you both agree on one design you work together building". Codex's
"AI Walled Sweep 90" is the model of a request turned into a good in-game
result.

## Goals

1. **Conductor:** a hub service that keeps a Claude worker and a Codex worker
   running on the owner's subscriptions. It hands each one its next step, starts
   its turn, waits for it to finish, and moves the job on. No owner nudging.
2. **Usage is the only brake:** before every turn the conductor checks that
   model's live usage (the clients report real rate limits). When a model is out,
   its step waits until the reset, or goes to the HauhauCS backup shift if
   that's allowed for the step.
3. **Design studio tab:** the owner types a brief. The job then runs:
   - **candidate**: the first designer compiles a piece list and a rationale;
   - **render**: the hub renders it;
   - **critique**: the other designer reviews the render and the piece list and
     posts a variant or fix, which is also rendered;
   - repeat until both mark one candidate **agree**;
   - **build**: the steps are split by strength and run in turn.

   Every render, critique and decision shows in the tab, with each worker's live
   activity in the Team room. The owner can pick, redirect or stop at any point.
4. **Renders from exact poses:** each piece is drawn as an oriented shaded box
   from its class and full transform, in three views (two isometric and top),
   saved as PNG by headless Edge. It's offline and makes no game calls. Proven
   on the v3 tunnel and on Walled Sweep 90.
5. **Milestone work:** the same conductor can run "next step on the active
   milestone" jobs, alternating builder and reviewer as Agent Pair already does.

## Non-goals

- Replacing the owner's own chat sessions. Those stay as they are. The
  conductor's workers are separate sessions that share the repo, Agent Pair
  memory and the mailbox.
- Paid APIs. Subscriptions only, as the clients already enforce.
- A new coordination ledger. Agent Pair stays the record.

## Anti-goals

- A runaway loop: turns that make no progress, or two models arguing forever.
  The limits are a round cap per design job (default 4 critique rounds, then the
  owner decides) and a stop on identical repeated failures (Agent Pair already
  does this).
- Unreviewed game writes, or anything reaching `master` without review.
- Claiming something works in the game without game readback.

## How it works

- **Workers:** the reviewed Agent Pair clients (`runtime/agent-pair/
  claude-client.mjs` and `codex-client.mjs`). One persistent session each, in
  its own worktree (`hub/workspaces/auto-claude` and `hub/workspaces/auto-codex`)
  on author branches (`claude/auto-*`, `codex/auto-*`). Their agent_pair
  instance ids are `claude-conductor` and `codex-conductor`.
- **Jobs:** stored under `hub/state/conductor/` as a small state machine (job,
  step, owner, inputs, outputs, status). Every step result is also posted to
  Agent Pair, so any model can read the thread.
- **Design format:** the candidate handoff is a **piece list** (`class_path`
  plus full transform, the same shape as the saved reference poses) with a short
  rationale and its source (compiler call or file). The conductor renders it;
  critiques reference it by candidate id. Open: Codex may prefer exchanging
  structural briefs or revisions first (asked in Agent Pair #637/#638).
- **Usage:** the clients emit live rate-limit events (Codex
  `account/rateLimits/read`; Claude `rate_limit_event`). Those also feed the
  Team room, which fixes the missing Claude usage percentage.
- **Visibility:** each worker's stream becomes Team room events in its column.
  The Design studio shows the job timeline with renders inline.

## Decided by the owner

- Full automation between agents is a milestone; only usage should stop progress.
- The design flow is render and critique in turns, then agree, then build together.
- Subscriptions plus local HauhauCS, no paid APIs.

## Open: needs the owner

1. **What may unattended workers do without asking?** Recommended:
   - code, tests, renders, compiles and commits on their own branches,
     automatically;
   - merging to `master` after the other model's review, automatically;
   - **game actions** (native blueprint save, placing in the world, deploying
     the mod): see the choice below.
2. **Game actions:**
   - (a) automatic, with the save backup the release rule requires;
   - (b) one "Approve" click in the hub per game action. This is the default
     until the owner says otherwise.

## Builder's choices

Exact render styling, job storage layout, prompt wording for each step, and the
critique checklist (proportions, joints, clashes, fit to brief, fit to
reference, buildability with unlocked pieces).
