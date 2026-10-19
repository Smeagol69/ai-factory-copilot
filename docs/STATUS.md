# Status: where the work stands (2026-10-18)

**Start here.** This is the single picture of the project as of 2026-10-18,
right after every Claude and Codex branch, every nested checkout and the
separate MCP Lab were consolidated into this one repo. Read in this order:

1. this file: where the latest progress is, what's verified, what's next;
2. [AGENTS.md](../AGENTS.md): the rules, the release process and the traps;
3. [ARCHITECTURE.md](ARCHITECTURE.md): how the mod, companion and hub fit together;
4. [hub/README.md](../hub/README.md): the model hub (portal, MCP servers, local model);
5. [HISTORY.md](HISTORY.md): how it got here, who did what, the consolidation
   record, and the full Claude + Codex ledger in [history/ledger/](history/ledger/).

## The project in one paragraph

AI Factory Copilot is an AI assistant inside a running game of Satisfactory
(1.2.4.1, CL 513885). A C++ SML mod (`Source/`, `AIFactoryCopilot.uplugin`)
scans the world and executes actions. It talks to a Node bridge on the same PC
(`companion/`, port 8142) that holds the deterministic solvers, the blueprint
tools and the model routing. The **AI Architect** side designs structures and
writes them as **native Satisfactory blueprints** (`.sbp`) that the game's own
blueprint designer can load and place. The **hub** (`hub/`, portal on
8795) is where models connect through MCP, share memory and claims through the
Agent Pair coordinator (8791), and where the local model runs. The owner's goal:
**type a prompt, and the models work together until a blueprint that works in
the game exists: bases, factories, tunnels.**

## The one line

- Everything is on **`master`**, on GitHub too (pushed 2026-10-18). Branch from
  `master` in your own worktree; old branches are gone. Every
  earlier branch is either in master's history, an identical rebase of commits
  that are, or recorded as superseded in [HISTORY.md](HISTORY.md#consolidation-2026-10-18).
  Each old branch tip is kept as a tag `archive/<branch>` (`archive/local/<branch>`
  where the local copy differed), on GitHub as well, so every hash quoted in the
  ledger and in `docs/ai-collaboration.md` still resolves.
- Tests, no game needed:
  - `cd companion; npm install; npm test`: **1359 pass, 0 fail**
  - `cd hub; runtime\node\node.exe --test --test-isolation=none test/*.test.mjs`:
    **168 pass, 0 fail, 2 skipped**
- Start: double-click **`Start Copilot.cmd`**. It opens the hub at
  <http://127.0.0.1:8795/>, starts the bridge, and writes the MCP launchers
  (`.mcp.json`, `.codex/config.toml`) that Claude Code and Codex use when they
  open this folder.

## Latest progress: the curved level tunnel (POC, 2026-10-17 → 18)

Built by Codex, verified by Codex with Google and the local model reviewing.
The owner said it "turned out great for a POC". Plan with checkboxes:
[superpowers/plans/2026-10-18-level-tunnel.md](superpowers/plans/2026-10-18-level-tunnel.md).
Proof files: [history/tunnel-milestone/](history/tunnel-milestone/README.md).

| What | Verified |
|---|---|
| `AI Level Tunnel 28deg.sbp`: 66-piece native blueprint, written through the game's own blueprint save | **Yes.** Read back from disk, 66/66 pieces at the exact saved pose (±0.1 cm), fingerprint `sha256:cb1a1cec…` |
| Placing it in the world through the game's own validated placement, with explicit height | **Yes.** 270 pieces placed, every pose checked against the plan |
| Undo of a placed blueprint actually removes its pieces | **Yes.** 72 removed, a fresh capture contained 0 |
| Curve refined (v2 had visible joint ridges, v3 "Fine Turn" fixed them within the piece budget) | **Partly.** All 270 v3 poses verified. `visualJointsVerified` is still **false**: nobody has formally inspected the joints. The owner's screenshots look clean |
| `AI Tunnel Work Area Preserved.sbp`: whole area re-saved (528 members) | **Yes.** 330/330 wanted members (60 original + 270 generated) at exact class and position (max error 0.00014 cm). It also caught 198 nearby test pieces |
| `AI Walled Sweep 90.sbp`: gradual64m-radius turn with straight connection sections | **Owner approved.** All504 placed class/position/rotation poses match the actual archive. The attempted v7 fitted-size readback failed because the archive retained unit scales; the owner likes that actual unit-scale shell. Preserve it. Physical attachment to the straight is not yet verified. |
| Lighting and industrial pedestrian-tunnel decoration | **In progress.** Native5454D8EF and companion aa6aa24 are deployed. Live checks found a missed outer v8 dispatch gate and lost scaled poses. A reviewed native repair is built, not yet installed. Exact prop calibration comes before decoration. No railway; preserve a clear walking route and future beltway space. |

Saved blueprints live in `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\blueprints\Bp Builder\`.

## What to do next, in order

1. **Install and test the reviewed native stage repair** with a fresh save backup
   and peer/source checks. Reapply validated scaled poses after construction,
   report before/staged/requested scale and retain exact saved-geometry checks.
   Do not overwrite the approved504-piece unit-scale shell.
2. **Test the lights and real Factory Props palette**. The bridge's old
   BP_BuildGun-only producer filter excluded815 unlocked props using native
   `/Script/FactoryGame.FGBuildGun`; its regression test and fix pass. Seven
   calibration props need native save/place/bounds readback before decoration.
3. **Verify the lights get power** in the game (the original source lamps
   captured no power).
4. **Save a clean finished tunnel** without the 198 nearby prototype pieces.
5. **Test the v7 shortened panels separately**, keeping the version the owner likes.
6. **Team room portal**: phase 1 is built (2026-10-18, branch `claude/team-room`). It is the hub's
   front page at <http://127.0.0.1:8795/>: one live column per model, read from its own
   session log (Codex rollouts, Claude Code transcripts, the hub's local chats), with
   working / idle / out-of-usage status and reset times, plus the owner's milestone strip.
   Milestones are published to shared memory (`pair_recall`, key `milestones`). The old
   page is at `/workshop`. **Phase 2, the backup shift, is built and on:** when Codex and
   Claude are both out of usage and a milestone is active, HauhauCS takes one small step at a
   time in `hub/workspaces/local-shift` (branch `local/shift`, 5 tool calls, no game, no push),
   commits it and posts "Review requested" to Agent Pair. Its steps show as "needs review"
   in its column until a reviewer merges them into `master`. Verified live 2026-10-18: the
   loop works end to end; the 9B model mostly reads and reports, so expect small steps.
   Claude's usage percentage is not in its logs; the Team room only sees when it hits the limit.
   Design: [superpowers/specs/2026-10-18-team-room-design.md](superpowers/specs/2026-10-18-team-room-design.md).
7. **Creative Architect research** (project 3): look for design-focused models or
   MCP tools that make the Architect better at layouts; add only what earns its place.

## Owner decisions pending

### Live industrial-tunnel continuation (2026-10-19)

The owner-approved `AI Walled Sweep 90` remains the504-piece unit-scale native
baseline. Seven FactoryProps calibration samples saved, reloaded and placed
7/7; fresh game capture independently matched full poses/unit scales and measured
their bounds. An18-piece native-size side-bay compiler now uses those measured
vents, M.A.M. consoles, crates and Ficus plants, a continuous measured floor and
a reserved12m central walking corridor. It handles either turn sign, preserves
both wall pipe bands and refuses missing/inconsistent/oversized measurements.
1367companion tests and197hub tests pass (2hub skips); bounded independent local
review approved the exact compiler/router. Native save/placement/render pending.

Lighting: reduced .25-size fixtures pass live228-piece collision preflight, but
the native Blueprint write resets every saved actor scale to1. Exact native
reload correctly refuses the result; failed file `AI Walled Sweep Lighting 90 v4`
must not be treated as a verified add-on. No world fixtures were placed. Native
unit-size props work. Investigate the save/membership phase or use real native
beam lengths and unit-size lamps; do not waive scale/readback checks. Power and
matching native wall pipes are still open.

- The 13 GB Wwise download cache at `hub/state/local-game-re/wwise-cache`: keep or
  delete (it can be downloaded again).

## The team and how models connect

| Model | How it runs | Role |
|---|---|---|
| Codex | Codex app/CLI on the owner's ChatGPT subscription | builder, game deployer |
| Claude | Claude Code on the owner's Claude subscription | builder, reviewer |
| Google (Gemini) | via the hub's team work | reviewer |
| **HauhauCS Qwen3.5 9B** (`copilot-hauhau-game:latest`) | local Ollama started by the hub on 127.0.0.1:11436, models in `hub/models/ollama` | backup worker when the others are out of usage; its work is reviewed by the others |

All of them use the same MCP servers from `hub/scripts/`: `agent_pair` (claims,
messages, shared memory: the Agent Pair coordinator on 8791, database in
`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\AgentPair\pair.sqlite`),
`superpowers` (process skills), `rea` (reverse engineering), and `local_model`
(talk to the local model). Ledger project keys: `satisfactory-mcp-lab` (hub team)
and `satisfactory-ai-architect` (Architect work).

## The owner's rules (summary, full text in AGENTS.md)

- Only improve, extend or optimise. Never remove a working feature unless the owner asks.
- Branch by author (`claude/…`, `codex/…`); `master` is integration.
- Before any release or deployment: fetch, read the other agents' latest work
  (including uncommitted), integrate on your own branch, verify, back up the save,
  and record the deployment in `docs/ai-collaboration.md`.
- The game is the authority. Never claim something works in the game without
  game readback; say "unknown" or "not verified" otherwise.
- Paid API models only with the owner's explicit go-ahead; subscriptions and the
  local model are the default team.

## Where things live

```text
Source/ Config/ Resources/ AIFactoryCopilot.uplugin   the C++ SML mod
companion/            bridge (8142), solvers, blueprint read/write, Architect compiler
hub/                  model hub: portal app (8795), MCP launchers, local model, REA
  runtime/ models/ state/ tools/satisfactory-sdk-513885/   local only (gitignored, ~33 GB)
scripts/              install, build, validate, export-ledger
docs/                 this file, history, designs, plans and specs (docs/superpowers)
Start Copilot.cmd     one-click start
```

`hub/state/live-architect/` holds the full raw evidence of the live Architect
runs (large captures stay local; the small proofs are copied to
`docs/history/tunnel-milestone/evidence/`). The mod SDK used for builds is
`hub/tools/satisfactory-sdk-513885` (Unreal/SML, 14 GB, local only).
