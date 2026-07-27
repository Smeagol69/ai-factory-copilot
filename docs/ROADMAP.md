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

## Next: construction observer

- versioned plan records
- expected-versus-actual transforms
- invalid versus inefficient deviation classification
- revised plans after player changes
- in-world colored preview actors and arrows

## Later: controlled building

- typed action schemas
- per-action server authority
- stale-revision rejection
- material and unlock validation
- explicit player approval modes
- construction through normal FactoryGame systems
- read-back verification and recoverable failure handling

## Later: AI blueprint compiler

- Blueprint Designer volume and object-limit model
- modular blueprint partitioning
- connection boundary ports
- preflight validation
- designer population
- saved blueprint read-back verification

No write stage should begin until the read-only scanner and the solvers pass
representative vanilla and modded save tests. The solvers are covered by unit
tests against a synthetic snapshot; they have not yet been run against a real
save, and the belt-speed convention and extractor reflection in particular need
confirming there first.
