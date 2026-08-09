# Megabase design and construction contract

The target is an AI-designed Satisfactory campus, not a rectangular machine
array. Reference builds supplied by the owner establish three initial visual
languages:

1. **Elevated industrial campus** - large production decks on pylons, separate
   halls linked by skybridges, a vertical command/utility tower, visible
   structural trusses, glass facade bands, sloped roofs and open terraces.
2. **Terraced megafactory** - one dominant multi-floor mass whose production,
   logistics and circulation floors step backward into a tower.
3. **Curvilinear future campus** - several related buildings arranged along a
   curved or stepped spine, with bridges and circulation making the campus read
   as one composition.

These are grammars, not fixed blueprints. The model may vary proportions,
symmetry, tower emphasis, facade rhythm and the relationship between halls. It
may not invent a Satisfactory class path, unlocked part, terrain fact, machine
dimension or world coordinate.

## Pipeline

```text
authoritative snapshot + captured mod catalog + measured site/grid
        |
production and logistics program (deterministic solvers)
        |
creative brief (style, massing, hierarchy, facade intent)
        |
architectural compiler (exact grid cells -> exact world XYZ)
        |
preview-only design manifest + unresolved requirements
        |
captured recipe resolution + terrain/collision/hologram preflight
        |
game-authoritative transactional construction and read-back
        |
optional Blueprint Designer population and saved-file verification
```

The creative brief is deliberately above the engine boundary. It speaks in
semantic roles such as `production_hall`, `logistics_deck`, `support_pylon`,
`skybridge`, `glazed_facade` and `sloped_roof`. A separate resolution step may
map a role to a recipe only when that recipe was captured from the current save
and is available. Missing roles stay missing and are listed in the manifest.

## Preview manifest

`companion/lib/megabase.mjs` emits `megabase.design/v1`. A manifest contains:

- an authoritative anchor, grid unit, floor height and yaw;
- the requested style and its explicit creative parameters;
- production zones derived from measured machine rows;
- structural platforms, pylons, bridges, tower and facade/roof intents;
- integer grid-local origins and extents for every element;
- deterministic world-space XYZ and yaw for every element;
- captured part resolutions and unresolved semantic roles;
- bounded captured Build Gun recipe candidates per role, including mod ownership,
  availability and an explicit `behavior_verified: false` caveat;
- validation issues, provenance and a permanent `actions: []` field.

The manifest is not a list of build actions. `concept_only` means exactly that.
It cannot claim that terrain is suitable, that a hologram will place, that the
player can afford the design, or that a modded part behaves like a vanilla one.

## Design families and staged commissioning

Every manifest carries a `design_family`. Its human-readable `family_id` is not
authority by itself: the compiler also hashes that id, the exact style grammar,
creative parameters, and captured recipe selected for every semantic role. Related
buildings match only when that signature matches. An unresolved role stays null
and makes the family provisional; the model cannot fill the gap with a plausible
class path. A later request can pass `match_design_family_fingerprint`; the
compiler refuses the preview if any style parameter or exact role recipe drifted,
even when the human-readable family id was reused.

The optional `commissioning_phases` request splits every measured production
group across one to eight phases and proves that all machine totals are
preserved. It refuses a phase count that would leave any phase without a
required production stage. Equal machine allocations are reported as identical;
unequal allocations are reported honestly. It does not infer phase throughput
from machine counts because a final machine may be supply-limited or underclocked.
Each phase must be re-solved from the production graph.

This is still a preview contract, not a claim that floors or wings are isolated.
Spatial phase assignment, input/output trunks, belt and pipe topology, separate
power switching, and post-build connectivity readback remain construction gates.
That distinction comes directly from the owner's two-floor steel reference: a
factory is independently commissionable only when each floor has a complete
material and power path, not merely half of every machine row.

## Trust boundaries

1. A site must supply explicit XYZ. No inferred Z is accepted.
2. Grid and floor measurements must be positive finite values. The compiler
   never guesses a missing floor height.
3. Machine groups must come from a successful measured factory layout. A group
   with no measured footprint is rejected, not assigned a vanilla size.
4. Only integer foundation/floor cells cross into the transform compiler.
5. A semantic part resolves only when its selected recipe class is found in the
   graph's captured catalog with `available: true`. Caller-supplied provenance
   flags are ignored; a model cannot certify its own suggestion as captured.
6. No generated manifest emits an action or reports a construction as complete.
7. The game remains the only writer and must read every committed result back.

## Construction gates still required

Before a concept can become a base, all of these must exist and pass together:

- semantic-role to captured build-recipe resolution, including mod ownership;
- terrain, slope, water and clearance checks over the complete footprint;
- exact foundation, wall, roof, support and machine hologram preflight;
- deferred connection preflight for machines created earlier in one plan;
- splitter, merger, belt, pipe, hypertube and power topology;
- deterministic per-phase rate solving, spatial isolation, dedicated I/O and
  separately switchable power when staged commissioning was requested;
- chunked transactions with rollback and a resumable build journal;
- post-build world read-back against the manifest;
- repair planning for only the observed differences;
- Blueprint Designer population and saved blueprint read-back, if saving rather
  than direct construction is requested.

Claude owns the construction/action side of that seam. Codex owns the
preview-only manifest and compiler. The shared seam is `megabase.design/v1` and
must remain declarative until the game-side gates above are implemented.
