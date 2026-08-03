# Changelog

All notable changes to AI Factory Copilot are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

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
