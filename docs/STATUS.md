# Status: where the work stands (2026-10-19)

**Start here.** Updated with the 2026-10-19 live industrial-tunnel proof after
the branches, nested checkouts and separate MCP Lab were consolidated into
this one repo. Read in this order:

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
  - `cd companion; npm install; npm test`: **1367 pass, 0 fail**
  - `cd hub; runtime\node\node.exe --test --test-isolation=none test/*.test.mjs`:
    **197 pass, 0 fail, 2 skipped**
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
| Industrial pedestrian-tunnel decoration | **First pass verified in game.** `AI Walled Sweep Industrial 90 v1`: 18 native-size props saved/reloaded and placed; every full world pose checked. 1,372 footprint samples land on the approved shell's flat floor, with the central 12m corridor clear. See the 2026-10-19 proof below. |
| Lighting | **Open.** DLL0614e6dd and companion e91eb17 are installed. The 228-fixture plan clears native collision checks, but the game writes every actor scale as1. Exact reload refuses it. The failed file is quarantined; no new world fixtures were placed. |

Saved blueprints live in `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\blueprints\Bp Builder\`.

## What to do next, in order

1. **Fix native fixture persistence**, or use real native beam lengths and
   unit-size lamps. Construction already retains requested scales; saving loses
   them. Inspect membership and serialization phases, keeping exact readback.
   Preserve the approved 504-piece shell and the placed 18-piece decor kit.
2. **Match the original wall pipes through the curve**, using measured native
   spline geometry, real support placement and reciprocal native connections.
   The decoration reserves those wall bands; it does not supply new pipes yet.
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
7. **Conductor and Design studio** (milestone "Full automation between agents", built
   2026-10-19): the hub runs Codex and Claude turns itself on the owner's subscriptions, with
   scoped permissions while the owner supervises. At <http://127.0.0.1:8795/studio> the owner
   writes a brief. Then: a candidate piece list (rendered offline in three views, with measured
   native sizes where known), a critique by the other model, both agree (or the owner picks), build,
   verify. Workers live in `hub/workspaces/auto-claude` and `auto-codex`, with the `agent_pair` and
   `studio` MCP servers. Game actions belong to Codex; the conductor's game tools stay off until
   Codex's live session hands off (`hub/state/studio/game-operator.json`). Usage is the only
   brake. **First run (00:37–00:45):** Codex's worker designed "AI Walled Straight — 2 Bays"
   (36 pieces); Claude's worker verified the join against the sweep byte for byte and agreed. The
   build waits for the game hand-off (job `1c963dbd`). Design:
   [superpowers/specs/2026-10-18-conductor-design.md](superpowers/specs/2026-10-18-conductor-design.md).
8. **Creative Architect research** (project 3): look for design-focused models or
   MCP tools that make the Architect better at layouts; add only what earns its place.

## Live industrial-tunnel continuation (2026-10-19)

The owner-approved `AI Walled Sweep 90` remains the 504-piece unit-scale native
baseline, with identical saved bytes. Seven FactoryProps calibration samples
saved, reloaded and placed 7/7; fresh capture matched their full poses and scales.
The measured side-bay compiler created **AI Walled Sweep Industrial 90 v1**:
6 vents, 4 M.A.M. consoles, 4 crates and 4 Ficus plants, all native size.
The game saved/reloaded and placed **18/18**. Fresh world capture matched every
class/position/rotation/unit scale; all 504 original shell scales also checked.
The hologram rounded heading by -0.450003 degrees; floor sampling accounted for
this actual heading: **1,372 supported samples**, maximum floor-height error
0.0042cm, and nearest prop footprint 644.84cm from the central path.
One interior night view was inspected; final daytime finish is still open.

Companion **1367 pass**, hub **197 pass / 2 skipped**; exact compiler/router
reviewed by the configured local model. Source e91eb17, DLL0614e6dd, companion
runtime1f96e53a; deployment owner codex-14540. Save backups and raw evidence stay
under `hub/state/live-architect/tunnel-milestone`. Compact proof and actual image:
[industrial accents](history/tunnel-milestone/evidence/industrial-accents-2026-10-19.json),
[night inspection](history/tunnel-milestone/evidence/industrial-accents-night-2026-10-19.png).

Lighting: reduced .25-size fixtures pass live228-piece collision preflight, but
the native Blueprint write resets every saved actor scale to1. Exact native
reload correctly refuses the result; failed file `AI Walled Sweep Lighting 90 v4`
must not be treated as a verified add-on. No world fixtures were placed. Native
unit-size props work. Investigate the save/membership phase or use real native
beam lengths and unit-size lamps; do not waive scale/readback checks. Power and
matching native wall pipes are still open.

## Owner decisions pending

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
