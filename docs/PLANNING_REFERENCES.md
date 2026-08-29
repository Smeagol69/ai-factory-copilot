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

## Fresh unlock-constrained optimization

Each Send is a new planning boundary. The companion hashes the exact set of
recipe classes the current save's `AFGRecipeManager` marked available and uses
only explicit `available: true` candidates when that authoritative field is
present. Production chains, machine counts, selected tiers, architectural part
candidates, site/placement geometry, and transport topology must be recomputed
from that same capture. Inventory cost and every exact recipe are then checked
again by the game before construction. A changed or missing unlock fact fails
closed; the planner does not keep an older choice or silently use a locked
alternate.

"Optimal" always names its constraints and objectives. Throughput correctness,
requested tier limits, current unlocks, captured transport capacity, exact XYZ,
and hologram acceptance are hard constraints. Shorter and cleaner routing,
smaller footprint, service access, expansion, independent commissioning, and
visual cohesion are ordered soft objectives. A subsystem that has not yet
solved one of those objectives reports it as a construction blocker rather than
claiming the whole design is optimal.

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

## Reference blueprint pair: enclosed underground and surface levels

The owner supplied `Underground Level (Enclosed)[Mk.1]` and `Main Level
(Building Shell)[Mk.1]` as a visual and functional reference on 2026-08-28.
The binary files are not redistributed in this repository. Their local hashes
are recorded so a later inspection can distinguish these exact inputs:

- lower `.sbp` SHA-256
  `0A9AA627D9B7D50E4BBE3A6A1B1501280AB14B61884F54D832B73143B0C66EA9`;
  `.sbpcfg` SHA-256
  `EF3808BD06AAAB029CC787734E074F5768A4683CEE27A46AD88DE0CAFB2CC31D`;
- main `.sbp` SHA-256
  `BBC55FEBBDF202F55DB6378C6C0B2327BF9980B1D77FC2C6D1A896792D731343`;
  `.sbpcfg` SHA-256
  `7287C2B960A9E19B861B24C8C43B2BB0FF7AB3C827D93ABAE02119B7E0439323`.

Facts decoded by the pinned read-only serializer (parser 4.1.2):

- both files are save version 58, authored at game changelist 481836, with a
  4 × 4 × 4 Designer envelope; the current installed CL 502094 and native
  Build Gun remain the authority at placement;
- the lower file contains 420 decoded objects (248 Build_* entities and 172
  components), including 4 `SmelterMk1`, 1 automated biomass generator, 9
  `ConveyorBeltMk2`, 13 `ConveyorLiftMk2`, 2 `PipeHyper`, 2 `PipeHyperStart`,
  one `FoundationPassthrough_Hypertube`, one `HyperTubeWallHole`, and one
  `PipeHyperSupport`;
- its exact native `/Script/FactoryGame.FGPipeConnectionComponentHyper`
  records number 10; 8 saved `mConnectedComponent` references form 4
  reciprocal internal pairs. The two `PipeHyper` entities contain 5 and 6
  saved spline points (11 total), with transformed Blueprint-relative
  endpoints. Each pipe's two saved `mSnappedPassthroughs` entries is blank,
  so no cross-blueprint or external passthrough join is proven;
- the lower file also contains 25 verified physical native power-wire edges;
  that is evidence of saved power topology, not proof of live power, load,
  capacity, or an external grid connection;
- the main file contains 145 decoded objects (137 Build_* entities and 8
  components): 16 foundations, 47 solid walls, 48 window walls, 1 door, 16
  roof pieces, 2 ceiling lights, 1 lights panel, 2 wall poles, and 4 native
  power-wire edges. It contains **no** saved Hyper connection components or
  `PipeHyper` entities, despite the descriptive claim of an elevator exit;
- saved Build_* pivot locations span 32 × 32 × 31.5 m (lower) and 32 × 32 ×
  28 m (main). These are pivot spans, not collision/visual extents or proof
  that the two files will snap together.

These samples establish a two-level style target—enclosed shell, repeated
structural grid, separated utility/power layer, and a native hypertube corridor
where the file actually contains one. They do **not** prove that the lower level
is excavated, that the main level has a hypertube exit, that the pair snaps at a
new destination, or that it runs after placement. Future generated layouts
should use the captured current unlocks and native hologram checks, preserve
the exact Hyper component/spline evidence when they choose to include a
hypertube, and report missing cross-level links instead of inventing them.

### Comparison contract for reference-led design

The companion's `compare_blueprint_layouts` solver accepts two exact names (or
the `blueprint_reference` returned by `list_blueprints`) and compares only
serialized native evidence. Claude can therefore see version and Designer
dimensions, decoded object/entity/component/buildable totals, saved pivot
spans, buildable-class counts, recipe references, build cost, and aggregate
conveyor/pipe, physical power-wire, railroad, and hypertube topology deltas in
one bounded result. The comparison is complete only when both class lists and
the relevant arrays are intact; truncated, missing, malformed, or unsupported
fields remain explicitly unknown.

This tool is a design-corpus aid, not a style classifier. It never treats a
description, filename, shared class, or similar dimensions as proof of an
aesthetic theme, native snap compatibility, terrain or collision clearance,
cross-blueprint joins, external hookups, item/fluid/power flow, or destination
Build Gun validity. A later design compiler must still use current unlocks,
native hologram checks, and game-side readback before placement or Blueprint
export.

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
