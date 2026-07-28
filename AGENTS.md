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
  -> answer in the in-game panel (Insert)
```

## Non-negotiable rules

These are the project's spine. Breaking one is a regression even if tests pass.

1. **The game is authoritative; the model is not.** Never let the model produce a
   number it could have got from a solver.
2. **Unknown stays unknown.** If the snapshot cannot support a value, say so and
   name the missing field. Never estimate into a gap. Every omission in the model
   payload names the solver that serves it.
3. **Solvers read the complete snapshot; the model reads a lean view.** This is
   the inverse of the original design and it is deliberate — see below.
4. **No write actions yet.** The mod is read-only. Nothing may claim it placed,
   changed, or executed anything in the game.
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
| `Source/AIFactoryCopilot/` | The scanner. `AIFactorySnapshot.cpp` emits the JSON; `AIFactoryTerrain.cpp` probes ground/slope/water; `AIFactoryCopilotUISubsystem.cpp` is the in-game panel |
| `companion/lib/graph.mjs` | Cached production graph: component→actor resolution, belt/pipe/power topology, chain tracing |
| `companion/lib/solvers.mjs` | Every deterministic answer. One exported `solveX` per tool |
| `companion/lib/tools.mjs` | Tool schemas + dispatch. **Three different shapes**: flat (Responses), nested under `function` (Chat Completions), `input_schema` (Messages) |
| `companion/lib/sources.mjs` | Outside-reference policy and the official-source allowlist |
| `companion/lib/blueprints.mjs` | `.sbp` / `.sbpcfg` parsing |
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

## State of play

Done: read-only scanner; nine deterministic solvers; terrain probing; site
selection; official-source web search; adaptive thinking; multi-line in-game
chat; blueprint header/cost reading.

Open, in rough order:

1. **Belt speed divisor.** `items/min = reported_speed / 2` is an assumption.
   `ITEM_SPACING` (120 cm) is authoritative from the header, but whether `mSpeed`
   is cm/s or cm/min is not — both readings give 60/min for a Mk1. Check one known
   belt in a live save and set `AIFACTORY_BELT_SPEED_DIVISOR` if it is 120.
2. **Blueprint object graph.** Only the header and cost are decoded. The full
   per-building layout needs Satisfactory's save serialiser —
   [`satisfactory-file-parser`](https://github.com/etothepii4/satisfactory-file-parser)
   already implements it and is a Node library, so it drops straight into the
   companion. This is the prerequisite for generating blueprints.
3. **Blueprint generation.** The goal is layouts tailored to the player's actual
   base: terrain-aware, matching their existing scheme. Needs (2), plus the
   designer volume/object-limit model, then plan → validate → populate.
4. **Recipe unlock mapping.** Purchased schematics are captured but not which
   recipes they unlock, so recipe availability is reported as unknown.
5. **Write actions.** Gated: no write stage until the read-only scanner passes
   representative vanilla and modded save tests.
