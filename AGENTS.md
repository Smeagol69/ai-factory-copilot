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
dismantle, undo, and rollback refunds with inventory-overflow drops.

Latest verified checkpoint (2026-07-28): all 253 companion tests pass and the
FactoryEditor Development target compiles against the local official Starter
Project headers. The repo source was synced into the Starter Project after that
compile. The companion is clean-installed at
`D:\Modding\Satisfactory\Companion`; its scheduled task is healthy on port 8142
using Anthropic, and the installer verifies all runtime copies by SHA-256. The
mod is version 0.4.0 but has not yet been packaged/deployed or exercised in a
live save.

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
5. **Recipe unlock mapping.** Purchased schematics are captured but not which
   recipes they unlock in the snapshot/solver. `AFGRecipeManager` is the verified
   runtime source for availability and should be captured explicitly.
6. **Writing a `.sbp` file.** Saving a generated layout *as* a blueprint, rather
   than placing it directly. Needs (3).
