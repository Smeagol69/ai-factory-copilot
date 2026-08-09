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

## Reference blueprint: modular coal plant

The owner supplied `Coal power plant 2700MW v1.1.sbp` and its `.sbpcfg` as a
quality target on 2026-08-09. The binary is not redistributed in this public
repository. Its SHA-256 is
`839925B4C67362A31EBD0E1153A449355D5BD8712CB174CAC38149C3A01C3455`;
the config SHA-256 is
`757AE98BFEB0E695F8A903AA9FFD0F8C6A4197DFF0A85D78ADFAABEF0778A82B`.

Facts decoded by the local blueprint reader:

- save version 2, authored at changelist 211839;
- Blueprint Designer envelope 12 x 12 x 6 cells (the description separately
  calls the finished building 9 x 9; preserve that distinction rather than
  choosing one silently);
- 11 exact cost classes, led by 3,030 Concrete, 1,273 Cable, 740 Iron Plates,
  720 Reinforced Iron Plates, 399 Copper Sheets, and 372 Rotors;
- 51 referenced build-recipe classes spanning generators, pipes, junctions,
  pumps, belts/lifts, splitters/mergers, foundations, walls/windows, ramps,
  gates, catwalks, railings, roofs, pillars, signs, and power lines.

The author's config declares 36 Coal-Powered Generators, 2,700 MW total, two
independently commissionable 1,350 MW halves, two 270 Coal/min inputs, six 270
Water/min inputs, balanced coal distribution, Mk.3 belts, Mk.1 pipes, and pumps
at the water inputs. Those are declared design facts, not independently decoded
object counts; the current parser does not yet decode per-object transforms.

This establishes the acceptance shape for generated factories:

1. **Site reasoning:** rank bounded candidate footprints between the required
   resource nodes and water access using captured distance, elevation, terrain,
   obstruction, existing construction, logistics, and expansion space.
2. **Authoritative functional core:** derive recipes, tiers, clocks, machine
   counts, belt/pipe throughput, head lift, and power from the loaded save and
   its mods. Never substitute vanilla tables for missing live evidence.
3. **Modular commissioning:** split large builds into independently usable
   phases or mirrored wings where the production graph permits it, with named
   inputs/outputs and an expansion path.
4. **Serviceable topology:** reserve manifold corridors, utility floors,
   walkways, access doors, pipe and belt penetrations, pump/head-lift service,
   maintenance clearance, and reachable power distribution before decorating.
5. **Architectural composition:** use only captured unlocked vanilla/modded
   parts to choose a coherent facade grammar, hierarchy, symmetry/asymmetry,
   windows, supports, roofs, lighting/signage, and human circulation. The model
   owns these bounded creative choices; deterministic solvers own every number.
6. **Staged game proof:** preview terrain and footprint, then construct through
   Satisfactory's real holograms in reversible transactions. Read back recipes,
   connections, fluid networks, and power before claiming a phase works.
7. **Reusable output:** once direct placement is proven, compile the same
   validated manifest into modular `.sbp` blueprints so the player can stamp,
   mirror, extend, and share the design.

The current aimed Wire route is intentionally the functional-core prototype.
It is not considered aesthetically complete until it passes through the site,
service-layout, architectural-composition, and reusable-blueprint stages above.

## Reference blueprint: staged steel Pipe and Beam factory

The owner supplied `Early game steel pipe(160ppm)  steel beam(140ppm)
factory.sbp` and its `.sbpcfg` on 2026-08-09. They are design-corpus inputs,
not files to redistribute. The `.sbp` SHA-256 is
`9490C36C74F887D6929D7A1793EC3B6292DDCE3BC5253650336A650E0BDBF0CE`;
the config SHA-256 is
`2E4A2B6A44FA5A21BDEE8084D75234B337565729CDABED8AB22C10C147033A5D`.

Authoritative facts decoded from the files:

- save version 2, changelist 211839, and a 12 x 12 x 6 Blueprint Designer
  envelope;
- 11 exact cost classes: 2,350 Concrete, 950 Iron Plates, 632 Steel Plates,
  574 Iron Rods, 438 Cable, 306 Reinforced Iron Plates, 188 Silica, 160 Wire,
  140 Modular Frames, 140 Rotors, and 120 Quartz Crystals;
- 34 exact referenced build-recipe classes spanning Smelters, Constructors,
  splitters/mergers, belts/lifts/poles, concrete and asphalt foundations,
  walls/windows, roofs, pillars, railings, catwalks, signs, wall power poles,
  and power lines.

The author's config separately declares a 7 x 12 finished footprint, two 267
Coal/min inputs, two 267 Iron Ore/min inputs, 160 Steel Pipe/min and 140 Steel
Beam/min total output. The building is two identical and independent floors;
each floor accepts 267 Coal/min plus 267 Iron Ore/min, exports 80 Pipe/min plus
70 Beam/min, and has separately connectable power and logistics. It is described
as an early-game, no-mod build requiring only Mk.3 belts and no architecture
unlock.

Keep the evidence boundaries explicit. The current reference scan proves class
paths are present, but its occurrence counts are only indicative and it does not
decode transforms. Its Mk.1/Mk.2/Mk.3 belt and lift references therefore do not
prove which tier each placed segment uses and do not override the author's Mk.3
statement. Full save-serializer decoding and game readback are required before
claiming exact placed counts, routes, floor membership, or symmetry.

This reference adds four requirements to the design target:

1. **Design-family identity:** related factories carry a stable family id plus
   an exact fingerprint of style parameters and captured semantic-part recipes.
   Reusing a name with a different recipe palette is a new revision, not the
   same theme. Passing an earlier fingerprint turns this into a hard compiler
   gate: a drifted proposal is refused rather than silently relabelled.
2. **Staged production:** a requested phase count is decomposed across every
   measured production group without losing machines. A phase is never called
   independent if it omits a required stage.
3. **Independent commissioning:** each phase needs isolatable input trunks,
   dedicated output collection, separately switchable power, a complete
   internal recipe/transport path, and game readback before being described as
   operational.
4. **Multi-objective layout:** throughput correctness and tier constraints are
   hard requirements; compactness, route length, service access, expansion,
   phase isolation, and architectural cohesion are scored together. "Optimal"
   must name those objectives and tradeoffs rather than mean shortest belts at
   the expense of maintainability or appearance.

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
