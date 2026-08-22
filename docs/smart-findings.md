# How Smart! works, and what it means for us

**Smart!** (`SmartFoundations` 34.3.1, by Finalomega) — a GameFeature plugin,
4.5 MB C++ DLL, depending on SML ^3.12.0 and `AbstractInstance`. Installed on
this machine, so how it works is answerable rather than guessable.

Method: read the DLL import table for which FactoryGame functions it links
against, and the shipped PDB for its own class and method names, then verify
every game symbol against the CL 502094 headers. This is learning which public
game APIs solve a problem — not reading or copying an implementation.

---

## Correction: we already do most of this

**An earlier version of this document claimed "Smart! never bypasses the build
gun — we do" and made that the headline finding. That was wrong.** It was
written from Smart!'s import list without first reading our own placement lane.
Recorded rather than quietly edited, because the wrong version was pushed and
may have been read.

`AIFactoryActions.cpp` already follows the build gun's lifecycle deliberately:

    AFGHologram::SpawnHologramFromRecipe      with the build gun as owner
    ResetConstructDisqualifiers
    ValidatePlacementAndCost                  with the player's inventory
    CanConstruct                              gate
    DoMultiStepPlacement                      advanced while CanTakeNextBuildStep
    Construct( children, Buildables->GetNewNetConstructionID() )

The comment above that sequence names `Server_ConstructHologram` as the model
it copies, and `CheckActionPreconditions` refuses to run at all under
`NM_Client` (`not_server_authoritative`). So the "latent multiplayer bug in
every placement action" claimed earlier is also wrong: we do not construct on
clients, we decline.

What Smart! genuinely does differently is *where the holograms come from* — it
adopts the ones the build gun already owns and multiplies them into children,
while we spawn our own from a recipe. Both end at the same `Construct`. Its way
is better for a mod that decorates the player's own build action; ours is
better for placing something the player never aimed at. Neither is a bypass.

### The gap that is real

`AFGHologram::AdjustForGround` — **zero calls in our code**.

```cpp
/**
 * Adjust the placement for the ground, this should be the last step in the
 * placement. Usually for things such as updating legs on buildings and such.
 */
virtual void AdjustForGround( FVector& out_adjustedLocation, FRotator& out_adjustedRotation );
```

The header says plainly that it should be the last step of placement, and we
have never run it. Smart! does. This is one call, not an architecture.

It must not run when the caller asked for an exact Z: `exact_z` exists so a
plan can put a machine at a stated height, and ground adjustment would fight
it. Ground-adjust when the caller did not specify a height, honour the request
when they did.
## Conveyor chains — this likely explains our crash

Smart! calls all of these:

    AFGBuildableSubsystem::AddConveyor
    AFGBuildableSubsystem::RemoveConveyor
    AFGBuildableSubsystem::MigrateConveyorGroupToChainActor
    AFGBuildableSubsystem::RemoveChainActorFromConveyorGroup
    AFGBuildableSubsystem::RemoveConveyorChainActor
    AFGBuildableSubsystem::ForceDestroyChainActor
    AFGBuildableConveyorBase::SetConveyorChainActor

Belts are not independent actors once they join a chain; the chain owns them, and
changing a belt means telling the chain. Smart! manages that membership
explicitly on every belt operation.

**We never touch chain membership at all.** This project has exactly one
unattributed crash — `AFGConveyorChainActor::Factory_Tick`, 34 minutes after a
blueprint export, with no AIFactoryCopilot frame on the stack. A chain ticking
over belts whose membership no longer matched reality is a very good candidate
for that, and it is the first explanation offered that fits the evidence.

Not proven. But it is now the leading theory, and it is testable.

## Belt connection

    UFGFactoryConnectionComponent::FindAllOverlappingConnections   find candidates
    UFGFactoryConnectionComponent::CanConnectTo                    validate
    UFGFactoryConnectionComponent::SetConnection                   join
    UFGFactoryConnectionComponent::GetConnectorNormal              facing
    AFGBuildableConveyorBelt::Respline                             rebuild after a move

```cpp
static int32 FindAllOverlappingConnections(
    TArray< UFGFactoryConnectionComponent* >& out_Connections,
    UWorld* world, const FVector& location, float radius,
    EFactoryConnectionDirection direction,
    const TArray< TSubclassOf< AFGBuildable > >& buildableClassFilter = {},
    const TSet< UFGFactoryConnectionComponent* >& ignoredConnections = {} );
```

Its own comment: *"filters to not include blocked connections or incompatible
connections."* The hard part — deciding which connector is legitimately
joinable — is already solved by the game. Our `place_belt` built belts by
hologram and hoped they would wire themselves up.

## Recipes

Two routes, and Smart! uses the first:

```cpp
UFGBuildGunStateBuild::SetActiveRecipe( recipe );          // before placing
AFGBuildableManufacturer::SetRecipe( recipe );             // on a placed machine
AFGRecipeManager::GetAvailableRecipesForProducer(          // what a machine can run
    TSubclassOf< UObject > forProducer,
    TArray< TSubclassOf< UFGRecipe > >& out_recipes );
```

That is the whole of "clicked Iron Ingot". `GetAvailableRecipesForProducer` is
also exactly what a recipe dropdown in our panel would need, and it respects
what the player has unlocked.

`SampleClipboardSettingsFromActor` is the MMB "Sample Building" feature —
copying settings off an existing building, which is a cheaper version of what
our clone lane does by hand.

## What to change here, in order

Re-ranked after reading our own code. The original list led with routing
placement through the build gun, which is largely already done.

1. **Call `AdjustForGround` as the last placement step**, except when the
   caller asked for an exact Z. One call; the header says it belongs there.
2. **Manage conveyor chains on every belt operation.** `AddConveyor`,
   `RemoveConveyor`, `MigrateConveyorGroupToChainActor`,
   `RemoveChainActorFromConveyorGroup`. We touch chain membership never, and
   it is the leading theory for the one unexplained crash in this log.
3. **Connect belts by connector, not by hologram.**
   `FindAllOverlappingConnections` → `CanConnectTo` → `SetConnection`. This is
   the genuine capability gap — `place_belt` has never reliably connected.
4. **Set recipes.** `AFGBuildableManufacturer::SetRecipe`, plus
   `AFGRecipeManager::GetAvailableRecipesForProducer` for what a machine can
   run. Every planner in `companion/lib` computes recipes already and has had
   no way to apply them.

Then the generated-blueprint chain has no unknowns: spawn buildables in a
designer (`FScopedMaterialisedInstances`, built), set recipes, join
connectors, serialise with `SaveBlueprint` (built).
## From the panel, separately

Already taken (`8278128`): typed numeric fields beside every slider, a live
consequence readout, empty states that instruct.

Not yet: preset **Export/Import codes** (serialise, encode, and validate
untrusted input — worth landing deliberately); **`bApplyImmediately`**, a toggle
between live preview and preview-on-Apply, which ours needs for large selections
on a busy map; and a **movable, scalable HUD** (`HUDScale`, `HUDPositionX/Y`)
where ours is pinned at 760x700.

---

## The QOL worth copying first

From the Extend screenshot, in order of value-per-line-of-code.

### have / need, not just need

The build cost row reads `130/15  73/16  1,306/28  51/1  67/2` — **carried over
required**, per ingredient, colouring the ones you are short of.

Our new rebuild-cost line reports totals. Totals answer "what does this cost";
they do not answer the question a player is actually asking, which is **"can I
place this right now"**. The player's inventory is already reachable, so this is
a small change to a line that already exists — and it turns a fact into a
decision.

### Tiny / Small / Large adjustment

Ctrl, Alt and Shift modify the increment of whatever control is active — one
binding, three precisions, no extra UI. Compare our approach: a slider, then a
typed box added beside it because the slider could not be precise. A modifier is
cheaper than a second widget and does not consume panel space.

`SpacingIncrement`, `StepsIncrement`, `StaggerIncrement` and `RotationIncrement`
in the config are the base values those modifiers scale.

### Extend

`bExtendEnabled` — continue an existing structure by its own pattern rather than
placing from scratch, with the multiplier shown as plain text (`Extend: 1x1`).
Conceptually close to our `planStructure`, but driven off a building the player
is pointing at instead of parameters they typed.

### The transform gizmo

A 3D manipulator on the hologram, rather than numeric fields for rotation. The
most expensive item here and the least essential — worth noting, not worth
copying before the four architectural fixes above.
