# AI Architect: measured designs that fit

The owner's target is an attractive, useful Satisfactory build that fits its
actual site. A model's plausible drawing, a compilable Blueprint and a building
that the game permits are different kinds of evidence. Track them separately.

## Verified foundation, 2026-10-16

- Claude implemented the structural adapter; Codex integrated immutable save,
  compare, select, rollback and promotion. Independent exact-source review
  approved both stages. The companion suite passes 1,276 tests.
- Structural requests need no fictitious production item or rate. Exact recipes,
  measured piece geometry, pivots and unlock evidence bind a revision. Changing
  geometry or unlocks invalidates promotion; ordinary global revision drift
  alone does not. Production revision IDs remain unchanged.
- The canonical companion is bundled here, with the reviewed changes deployed
  from game commit `3997694543047b2f23f953cfbc45745326b2d16b`. One launcher
  starts/reuses the app and its hidden companion. Game-owned metadata and the
  shared credential/coordination stores retain their existing locations.
- An actual saved whole-world capture from October 11 supports an eight-piece
  concrete shell. It is stale, revision 2058, with 5,160 captured actors. This is
  offline evidence. No new construction or loaded-world check is claimed.
- The lab's new geometry audit checks measured rectangular boxes with oriented
  separating axes and a stated 1 cm tolerance. Touching faces, a 10 cm overlap
  and rotated separated beams have hand-computed tests. This diagnostic does
  not certify exact meshes, terrain, native placement or walking access.

## The implementation path

### 1. Build a measured piece library

Extend the existing captured catalog, structural compiler and native staging
readback instead of replacing them. A usable asset needs its recipe/unlock,
native class, transform convention, local pivot, measured shape/clearance,
supported rotations and relevant snapping/connection rules. Store provenance,
game/mod version and uncertainty beside each measurement.

Add adapters for doors, ramps, beams, pillars, roofs and decorations one family
at a time. Unsupported curved, tilted or offset shapes stay unknown until the
game measures them. Never treat a descriptor name or a screenshot as a pivot.

### 2. Capture a site, not only an inventory of actors

Create a site contract with an explicit origin/frame, destination transform,
fresh capture identity, preservation list and reserved spaces. Combine existing
actor/connector data with local ground, ceiling and obstruction probes. Existing
nearby/whole-world scan coverage is not proof that a cave's collision surface
has been measured. Unstreamed geometry and gaps must remain visible.

Reserve entrances, walking routes, stairs, doors, belt/pipe corridors and machine
service space before decoration. Keep the original machines and live transport
unless the owner's task actually asks to change them. Re-probe the selected
destination before construction; a stale map cannot certify current fit.

### 3. Generate functional alternatives with a deliberate style

Turn the brief into required rooms, routes, capacity and preservation constraints.
Use deterministic solvers for production, dimensions, spacing and transforms.
Generate a small bounded set of alternatives, then compare explicit criteria:
access, production correctness, site fit, construction cost and the selected
style. There is no unqualified mathematical "best-looking Blueprint."

For aesthetics, use a coherent material palette, repeated structural bays,
aligned seams, consistent trim, intentional openings, lighting and restrained
decoration. Evaluate real previews from known viewpoints when available. A
missing image or unmeasured prop must not become an invented visual score.
Save alternatives as revisions so the user can see differences and recover an
earlier option without another model rebuilding the same work.

### 4. Separate fit checks from permission to construct

Check internal measured geometry, support/alignment, reserved routes and nearby
obstructions first. Report suspected penetration with part IDs and dimensions.
The current native generator deliberately accepts structural contacts; its
success does not mean every structural overlap is aesthetically acceptable.

Then use the real game's Blueprint/building holograms at the actual destination.
Record every hard and soft disqualifier. A game setting allowing an overlap is
not proof that it meets this task's no-clipping requirement. Keep the existing
explicit clearance-override feature working for older workflows, but do not
silently use it to pass an Architect fit check. Native APIs must be verified in
the exact installed headers and compiled before any C++ extension is deployed.

### 5. Construct, inspect, and retain the result

On a separate test save, stage the selected native Blueprint, verify serialized
parts and transforms, preview it, and construct through the mod's authoritative
action path. Read back actual classes, locations, rotations, connections and
action outcomes. Compare against the requested revision using documented
tolerances; inspect the entrance/walking route and real viewpoints as well.

Keep reversible operations in the existing undo transaction. Treat irreversible
dismantling separately. Failed checks should identify the offending part/site
and trigger a bounded repair of the same revision lineage, not an endless new
conversation. Current schema-v1 structural serialization has narrower evidence
than the later native topology paths; exact per-piece readback remains to prove.

## The next acceptance milestone

One concrete entrance shell at a measured test site: foundations, correctly
aligned walls, an open walking route and a saved native Blueprint. Completion
requires exact part/transform readback and a destination clearance result, plus
visible before/after evidence. The October 11 offline draft does not satisfy it.
Decoration and a full cave interior follow after this narrow loop is reliable.

Claude can author adapters/design logic, Codex integrates and verifies, and
Google supplies independent acceptance cases or critiques. These are roles for
explicit bounded jobs, not a claim that all models are continuously running.
The successful Google matrix is shared MCP message 586; its pure-compiler versus
emitted-action distinction is clarified in reply 587. Preserve each provider's
usage/failure receipts and stop unchanged failures. Native Codex capacity was
exhausted during the API workflow; a fresh independent session reviewed the
preserved exact artifact. No implementation replay or automatic API billing
fallback was used.

Improvement means a growing verified asset library, reusable design rules,
test cases, measured outcomes and project-scoped MCP memory. Model weights are
not being trained by this process.
