# The Undercroft — a cyberpunk terrace on the river cliff

A design for the site around the owner's HUB: a river channel running roughly
east–west, a dark stratified rock wall on the far bank, sandy clearing on the
near side. Designed from vision frames 001, 003 and 009 plus the capture's
resource survey.

**Every asset named here was verified present in the owner's own exported
blueprint** (`claude test v1.sbp`, 51 distinct classes). Nothing is invented and
nothing is recalled from vanilla — if it is listed, they have built with it.

---

## The idea in one line

Do not build a box on the bank. **Build into the rock and out over the water**,
so the cliff is the back wall and the river is the floor you look down through.

Cyberpunk in Satisfactory is not a colour scheme, it is three things: *verticality
in a tight space*, *light from below and behind*, and *visible infrastructure*.
The site hands you all three for free — a cliff to stack against, water to bounce
floodlights off, and an existing coal plant already smoking on the skyline.

---

## Footprint and levels

Three decks, 4 m apart (one `Build_Foundation_Concrete_8x4_C` thickness each),
running **along** the water rather than facing it. Long and thin beats square
here: it hugs the cliff, it reads as a street, and it keeps every window facing
the water.

    Deck 3  ── catwalk web, cable runs, floodlight gantry     (cliff top)
    Deck 2  ── the main floor: glass, orange banding          (mid cliff)
    Deck 1  ── cantilevered over water, glass floor sections  (waterline)
                 ↓ pilings into the riverbed

Suggested size: **16 foundations long × 4 deep** (128 m × 32 m). Scale to the
straight section of cliff; the length matters more than the depth.

---

## Level by level

### Deck 1 — over the water

The move that makes the whole thing work. Run the deck **past the bank** so its
outer third hangs over the river.

| Piece | Class | Use |
|---|---|---|
| Deck | `Build_Foundation_Concrete_8x4_C` | main slab |
| Windows in the floor | `Build_FoundationGlass_01_C` | every 3rd panel on the outer row |
| Pilings | `Build_Beam_Support_C` + `Build_Beam_C` | down into the water, deliberately visible |
| Skirt | `Build_QuarterPipeMiddle_Concrete_8x4_C` | where deck meets bank, hides the seam |
| Edge | `Build_Railing_01_C` | outer edge only |

**Light it from underneath.** `Build_FloodlightWall_C` mounted on the pilings,
aimed up at the deck underside. The water throws it back and the glass floor
panels glow from below. This is the single highest-impact detail in the build.

### Deck 2 — the main floor

Where the banding lives, and where your existing building's language carries over.

Alternate vertically, bottom to top, per 8 m bay:

    Build_Wall_Orange_8x1_C            ← thin orange strip, reads as neon
    Build_Wall_Window_Thin_8x4_02_C    ← tall thin glazing
    Build_Wall_Orange_8x1_C
    Build_Wall_8x4_01_C                ← solid, breaks the rhythm

Break the run every 4th bay with `Build_Wall_Window_8x4_05_C` for a wide pane,
and put one `Build_BigGarageDoor_16x8_C` at the downstream end — a big opening
at one end stops a long façade reading as a wall.

**The cliff side gets no windows.** It gets machinery:
`Build_LargeVent_C` and `Build_LargeFan_C` alternating, `Build_Beam_Cable_C` run
diagonally between them, `Build_PowerPoleWall_C` at each bay. Industrial back-of-
house texture, and it means the cliff never needs to be flattened.

### Deck 3 — the gantry

Mostly open. This is the level that sells the silhouette from across the river.

- `Build_CatwalkStraight_C` / `Build_CatwalkT_C` / `Build_CatwalkCross_C` as a web
- `Build_CatwalkStairs_C` and `Build_Ladder_C` connecting all three decks
- `Build_Beam_H_C` spanning from the deck **into the rock face** — cantilevers
  anchored to the cliff, not columns to the ground
- `Build_FloodlightWall_C` on a `Build_PowerPoleWallDouble_C` row, angled *down
  and outward* over the water
- `Build_Roof_Tar_01_C` in patches only — partial roofing reads as unfinished
  industrial, full roofing reads as a warehouse

---

## Colour

Two colours, no more. The existing building already sets it:

- **Near-black** on all structural pieces (beams, catwalks, railings, foundations)
- **Orange** on the `8x1` strips *only*

The discipline is the effect. Orange on 5% of the surface reads as neon; orange
on 40% reads as a shipping container.

---

## Why this site specifically

From the capture, within 250 m of the HUB:

- **6 Pure Iron nodes, nearest 96 m, all unoccupied** — the deck has a reason to
  exist; run the smelting line along Deck 2 with the output belt on Deck 1
- **1 Pure Copper at 54 m, already taken**
- **3 Normal + 1 Pure Limestone from 39 m**
- **3 water extractor spots** — the river is already usable, so the pilings are
  not purely decorative
- **No coal within 250 m** — power comes from elsewhere, so keep the cliff face
  free for the trunk line

---

## Build order

1. Level the bank with `Build_Foundation_Concrete_8x4_C`, one row at a time
2. Push Deck 1 out over the water, pilings **after** the deck (build the slab,
   then support it — the reverse fights the snapping)
3. Deck 2 floor, then the cliff-side wall, then the window façade last
4. Deck 3 catwalks and the floodlight row
5. Lighting last, at night, adjusting as you go — this is the part that cannot
   be planned on paper

---

## Honest limits

Designed from three screenshots. I cannot measure the cliff's exact height or
where the straight section runs, so **16 × 4 is a starting proportion, not a
survey**. The one thing worth checking before committing: whether the water is
deep enough at the outer edge that the pilings read as pilings rather than as
posts in a puddle. If it is shallow, move the whole thing 8 m out and accept a
longer bridge to the bank.

This is a design, not a blueprint file. Generating it directly is the next
capability — `FScopedMaterialisedInstances` already spawns arbitrary buildables
inside a designer and serialises them, which is a blueprint generator pointed at
computed transforms rather than at existing instance data.
