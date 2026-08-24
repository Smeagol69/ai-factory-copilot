# The Cove — designed against a terrain scan

Supersedes the earlier `undercroft-cyberpunk.md` draft, which was written from
screenshots and assumed a straight cliff face and a palette that turns out to be
locked on this save. Both assumptions were wrong. This one is measured.

## The survey

`/aifactory terrain 120 3` — 9,216 probes, 3 m pitch, every one hit ground.

| | |
|---|---|
| **Water surface** | **89.5 m** (p25 89.4, p75 91.1 — dead flat) |
| Shelf at the hub | **4.8 m** above water → **94.3 m** |
| Rock outcrop at the hub | **8–20 m** above water, water on both sides |
| Cliff, west | up to **71.5 m** above water |
| Water within 45 m of hub | ~2,772 m² |
| Flat shelf within 45 m | ~2,529 m², slope < 10° |

The site is a **rock knoll standing in a cove**, backed by a cliff to the west
and edged by a flat terrace to the east. That is a far better shape than the
linear terrace I first drew — a bowl throws light back at itself.

## The constraint that shapes everything

248 of 4,040 recipes are unlocked. **No floodlights, no catwalks, no railings,
no beams, no `Wall_Orange_8x1`.** The neon-gantry idea is not buildable here.

What *is* unlocked is better suited to this water anyway:

| Piece | Role |
|---|---|
| `Desc_FoundationGlass_01_C` | lit floor over black water |
| `Desc_Foundation_Frame_01_C` | open grating, industrial |
| `Desc_Wall_Window_Thin_8x4_01/02_C` | tall thin glazing |
| `Desc_Roof_Window_01–04_C` | glass roof |
| `Desc_PillarBase_C`, `Desc_PillarMiddle_C`, `Desc_Pillar_Small_Metal_C` | pilings |
| `Desc_Wall_Concrete_8x1_C` | 1 m banding strip |
| `Desc_WallSet_Steel_Angular_8x4/8x8` | faceted panels |
| `Desc_Foundation_Metal_8x1/8x2/8x4_C` | dark deck |

So: **a lit glass volume standing over dark water on pilings**, not a neon
gantry. Cleaner, and it suits a still black pool.

## The design

**Deck level 96 m.** That is 6.5 m above the water and ~1.7 m above the shelf —
one `Foundation_Metal_8x2` proud of the terrace, so the deck reads as *placed on*
the site rather than dug into it. Pilings are then 6.5 m: tall enough to read as
pilings rather than posts in a puddle. That was the one thing I said I would
check before committing, and the scan clears it.

**Footprint 6 × 6 foundations = 48 m × 48 m**, centred on the rock outcrop so the
knoll carries the middle and the outer ring hangs over water.

    ring 3   over water — glass floor, pilings to 89.5 m
    ring 2   the enclosure — glazing, banding, glass roof
    core     on the rock — no foundation, build to the stone

### Core, on the knoll

Do not flatten it. The outcrop is 8–20 m above water, so it already rises through
the deck. Leave a **3 × 3 foundation void** and let the rock come up through the
floor as an interior feature. `Desc_Foundation_Frame_01_C` around the opening so
the grating reads as a walkway around a boulder.

This is the single move that makes the build belong to this site and nowhere
else.

### Ring 2, the enclosure

Per 8 m bay, bottom to top:

    Desc_Foundation_Metal_8x2_C        deck, dark
    Desc_Wall_Concrete_8x1_C           1 m banding strip
    Desc_Wall_Window_Thin_8x4_01_C     4 m glazing
    Desc_Wall_Concrete_8x1_C           1 m banding
    Desc_Roof_Window_01_C              glass roof

Break every 4th bay with `Desc_WallSet_Steel_Angular_8x8_C` for a faceted solid.
One `Desc_Wall_Concrete_Gate_8x4_C` on the east face, toward the flat shelf —
that is where belts and foot traffic arrive from.

**The west face gets no glazing.** It faces a 71 m cliff 20 m away; glass there
looks at rock. Solid `WallSet_Steel_Angular_8x4` instead.

### Ring 3, over the water

`Desc_FoundationGlass_01_C` on the outer ring, dropped to **pillars** at 89.5 m:

    Desc_PillarBase_C          at the waterline
    Desc_PillarMiddle_C  x2    stacked to 96 m
    Desc_Pillar_Small_Metal_C  the thin outriggers between them

Glass floor over dark water, with the pillars visible through it. No railing is
unlocked, so keep the outer row `Foundation_Frame_01` — the grating edge reads as
deliberate where a bare slab edge would read as unfinished.

## Colour

Two, no more. **Near-black** on every structural piece; **orange** only on the
`Wall_Concrete_8x1` banding. Orange on ~5% of surface reads as neon; on 40% it
reads as a shipping container. Your existing building already sets this ratio.

## Build order

1. Pillars first, from the waterline at 89.5 m — everything hangs off them
2. Ring 3 deck at 96 m, working inward
3. Ring 2 deck, then the void framing around the rock
4. Walls: west solid, then east gate, then glazing last
5. Glass roof

## What the scan cannot tell me

Slope and height, yes; **what the rock looks like**, no. The 3 × 3 void is sized
from the outcrop's 8–20 m band, but whether the stone reads well coming through a
floor is a judgement from standing there. Build the void framing before the
glazing and look at it — if the rock is uglier than it looked, cap it and the
design still stands.

Nothing here is a blueprint file yet. Generating it directly is the next
capability: `FScopedMaterialisedInstances` already spawns arbitrary buildables
inside a designer and serialises them, which is a blueprint generator pointed at
computed transforms rather than at existing instance data.
