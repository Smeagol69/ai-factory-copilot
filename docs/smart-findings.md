# What SMART! knows that we didn't

The owner built two spaced smelters with an Iron Ingot recipe using SMART! and
said *"kinda what we are trying to do"*. They were right, and the mod is
installed on this machine, so the question of how it does it is answerable
rather than guessable.

The mod is **`SmartFoundations`** — `FactoryGame/Mods/GameFeatures/SmartFoundations`,
a 4.5 MB C++ DLL. Its config file states the feature surface outright:

```
BeltAutoConnect       bAutoConnectEnabled, BeltRoutingMode, bStackableBeltEnabled
PipeAutoConnect       PipeRoutingMode, PipeIndicator
PowerAutoConnect      PowerConnectMode, PowerConnectRange, bScaleDaisyChainPower
BlueprintAutoConnect  bBlueprintSeamAutoConnectEnabled
BuildingBehavior      bExtendEnabled, SpacingIncrement, StaggerIncrement, ...
```

**Belt auto-connect is the exact thing our `place_belt` has never managed.**

## How it connects belts

Read from the DLL's import table — which FactoryGame functions it links
against — then each one verified present in the CL 502094 headers. This is
learning which public game APIs solve a problem, not copying an implementation.

    UFGFactoryConnectionComponent::FindAllOverlappingConnections   find candidates
    UFGFactoryConnectionComponent::CanConnectTo                    validate the pair
    UFGFactoryConnectionComponent::SetConnection                   join them
    UFGFactoryConnectionComponent::ClearConnection                 unjoin
    UFGFactoryConnectionComponent::GetConnectorNormal              which way it faces
    UFGFactoryConnectionComponent::GetOuterBuildable               owner of a connector
    AFGBuildableConveyorBelt::Respline                             rebuild after a move
    AFGBuildableConveyorBase::SetConveyorChainActor                chain membership

The finder's real signature:

```cpp
static int32 FindAllOverlappingConnections(
    TArray< UFGFactoryConnectionComponent* >& out_Connections,
    UWorld* world,
    const FVector& location,
    float radius,
    EFactoryConnectionDirection direction,
    const TArray< TSubclassOf< AFGBuildable > >& buildableClassFilter = {},
    const TSet< UFGFactoryConnectionComponent* >& ignoredConnections = {} );
```

Its own comment says it *"filters to not include blocked connections or
incompatible connections"* — so the hard part, deciding which connector is
legitimately joinable, is already done by the game. We were building belts by
hologram and hoping they would wire themselves up. The supported route is:
find overlapping connectors, ask `CanConnectTo`, call `SetConnection`.

`SetConveyorChainActor` is also worth noting: conveyor chain membership is the
subject of the one unattributed crash in this project's log
(`AFGConveyorChainActor::Factory_Tick`). SMART! touches it deliberately, which
suggests chain membership is something a mod is expected to manage rather than
something to avoid.

## How it sets a recipe

```cpp
void AFGBuildableManufacturer::SetRecipe( TSubclassOf< UFGRecipe > recipe );  // BlueprintCallable
```

That is the whole answer to *"clicked Iron Ingot"*. One call on a placed
manufacturer.

This matters more than it looks. It is the difference between generating **a
pile of smelters** and generating **a working iron line**. Every planner in
`companion/lib` computes recipes already and has had no way to apply them.

## What this unlocks, put together

Four pieces, all now verified present:

| Piece | Status |
|---|---|
| Spawn arbitrary buildables inside a designer | built — `FScopedMaterialisedInstances` |
| Set a machine's recipe | `AFGBuildableManufacturer::SetRecipe` |
| Join two connectors | `FindAllOverlappingConnections` → `CanConnectTo` → `SetConnection` |
| Serialise the designer to a `.sbp` | built — `SaveBlueprint` |

Chained: **spawn machines at computed transforms, set their recipes, connect
their belts, save the result as a native blueprint.** That is the SMART!
workflow, generated rather than hand-placed, and it is the "planner → blueprint"
step in `GOALS.md` with every unknown now resolved.

It also sidesteps the fragile path entirely — no holograms, no clearance checks,
no Z drift — and inside a designer the game's own loader rewires belts on
placement, which is already why belts inside blueprints work when ad-hoc ones do
not.

## Other things worth stealing

From the panel itself, already taken (commit `8278128`): typed numeric fields
beside every slider, a live consequence readout, and empty states that instruct
rather than apologise.

Not yet taken:

- **Presets with Export/Import codes.** Share a configuration as a text code.
  Real work — serialise, encode, parse, and validate untrusted input — so it
  deserves landing deliberately.
- **`bApplyImmediately`.** A toggle between "preview as I change things" and
  "only when I press Apply". Ours always applies immediately, which is right for
  a slider and wrong for a large selection on a busy map.
- **A movable, scalable HUD** (`HUDScale`, `HUDPositionX/Y`). Our panel is fixed
  at 760x700 in the top-left.
