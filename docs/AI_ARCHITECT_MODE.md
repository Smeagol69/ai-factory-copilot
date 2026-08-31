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
- stale world or unlock fingerprints force re-planning before promotion;
- option A/B/C and rollback to an earlier revision are explicit;
- deleting a draft never deletes a native Blueprint or placed factory.

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

### A4 — Working-factory topology

Production machines, splitters/mergers, conveyors/lifts, pipes/junctions/pumps,
power, walkways, entrances, vertical circulation, resource anchors, and external
I/O are routed from captured native connectors and capacities. Terrain and
clearance evidence is recalculated at the destination immediately before native
Blueprint generation.

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

- The draw-only semantic preview compiler and game overlay are the Codex lane.
- The selected-manifest to generated native Blueprint and Build Gun hologram is
  the requested Claude lane.
- Both consume `megabase.design/v1`; neither rewrites the other's output.
- Production/topology work already claimed on
  `codex/generated-blueprint-two-stage-wire` remains independent and should be
  merged through `master` before Architect topology consumes it.
