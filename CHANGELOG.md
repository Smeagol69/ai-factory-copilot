# Changelog

All notable changes to AI Factory Copilot are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

- Fixed vanilla Miner snapping on ordinary nodes created by the Creative Node
  Spawner. FactoryGame CL 502094 restricts Miner CDOs to the Blueprint-generated
  `BP_ResourceNode_C` class, which a native mod node cannot inherit even when it
  implements the complete resource-node and collision contract. A narrowly
  scoped SML hook now removes that one class predicate only while FactoryGame
  evaluates a valid `AAIFactoryCreativeOrdinaryResourceNode`; the original
  native function still decides occupation, allowed resource forms, explicit
  extractor resource allowlists, and every non-class compatibility rule.
  Vanilla nodes, geysers, Refined Power templates, and other mods' extractable
  actors keep the untouched path. The hook is Shipping-only because the Starter
  Project's generated Editor method is an empty non-hookable stub; this keeps
  Editor/cook startup safe while targeting the installed game's real function.
  Exact CL 502094 validation, Shipping and Editor builds, UAT cook/archive,
  matched Steam deployment, and **888/888** tests pass. The installed DLL
  SHA-256 is
  `1BC3CF022299AE5BDF6B2C9987FE2FDE518C3004697914CB1862761425CB5723`;
  live Miner hologram confirmation is the remaining gate.
- Repaired the live Creative Node Spawner compatibility gaps found against
  Refined Power. Ordinary solid/liquid/gas resources now construct a true
  `AFGResourceNode` subclass instead of changing the type flag on a geyser
  subclass, restoring the concrete native contract used by Miner holograms;
  the retained geyser class remains load-compatible for old saves and handles
  real geothermal descriptors. Creative-node prompts now use Unreal's
  localized purity display text (`Pure`) instead of leaking internal enum
  names such as `RP_Pure`. The spawner also discovers special resource-node
  classes from exact live actors, so Refined Power's `BP_WaterTurbineNode_C`
  appears as `Water Turbine Node` even though it intentionally uses
  `RF_INVALID` and node type `Invalid`. Discovery prefers the authoritative
  current resource over an inherited compatibility descriptor and excludes
  native `AFGResourceNodeGeyser` actors from the special-template lane, so a
  Refined Power node cannot be mislabeled as vanilla `Geyser`. A selected
  special class/resource pair
  is re-proven in the live world before arming and again before construction;
  the server spawns that exact mod class and rejects mismatched readback rather
  than approximating it as generic Water. Generic Water remains a liquid node
  for compatible node extractors; vanilla Water Extractors still target water
  volumes. Exact CL 502094 headers, Shipping/Editor builds, UAT cook/archive,
  matched Steam deployment, and **887/887** tests pass. Installed DLL SHA-256
  is `9714A0D07C82FD2E5AE903538F1C44FE9F39C66BD8603A1217FC7E2DE8B046AE`;
  live Miner / Water Turbine hologram confirmation remains pending.
- Extended the Creative Node Spawner beyond solid ores. The registered resource
  catalogue now includes liquid, gas, and geothermal geyser descriptors, while
  the server validates each descriptor against its native node form and node
  type before the Build Gun is armed. Geysers use the native
  `AFGResourceNodeGeyser` hierarchy so geothermal-generator holograms can
  recognise them; ordinary solid/liquid/gas nodes retain the ordinary
  `EResourceNodeType::Node` identity. Creative nodes now expose the game's
  `Resource` collision profile, Build Gun overlap response, canonical snap
  transform, and runtime extractor checks, fixing generated nodes that looked
  like deposits and refused Miner placement. Snapshots expose `resource_form`
  so the companion can distinguish solids, liquids, gases, and geysers without
  inference. Exact CL 502094 headers, Shipping/Editor builds, UAT packaging,
  and **887/887** companion tests pass; a packaged live-game Miner/geothermal
  placement test remains to be performed.
- Fixed live native Build Gun recipe discovery for node-sourced Blueprint
  generation. FactoryGame CL 502094 reflects the producer as `FGBuildGun`,
  whereas Blueprint-authored recipes use `BP_BuildGun`; both exact terminal
  class names are now accepted, with no broad substring guessing. The
  companion regression suite passes **887/887** and the clean install was
  refreshed.
- Fixed node-sourced native Blueprint generation being blocked on a fresh save:
  the mod-owned Blueprint Resource Anchor recipe is now made available
  idempotently during world initialization, and `/ai anchor` reuses the same
  readiness check. The bridge still requires exact live recipe availability;
  no vanilla progression recipe is unlocked. Shipping and Editor module builds
  pass; the matched UAT package/deploy completed after the game closed.
- Added deterministic **aimed-node sourcing** for planner-generated native
  Blueprints. A request such as `create a blueprint that makes 30 iron ingot
  per minute from this node using Miner Mk.1` now resolves the exact aimed
  ordinary solid node, captured resource descriptor and native purity, current
  Build Gun unlocks, selected vanilla Miner capability/rate, measured Miner
  collision radius, and the machine/Miner class-default conveyor ports. The
  generated v4 file contains one configured Resource Anchor, its exact paired
  Miner, a named-port input belt through one measured wall aperture, the
  production stage, shell, and captured-capacity power topology. One consumer
  is connected directly. Multiple identical fully utilized consumers use one
  unlocked vanilla regular Conveyor Splitter only when its class-default input
  and distinct output ports plus a live-instance collision footprint are all
  captured; the bridge now independently rejects reused or direction-wrong
  generated conveyor endpoints before game staging. It never serializes the
  live node actor id and leaves final node alignment to the vanilla Build Gun.
  Multi-stage source routing, partial-machine clocking, fluids, and automatic
  destination siting refuse explicitly rather than producing a Blueprint that
  cannot run. Exact CL 502094/SML validation and **884/884** companion tests
  pass. The game stayed open, so this source is not deployed or live-placement
  proven yet.
- Extended aimed-node Blueprint sourcing to an exact balanced two-stage linear
  chain. Standard Copper Ore → Copper Ingot → Wire now compiles as one native
  v4 file with the measured Resource Anchor/Miner, one raw-input Splitter, one
  per-Smelter intermediate Splitter, two Smelters, four Constructors, nine
  named-port conveyors, and captured internal power. The compiler checks recipe
  ratios, fully utilized machine counts, connector directions, collision
  bounds, shell fit, and observed belt capacity; merger-required, fractional,
  coproduct, mixed-input, and unsupported graphs refuse before emitting a file.
  Reply text identifies the two-stage topology instead of claiming a single
  splitter. Exact CL 502094/SML validation and **886/886** companion tests pass.
  Deployment and live Build Gun placement remain the next verification gate.
- Added generated native Blueprint schema v4: the API may now serialize an
  explicitly configured solid-resource Blueprint Resource Anchor paired
  one-to-one with a captured vanilla Miner Mk.1-Mk.3. Both bridge and game
  revalidate exact unlocks, resource form/purity, roles, identity mapping, and
  the per-Anchor Miner class pairing;
  the game refuses success unless the saved `.sbp` reload preserves the exact
  Anchor configuration and Miner relationship. Destination terrain/node
  alignment, fluid extractors, portable/modded miners, and automatic siting
  remain explicitly unclaimed.

- Added read-only native **Blueprint comparison**. Claude can now compare two
  exact saved `.sbp`/`.sbpcfg` library entries side by side using serialized
  header/version, designer dimensions, decoded totals, pivot spans, complete
  buildable-class counts when available, recipe references, build cost, and
  aggregate conveyor/pipe, physical power-wire, railroad, and hypertube
  topology deltas. Missing, malformed, and truncated records stay unknown;
  filenames/descriptions are never treated as visual-style evidence, and no
  snap, terrain, collision, cross-blueprint join, flow, or Build Gun claim is
  made. No writer or world mutation was added.
- Added read-only native **hypertube reference inspection** to the Blueprint
  structural reader. Exact `FGPipeConnectionComponentHyper` reciprocal links,
  `Build_PipeHyper` spline locations/tangents, Blueprint-relative endpoints,
  saved spline bounds/chord lower bounds, native entrance/passthrough/support
  class counts, and explicit blank passthrough references are now exposed with
  bounded output. This lets the assistant study enclosed multi-level samples
  without confusing a saved link with proof of traversal direction, speed,
  throughput, underground excavation, collision clearance, cross-blueprint
  joins, or destination Build Gun validity. No writer or world mutation was
  added; existing conveyor/pipe/power/rail topology contracts remain intact.
- Added read-only native **rail/tunnel reference inspection** to the Blueprint
  structural reader. The companion now decodes exact saved
  `Build_RailroadTrack` `mSplineData` locations/tangents, local spline bounds,
  Blueprint-relative transformed endpoints, chord-length lower bounds,
  transforms, and `mTrackGraphID` metadata with
  bounded output. This lets the assistant study modular tunnel references such
  as entrance, middle, and facade segments without mistaking a saved track for
  proof of cross-segment joins, terrain excavation, collision clearance,
  signals, power, or destination Build Gun validity. No writer or world mutation
  was added; v1/v2 Blueprint behavior is unchanged.
- Added the first exact native **pipeline topology** primitive to
  planner-generated Blueprints through `aifactory.generated-blueprint/v3`.
  Registered building descriptors now expose their real pipe-connection names,
  connection types, local transforms, connector-clearance values, and snapping
  restrictions. Unlocked pipeline descriptors additionally expose their native
  flow limit and the installed pipeline hologram's exact minimum/maximum spline
  lengths; no vanilla pipe tier, capacity, or distance is hard-coded. The
  companion accepts only explicit straight, collinear links between compatible,
  oppositely facing, unused ports and checks their transformed length before the
  game independently creates the native two-point spline. Commit requires
  reciprocal endpoint readback both before save and after loading the `.sbp` in
  Satisfactory's isolated Blueprint world. v1 and v2 remain unchanged, and v2
  refuses rather than drops v3 pipe data. Exact CL 502094 header validation,
  **861/861** companion tests, Editor/Shipping module builds, UAT cook/archive
  and Steam deployment, and a clean 39-file companion install pass. Live
  generated-file/Build-Gun placement is still required; pumps, head lift,
  junction manifolds, automatic fluid routing, and miner/resource anchoring are
  not claimed.
- Added deterministic **internal power distribution** to planner-generated
  native Blueprints. The scanner now captures each registered building
  descriptor's native circuit-component names, circuit type, hidden state, and
  exact `GetMaxNumConnections()` capacity, plus native wire length and ground
  pole type, directly from the installed class defaults. The companion
  daisy-chains machines only when that captured capacity supports it; otherwise
  it adds the minimum compatible unlocked ground-pole trunk, reserves one real
  link for the external grid, and refuses missing, ambiguous, overloaded, or
  obviously overlength topology instead of applying vanilla assumptions to
  modded content. Generated wires are length-checked again against their
  resolved native endpoints in the game, serialized as physical wire actors,
  and must pass the existing isolated-Blueprint-world reciprocal endpoint
  readback. Exact CL 502094 header validation, **859/859** companion tests,
  Editor/Shipping module builds, UAT cook/archive/game deployment, and the clean
  companion install pass. A fresh live snapshot and generated multi-machine
  Blueprint placement remain required before calling the new power lane
  gameplay-proven.
- Fixed the first live AI-generated Blueprint attempt. General Blueprint
  production planning now treats exact captured/registered extracted resources
  as external factory inputs and prefers the ordinary product-named recipe, so
  30 Iron Ingot/min resolves to one Smelter plus 30 Iron Ore/min instead of
  recursively manufacturing ore through a nine-step Converter/SAM chain.
  Generated structural parts now use Satisfactory's native `FFGClearanceData`
  as their primary bounds; registered colliding and then non-colliding primitive
  bounds are exact fallbacks. This handles server-side lightweight foundations,
  which intentionally have no registered colliding render primitive, while
  preserving fail-closed internal-overlap validation and reporting each bounds
  source in the action result.
- Added the first true **AI plan → native Blueprint** pipeline. A request such
  as `create a blueprint that makes 60 wire per minute` now sizes the production
  chain from the live recipe catalog, lays out an enclosed factory, converts
  every exact build/production recipe and transform into Blueprint-relative
  geometry, and submits one standalone `generate_native_blueprint` file write
  instead of hundreds of live-world placements. The game independently checks
  current unlocks and class compatibility, stages only deferred `RF_Transient`
  native buildables inside an empty real Designer, applies and reads back
  manufacturer recipes, measures native hologram clearance/primitive bounds,
  refuses unapproved internal overlap, serializes with `SaveBlueprint`, unwinds
  Designer membership, destroys every staging actor, refreshes the native
  library, and accepts the result only when `ReadBlueprintFromDisc` succeeds.
  The resulting `.sbp` is then placed through the existing vanilla Build Gun
  preview/placement workflow. Initial v1 deliberately refuses conveyor, pipe,
  wire, miner/resource-anchor, and host-dependent attachment topology; it does
  not pretend a machine-only graph is a finished powered factory. Exact CL
  502094 headers, 846 companion tests, Editor/Shipping module builds, UAT
  archive, game deployment, and the clean companion install pass. A generated
  file/readback and vanilla Build Gun placement still require live-save proof
  before calling generation gameplay-proven.
- Added the experimental **Creative Resource Node** world-editor foundation.
  `/ai node place <resource> [impure|normal|pure]` arms Satisfactory's normal
  Build Gun hologram for a new mod-owned, saveable, replicated infinite solid
  node; it never directly spawns, moves, replaces, or adopts a vanilla map
  node. It is gated by the existing world-write switch and multiplayer server
  admin check. Generic retargeting now rejects Blueprint Anchor runtime nodes,
  deposits, geysers, fracking actors, and other special nodes so their own
  persisted/game-owned configuration cannot be corrupted. The Insert panel
  now includes a compact resource field plus **Arm impure / normal / pure**
  controls. Each produces only that exact documented command through SML's
  native server chat route, then returns focus to the Build Gun; it does not
  bypass the server validation or construction path. Source contracts, exact
  FactoryGame CL 502094 headers, **837 companion tests**, Editor and Shipping
  builds, and UAT archive/game deployment pass. The feature remains explicitly
  gated on a
  disposable-save and host/client live matrix before it is called proven.
- Added the native **Use dismantle marks** capture workflow. Mark a megabase
  with Satisfactory's own mass-dismantle selector, adopt the exact actor set in
  the Copilot panel, and save one native `.sbp`; nothing is dismantled and the
  existing game serializer/Build Gun path remains in charge. Category filters
  are reflected in the preview, and any structural lightweight pieces the
  actor-only API cannot expose are called out instead of silently claimed. The
  original box scan remains intact as an explicit **Box scan** toggle for empty
  sites and structure that the dismantle actor list cannot expose.
- Extended native `.sbp` structural inspection with bounded, exact **physical
  power-wire topology**. The companion now inverts the game-saved `mWires`
  membership on native power-connection components, reporting verified wire
  endpoints and their blueprint-owner evidence along with aggregate counts.
  Blank, malformed, duplicate, unresolved, unsupported, unowned, incomplete,
  and overconnected records remain partial rather than being guessed.
  `mHiddenConnections` logical circuit links, electricity direction, load,
  capacity, external-grid connections, and placement validity remain explicitly
  outside this read-only result.
- Extended the read-only placed-Blueprint audit with bounded **Blueprint
  Resource Anchor** evidence: saved resource/purity, exact runtime-node
  ownership/occupancy, and exact live miner identities are reported only from
  public game accessors and exact pointer identity. Client-null transient nodes,
  lightweight Anchor members, malformed records, count mismatches, and duplicate
  miner claims stay unknown/partial rather than becoming a healthy binding.
- Added the experimental **Blueprint Resource Anchor** workflow for native
  Blueprint Designer miners. `/ai anchor <resource> [impure|normal|pure]`
  arms a normal Build Gun anchor with a real transient resource node; Miner
  Mk.1–Mk.3 retain their own normal snap, resource, occupancy, cost, and
  construction validation. The archive records explicit bindings rather than
  guessing nearest nodes. It is compile- and contract-validated but remains
  gated on a packaged disposable-save/host-client proof before being called a
  working release feature.
- Removed a packaging-discovered unsafe SML detour from the Resource Anchor
  lifecycle. Some supported generated `SetExtractableResource` implementations
  are too short for a safe trampoline, so anchors now discover only the exact
  extractor-interface bindings Satisfactory already made at the native
  save/Blueprint archive boundary. The package cook now loads cleanly; the
  required disposable live proof remains outstanding.
- Hardened Resource Anchor restoration: a recorded Miner is restored only if
  its current and legacy resource references are empty and the anchor node is
  vacant. A stale saved entry can no longer overwrite a live miner binding or
  create a second claim on the one-extractor node.
- Repaired a const-reference compilation error in the read-only native
  Blueprint placement auditor.
- Added a bounded, read-only runtime Blueprint-placement audit. A player can
  ask whether the native Blueprint instance they are aiming at has finished
  replication and whether its extractor members actually bound to resources.
  The result comes from the placed proxy and extractors, preserves the real
  crosshair/camera fallback used for miners, and reports pending or unknown
  state instead of inventing an unbound miner. It never reads a saved file,
  places anything, changes cost, or mutates the world.
- Made native Blueprint Build-Gun preview session-aware. The companion now
  distinguishes a disk blueprint from one registered in Satisfactory's active
  save library, refuses cross-session files before promising a hologram, and
  reads the current native registry without disturbing the player's Build Gun
  during normal chat capture. Only the requested server handoff and owning
  client refresh the descriptor cache before lookup. Preview still never copies
  files, spends items, changes the world, or creates an undo entry.
- Added bounded, read-only structural inspection for native `.sbp` blueprints:
  exact header evidence, decoded native `Build_*` entity class counts, saved transforms,
  pivot bounds, recipe evidence, and exact reciprocal saved conveyor/pipe
  component links. It reports malformed, unresolved, ambiguous, one-way, and
  unsupported component references rather than guessing a connection. Flow
  direction/rate, power direction/load/capacity, destination terrain clearance,
  Build Gun hologram validity, and external topology remain explicitly unknown.
- Made saved-blueprint inspection safe for duplicate names by accepting only a
  `blueprint_reference` emitted from the configured library, never an arbitrary
  filesystem path.
- Bundled the lock-pinned structural-parser dependency into the game companion
  and made standalone installation materialise it transactionally before
  replacing a working bridge.

## 1.0.0-beta.2 - 2026-08-16

- Rebuilt the native mod against Satisfactory 1.2.4 / FactoryGame CL 502094,
  so native virtual dispatch targets the supported live build instead of the
  stale CL 491125 headers that crashed snapshot export on save load.
- Added validation and packaging preflights that refuse a mismatch between the
  mod descriptor, Starter Project headers, and installed game changelist.
- Hardened direct conveyor placement, including real engine aim lifecycle,
  endpoint readback, cost charging, cleanup, and rollback diagnostics.
- Added an explicit Mk.1 Wire-factory `without belts` option, resource-node
  clearance advisories instead of unsupported geometric refusals, and a durable
  game-side action-outcome journal.

## 1.0.0-beta.1 - 2026-08-03

First public Windows beta.

- Added an Insert-toggled in-game copilot with authoritative whole-world state.
- Added deterministic production, power, logistics, unlock, siting, blueprint,
  layout, belt-route, and compact belted-module planning tools.
- Added server-authoritative building, blueprint, inventory, waypoint,
  teleport, dismantle, undo, and overlay actions with dry-run and validation
  gates.
- Added OpenAI, Anthropic, local OpenAI-compatible, hybrid, and diagnostic
  companion providers with official-source web search.
- Added clean companion installation, rollback, health checks, provider
  grounding, privacy limits, response-contract versioning, and bounded payloads.

Known beta limits:

- The packaged target is Windows client only. Dedicated Windows and Linux
  server targets have not been validated.
- The complete live construction matrix, including modded recipes and every
  rollback/refund path, is still in progress.
- Belt routing currently covers a narrow direct-connection path and a two-phase
  compact module plan. General obstacle-aware belts, pipes, and power routing
  are not complete.
- The belt-speed conversion divisor still needs an authoritative live reading
  from a known belt tier.
