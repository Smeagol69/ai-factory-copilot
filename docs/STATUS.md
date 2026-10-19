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

- Everything is on **`master`** (consolidated on branch `consolidate`). Every
  earlier branch is either in master's history, an identical rebase of commits
  that are, or recorded as superseded in [HISTORY.md](HISTORY.md#consolidation-2026-10-18).
  Each old branch tip is kept as a tag `archive/<branch>` (`archive/local/<branch>`
  where the local copy differed), so every hash quoted in the ledger and in
  `docs/ai-collaboration.md` still resolves.
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
| Lighting add-on: 6 ceiling lights + 28 emissive beams along measured rows, separately undoable | **No.** The first two native saves refused safely (missing instance bounds, then real lamp overlap). Both are fixed in commit `46534bf` (v8 fitted fixtures, 1352 tests), but that build is **not deployed to the game yet** |

Saved blueprints live in `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\blueprints\Bp Builder\`.

## What to do next, in order

1. **Deploy the fitted-fixtures build (`46534bf`)** with a fresh save backup and
   source/hash checks (see AGENTS.md release rule). The game currently runs the
   instance-bounds build (`18e7022`).
2. **Save and load the lighting add-on**: exact 66 fixture poses and scales read
   back, then place it onto the curve and look: reveals, spacing, ceiling coverage.
3. **Verify the lights get power** in the game (the original source lamps
   captured no power).
4. **Save a clean finished tunnel** without the 198 nearby prototype pieces.
5. **Test the v7 shortened panels separately**, keeping the version the owner likes.
6. **Team room portal** (project 2, owner-approved direction): one live column per
   model, a milestone strip the owner fills in and marks complete, one-click
   connect for Claude Code and Codex on the owner's subscriptions, Ollama models
   found automatically, and the local model as the backup shift whose work other
   models review. Design: `docs/superpowers/specs/` (next spec to write).
7. **Creative Architect research** (project 3): look for design-focused models or
   MCP tools that make the Architect better at layouts; add only what earns its place.

## Owner decisions pending

- Push `consolidate` → `master` and the `archive/*` tags to GitHub, then delete the
  merged remote branches (not done; waiting for the owner's yes).
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
