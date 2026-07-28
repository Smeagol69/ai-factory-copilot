# AI Factory Copilot for Satisfactory

AI Factory Copilot is an SML C++ mod plus a localhost companion process. The
mod reads authoritative runtime state from Satisfactory and sends a bounded,
evidence-bearing snapshot to a configurable AI provider. It never asks the
model to identify machines from screenshots or guess undisclosed game state.

This repository implements a working **AI co-player that can act**: it reads the
world, computes answers deterministically, and — when asked — changes the world
through server-authoritative actions the game itself executes and confirms.

- an Insert-toggled in-game chat panel: type a question however you want to word
  it, Enter to send, Shift+Enter for a new line, with a transcript, a live
  elapsed indicator while the answer is being worked out, and a continuously
  updating exact player-position/current-focus status strip
- reasoning plus outside references: adaptive thinking, and web search
  restricted to the official wiki, modding docs, and forums, cited in the answer
- fresh whole-world capture for every panel message, including exact pawn,
  camera, crosshair hit, and Satisfactory cached interaction state
- SML 3.12.0 native root module and server-authoritative mod subsystem
- discovery of loaded mods and versions
- SML registry discovery for vanilla and modded items and recipes
- live buildable, resource-node, transform, bounds, blueprint membership,
  inventory, conveyor/pipe/power connection, recipe, production, boost,
  clocking, productivity, transport, power-circuit, player, vehicle, pickup,
  onboarding objective, active milestone, game phase, todo list, exact recipe
  availability, progression, and power-consumption scanning
- exact rendered UMG text capture from the base-game HUD and other mods, without
  screenshots or OCR, with manager/HUD conflicts preserved instead of guessed
- bounded Unreal reflection for additional non-transient mod properties
- an explicit `IAIFactoryDataProvider` adapter contract for custom semantics
- continuously changing world revisions based on live factory fingerprints
- authoritative JSON snapshot export
- natural in-game `/ai <question>` chat plus administrative commands
- an opt-in startup self-test that exercises the real SML command path and
  persists the bridge response for non-interactive diagnostics
- a loopback-only companion supporting diagnostic, local (free), OpenAI, and
  Anthropic modes
- local multi-turn conversation memory, per-save/player reset, and optional
  OpenAI web search for clearly labeled outside references
- strict context compaction that reports every omitted category

## Deterministic solvers

The model does not do factory arithmetic. It calls solvers, and answers that mix
solver output with guesswork are prevented by construction: a value the snapshot
cannot support comes back as an explicit unknown with the missing field named.
The solvers read the complete snapshot while the model gets a lean view, so an
absence in the model's view is never treated as an absence in the world.

| Solver | Answers |
|---|---|
| `get_machine_rates` | exact per-minute inputs and outputs per machine |
| `get_item_balance` | production versus consumption per item, with surplus/deficit |
| `find_recipes` | recipes producing or consuming an item, ranked by rate |
| `get_transport_capacity` | belt and pipe capacity against supply and demand |
| `get_power_circuits` | capacity, headroom, fuse state, battery runtime |
| `diagnose_bottlenecks` | why a machine is stopped, and the upstream root cause |
| `get_build_cost` | construction cost against captured player inventories |
| `plan_production` | designs a line for a target item and rate, against this base |
| `list_blueprints` | saved blueprints: dimensions, cost, contents, and whether you can afford them |
| `find_best_site` | ranks where to build, scoring resource access around every candidate |
| `get_unlock_status` | rendered HUD, objective, active milestone, game phase, recipe availability, schematics, and tech tier |
| `design_factory_layout` | a placeable layout fitted to this base, with exact coordinates |
| `perform_actions` | places, removes, moves, teleports — validated, then executed by the game |
| `highlight` | tracer lines and bounding boxes around anything, drawn in-world |
| `clear_highlight` | removes an overlay |

Siting questions are computed, not eyeballed. Ask *"where should I put the HUB?"*
and `find_best_site` scores every usable resource node as a candidate centre by
resource diversity, purity-weighted node count, coverage of the resources you
named, and distance cost — returning exact coordinates, the runners-up, and the
per-factor breakdown. Occupied nodes and hand-mined `Deposit` nodes are excluded,
because a miner cannot be placed on either.

Terrain is measured, not guessed: downward line traces across each footprint give
slope and elevation range, the game's own water volumes give water, a lifted box
test finds rock and cliff, and existing buildings come from their captured bounds.
Sites outside the scanner's probe radius report `not_sampled` — unmeasured ground
is not flat ground. Only exact placement validity stays unknown; that needs the
game's own hologram check.

Rates come from each machine's live production cycle time, so overclocking is
never double-counted; production boost applies to products only; liquid and gas
registry amounts are converted to cubic metres before being compared with
pipeline flow limits. Stalls are classified as invalid, inefficient, or unknown,
and a starved machine's report names the upstream machine that actually has to
change.

Ask the whole report with no model involved:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8142/v1/analyze `
  -ContentType 'application/json' `
  -Body (Get-Content -Raw 'FactoryGame\Saved\AIFactoryCopilot\Snapshots\latest.json' |
    ForEach-Object { "{`"schema`":`"aifactory.analyze`",`"schema_version`":1,`"world_snapshot`":$_}" })
```

## Acting on the world

The copilot places buildings, stamps blueprints, teleports, dismantles, and
draws overlays. Every action runs through the same contract:

| Action | What it does |
|---|---|
| `place_building` | Places one machine from its build recipe, ground and clearance probed first |
| `place_blueprint` | Stamps a saved blueprint via `AFGBlueprintHologram`, so snapping, validation, layout, wiring, and proxy grouping stay in Satisfactory's systems |
| `teleport_player` | Moves the player, snapping to measured ground so a bare coordinate cannot drop them through the map |
| `dismantle` | Removes a building. The one action with no undo, and it says so everywhere |
| `undo_last` | Reverses the previous action |
| `highlight` / `clear_highlight` | Tracer lines and bounding boxes drawn in-world, visible through terrain |

Five gates stand between a model deciding something and the world changing:
server authority, an optional world-revision match so an action cannot land on
a world the model never saw, per-action validation on both sides, the mod's own
`allowWriteActions` switch, and `commit: true` on the action itself. The model
can *request* a commit; only the game can grant one. With writes off, every
action still runs its validation and reports exactly what it would have done.

Results are read back from the world rather than assumed. A placement reports
where the building actually landed and how far that is from where it was asked
for — the two differ whenever the game snaps or refuses. A plan stops at its
first failing step instead of pressing on, because a half-built layout is not
the layout that was designed.

Writes are **off by default**. Turn them on in the mod config:

```json
{ "allowWriteActions": true }
```

## Designing a factory, not just costing one

`plan_production` says what to build. `design_factory_layout` says where, and
fits it to the base that is already there:

- machine footprints are **measured from the player's own machines**
- so is the build recipe, read off `built_with_recipe` — which is why the
  designer works for modded buildings with no table to maintain
- the grid is rotated onto the alignment the existing buildings share, reported
  with the percentage that agree, so a mixed base is a best guess and says so
- the origin is phase-locked to the existing foundation lines, so new rows land
  on the same grid rather than a half-foundation off it
- occupied ground is detected from captured bounds; a blocked slot names what is
  in the way and is never emitted as an action

A building type the player has never placed is reported as unplaceable with the
fix — place one by hand, then ask again — rather than guessed at. Both the
footprint and the build recipe come from a real machine, so they fail together
and they fail honestly.

Belts, pipes, and power poles are not routed yet. The layout leaves a
foundation-wide aisle between rows for them.

## In-game commands

Press **Insert** in a loaded save to open or close the copilot panel. Type a
question and press Enter. The panel defaults to a whole-world snapshot; its
live status strip updates while open, and the exact state used for an answer is
captured when Send is pressed.

```text
/ai <question>
/ai all <question>
/ai reset
/ai status
/ai scan [radius_m]
/ai export [radius_m|all]
```

Examples:

```text
/ai what should I build here?
/ai is this machine connected correctly?
/ai Why are the manufacturers near me not producing?
/ai Which installed mod owns the machines in this area?
/ai all Where is the largest current bottleneck in my world?
```

The longer `/aifactory ask ...` syntax remains available for compatibility.

## Start the companion

Node.js 20 or newer is required. No packages need to be installed.

Diagnostic mode works without an API key:

```powershell
cd companion
$env:AI_PROVIDER = 'mock'
node server.mjs
```

Free and unlimited, using any OpenAI-compatible local server (Ollama, LM Studio,
llama.cpp, vLLM) — no key, no rate limits, no cost:

```powershell
cd companion
$env:AI_PROVIDER = 'local'
$env:LOCAL_AI_MODEL = 'qwen3'
node server.mjs
```

`LOCAL_AI_BASE_URL` defaults to Ollama's `http://127.0.0.1:11434/v1`. Pick a model
that supports tool calling, since the solvers are tools; with one that does not,
set `LOCAL_AI_TOOLS=false` and the bridge will label its numbers unverified rather
than passing them off as computed.

OpenAI:

```powershell
cd companion
$env:AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'your-key'
$env:OPENAI_MODEL = 'gpt-5.6-sol'
$env:OPENAI_WEB_SEARCH = 'true'
node server.mjs
```

Anthropic:

```powershell
cd companion
$env:AI_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = 'your-key'
$env:ANTHROPIC_MODEL = 'an-explicit-model-id'
node server.mjs
```

The OpenAI bridge uses the Responses API with `store: false`; conversation
history stays in the local companion process. Web search is selected by the
model only when outside/current information is needed and adds cited URLs to
the answer. It can be disabled with `OPENAI_WEB_SEARCH=false`.

The Anthropic model is deliberately required instead of guessed. API keys stay
in the companion process and are never stored in the Unreal plugin.

Check the bridge:

```powershell
Invoke-RestMethod http://127.0.0.1:8142/health
```

The health response lists the solver tools the bridge will offer the model. Mock
mode runs the solvers too, so the deterministic analysis can be verified without
any API key.

## Outside references

Save state answers most questions. When one genuinely needs outside knowledge —
a mod's documented behavior, a patch change,
a community technique — the copilot searches, and by default it may only search
the sources that are actually authoritative for Satisfactory:

`satisfactorygame.com`, `questions.satisfactorygame.com`, `docs.ficsit.app`,
`ficsit.app`, `satisfactory.wiki.gg`, `satisfactory.fandom.com`,
`satisfactory-calculator.com`, `satisfactorytools.com`, `reddit.com`,
`steamcommunity.com`

On Anthropic this is enforced by the API through the search tool's
`allowed_domains`, so an answer cannot cite anything off the list while the
restriction is on. Pages used are cited under the reply. Three rules hold
regardless of provider: the live save always outranks any page, the solvers
outrank the model's own arithmetic, and a search failure is stated in the answer
rather than passed off as a complete result.

Override with `AIFACTORY_SOURCE_DOMAINS`, loosen with
`AIFACTORY_RESTRICT_SOURCES=false`, or turn searching off entirely with
`AIFACTORY_WEB_SEARCH=false` — the copilot then says search is off instead of
answering from memory as though it were verified.

Install the clean local runtime with `scripts/install-companion.ps1`. It copies
only the bridge runtime, verifies every copied file by SHA-256, registers a
restartable logon task, and waits for the health endpoint. The installed runner
selects Anthropic when both its key and an explicit model are configured,
OpenAI when its key is available, and mock mode otherwise. `AI_PROVIDER`
overrides the automatic choice. API keys are never copied into this repository
or its logs. See [docs/INSTALL.md](docs/INSTALL.md) for the exact behavior.

## Build the mod

This source targets:

- Satisfactory changelist `491125` or newer
- SML `3.12.0`
- the Coffee Stain `5.6.1-CSS` Unreal build used by the official Starter Project

Follow [docs/INSTALL.md](docs/INSTALL.md). A stock Epic Unreal installation is
not ABI-compatible with Satisfactory and must not be used to package the mod.

## Validate

```powershell
./scripts/validate.ps1
```

The companion tests can also be run directly:

```powershell
cd companion
npm test
```

## Design documents

- [Architecture](docs/ARCHITECTURE.md)
- [Installation and packaging](docs/INSTALL.md)
- [Compatibility contract](docs/COMPATIBILITY.md)
- [Current boundaries and roadmap](docs/ROADMAP.md)
- [Official documentation references](docs/OFFICIAL_REFERENCES.md)
