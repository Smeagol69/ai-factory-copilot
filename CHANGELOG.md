# Changelog

All notable changes to AI Factory Copilot are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

- Added bounded, read-only structural inspection for native `.sbp` blueprints:
  exact header evidence, decoded native `Build_*` entity class counts, saved transforms,
  pivot bounds, and recipe evidence. It explicitly does not claim destination
  terrain clearance, Build Gun hologram validity, or external topology.
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
