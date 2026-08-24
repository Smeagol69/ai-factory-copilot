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
| `get_factory_summary` | captured actors, buildable types, machine states, transports, resources, and owner mods, with scan-scope caveats |
| `get_machine_rates` | exact per-minute inputs and outputs per machine |
| `get_item_balance` | production versus consumption per item, with surplus/deficit |
| `find_recipes` | recipes producing or consuming an item, ranked by rate |
| `get_transport_capacity` | belt and pipe capacity against supply and demand |
| `get_power_circuits` | capacity, headroom, fuse state, battery runtime |
| `diagnose_bottlenecks` | why a machine is stopped, and the upstream root cause |
| `get_build_cost` | construction cost against captured player inventories |
| `plan_production` | designs a line for a target item and rate, against this base |
| `list_blueprints` | saved blueprints: dimensions, cost, contents, and whether you can afford them |
| `inspect_blueprint_layout` | read-only decoded native `Build_*` classes, bounded saved transforms, recipe evidence, and verified internal conveyor/pipe component links |
| `find_best_site` | ranks where to build, scoring resource access around every candidate |
| `get_unlock_status` | rendered HUD, objective, active milestone, game phase, recipe availability, schematics, and tech tier |
| `design_factory_layout` | a placeable layout fitted to this base, with exact coordinates |
| `find_belt_candidates` | recipe-compatible pairs of captured free conveyor ports, shortest first, with exact component paths |
| `plan_belt_route` | a direct conveyor route between two captured connection components |
| `plan_belted_module` | a compact two-phase miner-to-machine module using measured footprints |
| `perform_actions` | places, removes, moves, teleports — validated, then executed by the game |
| `highlight` | tracer lines and bounding boxes around anything, drawn in-world |
| `clear_highlight` | removes an overlay |

Siting questions are computed, not eyeballed. Ask *"where should I put the HUB?"*
and `find_best_site` scores every usable resource node as a candidate centre by
resource diversity, purity-weighted node count, coverage of the resources you
named, and distance cost — returning exact coordinates, the runners-up, and the
per-factor breakdown. Occupied nodes and hand-mined `Deposit` nodes are excluded,
because a miner cannot be placed on either.

Saved blueprints can be inspected without placing them: ask *"inspect blueprint
<name>"* to decode native saved `Build_*` entities, their classes, a bounded
set of exact transforms, and bounded exact reciprocal conveyor/pipe component
links saved inside the Blueprint. The aggregate link counts still cover every
decoded supported connection record; malformed, unresolved, one-way, and
unsupported references remain explicit instead of becoming a guessed route.
When two saved blueprints share a display name, the blueprint list prints a
`blueprint_reference`; use that value instead of making the copilot guess. A
decoded layout does not infer item/fluid direction or rate, power wiring,
destination terrain, Build Gun hologram validity, or external connections.

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
  -Headers @{ 'X-AIFactory-Schema' = '1' } `
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
| `give_item` | Adds a validated catalog item to the player's inventory; creative, write-gated, and reversible |
| `waypoint` / `clear_waypoints` | Adds or removes only the copilot's persistent map markers; each marker label tracks the live player distance |
| `highlight` / `clear_highlight` | Tracer lines and bounding boxes drawn in-world, visible through terrain |

Six gates stand between a model deciding something and the world changing: an
exact bridge-version and action-contract match, server authority, a mandatory
captured world-revision stamp with optional strict unchanged-world enforcement,
per-action validation on both sides, the mod's own `allowWriteActions` switch,
and `commit: true` on the action itself. The model
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

Direct belts can now be routed between two already captured connection
components, and `plan_belted_module` lays out a compact two-phase machine chain:
place the machines first, recapture their actual snapped connectors, then route
the belt legs. General obstacle-aware belts, pipes, and power poles are not yet
routed. The layout leaves a foundation-wide aisle between rows for that work.

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
/ai anchor <resource> [impure|normal|pure]
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

### Experimental Blueprint Designer miners

Stock Blueprint Designers have no resource node inside their volume, so a
normal Miner hologram has nothing valid to attach to. The experimental
`/ai anchor copper pure` command arms a **Blueprint Resource Anchor** in your
normal Build Gun. Place that anchor inside a native Designer, then place a
Miner Mk.1–Mk.3 on its visible node using the ordinary Miner hologram. The
anchor records the exact miner relationship so it can rebuild that same node
when the Blueprint is reopened or placed. Save the Blueprint only after the
Miner has visibly snapped: the anchor records bindings by reading the exact
native extractor-interface relationship at Satisfactory's archive boundary,
not by guessing from distance or a class name.

It does not make an extractor free-form: the game still owns its normal
resource, occupancy, cost, snapping, and construct-disqualifier checks. Pumps,
oil/fracking extractors, modded extractors, and portable miners remain outside
this narrow experimental path. The source compiles and has regression coverage,
but this feature is not yet release-certified until its disposable native
Blueprint save/reload/placement and host/client test matrix is completed.

## Saving and replaying a layout

Mark buildings with the dismantle tool, then name them. The selection is what
gets saved — a radius is offered as a fallback, but marking is the player saying
exactly which ones.

```text
save this as mk1 copper
place mk1 copper on this node
place mk1 copper here rotated 90
list designs
rename mk1 copper to copper starter
delete the copper starter design
```

A saved design keeps the exact distances between buildings, each facing, and
each machine's production recipe. Placing on a resource node attaches any
extractor in the design to *that* node and re-anchors everything else on it, so
the arrangement stays rigid rather than shearing. Adding `rotated 90`,
`turned right` or `half turn` turns the whole thing about its anchor, the way
a vanilla blueprint turns under the build gun.

Housekeeping moves rather than deletes: a retired design goes to a 
`retired` folder beside the others, timestamped, and the reply gives you the
path. Nothing here unlinks a file.

What it does not replay, and says so rather than quietly dropping:

- **Belts, lifts, pipes and power lines.** Each is defined by two connection
  components rather than a coordinate, so replaying one from a saved offset can
  only be refused. They are recorded on the design and left for you to run.
- **Overclocking.** Nothing here can spend a Power Shard, so an overclocked
  machine rebuilds at 100%. The rate is saved for when it can.

This is not a `.sbp`. The stock Blueprint Designer has no resource target for
extractors and caps the volume, which is exactly the case a saved design exists
for. The experimental Blueprint Resource Anchor above is the narrow native
exception for Miner Mk.1–Mk.3; anything else that fits a designer and has no
miner in it is better off as a real blueprint.

### The library page

The panel has a **Library** button, and the bridge serves the same page at
<http://127.0.0.1:8142/library>. It lists every saved design and every `.sbp`
the game knows about, with what each is made of, its footprint, and a copy
button for the phrase that places it — including turn buttons for 90°, 180° and
270°. Type `/` to search, `Esc` to clear. It refreshes itself while open.

## Start the companion

Node.js 20 or newer is required. The packaged mod carries its lock-pinned
production dependencies, so a normal SML install does not need an `npm` step.
For a source checkout, run `npm ci` once in `companion/` (the validation and
Starter Project install scripts do this automatically) before starting it by
hand.

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
than passing them off as computed. Ollama's default endpoint also disables Qwen's
hidden reasoning for these dispatch turns so it cannot consume the completion
budget before emitting a tool call. Set `LOCAL_AI_REASONING_EFFORT=omit` for a
different OpenAI-compatible gateway that rejects that field.

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
`satisfactory-calculator.com`, `satisfactorytools.com`,
`factoriolab.github.io`, `manifolder.app`, `steamcommunity.com`

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
or its logs. A local `.env` in the installed companion is the final authority,
so the scheduled task always uses the provider the player deliberately chose.
See [docs/INSTALL.md](docs/INSTALL.md) for the exact behavior.

Configure a hosted key without placing it on the command line or in shell
history:

```powershell
./scripts/configure-companion.ps1 -Provider openai
```

## Build the mod

This source targets:

- Satisfactory changelist `502094` (rebuild against matching headers after a game update)
- SML `3.12.0`
- the Coffee Stain `5.6.1-CSS` Unreal build used by the official Starter Project

The `1.0.0-beta.2` package is a Windows-client public beta. It does not claim
dedicated-server or Linux compatibility until those targets pass the live test
matrix. See [CHANGELOG.md](CHANGELOG.md) for the remaining beta limits.

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
- [Planning and transport references](docs/PLANNING_REFERENCES.md)
