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

## State of play

Done: the read-only scanner; fifteen tools (eleven solvers plus four action
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

Latest verified checkpoint (2026-07-28): all 256 companion tests pass and the
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

**Before reaching for a small local model again, read this.** `qwen3:4b` was
measured on the real save, same question both times:

| Config | Request | Result |
|---|---|---|
| `num_ctx` 32768, payload trimmed to 30k chars | ~21.7k tok | Correct `highlight` action; prose falsely claimed no Mercer Spheres within 150 m (there are two, at 105 m and 125 m) |
| `num_ctx` 40960, full payload | ~29.4k tok | **No action at all**; ignored the question and fabricated "3 Paleberry bushes within 50 m" and "raw quartz, copper ore deposits" |

More context made it worse, not better — a 4B model drifts as the payload grows.

The useful part is where it broke. **The action path survived the weak model**,
because the mod resolves overlays against live actors and appends the real
outcome, so a wrong count in the prose gets corrected by the game. The prose did
not survive: a 4B model violates rule 2 (unknown stays unknown) freely. If a
local model is wanted again, start at `-BaseModel 'qwen3:14b'` and re-measure
before trusting anything it narrates.

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
