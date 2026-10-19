# Inspiration board (owner's style references)

The owner shared these seven images on 2026-10-19 as **inspiration for future
builds**: when a brief does not say what style to use, design in this direction.
They are references to learn from, **not designs to copy**. They are not
measurements, not native meshes and not proof that a look can be built. Every
design still comes from saved blueprint poses, measured pieces and real recipes,
and every in-game claim still needs a game receipt.

Designers: open the images (they are ordinary JPEGs; both Claude and Codex can
look at them) before your first candidate, and say in your rationale which
references you drew on and what you changed. Critics: judge a candidate against
the brief first, then against this language.

| # | File | What to take from it |
|---|---|---|
| 1 | [01-stepped-amber-tower.jpg](01-stepped-amber-tower.jpg) | A tower built from stacked boxy modules with **setbacks**, each tier narrower than the one below; framed panel facades; thin warm-amber light lines along every tier edge; a crown of small blocks with a lit core. |
| 2 | [02-dark-crowned-tower.jpg](02-dark-crowned-tower.jpg) | A dark, near-black mass with **chamfered/octagonal crown blocks**, X-braced window frames, bold **vertical yellow light bars** grouped in threes, one purple accent, an antenna mast. |
| 3 | [03-stacked-capsule-slabs.jpg](03-stacked-capsule-slabs.jpg) | Three long rounded-end floors **stacked and rotated off each other** (cantilevers); dark glass bands; a single orange edge line tracing every outline; small cyan screens; an elevated rail line passing below. |
| 4 | [04-white-terraced-campus.jpg](04-white-terraced-campus.jpg) | A white campus: **curved terraces** stepping down to water, a ring building, slim bridges and towers, roof equipment as texture; buildings sit into the landscape instead of on it. |
| 5 | [05-garden-terrace-concept.jpg](05-garden-terrace-concept.jpg) | Concept art: green-grey layered **terraces with trees**, angled ramps and stairs, deep horizontal bands, a tower with banded blue glazing. Human scale at the edges. |
| 6 | [06-halo-spire-desert-base.jpg](06-halo-spire-desert-base.jpg) | A desert factory base: a slender **spire with a cyan halo ring**, a boxy hall with **yellow trim on every edge**, gridded glazing, lit conveyor lines crossing the sand in straight runs. |
| 7 | [07-neon-edge-cantilever-tower.jpg](07-neon-edge-cantilever-tower.jpg) | A charcoal tower with **cantilevered floor plates**, orange edge lines on each plate, white vertical light strips on the shaft, an octagonal crown with a blue rim light, an external ramp. |

## The shared language

1. **Massing by stacking.** Buildings are tiers, slabs and blocks stacked with
   setbacks, offsets and cantilevers, never one extruded box. A silhouette that
   steps (1, 2, 7), slides (3) or terraces (4, 5).
2. **Strong horizontal banding.** Each floor reads as a band: solid spandrel,
   glazing, solid. Bands are deep enough to cast shadow.
3. **Light outlines the form.** Thin lines of warm light (amber, orange, yellow)
   trace edges and floor plates; one cool accent (cyan, blue or purple) marks the
   crown, a ring or a screen. Light follows the architecture, it is not scattered.
4. **A crown and a vertical.** Something marks the top: an octagonal or chamfered
   crown, a mast, a halo ring, a spire.
5. **Dark or white, rarely in between.** Either charcoal/black with warm light
   (1, 2, 3, 6, 7) or white/pale with landscape (4, 5). Pick one per build.
6. **Grounded in the site.** Terraces, bridges, rail and conveyor lines tie the
   building to the land and to the factory around it; logistics are part of the
   composition (3, 6), not hidden.
7. **Repetition with rhythm.** Window grids, light bars in groups of three, ribs
   at a fixed pitch: the same element repeated at an even pitch reads as designed.

## Only real game pieces (owner rule)

Designs and renders use **only buildings the game itself can place**: the
classes in [`hub/catalog/game-buildables.json`](../../../hub/catalog/game-buildables.json),
pulled from the game's live recipe registry (base game and the owner's installed
mods) by `hub/scripts/ingest-game-catalog.mjs`. No made-up assets: a neon tube or
glass ring that is not in that list cannot appear in a candidate, and the studio
refuses any candidate that uses one. Sizes come only from what the game reported
(placed-actor bounds, reflected width/depth/height); a piece the game has not
measured is drawn as a red "size unknown" marker, never guessed. Regenerate the
catalog after a new world capture or a mod change.

## Translating it into Satisfactory (to be measured, not assumed)

These are **candidate** mappings for designers to try and measure; none is
verified until a native save and readback show it:

- Tiers and setbacks: foundations and walls stacked with each tier inset by whole
  grid units; cantilevers from foundations overhanging the tier below.
- Banding: alternate solid walls with window/glass walls per floor; beams along
  floor edges for the band line.
- Light outlines: lights placed along edges with a light control panel setting
  colour and intensity; signs or displays as the cool accent screens; painted
  finishes (customizer) for the dark or white body.
- Crowns and verticals: chamfered (angled) foundations or walls for octagonal
  crowns; pillars/beams for masts; a ring of curved pieces for a halo.
- Site: conveyor and rail runs as deliberate straight lines, ramps and stairs at
  the edges, terraces stepping with the terrain.

Record what actually works (piece, measured size, how it looks in game) next to
the build, so the next design starts from evidence, not from this list.
