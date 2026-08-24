# Concrete module — a stackable blueprint for this save

Based on **oldshavingfoam's Stackable Concrete Factory (Mk.1)**, adapted to what
is actually unlocked here and to the limestone this base has.

The important thing about that design is that **the blueprint is one floor**. You
do not blueprint the tower; you blueprint the module and place it N times. Every
number below is per floor.

## The module, verified

Cross-checked against `content.recipes` from this install, not recalled:

    Concrete:  3 Limestone -> 1 Concrete in 4s
               = 45/min in, 15/min out per Constructor

    4 Constructors = 180/min limestone in -> 60/min concrete out

That reproduces the guide's stated figures exactly. Power is **16 MW per floor**
(4 MW per Constructor) — taken from the guide's own annotation, since machine
power is not exposed in the snapshot and reciting it would be a guess.

## How tall you can stack it

The limit is the **input belt**, not the building. Each floor draws 180/min off a
riser that has to carry the whole stack.

| Belt | Rate | Floors | Concrete | Power |
|---|---|---|---|---|
| Mk.3 | 270 | 1 | 60/min | 16 MW |
| Mk.4 | 480 | 2 | 120/min | 32 MW |
| Mk.5 | 780 | **4** | 240/min | 64 MW |
| Mk.6 | 1200 | **6** | 360/min | 96 MW |

The guide says "Maximum building height (Mk.5 belt): 4 floors" and the table
lands on 4 for Mk.5, which is a good sign the arithmetic matches the author's.

**This save has Conveyor Belt Mk.6 at 1200/min** — a modded tier, seeded into
`efficiency.json` from this install rather than from vanilla. So the ceiling here
is **6 floors**, not 4.

## Feeding it from the nodes near the hub

The site survey found **3 Normal Limestone nodes, nearest 39 m**, all free, plus
one Pure at 225 m.

Miner Mk.4 is unlocked (720/min base — another modded tier):

| Node | Mk.4 output |
|---|---|
| Normal | 720/min |
| Pure | 1440/min |

Two clean configurations:

**4 floors — the tidy one.** One Miner Mk.4 on a Normal node at **exactly 100%**
gives 720/min, which is exactly four floors. No underclocking, no leftovers, one
node, 39 m away. 240 concrete/min for 64 MW.

**6 floors — the ceiling.** Needs 1080/min, which one Normal node cannot reach.
Two Miner Mk.4s on two Normal nodes at **75% each** = 540 + 540 = 1080/min.
Underclocking rather than running one flat out and one part-idle is deliberate:
the power curve is superlinear (`clock^1.321928`), so two at 75% draw less than
the same output split unevenly. 360 concrete/min for 96 MW.

## The thing that will actually stop you

**96 MW of constructors, before miners.** This base is on biomass, and the
circuit tripped earlier today with seven machines reporting a blown fuse.

A 4-floor tower is 64 MW. That is not a biomass number either. Build the module,
place **one** floor, and add floors as power arrives — the design exists to be
stacked incrementally, which is exactly why it is worth blueprinting.

## Layout for the designer

Blueprint Designer Mk.3 is placed in this world: **6 x 6 foundations, 48 m**. The
module is 4 x 4 foundations (32 m), so it fits with a foundation of margin all
round.

    input riser (Mk.6, whole stack)
        |
     [splitter] --> Constructor A ---> [merger]
        |           Constructor B --->    |
     [splitter] --> Constructor C ---> [merger]
                    Constructor D --->    |
                                          v
                                   output riser

- **Constructors 2 x 2**, recipe set to **Concrete** on each before saving — a
  blueprint stores the recipe, so a placed module arrives already producing.
- **Input**: one riser up the side. A splitter per floor takes 180/min off it and
  feeds two constructors; the pass-through continues to the floor above.
- **Output**: mergers collect 4 x 15/min into 60/min, onto a second riser.
- **Belts inside the module** only ever carry 45/min (to a machine) or 60/min
  (the floor's output), so **Mk.1 belts are sufficient inside**. Only the two
  risers need Mk.6. Building the interior in Mk.1 saves a lot of material across
  six copies.
- Lifts at both risers, so stacking is placing the module directly above and
  letting the lifts meet.

## Why standard Concrete and not an alternate

All four are unlocked here:

| Recipe | Limestone per Concrete | Machine | Also needs |
|---|---|---|---|
| **Concrete** | 3.00 | Constructor | — |
| Wet Concrete | 1.50 | Refinery | 100 m³/min water |
| Fine Concrete | 1.20 | Assembler | Silica |
| Rubber Concrete | 1.11 | Assembler | Rubber |

Rubber Concrete is nearly three times as limestone-efficient. It is also the
wrong recipe for this base right now: it needs a rubber supply, which needs oil,
which this base does not have.

Limestone is not the constraint here — there are three free Normal nodes 39 m
away and one of them alone feeds four floors. **Power is the constraint.** Trading
a resource you have plenty of for a production chain you do not have is a bad
trade, and the standard recipe runs in the cheapest machine of the four.

Worth revisiting once there is oil: Wet Concrete in particular pairs well with
this base, because the cove is right there and water is free.

## Status

This is a design, not a `.sbp` yet. Generating one directly is the pending
capability — `FScopedMaterialisedInstances` already spawns buildables inside a
designer, `AFGBuildableManufacturer::SetRecipe` sets the recipe, and
`SaveBlueprint` serialises. When that lands, this module is the obvious first
thing to generate: it is small, its correctness is checkable against the table
above, and a wrong one costs nothing to delete.
