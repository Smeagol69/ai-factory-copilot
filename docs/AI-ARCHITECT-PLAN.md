# AI Architect: measured designs that fit

The owner's target is an attractive, useful Satisfactory build that fits its
actual site. A model's plausible drawing, a compilable Blueprint and a building
that the game permits are different kinds of evidence. Track them separately.

This extends the existing **AI Factory Copilot**, not a replacement game mod.
Its canonical source checkout is `workspaces/architect/integration`, from
`Smeagol69/ai-factory-copilot`. The existing scanner, full-snapshot solvers,
structural compiler, revision store, game-owned Blueprint serializer, holograms,
action gates and undo remain the implementation path. This outer application
provides one home, launcher, model coordination and visible evidence around it.

## Current validation work, 2026-10-17

The offline reference decoder now reuses the existing native hypertube and rail
decoders. Human-readable reference sheets retain exact connection identities,
uncertainty and malformed/truncated distinctions. The uploaded architectural
references also have a private, source-hashed comparison in
`state/architect/reference-traits.md`: repeated entrance motifs, concrete bays,
wall courses and appearance descriptors are measured evidence, while collision,
walking clearance and rendered appearance are still unknown. The current flat
structural adapter does not yet reproduce the curved/modded/decorated motif.

Native generated Blueprint verification now reloads structural v1 as well as
later formats and matches every requested part's class, position, rotation and
scale. Its exact-geometry native Automation test has run successfully in the
headless Editor. That unit test does not prove a saved Blueprint or destination
fits in a loaded game; the game-side acceptance loop remains open.

The opt-in native test mailbox reuses Copilot's existing `export all`, `look`
and `AskBridge` paths. It never exposes an arbitrary command or a second world
writer. Fresh loaded-world and selected-player identities bind each request;
immutable consumed-ID markers prevent an interrupted task from being replayed.
`accepting_requests` reports actual readiness after marker recovery. The repo
default remains disabled. All automated children hide their consoles.

From this home, `node scripts/playtest.mjs status` reads readiness without
inference or a game write. `capture` exports current state, `look` requests an
image, and `askall <question>` uses the existing game-to-companion model path.
No loaded-world heartbeat means no request is submitted. A completed request,
accepted action, dry run, committed action and observed world mutation are
reported separately. A requested screenshot is not a verified image.

Claude supplied the bounded transport-decoder patch through the existing MCP
worker. Our 28-tool limit stopped it at final fixture verification; Codex
preserved the exact patch, repaired the fixture/imports and obtained independent
review. The stop was a launcher limit, not a model policy refusal. Its preserved
usage/handoff is in `state/architect/transport-workflow`; no fresh implementation
or automatic paid fallback was used.

Verification checkpoint: 1,299 companion tests passed; 49 lab tests passed with
one explicit native-engine check skipped; native geometry Automation passed 1/1.
Editor and Shipping compiled against the retained CL502094 SDK. Deployment is
held because the installed game updated to CL513885 / 1.2.4.1 on October12.
The exact release check caught this mismatch. A separate pinned official SDK is
being prepared inside `tools/satisfactory-sdk-513885`; the old SDK and game
installation are preserved. Nothing here claims a new live construction test.

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
  The same reviewed commit is integrated into the shared game's master branch.
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
