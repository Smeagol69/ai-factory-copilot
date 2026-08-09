# Planning and transport references

This is the curated outside-reference layer for factory design. It records the
rules worth teaching the planner without copying entire wiki pages or treating
a web calculator as live-save evidence.

## Authority order

1. The current snapshot and game-side validation own actors, coordinates,
   recipes, unlocks, machine tiers, rates, capacities, inventory, and whether a
   hologram can actually be constructed.
2. The exact local FactoryGame/SML headers own engine API behavior.
3. Coffee Stain's modding documentation owns supported mod construction and
   packaging patterns.
4. The maintained Satisfactory wiki and Pipeline Manual supply topology and
   operating guidance.
5. FactorioLab and Manifolder supply planning-algorithm and layout-UX ideas.

Lower levels never overwrite higher ones. In particular, vanilla ratios from a
guide are examples—not constants—when a save contains modded miners,
generators, extractors, belts, or pipes.

## Belts and connectors

- [Factory connectors](https://docs.ficsit.app/satisfactory-modding/latest/Development/Satisfactory/FactoryConnectors.html)
- [Conveyor Belts](https://satisfactory.wiki.gg/wiki/Conveyor_Belts)

The planner resolves endpoints from captured connection components, proves
recipe compatibility, and leaves length, clearance, pole requirements, and the
final result to Satisfactory's conveyor hologram. Belt speed comes from the
captured actor and the configured conversion divisor, never from a tier table.

## Pipes, head lift, and water

- [Pipeline Manual (owner-supplied PDF)](https://static.wikia.nocookie.net/satisfactory_gamepedia_en/images/3/39/Pipeline_Manual.pdf/)
- [Pipelines](https://satisfactory.wiki.gg/wiki/Pipelines)
- [Head lift](https://satisfactory.wiki.gg/wiki/Head_lift)
- [Pipeline Pump](https://satisfactory.wiki.gg/wiki/Pipeline_Pump)
- [Water Extractor](https://satisfactory.wiki.gg/wiki/Water_Extractor)

Rules to encode and verify against the loaded save:

- Pipes are bidirectional, gravity-bound networks. A nominally adequate pipe
  can still starve machines when it is not kept full or flow sloshes.
- Head lift is vertical elevation, not route length. Pumps add head lift, not
  flow capacity, and an unpowered pump resets upstream head lift rather than
  stacking it onward.
- Feed a manifold level with or above consumer inputs where practical, prefill
  the network before full load, and consider a loop or both-end injection near
  the pipe's captured capacity.
- Every segment must stay within its captured flow limit. Pump spacing and
  margin must come from the selected pump's live class data; old manual numbers
  and current vanilla wiki numbers are guidance, not mod-safe inputs.
- A vanilla three-extractor/eight-generator illustration is a topology example.
  The copilot instead divides the selected generators' captured supplemental
  demand by the selected extractor's captured output and validates every
  placement and pipe through the game.

## Production graph and layout UX

- [FactorioLab for Satisfactory](https://factoriolab.github.io/sfy?v=11) and
  its [MIT-licensed source](https://github.com/factoriolab/factoriolab)
- [Manifolder](https://manifolder.app/)

FactorioLab is useful as an independent algorithm and test oracle for recursive
recipe expansion, surplus accounting, machine rounding, and alternate-recipe
selection. Its bundled data is not imported as truth because it cannot know the
loaded save's mods or unlock state.

Manifolder's separation between production-chain planning and spatial layout is
the right user-facing shape for this project: first build a deterministic
material graph, then divide it into lines/modules and compile those modules into
grid transforms. Its values and layouts remain reference material, not game
evidence.

## Implementation targets

- `companion/lib/solvers.mjs`: deterministic quantities and provenance.
- `companion/lib/designer.mjs`: grid transforms measured from the player's own
  base.
- `companion/lib/power.mjs`: fuel and supplemental-fluid sizing from captured
  classes.
- `Source/AIFactoryCopilot/`: authoritative water volumes, pipe connections,
  head lift, hologram placement, server validation, readback, rollback, and
  undo.
- `companion/lib/sources.mjs`: cited outside search with the live-save-first
  policy enforced in the model prompt.
