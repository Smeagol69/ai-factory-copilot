# AI Architect Mode

AI Architect Mode is the primary product roadmap for AI Factory Copilot. It is
the path from "the assistant can calculate a factory" to "a second player can
design a beautiful, efficient campus with me, show it to me, revise it, and hand
it to Satisfactory's native Build Gun."

## Player experience

The intended flow is conversational:

1. Aim at a site and ask for a goal, for example: "Design a compact cyberpunk
   240 Wire/min factory here using what I have unlocked."
2. Architect Mode captures the exact site, resources, unlocks, recipes, machine
   dimensions, existing structures, terrain evidence, and design-family input.
3. It produces one or more named revisions. Each revision has immutable solver
   provenance and a human creative brief.
4. The selected revision appears in the world before construction. Production
   halls, platforms, glass, roofs, supports, bridges, and the landmark tower are
   visually distinct. The preview says exactly which requirements remain
   unresolved.
5. The player can say "make the tower shorter", "hide the belts", "match this
   building", "separate it into two startup phases", or "show option B". A new
   revision is compiled; the old one remains available for comparison.
6. Once every required topology and game gate passes, the selected revision is
   written through the native Blueprint Designer serializer, registered in the
   active save, and armed as Satisfactory's real Build Gun hologram.
7. The player still moves, rotates, snaps, inspects cost, and clicks to build.
   The game remains the only authority that can construct it.

## Non-negotiable truth boundaries

- A model may choose theme, hierarchy, symmetry, facade rhythm, tower emphasis,
  and other bounded creative parameters. It may not invent recipes, class
  paths, unlocks, dimensions, coordinates, terrain, capacity, or connectivity.
- Every number that a deterministic solver can provide comes from that solver.
- Unknown stays unknown and blocks construction when it affects correctness.
- A semantic preview is not a native hologram. A native hologram is not proof
  that every internal production route works. Each stage reports its own exact
  evidence and remaining blockers.
- Pixels can critique appearance but never identify an actor, rate, recipe,
  coordinate, unlock, collision, or write target.
- Only the game writes the save and reads the result back.

## Delivery milestones

### A1 — Whole-campus semantic preview

Input is one valid `megabase.design/v1` manifest. A private deterministic
adapter carries only its exact world transforms into a bounded draw-only game
action. The game repeats schema, fingerprint, style, element-kind, count,
identity, transform, and module checks before drawing Shipping-safe oriented
wireframes. This preview changes no save state, consumes no materials, and can
be replaced or cleared by name.

Acceptance:

- all supported manifest elements are visible at their exact yaw and size;
- semantic categories use a stable color legend and multi-floor volumes show
  their floor divisions;
- malformed, oversized, duplicated, unsupported, or provenance-free input is
  refused whole;
- the action is absent from the model's generic world-write tool;
- the game reports the exact element and line counts it actually drew.

### A2 — Briefs, revisions, and variants

An Architect session stores the goal, chosen site, constraints, captured
revision/unlock/style fingerprints, unresolved blockers, and immutable design
revisions. "Change" creates a child revision; it never silently rewrites the
accepted one. Comparison reports geometric, production, topology, cost, and
style deltas from exact manifests.

Acceptance:

- revisions survive bridge restarts and are scoped to the save/session;
- stale relevant-world semantic or unlock fingerprints force re-planning before promotion;
- option A/B/C and rollback to an earlier revision are explicit;
- deleting a draft never deletes a native Blueprint or placed factory.

Implemented companion checkpoint (2026-08-31):

- `design_megabase_concept` can preserve its exact compiled manifest and exact
  deterministic design request under a named Architect session;
- revisions are immutable and content-addressed, carry an explicit label and
  parent, and persist per exact map/save/player chat scope;
- `manage_architect_revisions` lists, retrieves, compares, redraws, selects,
  rolls back, and deletes only an unselected leaf draft. Redraw recompiles and
  revalidates the stored option before emitting the same private draw-only
  preview, and does not change the selected revision;
- selection recompiles the stored design request from the current full graph
  and requires the same semantic manifest, design-family, and unlock
  fingerprints. Global `world_revision` drift is reported rather than refused
  because belt traffic changes it continuously; changed relevant solver output
  or unlock evidence refuses selection and requires a child revision;
- comparisons report bounded exact geometry, production-program, connection,
  style, and blocker deltas. Native Blueprint cost remains explicitly unknown
  until A3 supplies a verified native cost;
- the JSON store is size-bounded, written through a temporary file, validates
  every content address on load, and refuses corrupt or tampered data without
  overwriting it.

### A3 — Selected revision to native Build Gun hologram

The selected manifest is resolved to captured available build recipes and
compiled into the existing generated native Blueprint contract. The game stages
it through the real Designer/serializer, reconstructs it in the isolated
Blueprint world, requires exact contents/topology readback, refreshes the active
save descriptor registry, and hands it to the player's native Build Gun.

Acceptance:

- one accepted Architect revision produces one verified `.sbp`/`.sbpcfg` pair;
- no dimension cap or vanilla Designer capture restriction is reintroduced;
- the active save recognizes the descriptor before the client handoff;
- the player sees the normal move/rotate/snap/cost/confirm experience;
- failure leaves no partial world construction and reports the exact gate.

Promotion-adapter checkpoint (2026-09-01):

- `manage_architect_revisions promotion_status` now reloads and deterministically
  recompiles the exact stored revision, requires it to be the session's selected
  revision, repeats the immutable manifest and current unlock-fingerprint gates,
  and reports every semantic role or element that still lacks an exact native
  placement adapter;
- `promote_selected` additionally requires an explicit `commit:true`. It emits
  no action unless the entire selected manifest compiles. When it does, the
  result is passed unchanged into the existing standalone
  `generate_native_blueprint` transaction; Satisfactory still stages, measures,
  serializes, reloads, checks contents/topology, refreshes the active registry,
  and reports the real outcome;
- `structural_platform` elements become exact Foundation cells only when the
  selected recipe is currently captured and unlocked, belongs to the Build Gun,
  resolves to a captured building class, carries positive parseable descriptor
  dimensions, and its width exactly equals the manifest grid. Raised slabs are
  top-aligned to their semantic deck so the next floor starts on their proven
  thickness. The adapter does not impose a Designer dimension cap;
- `production_zone` now has an exact machine-population adapter too. Each
  production group retains its deterministic selected production recipe in the
  immutable manifest; promotion rechecks its Build Gun recipe, building class,
  production recipe unlock and machine compatibility, measured three-axis
  footprint, integer grid footprint, count, and fit inside the semantic hall.
  It then emits exact configured-machine transforms centred in that hall. This
  is contents only: it still claims no belt, pipe, power, or commissioning
  connectivity;
- all current massing kinds now have fail-closed native adapters. Glazed
  facades stack exact matching wall/window vertical modules; roofs tile the
  selected grid-width roof; pylons stack exact height divisors; skybridges are
  restricted to one-cell-wide orthogonal segments with an exact walkway and
  two rail lines; landmark towers repeat exact Foundation floors and matching
  wall/window perimeter modules. Any missing recipe, unlock, building class,
  positive descriptor dimension, grid divisibility, footprint fit, or semantic
  compiler still blocks the entire revision;
- lighting is explicitly optional visual polish because its native attachment
  contract is not yet compiled. No light is silently promised or required for
  an otherwise exact shell. Belts, lifts, pipes, pumps, power, entrances,
  vertical circulation, resource/external I/O, and commissioning remain A4
  topology and operational-readiness work, so A3 never calls the shell a
  working factory;
- a whole-campus revision can now reach the existing native transaction only
  when every required live part selection satisfies those exact checks. This
  has companion test coverage, but the resulting large `.sbp` and Build Gun
  hologram still require packaged-game readback and visual verification before
  A3 is called live-certified. After verified native file readback, the existing
  `preview_blueprint` handoff arms that exact descriptor in the player's normal
  Build Gun.

### A4 — Working-factory topology

Production machines, splitters/mergers, conveyors/lifts, pipes/junctions/pumps,
power, walkways, entrances, vertical circulation, resource anchors, and external
I/O are routed from captured native connectors and capacities. Terrain and
clearance evidence is recalculated at the destination immediately before native
Blueprint generation.

Direct-conveyor checkpoint (2026-09-01):

- immutable Architect production groups now retain their exact solver-selected
  step/recipe/item identity, machine-exact count, per-machine output, required
  inputs, and recursive production chain. The manifest deterministically derives
  every unambiguous internal material dependency and separately records external
  inputs; ambiguous producers invalidate the manifest;
- selected-revision promotion must compile every internal material edge. The
  first accepted subset is one direct solid conveyor per paired producer and
  consumer machine when both groups have equal integer/full-utilisation counts,
  the edge rate divides into the exact producer output rate, each captured
  machine class exposes exactly one native output/input connector, and the
  current graph proves an unlocked Build Gun conveyor with sufficient capacity
  observed on a captured live instance;
- each proposed direct lane transforms the captured connector locations and
  normals by the exact generated machine transforms and repeats the native
  serializer's straight-alignment threshold. A diagonal or vertically offset
  pair is reported as needing an explicit multi-leg route before a file action
  can exist;
- accepted lanes use the existing `aifactory.generated-blueprint/v2` step and
  connector contract. The existing action validator rechecks both endpoint
  classes, exact native component names, direction, unconnected state, relative
  endpoints, and conveyor recipe before Satisfactory stages and reads the native
  topology back;
- a needed splitter/merger, lift, fluid path, clocking/balancing step, reused or
  ambiguous connector, or unknown capacity blocks the complete native action.
  No dependency is silently dropped. External input/output routing, power
  generation/external feed, circulation, commissioning and destination
  terrain/clearance remain open, so
  this checkpoint still reports `operational_readiness.ready = false`.

Internal-power checkpoint (2026-09-03):

- every configured production-machine action is passed through the existing
  deterministic generated-Blueprint power planner. Each exact buildable class
  must expose one visible captured native circuit connector with a non-empty
  component name, circuit type, link capacity, and class-default position;
- a currently unlocked Build Gun wire must expose a captured maximum length.
  Length preflight transforms each connector position by its exact generated
  actor transform, matching what the native staging world will measure;
- compatible machines use a direct capacity-safe native daisy chain where
  possible. Otherwise an unlocked captured ground pole with a compatible
  circuit type and sufficient captured capacity is added as a minimal trunk.
  One link on the first endpoint remains reserved and explicitly reported for
  the player's live external grid;
- physical edges compile through the existing generated-Blueprint v2 power
  contract and still require native isolated-world wire/link readback. Missing
  connector, type, capacity, position, wire, range, or pole evidence blocks the
  whole selected revision. Internal distribution is not generation and the
  reserved external link is not called connected, so operational readiness
  remains false.

Direct-fluid checkpoint (2026-09-03):

- the exact item form partitions every retained internal dependency into a
  solid conveyor edge or a liquid/gas pipeline edge. An unknown form refuses
  promotion, and the combined compilers must account for every edge exactly
  once;
- a fluid edge compiles only for equal fully utilised producer/consumer groups
  whose per-lane rates match in m³/min and whose selected recipes each expose
  exactly one matching fluid product/input. This prevents a multi-fluid recipe
  from being assigned to a pipe port by position or guesswork;
- both machine classes must expose one usable captured native producer/consumer
  pipe connector with an exact component name, class, default location, and
  normal. The selected unlocked pipeline must expose its class-default
  `GetFlowLimit()` plus native hologram minimum and maximum length;
- transformed endpoints must fit that captured length range and the native
  straight-route alignment threshold. Accepted links compile through generated
  Blueprint v3 and still require Satisfactory's reciprocal isolated-world pipe
  readback. Pumps, head lift, junctions/manifolds, bends, and external fluid I/O
  remain blocked, so internal pipe generation is not a commissioned fluid
  system.

Material-I/O accounting checkpoint (2026-09-03):

- producer output is now a finite budget. A provenance-matched internal edge
  receives at most the producer's remaining planned rate, so existing-base
  surplus used by `plan_production` cannot be relabeled as output from a newly
  planned machine group;
- every remaining consumer demand is an explicit `external_input`, and every
  unconsumed intermediate or final product is an explicit `external_output`.
  Manifest validation requires the internal and external rates to sum exactly
  for every input and output item;
- external I/O obligations are reported in promotion readiness and remain part
  of the immutable manifest fingerprint. They are not silently treated as
  routed. A consumer that needs both an internal lane and an external supplement
  is blocked until a real merger or fluid junction is compiled.

Acceptance:

- every requested output and commissioning phase re-solves exactly;
- no port is reused and every saved internal connection reads back reciprocal;
- belt/pipe/power capacity and head-lift unknowns fail closed;
- unlocked parts and recipes are rechecked immediately before generation;
- post-placement auditing can distinguish working, pending, and broken links.

### A5 — Style intelligence and visual refinement

An explicitly selected Blueprint or factory region becomes a design-family
reference. Structural parsing supplies exact reusable vocabulary; bounded
screenshots supply non-authoritative visual critique. Architect revisions carry
the family fingerprint so "match this base" cannot silently drift.

Acceptance:

- style reference selection is visible and reversible;
- exact part/spacing/topology evidence is separated from visual observations;
- missing captured parts cause substitution proposals, never invented classes;
- related buildings can prove they share the same family fingerprint.

## Follow-on feature tracks

### Efficiency Vision

Map deterministic bottleneck, utilization, standby, capacity, and power results
onto live overlays. Use stable thresholds, refresh only after relevant world
changes, and report snapshot age. This later becomes Architect Mode's diagnosis
and commissioning view.

### Physical Copilot Drone

Create an optional companion actor that follows without blocking construction,
speaks through the existing grounded response path, and projects waypoints or
overlays. It must never become an authority, collide with builds, reveal hidden
map information, or spam observations.

### Style Cloning and Factory Beautifier

Style Cloning creates a design-family reference. Beautifier takes an explicit
selection, preserves its production contract, generates a parallel replacement
revision, and previews the delta. It never dismantles the source as a side
effect of designing.

### Cinematic Tour Mode

Generate a bounded camera spline and narrated stops from verified structure and
topology. The route is previewed and cancelable, avoids taking control during
combat/building, and never modifies factory state.

### What-if Mode

Fork an Architect revision with a changed rate, tier, recipe, footprint, phase,
or style constraint. Re-run exact solvers and show the bill-of-materials,
machine, route, footprint, power, and unresolved-gate delta.

### Construction Missions

Compile an accepted revision into ordered stages with required materials,
waypoints, safe dependencies, and game-read completion. A mission can pause,
resume, or re-plan after world drift; it never claims a stage complete from the
plan alone.

### Factory Personality

Profiles affect tone, interruption threshold, aesthetic preferences, and how
alternatives are presented. They cannot alter solver output, hide unknowns,
weaken write gates, or convert previews into permission.

## Claude/Codex collaboration seam

- Both agents coordinate through `docs/ai-collaboration.md` and `master`; neither
  relies on private chat state.
- The draw-only preview, immutable revision store, and fail-closed native
  promotion adapter all consume the same `megabase.design/v1` manifest and keep
  its fingerprints intact.
- Existing generated-Blueprint serialization and topology primitives remain the
  shared authority boundary. Architect extensions call those proven contracts
  instead of creating a parallel writer.
- A4 production/topology work must be claimed before editing and merged through
  `master` so a belt, pipe, or power compiler cannot silently diverge from the
  existing game-side readback rules.
