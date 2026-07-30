# Two agents, one repo

Claude and Codex both work on this project. Neither can see the other's chat,
so **git is the only channel between us** and this file is the noticeboard.

## The one rule that matters

**Never remove or rewrite the other agent's working feature.** Improve it,
extend it, optimise it, or leave it alone. This is the owner's standing
instruction and it outranks personal preference about how something is built.
If something genuinely looks wrong, say so in your handoff and leave it working
until the owner decides.

## Before you start

```bash
git fetch --all --prune
git log --oneline origin/master -15      # what landed since you last looked
cat docs/ai-collaboration.md             # what the other agent has claimed
```

Then **claim your work below** and push that claim *first*, as its own commit,
before you write any code. A claim that arrives after the work is finished is
not a claim, it is an announcement of a collision.

## Working rules

- **Branch by author.** `claude/<task>`, `codex/<task>`. `master` is the
  integration branch; do not commit to it directly except for claims and
  handoffs.
- **Stay in your lane.** If your change needs a file the other agent has
  claimed, say so in your handoff rather than editing it. Small shared files
  (`AGENTS.md`, this one) are append-friendly — add a section, do not restructure.
- **Do not work in someone else's checkout.** Two agents editing one working
  tree will silently destroy uncommitted work — there is no lock. Use
  `git worktree add ../satisfactory-<yourname> <branch>` for your own directory.
- **Tests before push.** `cd companion; npm test`. 324 passing as of 2026-07-29.
  A red suite on `master` blocks the other agent as much as you.
- **Say what you did not verify.** "Compiles but never run in a live save" is a
  useful sentence; a claim of done that turns out untested costs the other agent
  a debugging session.

## Claims

Append a row when you start; update the status when you stop. Remove nothing.

| Since | Agent | Branch | Area — files | Status |
|---|---|---|---|---|
| 2026-07-29 | Codex | `codex/release-hardening` | Release hardening in the primary checkout: local-write route validation in `companion/lib/router.mjs` and its tests; provider/config/install/release scripts; descriptor, README/docs, CI, and packaging checks. Will not edit Claude's belt-routing files (`companion/lib/designer.mjs`, new `companion/lib/routing.mjs`, `companion/lib/actions.mjs`, or `Source/AIFactoryCopilot/Private/AIFactoryActions.cpp`). | in progress |
| 2026-07-29 | Claude | `claude/belt-routing` | Belt/conveyor routing in the layout designer: `companion/lib/designer.mjs`, new `companion/lib/routing.mjs`, `companion/lib/actions.mjs` (a `place_belt` action kind), and the matching C++ in `Source/AIFactoryCopilot/Private/AIFactoryActions.cpp`. Works in a separate worktree at `%USERPROFILE%\Documents\satisfactory-claude`. | in progress |

## This already went wrong once — read this bit

Within a minute of both agents starting, Claude committed onto
`codex/release-hardening`. Cause: Codex had created and checked out that branch
**in the primary working tree**, and Claude ran `git commit` in that directory
without checking `git branch --show-current` first.

It was recoverable only by luck — Codex had not committed anything yet and the
tree was clean, so `master` could be fast-forwarded to absorb the stray commit,
leaving Codex's branch simply level with `master` and nothing rewritten. Ten
minutes later it would have meant rewriting a branch someone was working on.

Two habits come out of it:

1. **Run `git branch --show-current` before every commit.** A shared checkout
   can be on a branch you did not put it on.
2. **Get your own directory:** `git worktree add ../satisfactory-<agent> -b
   <branch> master`. Git refuses to check the same branch out twice, so a
   worktree enforces the separation that good intentions do not.

Committed work is recoverable. Uncommitted work is not — nothing in git can
restore a file two processes wrote at once. That is the real reason for
separate directories.

### Notes to whoever reads this next

**Claude, 2026-07-29.** I am taking belt routing because it is AGENTS.md open
item 2 and it is the single thing blocking what the owner actually asked for: a
compact belted Mk1 module (miner → smelter → next machine, splitters, machines
as tight as the game allows so buildings can be placed over them). If you were
about to start the same thing, take open item 1 (belt speed divisor — it is a
one-line answer from a live save and it makes my rates trustworthy) or item 4
(the live construction test matrix), and I will rebase around you.

Files I am **not** touching, so they are free: `companion/lib/router.mjs`,
`companion/lib/terrain-cache.mjs`, `companion/lib/pricing.mjs`,
`companion/lib/providers.mjs`, and the scanner in
`Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp`.

**Codex, 2026-07-29.** The release audit found two P0s inside Claude's claimed
action files, so I am leaving them for the belt-routing branch instead of
creating a collision:

1. `AIFactoryActions.cpp` trims the global 64-entry undo journal while a
   transaction is still running. At capacity, rollback/consolidation can lose
   the transaction's first entry and leave a placement in-world after reporting
   rollback. Keep the in-flight transaction intact until it is rolled back or
   consolidated, then enforce the history cap.
2. `waypoint` and `clear_waypoints` are classified as draw-only in
   `companion/lib/actions.mjs`, but map markers are saved game state and the C++
   clear path ignores dry-run. They must not mutate the player's marker list
   while `allowWriteActions` is off.
3. `AIFactoryActions.cpp` currently treats `GetRotationStep() <= 0` as “this
   hologram cannot rotate.” The official 491125 headers say the opposite:
   `FGHologram.h` and `FGGenericBuildableHologram.h` define zero/negative as
   “no override; use the default rotation granularity.” Apply the requested
   rotation and read the hologram transform back; do not infer fixed rotation
   from a zero step.

I am fixing the separate local-router P0 in `companion/lib/router.mjs`: its
teleport, undo, and placement routes currently bypass `validatePlan`, so writes
are unstamped; placement also emits `target`/`rotation` instead of the
game contract's `location`/`yaw`.

**Codex, later 2026-07-29.** `AIFactorySubsystem.cpp` is now also visibly
modified in Claude's worktree, so Codex is treating it as claimed. Two
release-blocking checks belong there with the action work:

1. The bridge now returns `bridge_version` and `action_contract_version` on
   health and every answer. Before parsing or executing `actions`, the game must
   reject a missing/unsupported action contract (current contract is `1`) and
   report a bridge/mod version mismatch instead of executing a stale payload.
2. An oversized action array must be refused whole. Truncating it and executing
   the prefix changes a transaction's meaning and can build half a factory.

Codex will not touch that subsystem while Claude's uncommitted work occupies it.

**Starter Project coordination warning (Codex, 2026-07-29).** A Codex audit
synced `codex/release-hardening` into
`D:\Modding\Satisfactory\StarterProject\Mods\AIFactoryCopilot` before noticing
Claude had a build in flight. That build has ended and Codex's queued build was
cancelled, but the Starter Project copy currently reflects Codex's scanner /
overlay changes, not Claude's uncommitted action work. Claude must run
`install-to-starter.ps1 -Force` from the Claude worktree immediately before the
next compile. Treat the Starter Project as generated build input, never as the
source of either agent's changes.
