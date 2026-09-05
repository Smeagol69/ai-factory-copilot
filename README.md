# AI Factory Copilot for Satisfactory

AI Factory Copilot is an SML C++ mod plus a localhost companion process. The
mod reads authoritative runtime state from Satisfactory and sends a bounded,
evidence-bearing snapshot to a configurable AI provider. It never asks the
model to identify machines from screenshots or guess undisclosed game state.
For visual questions it can attach one recent bounded game frame to a declared
multimodal provider for appearance and architectural critique; actor identity,
recipes, rates, coordinates, unlocks, collision and writes still come only from
the snapshot, solvers and game-side readback.

This repository implements a working **AI co-player that can act**: it reads the
world, computes answers deterministically, and — when asked — changes the world
through server-authoritative actions the game itself executes and confirms.

The primary roadmap is now **AI Architect Mode**: describe a factory and theme,
see the solver-grounded whole-campus concept in the running game, revise it in
conversation, then hand the accepted revision to Satisfactory's native
Blueprint and Build Gun workflow. The first in-world semantic preview uses
exact `megabase.design/v1` transforms and never pretends its colored wireframes
are placement validation. The selected-revision promotion path now has
fail-closed native massing compilers for platforms, configured production
machines, modular facades/roofs, pylons, guarded skybridges, and landmark
towers; topology and packaged-game readback remain explicit readiness gates.
See [`docs/AI_ARCHITECT_MODE.md`](docs/AI_ARCHITECT_MODE.md).

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
- freshness-checked vision handoff: the game writes a bounded screenshot ring,
  the bridge rejects stale/incomplete/oversized frames, ignores sidecar paths,
  and uses native OpenAI/Anthropic image blocks only when the question is visual

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
| `inspect_blueprint_layout` | read-only decoded native `Build_*` classes, bounded saved transforms, recipe evidence, verified internal conveyor/pipe links, and verified physical native power-wire edges |
| `find_best_site` | ranks where to build, scoring resource access around every candidate |
| `get_unlock_status` | rendered HUD, objective, active milestone, game phase, recipe availability, schematics, and tech tier |
| `design_factory_layout` | a placeable layout fitted to this base, with exact coordinates |
| `find_belt_candidates` | recipe-compatible pairs of captured free conveyor ports, shortest first, with exact component paths |
| `plan_belt_route` | a direct conveyor route between two captured connection components |
| `plan_belted_module` | a compact two-phase miner-to-machine module using measured footprints |
| `design_megabase_concept` | AI Architect Mode concept: exact semantic campus transforms, design-family provenance, blockers, and optional draw-only in-world preview |
| `manage_architect_revisions` | save/session-scoped immutable Architect options: list, inspect, compare, redraw, select, roll back, report exact native-promotion/topology blockers, promote only a completely compiled selected revision through the existing native Blueprint transaction, or delete an unselected leaf draft |
| `perform_actions` | places, removes, moves, teleports — validated, then executed by the game |
| `highlight` | tracer lines and bounding boxes around anything, drawn in-world |
| `clear_highlight` | removes an overlay |

Siting questions are computed, not eyeballed. Ask *"where should I put the HUB?"*
and `find_best_site` scores every usable resource node as a candidate centre by
resource diversity, purity-weighted node count, coverage of the resources you
named, and distance cost — returning exact coordinates, the runners-up, and the
per-factor breakdown. Occupied nodes and hand-mined `Deposit` nodes are excluded,
because a miner cannot be placed on either.

Architect promotion now preserves exact production-step provenance, rates, and
internal material dependencies in the immutable manifest. Its first A4 topology
slice compiles direct one-to-one solid conveyor lanes and direct one-to-one
liquid/gas pipelines when machine counts and per-lane rates match. Conveyor
endpoints require one captured native factory connector plus observed unlocked
belt capacity. Fluid endpoints require one captured native pipe connector,
unambiguous recipe-to-fluid identity, and an unlocked pipe with captured flow
and hologram length limits. Any edge that needs a splitter, merger, lift,
junction, pump/head lift, bent route, guessed port, or unproved capacity blocks
the whole native Blueprint instead of disappearing from it.

Material flow is balanced before routing. Each planned producer's exact rate is
allocated among provenance-matched internal edges; any unsupplied consumer rate
is recorded as an external input, and every unconsumed intermediate or finished
product is recorded as an external output. Both sides must sum exactly to the
captured plan. A partial internal plus external feed is named as needing a real
merger or pipe junction, not wired onto one occupied machine port.

Powered Architect machine sets also pass through the existing deterministic
generated-Blueprint power planner. It accepts only one captured visible circuit
connector per powered class, compatible circuit types, captured link capacity,
and an unlocked wire with a captured maximum length. It then emits either a
capacity-safe native daisy chain or the smallest captured compatible pole trunk,
using transformed connector positions for length checks and reserving one link
for the player's external grid. Missing power evidence blocks promotion; the
reserved link is not presented as an already connected power source.

Saved blueprints can be inspected without placing them: ask *"inspect blueprint
<name>"* to decode native saved `Build_*` entities, their classes, a bounded
set of exact transforms, bounded exact reciprocal conveyor/pipe component
links, and bounded exact physical native power-wire endpoint pairs saved inside
the Blueprint. The aggregate link and wire counts still cover every decoded
supported record; malformed, unresolved, one-way, incomplete, and unsupported
references remain explicit instead of becoming a guessed route.
Only physical `mWires` endpoints are decoded; saved `mHiddenConnections` are
logical circuit relationships and deliberately do not become pretend wires.
When two saved blueprints share a display name, the blueprint list prints a
`blueprint_reference`; use that value instead of making the copilot guess. A
decoded layout does not infer item/fluid direction or rate, electricity
direction/load/capacity, destination terrain, Build Gun hologram validity, or
external connections.

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
| `generate_native_blueprint` | Converts a solver-computed relative factory layout into one native `.sbp` through a real empty Blueprint Designer, transient native staging, bounds validation, and game-side disk readback; initial v1 omits unproven transport/power/miner topology explicitly |
| `export_native_blueprint` | Packages the exact existing factory selection the player made into a native `.sbp`; this is capture, distinct from AI generation |
| `preview_blueprint` | Arms an active-session saved Blueprint in the requesting player's vanilla Build Gun without constructing or spending anything |
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

The native Creative Resource Node editor uses the same write switch. Once it
is enabled, `/ai node place copper ore pure` arms the normal Build Gun
hologram rather than directly spawning an actor. The spawner catalog also
supports registered liquid, gas, and geothermal geyser descriptors, while
leaving water-volume and fracking actors to their native extractor systems.
Aim at an existing Copilot-created node and use **Clone aimed** to arm an exact
copy, or **Remove aimed** twice within five seconds to remove that same node;
the latter refuses occupied nodes and every node the mod does not own. In
multiplayer, a Satisfactory server admin must arm or remove one; the resulting
recipe availability is a persistent world-level unlock, not a player
permission. See
[`docs/CREATIVE_WORLD_EDITOR.md`](docs/CREATIVE_WORLD_EDITOR.md) for the
current supported boundary and live-test status.

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

### Precision Frame for symmetrical building

The Insert panel can use any placed buildable as an exact local coordinate
frame. Aim at a Miner, machine, foundation, or other buildable and click **Use
aimed as origin**. Enter offsets as **X forward**, **Y right**, and **Z up** in
metres, plus yaw relative to the selected object's yaw. Click **Snap Build Gun**
only after the target is correct; the current native hologram locks to that
coordinate and stays there after the panel closes. **Mirror X**, **Mirror Y**,
and **±90** make matching opposite or quarter-turned modules without eyeballing
them. **Release Build Gun** returns the hologram to ordinary mouse placement.

Selecting an origin is inert and never moves an object. Precision Frame does
not construct anything for you or bypass a red hologram: Satisfactory still
performs its normal snapping, range, clearance, cost, multiplayer, and server
construction checks. The panel shows the requested world coordinate, actual
position/yaw error, and native valid/blocked result. A hologram that does not
support FactoryGame's lock-and-nudge contract is reported and left untouched.

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

For a placed native Blueprint, aim at its proxy or one of its actor-backed
members and ask `audit this blueprint`. The read-only audit reports a Resource
Anchor's saved resource/purity, exact server-side transient-node ownership and
occupancy, and only miners whose live extractor interface points to that exact
node. On a client, a transient node or binding that is not authoritative stays
**unknown**—it is never reported as missing or unbound. The audit does not
repair, rebind, place, or alter the Blueprint.

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

AI Architect briefs and revisions persist under
`%LOCALAPPDATA%\FactoryGame\Saved\AIFactoryCopilot\Architect`. Set
`AIFACTORY_ARCHITECT_STORE` to an explicit directory to move that metadata, or
to `off` to disable disk persistence. The store filename is a digest; the
scope inside it is the exact map, save session, and stable player chat session.
This metadata is separate from native `.sbp`/`.sbpcfg` files and deleting a
draft cannot delete a Blueprint or placed actor.

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
