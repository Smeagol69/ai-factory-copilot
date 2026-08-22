# How Smart! works, and what it means for us

**Smart!** (`SmartFoundations` 34.3.1, by Finalomega) — a GameFeature plugin,
4.5 MB C++ DLL, depending on SML ^3.12.0 and `AbstractInstance`. Installed on
this machine, so how it works is answerable rather than guessable.

Method: read the DLL import table for which FactoryGame functions it links
against, and the shipped PDB for its own class and method names, then verify
every game symbol against the CL 502094 headers. This is learning which public
game APIs solve a problem — not reading or copying an implementation.

---

## The one finding that matters

**Smart! never bypasses the build gun. It extends it.**

That is the whole architectural difference between it and our placement lane, and
it explains most of what has gone wrong for us.

Our path: spawn a hologram ourselves, set its transform, call `Construct`. The
consequences have filled this project's log — Z drift we had to correct by
measuring, clearance failures, belts that would not connect.

Its path: hook the build gun's own build state, take the hologram the game
already made, and add *child* holograms to it.

    ASFSmartHologram          the parent, owns grid / spacing / stagger
      ASFSmartChildHologram          one placement
      ASFSmartFactoryChildHologram   a machine
      ASFSmartLogisticsChildHologram a belt, pipe or wire
    FSFSmartBuildableAdapter / FSFSmartLogisticsAdapter
                              normalise buildable kinds behind one interface

`ASFSmartHologram::ReplaceChildWithSmartHologram` is the hinge: the game creates
its normal child hologram, Smart! swaps in its own, and from then on it is inside
the game's placement pipeline rather than alongside it.

It then lets the game do the judging. It calls, and does not reimplement:

    AFGHologram::CheckValidPlacement    CheckClearance      CheckCanAfford
    AFGHologram::AdjustForGround        GetClearanceData    CanBeZooped
    AFGHologram::DoMultiStepPlacement   CanTakeNextBuildStep

`AdjustForGround` is the one that stings. We spent a build cycle discovering a
974 cm Z error and correcting it by measuring the drift and re-running the
placement. The game has a function for exactly that, and Smart! calls it.

## How it commits

```cpp
// Equipment/FGBuildGunBuild.h
void SetActiveRecipe( TSubclassOf< UFGRecipe > recipe );                       // :171
TSubclassOf< UFGRecipe > GetActiveRecipe() const;                              // :172
TArray< FItemAmount > GetHologramCost() const;                                 // :201
AFGHologram* GetHologram() const;                                              // :205
void Server_ConstructHologram( FNetConstructionID clientNetConstructID,
                               FConstructHologramMessage data );               // :209
```

`Server_ConstructHologram` is the supported, server-authoritative, replicated
construction path, paired with
`AFGBuildableSubsystem::GetNewNetConstructionID`. Smart! also routes through
`UFGRemoteCallObject`, so everything it does is multiplayer-correct by
construction.

**We construct client-side and locally.** That works in single player and is a
latent multiplayer bug in every placement action we have.

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

1. **Route placement through the build gun.** `Server_ConstructHologram` with a
   `FNetConstructionID`, instead of constructing locally. Fixes replication, and
   probably makes the Z correction and several clearance workarounds unnecessary
   — `AdjustForGround` already exists.
2. **Manage conveyor chains on every belt operation.** Even if it is not the
   cause of the crash, not doing it is unsound.
3. **Connect belts by connector, not by hologram.**
   `FindAllOverlappingConnections` → `CanConnectTo` → `SetConnection`.
4. **Set recipes.** One call, and it is the difference between generating a pile
   of smelters and generating a working iron line. Every planner in
   `companion/lib` already computes recipes and has had no way to apply them.

Then the generated-blueprint chain has no unknowns left: spawn buildables in a
designer (`FScopedMaterialisedInstances`, built), set their recipes, join their
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
