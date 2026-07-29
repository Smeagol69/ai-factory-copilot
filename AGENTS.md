# Working on AI Factory Copilot

Shared handoff notes for anyone — human or agent — picking this up. Read this
before changing anything; it records the decisions and the traps.

## What this is

An SML mod plus a localhost Node companion. The mod captures authoritative game
state; the companion turns it into deterministic answers and talks to a model.

```
Satisfactory + SML
  -> scanner (C++)            Source/AIFactoryCopilot
  -> JSON snapshot per message
  -> bridge (Node)            companion/
       -> graph + solvers     the model must call these for any number
       -> model provider      openai | anthropic | local | mock
  -> answer + actions[]       back to the mod
  -> mod re-validates, executes server-side, reads the world back
  -> answer + outcome in the in-game panel (Insert)
```

The return path is the important half. A tool result goes into the *model's*
context, not to the game, so an action tool validates the request and drops a
typed action into a per-request sink; the response carries them in `actions`.
The mod validates again and commits. Two independent checks, and the one that
owns the world has the last word.

## Non-negotiable rules

These are the project's spine. Breaking one is a regression even if tests pass.

1. **The game is authoritative; the model is not.** Never let the model produce a
   number it could have got from a solver.
2. **Unknown stays unknown.** If the snapshot cannot support a value, say so and
   name the missing field. Never estimate into a gap. Every omission in the model
   payload names the solver that serves it.
3. **Solvers read the complete snapshot; the model reads a lean view.** This is
   the inverse of the original design and it is deliberate — see below.
4. **Only the game commits a write.** The bridge proposes typed actions; the mod
   re-validates every one server-side and is the only thing that can apply it.
   Nothing may report an action as done — the mod reads the world back and
   appends the real outcome.
5. **Never guess an engine API.** Verify against the Starter Project headers
   first, then compile. Two real bugs were caught this way: a `protected`
   accessor, and the engine's misspelled `ModiferKeyForNewLine`.

## Environment (this machine)

| Thing | Path |
|---|---|
| Repo | `C:\Users\roesl\Documents\satisfactory` |
| Coffee Stain engine | `D:\Modding\Satisfactory\UnrealEngine-CSS` (registry: `5.6.1-CSS`) |
| Starter Project | `D:\Modding\Satisfactory\StarterProject` |
| Game | `D:\SteamLibrary\steamapps\common\Satisfactory` |
| Runtime output | `%LOCALAPPDATA%\FactoryGame\Saved\AIFactoryCopilot\` (**not** under the game dir) |
| Blueprints | `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\blueprints` |

The Starter Project and game copies are **real copies, not junctions** — they go
stale independently and must be re-synced.

## Build, deploy, run

```powershell
# 1. Sync repo source into the Starter Project
./scripts/install-to-starter.ps1 -StarterProjectPath 'D:\Modding\Satisfactory\StarterProject' -Force

# 2. Compile just this module (fast; ~3 min incremental)
D:\Modding\Satisfactory\UnrealEngine-CSS\Engine\Build\BatchFiles\Build.bat `
  FactoryGameSteam Win64 Shipping `
  -Project="D:\Modding\Satisfactory\StarterProject\FactoryGame.uproject" `
  -Module=AIFactoryCopilot -WaitMutex -NoHotReload

# 3. Package + deploy to the game  (-ScriptsForProject is required, not optional)
D:\Modding\Satisfactory\UnrealEngine-CSS\Engine\Build\BatchFiles\RunUAT.bat `
  -ScriptsForProject="D:\Modding\Satisfactory\StarterProject\FactoryGame.uproject" `
  PackagePlugin -project="D:\Modding\Satisfactory\StarterProject\FactoryGame.uproject" `
  -dlcname=AIFactoryCopilot -clientconfig=Shipping -build `
  -CopyToGameDirectory_Windows="D:\SteamLibrary\steamapps\common\Satisfactory"

# 4. Validate + test
./scripts/validate.ps1        # header checks + the whole Node suite
cd companion; npm test

# 5. Install/repair the localhost companion and its logon task
./scripts/install-companion.ps1
```

**Close the game before step 3.** A running game holds the DLL open and the
deploy fails with `UnauthorizedAccessException`. The build and cook still
succeed; only the final copy fails.

## Traps that already cost time

- **UAT needs `-ScriptsForProject`.** With only `-project`, `PackagePlugin` is
  not found.
- **`ModiferKeyForNewLine`** — the engine misspells "Modifier". Spell it their way.
- **`GetExtractableResourceActor()` is protected.** Use the public
  `GetResourceNode()`.
- **`RP_Inpure`**, not `RP_Impure`. The engine misspells this too.
- **Thinking tokens come out of `max_tokens`.** A small budget spends the whole
  allowance reasoning and truncates the answer. Anthropic default is 16000.
- **`budget_tokens` is rejected** by current models — use `thinking: {type:"adaptive"}`.
- **A 429 means two different things.** A TPM rate limit is transient and retried;
  `insufficient_quota` is a billing failure and must not be retried.
- **Terrain probing is O(resolution²) traces per site.** Both the per-probe
  resolution and the total probe count are clamped in `FAIFactorySettings`.
- **`DrawDebug*` is compiled out of Shipping.** `ENABLE_DRAW_DEBUG` is off, so
  those helpers silently no-op in the packaged mod. Overlays use
  `ULineBatchComponent` via `World->GetLineBatcher(...)`, which is a real render
  component and survives.
- **Unity builds share a translation unit.** An `anonymous namespace` helper in
  one `.cpp` still collides with a same-named one in another. Prefix them.
- **`startupSelfTest` costs real money on every save load.** It fires a full
  question ~10s after each world init — about 65k effective input tokens and
  ~$0.15 a load at Sonnet 5 rates. It is a genuinely useful deploy check, but
  it is not free and it is not silent: the answer lands in the player's chat
  panel looking like an unrequested status dump. The repo default is `false`;
  turn it on to verify a deploy, then turn it back off.
- **The world revision moves constantly — report drift, do not refuse on it.**
  `MarkWorldDirty` fires on every actor spawn and destroy, so items moving
  along a belt tick it continuously. A real build failed with
  `expected=569, actual=600` because the world moved 31 times while the model
  was thinking. Two rules were in direct conflict: a committed write **must**
  carry `expect_world_revision`, and the stamp had to match **exactly**. In a
  live game both cannot hold. The stamp is now always sent and any drift is
  reported on the result, but it only refuses the action when the caller sets
  `require_unchanged_world`. The real check is the per-action preflight —
  recipe, ground, overlap, cost, hologram — which is precise where a global
  counter is blunt.
- **`allowed_domains` can 400 the whole request.** Anthropic rejects a search
  tool naming a site that blocks its crawler (reddit.com does). Blocked hosts
  are filtered per provider in `sources.mjs`, and an unknown one is parsed out
  of the error and retried once.

## Why the model gets a lean payload

A whole-world snapshot on a real save is ~3.9M chars (~975k tokens); the item and
recipe catalog alone is ~713k tokens. That blew the provider's TPM limit on a
single question.

The catalog is now kept on the bridge, where the solvers read it in full, and the
model receives grounding, the analysis digest, and the nearest actors — measured
at **~10k tokens, a 95× reduction**. Because the model now sees *less* than the
solvers, the system prompt explicitly tells it that an absence in its view is not
an absence in the world, and to ask a solver before saying something does not
exist. `AIFACTORY_PAYLOAD=full` restores the old behaviour.

## Layout

| Path | What |
|---|---|
| `Source/AIFactoryCopilot/` | The scanner. `AIFactorySnapshot.cpp` emits the JSON; `AIFactoryTerrain.cpp` probes ground/slope/water; `AIFactoryActions.cpp` executes writes; `AIFactoryOverlay.cpp` draws in-world; `AIFactoryCopilotUISubsystem.cpp` is the in-game panel |
| `companion/lib/graph.mjs` | Cached production graph: component→actor resolution, belt/pipe/power topology, chain tracing |
| `companion/lib/solvers.mjs` | Every deterministic answer. One exported `solveX` per tool |
| `companion/lib/tools.mjs` | Tool schemas + dispatch. **Three different shapes**: flat (Responses), nested under `function` (Chat Completions), `input_schema` (Messages) |
| `companion/lib/sources.mjs` | Outside-reference policy and the official-source allowlist |
| `companion/lib/blueprints.mjs` | `.sbp` / `.sbpcfg` parsing |
| `companion/lib/actions.mjs` | Action validation. Refuses a bad plan whole rather than half-emitting it |
| `companion/lib/designer.mjs` | Layout design. Every spatial constant is measured off the player's own base |
| `companion/lib/snapshot.mjs` | `buildLeanPayload` (what the model sees) and the legacy compactor |
| `companion/test/fixtures/factory.mjs` | The synthetic factory every solver test runs against |

## Adding a solver

1. Export `solveThing(graph, args, services)` from `solvers.mjs`. Return an object
   carrying `source` and `certainty`, and list what it could not determine.
2. Add it to `SOLVER_TOOLS` in `tools.mjs` with a description that says **when**
   to call it, not just what it does — that measurably improves tool selection.
3. Point the system prompt at it in `providers.mjs`.
4. Test it against `test/fixtures/factory.mjs`. Hand-compute the expected numbers.
5. Bump the tool-count assertions in `tools.test.mjs`, `server.test.mjs`,
   `payload.test.mjs`.

## Write actions

`Source/AIFactoryCopilot/AIFactoryActions.cpp` executes these; `companion/lib/actions.mjs`
validates them first. Adding one means touching both, plus `ACTION_KINDS`.

| Action | Notes |
|---|---|
| `teleport_player` | Snaps to ground by default. A bare XY with a guessed Z drops the player through the world |
| `place_building` | Needs the **build** recipe (`Recipe_ConstructorMk1`), not the production recipe |
| `place_blueprint` | Uses `AFGBlueprintHologram`; descriptor, snapping, placement, cost, proxy grouping, layout, and wiring stay in Satisfactory's systems |
| `dismantle` | The one action with no undo. Warned about at every layer |
| `undo_last` | Pops the journal; dismantles what was placed, restores where the player was |
| `highlight` / `clear_highlight` | Draw only. Never gated, never counted as changes |

Gates, in order: server-authority → mandatory world-revision match for a
committed write → whole-plan preflight → `bAllowWriteActions` → `commit:true`
on the action itself. All five must pass. The bridge stamps the snapshot revision
onto validated actions; the model never supplies that value. `allowWriteActions`
is **off by default** and lives in the mod config, not the bridge — the model can
request a commit, only the game can grant one.

A plan is preflighted whole, stops at its first runtime failure, and rolls back
the reversible writes it already made. Successful multi-step writes are one undo
transaction. Dismantle and undo must each be standalone committed writes.

## Where the last session left off (2026-07-29)

Read this first if you are picking up work. Everything below was driven by
watching a live play session and reading what it actually cost.

**The finding that mattered: nothing was free.** Local routing was measured at
~75% coverage, but a whole play session went by paying for every question. Three
causes, all now fixed:

1. The bridge runs from a clean-install copy, so repo edits were not live. See
   the deploy trap below — it has now bitten twice.
2. **The question text was never logged**, so routing patterns had been tuned
   against phrasings I invented. Real ones missed by one word: "where should i
   build my hub **on the whole map**" left `whole, map`; "whats my power
   **looking like today**" left `looking, today`. Both routes were correct and
   both were rejected by the residue guard over padding.
3. Writes had **no local coverage at all**, and the session was write-heavy. The
   75% was measured on read questions only.

`explainRoutingMiss()` in `companion/lib/router.mjs` now reports the near miss,
and `server.mjs` appends every question to
`%LOCALAPPDATA%\FactoryGame\Saved\AIFactoryCopilot\Diagnostics\routing.jsonl`.

**Read that log before adding patterns.** It is the difference between tuning
against evidence and guessing again:

```powershell
Get-Content "$env:LOCALAPPDATA\FactoryGame\Saved\AIFactoryCopilot\Diagnostics\routing.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.answeredBy -eq 'model' } |
  Select-Object question, miss
```

### What is now answered locally (free)

| Request | Route | Why it needs no model |
|---|---|---|
| "where is BP_ResourceNode12_91" | `locate` | A search of the complete snapshot |
| "place a mk1 miner on this node facing north" | `place_building` | Three lookups: name→recipe, aim→coordinate, compass→yaw |
| "waypoint the best hub location" | `waypoint` | Site solver output handed to the game's marker system |
| "teleport me to \<thing\>" | `teleport_player` | A lookup followed by a move |
| "undo" | `undo_last` | One meaning, no arguments |
| a stray "1" or "?" | `clarify` | Cost $0.25 once; now never reaches a model |

Each falls through to the model when its target does not resolve. That is
deliberate and must stay: placing the wrong building is not a cheaper answer,
it is a building to dismantle.

### Two things the game already did better than we did

- **Waypoints use `AFGMapManager::AddNewMapMarker`** (`FMapMarker` in
  `FGMapMarker.h`), with `CompassViewDistance = CVD_Always`. That gives the map
  pin *and* the compass distance readout for free — the same thing the resource
  scanner shows. Markers are categorised `"AI Factory Copilot"` so
  `clear_waypoints` never deletes the player's own pins. The drawn
  `ULineBatchComponent` overlay is **not** replaced and is still the right tool
  for "show me every beryl nut in 100 m": many targets, at once, through
  terrain.
- **`hologram_has_no_rotation_step` was my bug, not the game's.** A miner on a
  node has no rotation freedom, so "facing north" is not a request the game can
  honour. Refusing the whole placement over it was wrong; it now places and
  reports `rotation_ignored` with the reason.

### Terrain no longer forgets what it measured

`companion/lib/terrain-cache.mjs`. The mod probes terrain with line traces,
which only hit streamed-in geometry, so it probes within 500 m of the player and
caps at `MaxTerrainProbes = 150`. On a 996-node save that is at best 15%
coverage, and every capture threw the results away.

Satisfactory's map is fixed, so a measurement stays true. The cache harvests
every live reading, refills what the current capture missed, and reports
coverage in the response as `terrain_cache`. Rules that keep it honest:
`no_ground_found` is an absence and is never stored; a served reading is marked
`from_cache` with its age; and obstruction counts carry an explicit caveat
because the player builds and dismantles.

**Still unverified, and cheap to settle:** `NORTH_IS_YAW_DEGREES = 0` in
`router.mjs` assumes the game's compass north is Unreal's +X. Every reply states
the yaw it used, so place one miner facing north in a live save, look at the
compass, and correct that single constant if it is wrong.

### Immediate next steps

1. **Package the mod.** The C++ changes (waypoints, the rotation fix) compile
   clean against the Starter Project but the game was running, so
   `package-local.ps1` refused to replace the deployed DLL. Close Satisfactory
   and run it. The companion changes are already deployed and live.
2. **The belted Mk1 module the owner asked for** — miner → smelter → splitter,
   machines as tight as the game allows, so they can build over it. This is
   blocked on open item 2 below (belt routing). Start with the narrow case: a
   straight belt between two placed machines whose connectors already face each
   other.
3. Read `routing.jsonl` and widen routing from what is actually in it.

## State of play

Done: the read-only scanner; sixteen tools (twelve solvers plus four action
tools); terrain probing; site selection; production planning against the live
base; the layout designer; server-authoritative writes; in-world overlays;
official-source web search; adaptive thinking; multi-line in-game chat;
blueprint header/cost/contents reading and placement; stale-snapshot enforcement;
whole-plan preflight/rollback; one-transaction undo; exact game-side action
results in both the panel and `latest-bridge-response.json`; truthful write-mode
status in the panel; live recipe/building unlock enforcement; single-building
placement through the recipe's real Satisfactory hologram and its snapping,
rotation, dynamic cost, multi-step, and construct-disqualifier checks; blueprint
placement through `AFGBlueprintHologram` with descriptor-cost cross-checking and
proxy-aware undo; exact inventory cost checks and charging; no-build-cost support;
dismantle, undo, and rollback refunds with inventory-overflow drops; recipe and
item availability captured from `AFGRecipeManager` into the snapshot, so the
solvers report unlock status on a three-tier ladder — live recipe-manager state,
then in-use-in-world, then an explicit unknown for snapshots predating the
field — rather than a blanket "not determinable".

Latest verified checkpoint (2026-07-29): all 324 companion tests pass and the
FactoryEditor Development target compiles against the local official Starter
Project headers. The repo source was synced into the Starter Project after that
compile. The companion is clean-installed at
`D:\Modding\Satisfactory\Companion`; its scheduled task is healthy on port 8142
using Anthropic, and the installer verifies all runtime copies by SHA-256. The
mod is version 0.4.0. Its FactoryGameSteam Shipping target compiled, cooked, and
packaged successfully through UAT/Alpakit, producing a 14,660,733-byte archive
at `Saved\ArchivedPlugins\AIFactoryCopilot\AIFactoryCopilot-Windows.zip`. The
same build is deployed into the game; the deployed DLL SHA-256 is
`4EE45459FC2AC0CBB6390E1B8FFDE1E8F3C1B66BABA3C7AEB4D36A1FD728098A`
(built 2026-07-28 12:11, i.e. including `864ba53`; an earlier note here recorded
a hash from before the last three commits).
It has not yet been exercised in a live save.

**Provider state as of 2026-07-28.** The bridge runs on **Anthropic /
`claude-sonnet-5`**, verified answering in ~5 s with prompt caching engaged
(59k written then 73k read across two questions). Sonnet was chosen over Opus
deliberately: at the introductory rate it is 2.5× cheaper per input token and
handles the tool-calling and unknown-stays-unknown discipline this project
depends on — roughly 200 questions per $30 instead of 80. `ANTHROPIC_MODEL` is
the only thing to change to move back. OpenAI on this machine returns
`insufficient_quota` and should not be selected.

**Deploy the companion after changing it.** The bridge runs from
`D:\Modding\Satisfactory\Companion`, a clean-install copy — editing the repo
does nothing until `./scripts/install-companion.ps1` re-syncs it. This is the
same real-copies-not-junctions trap as the Starter Project, and it hid a
working feature behind an empty response field with no error anywhere.

Ollama was trialled and then removed from this machine at the owner's request
(5.06 GB reclaimed), so `AI_PROVIDER=local` has nothing to talk to here until
it is reinstalled. `./scripts/install-local-model.ps1` is kept and works: it
pulls a model, bakes an explicit `num_ctx` into a derived Ollama model so the
base stays untouched, sizes the payload to match, and refuses to report success
until it has proved the model can actually call a tool.

**Local models were measured on this machine; the numbers are the answer.**
ROCm works on the RX 7800 XT (`library=ROCm compute=gfx1101`, 15.8 GiB), so
inference runs on the GPU. The ceiling is memory, not setup:

| Model | Needs | Verdict with the game running |
|---|---|---|
| `qwen3:14b` @ 32k ctx | ~14 GB (9 weights + 5 KV) | **OOM** — only 10.9 GB free |
| `qwen3:8b` @ 32k ctx, q8_0 KV | ~7.5 GB | Fits |

The payload is why: 26k tokens of snapshot, tools, and prompt before the
model says a word, so the context cannot simply be shrunk.

`qwen3:8b` benchmarked at **5/7** on `scripts/benchmark-provider.mjs`, at a
**median 71s per question against Sonnet 5's ~5s**. It called tools correctly
and did not invent resources, but it failed the two checks that matter most:
it did not cite a solver coordinate for a siting question, and it asserted a
causal reason as fact where the data cannot show one. That second failure is
the same shape as the 4B's — not refusal, but confident fabrication — so a
small local model is not trustworthy as an unattended default here.

Where it *is* useful is the hybrid cheap tier, because escalation is decided
by question shape before the model runs: causal, comparative, and planning
questions never reach it. `AI_PROVIDER=hybrid` with `AIFACTORY_CHEAP_PROVIDER`
and `AIFACTORY_STRONG_PROVIDER`.

Open, in rough order:

1. **Belt speed divisor.** `items/min = reported_speed / 2` is an assumption.
   `ITEM_SPACING` (120 cm) is authoritative from the header, but whether `mSpeed`
   is cm/s or cm/min is not — both readings give 60/min for a Mk1. Check one known
   belt in a live save and set `AIFACTORY_BELT_SPEED_DIVISOR` if it is 120.
2. **Belts, pipes, and power in the designer.** `design_factory_layout` places
   machines and leaves a foundation-wide aisle between rows for them, but does
   not run the connections. Belt routing needs a path between two connection
   components plus conveyor-pole placement; the aisle exists so that work has
   somewhere to go.
3. **Blueprint transforms for *analysis*.** Placement does not need these — the
   game's loader handles it. Reading where things sit *inside* a `.sbp`, to
   answer "what is in this blueprint and how is it arranged", still needs
   Satisfactory's save serialiser;
   [`satisfactory-file-parser`](https://github.com/etothepii4/satisfactory-file-parser)
   implements it. The companion has zero dependencies, a deliberate property —
   decide consciously before breaking it.
4. **Live construction test matrix.** Both building and blueprint writes compile
   through their real holograms, but must be exercised in a packaged game for:
   valid/blocked/unaffordable placement, rotation snapping, no-build-cost,
   multi-action rollback, undo refunds, blueprint proxies, and modded recipes.
   Do not claim production-ready placement until those exact outcomes are saved
   in `latest-bridge-response.json` and checked against the world.
5. **Writing a `.sbp` file.** Saving a generated layout *as* a blueprint, rather
   than placing it directly. Needs (3).
