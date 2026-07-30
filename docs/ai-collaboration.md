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
| 2026-07-29 | Claude | `claude/belt-routing` | Belt/conveyor routing in the layout designer: `companion/lib/designer.mjs`, new `companion/lib/routing.mjs`, `companion/lib/actions.mjs` (a `place_belt` action kind), and the matching C++ in `Source/AIFactoryCopilot/Private/AIFactoryActions.cpp`. | in progress |

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
