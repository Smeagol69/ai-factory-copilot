# Current boundaries and roadmap

## Implemented through 0.2.0

- authoritative registry and live-world scanner
- exact player pawn/control/camera transforms
- authoritative cached interaction hit plus camera-trace fallback
- deterministic player-relative distances and preferred-target grounding
- mod ownership and compatibility metadata
- discovery of otherwise-unclassified mod-owned actors
- live revision/fingerprint observer
- snapshot export
- Insert-toggled conversation UI and natural `/ai` chat commands
- provider-isolated AI conversation
- local multi-turn history, reset, and optional cited OpenAI web search
- strict unknown and omission handling
- custom-mod data-provider interface

## Implemented in 0.3.0: deterministic analysis

The model no longer performs factory arithmetic. It calls solvers, and the
solvers run on the same compacted snapshot the model was shown, so a tool result
can never describe data the model was not given.

- cached production graph (`companion/lib/graph.mjs`): component-path to actor
  resolution, belt/pipe/power topology, transport chain tracing with the
  narrowest segment on each path, and explicit cycle reporting
- exact per-minute transformation solver from each machine's live cycle time,
  with production boost applied to products only and observed output scaled by
  reported productivity
- registry-unit handling for liquids and gases, so recipe amounts can be
  compared with pipeline flow limits
- recipe-selection constraints, ranked by output rate, with in-world usage as
  availability evidence
- conveyor and pipeline capacity graph with supply, demand, utilisation, and
  over-capacity/under-supply findings
- power-circuit graph with headroom, fuse state, and battery runtime at the
  current deficit
- starvation and blockage root-cause analysis that classifies every cause as
  invalid, inefficient, or unknown and walks upstream to the machine that
  actually has to change
- construction-cost checks against captured player inventories
- site selection: ranks build locations by surrounding resource access, with
  occupied and hand-mined nodes excluded and terrain declared unknown
- nine solver tools exposed to both providers, with bounded tool results that
  report their own truncation
- `POST /v1/analyze` for the whole solver report with no model involved
- mock mode runs the solvers, so their output is verifiable without an API key

## Implemented in 0.3.0: chat, reasoning, and cited sources

- multi-line in-game input: type a question in your own words, Enter sends,
  Shift+Enter adds a line, with a live elapsed indicator while the answer is
  being worked out
- the system prompt maps casual, partial, and misspelled wording onto real class
  and recipe names instead of asking the player to rephrase
- adaptive thinking requested explicitly, with `max_tokens` raised to match
  because thinking is drawn from the same budget
- web search restricted to the official wiki, modding docs, and forums, enforced
  through the search tool's `allowed_domains` where the provider supports it
- cited pages appended to the in-game reply; a failed search is stated rather
  than passed off as a complete answer
- paused search turns resumed instead of returned half-finished

### Known snapshot gaps

These are the places the current scanner cannot answer, and each is reported as
an explicit unknown rather than estimated:

| Gap | Effect | Accessor to add |
|---|---|---|
| Schematic-to-recipe unlock mapping | Recipe and build availability is unknown | `AFGRecipeManager` available-recipe accessor |
| Extractor per-cycle yield | Extractor rates depend on `mItemsPerCycle` surviving reflection | Explicit field on `AFGBuildableResourceExtractor` |
| Generator fuel consumption | Generators have no derivable input rate | `AFGBuildableGeneratorFuel` fuel accessors |
| Pipeline head lift and pressure | Elevation-related fluid faults cannot be confirmed or ruled out | `AFGBuildablePipeline` head-lift accessors |
| Per-item inventory capacity | Output blockage is inferred from status plus belt backup, not from a full-inventory fact | Inventory slot-limit accessors |

Each needs a small addition to `AIFactorySnapshot.cpp` and must be verified
against the exact Starter Project headers before use.

## Next: spatial planning

Site selection landed in 0.3.0 as the first piece: `find_best_site` scores every
usable resource node as a candidate centre by resource diversity, purity-weighted
node count, required-resource coverage, and distance cost, excluding occupied
nodes and hand-mined `Deposit` nodes. It answers "where should the HUB go" with
exact coordinates and an auditable breakdown.

What it deliberately does not claim: terrain slope, obstructions, buildable
footprint, and water access are absent from the snapshot and are returned as
explicit unknowns. Closing that needs `LineTraceSingleByChannel` terrain sampling
in the scanner, which is the real blocker for the rest of this stage.

Remaining:

- terrain and obstruction sampling (blocks everything below)
- foundation-grid coordinate system
- building clearance extraction
- connection-port transforms
- belt/pipe route generation
- layout objective profiles
- future expansion reservations
- exact hologram-based placement validation

## Done: controlled building

- typed action schemas — `companion/lib/actions.mjs` and `AIFactoryActions.cpp`
- per-action server authority — refused outright on a client
- stale-revision rejection — `expect_world_revision` on any action
- explicit player approval — `allowWriteActions`, off by default, mod-side
- construction through normal FactoryGame systems — `BeginSpawnBuildable` with
  the build recipe bound, and `LoadStoredBlueprint` for blueprints
- read-back verification — results report where the building actually landed
  and how far that is from the request
- recoverable failure handling — a plan stops at its first failure and reports
  the remainder as skipped, rather than half-building a layout

Material and unlock validation is **not** done: cost is priced against captured
inventories before the fact, but the game's own construction is what enforces it.

## Done: in-world overlays

- tracer lines, bounding boxes, and pillars via `ULineBatchComponent`
- live query resolution against actors, not the snapshot
- per-overlay batch ids so one can be cleared without disturbing the others

## Next: connections in the designer

`design_factory_layout` places machines and leaves a foundation-wide aisle
between rows. What remains:

- belt and pipe route generation between connection components
- conveyor pole and power pole placement
- layout objective profiles
- exact hologram-based placement validation

## Later: AI blueprint compiler

Placing a blueprint is done. *Writing* one is not:

- Blueprint Designer volume and object-limit model
- modular blueprint partitioning
- connection boundary ports
- preflight validation
- designer population
- saved blueprint read-back verification

The solvers are covered by unit tests against a synthetic snapshot and have been
spot-checked against a real 4.9 MB capture. The belt-speed convention and
extractor reflection still need confirming against a built-up save; the current
capture is a fresh start with nothing constructed.
