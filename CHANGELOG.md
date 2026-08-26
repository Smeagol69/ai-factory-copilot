# Changelog

All notable changes to AI Factory Copilot are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

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
