# Changelog

All notable changes to AI Factory Copilot are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## 1.0.0-beta.3 - 2026-08-17

- Added a client-owned native Blueprint Build Gun preview: the Copilot can arm
  an existing saved blueprint in the requesting player's own build gun without
  placing anything or bypassing Satisfactory's hologram lifecycle.
- Added the authoritative half of native whole-factory export. It rechecks the
  exact live dismantle selection, expands existing blueprint proxies, derives
  800 cm native dimensions from real bounds, writes through Satisfactory's
  archive/config APIs, refreshes the descriptor library, and reads it back.
- Removed arbitrary export size/count limits. The first portable export safely
  refuses lightweight temporary architecture and resource-bound extractors
  until their explicit sidecar and native re-placement paths are complete;
  this avoids silently producing incomplete blueprints.
- Bumped the bridge/mod action contract to v2 so a mixed beta.2/beta.3 install
  fails closed instead of misinterpreting preview or export actions.

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
