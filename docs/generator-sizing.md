# Sizing a power plant without guessing

## The gap

Asked for coal power "step 1 to end", the copilot has to answer one question it
currently cannot: **how many generators does this node support?**

It refuses to answer, and says why — a coal generator's burn rate is not in the
snapshot. `AIFactorySnapshot.cpp` captures circuit totals (production capacity,
consumption, batteries) but nothing per generator. Hardcoding 15 coal/min would
be inventing a number the save could contradict: this player runs 50 mods,
including RefinedPower, which adds generators of its own.

So the player is asked instead. That is honest, but it is friction on the one
question they most wanted answered.

## It is derivable — verified against the headers

Checked against `D:\Modding\Satisfactory\StarterProject\Source\FactoryGame\Public`,
not recalled. Every signature below was read from the real header.

`Buildables/FGBuildableGenerator.h`

| Member | Signature |
|---|---|
| `GetDefaultPowerProductionCapacity` | `float GetDefaultPowerProductionCapacity() const` |
| `GetPowerProductionCapacity` | `float GetPowerProductionCapacity() const` |
| `GetLoadPercentage` | `float GetLoadPercentage() const` |

`Buildables/FGBuildableGeneratorFuel.h`

| Member | Signature |
|---|---|
| `GetDefaultFuelClasses` | `FORCEINLINE TArray<TSoftClassPtr<UFGItemDescriptor>> GetDefaultFuelClasses() const` |
| `GetRequiresSupplementalResource` | `FORCEINLINE bool GetRequiresSupplementalResource() const` |
| `GetSupplementalResourceClass` | `FORCEINLINE TSubclassOf<UFGItemDescriptor> GetSupplementalResourceClass() const` |
| `GetSupplementalConsumptionRateMaximum` | `float GetSupplementalConsumptionRateMaximum() const` |
| `IsValidFuel` | `bool IsValidFuel(TSubclassOf<UFGItemDescriptor>) const` |

`Resources/FGItemDescriptor.h`

| Member | Signature |
|---|---|
| `GetEnergyValue` | `static float GetEnergyValue(TSubclassOf<UFGItemDescriptor> inClass)` |

### The arithmetic

Power is MJ/s and a fuel item is worth MJ, so the burn rate falls out:

```
items_per_minute = (power_mw / energy_value_mj_per_item) * 60
```

This is the game's own relationship, not a table copied from a wiki, so it
stays correct across mods, fuel types, and balance changes.

### No generator needs to exist

`GetDefaultPowerProductionCapacity` and `GetDefaultFuelClasses` read from the
class default object, so the values come off the **build recipe's product
class** — no instance to measure. That matters: a player switching to coal power
has no coal generator yet, which is exactly when they ask.

```cpp
// Sketch. Not compiled — the game was open, and StarterProject is not to be
// touched while it is running.
if (const AFGBuildableGeneratorFuel* Default =
        GetDefault<AFGBuildableGeneratorFuel>(GeneratorClass))
{
    Json->SetNumberField(TEXT("power_production_mw"),
        Default->GetDefaultPowerProductionCapacity());
    Json->SetBoolField(TEXT("requires_supplemental_resource"),
        Default->GetRequiresSupplementalResource());
    // fuel classes -> UFGItemDescriptor::GetEnergyValue -> items/min
}
```

## The miner side is the same shape

`Buildables/FGBuildableResourceExtractor.h`

| Member | Signature |
|---|---|
| `GetNumExtractedItemsPerCycle` | `FORCEINLINE int32 GetNumExtractedItemsPerCycle() const` |
| `GetDefaultExtractCycleTime` | `float GetDefaultExtractCycleTime() const { return mExtractCycleTime; }` |
| `GetExtractionPerMinute` | `float GetExtractionPerMinute() const` (instance) |

Both `GetDefault*`-style accessors are `FORCEINLINE` reads of `UPROPERTY`
fields, so they come off the CDO like the generator's do:

```
items_per_minute = items_per_cycle / cycle_time_seconds * 60 * purity_multiplier
```

## What is already known, and what is not

The snapshot is closer than it looked. Verified in
`AIFactorySnapshot.cpp`:

| Fact | Captured? | Where |
|---|---|---|
| Node purity (Normal / Pure / Impure) | **yes** | line 957, `EResourcePurity` |
| Node resource class | **yes** | line 950 |
| Highest available tech tier | **yes** | line 1343 |
| Which miner and generator are unlocked | **yes** | build recipes, `available` |
| Miner extraction rate | no | needs the extractor CDO above |
| Generator burn rate | no | needs the generator CDO above |

So the copilot already knows it is a normal coal node, what tier the player is,
and which miner they can build. **Only two numbers are missing**, and both come
from the same kind of CDO read. That is one change to the snapshot, not a
redesign — and once it lands, "how many generators?" stops being a question the
player has to answer.

## What it unblocks

1. **The count stops being a question.** Node purity and miner tier give
   coal/min; burn rate gives coal/min per generator; the ratio is the answer.
2. **Water gets a number.** `GetRequiresSupplementalResource` is the water flag
   and `GetSupplementalConsumptionRateMaximum` is the rate, so the reply can say
   how much water the plant needs rather than only that it needs some.
3. **It generalises.** Nothing here is coal-specific — fuel generators, and the
   modded ones this save has, all answer the same way.

## Before doing it

- **The game must be closed.** This changes the mod's C++ and needs a rebuild,
  and `StarterProject` is not to be touched while the game is running.
- **Compile before believing any of it.** Two engine-API mistakes have already
  been caught only at compile time — `FHitResult::Component` needing
  `UPrimitiveComponent`, and `GetRotationStep() <= 0` meaning "no override"
  rather than "cannot rotate". Headers verified is not the same as compiles.
- **`GetSupplementalConsumptionRateMaximum` is not a CDO accessor** — unlike the
  two `GetDefault*` calls, it is a plain method and may depend on instance
  state. Check what it returns on a default object before relying on it; if it
  is unusable there, the ratio field behind it is the fallback.
- Keep the refusal path. If a class is not a fuel generator, or a value comes
  back non-finite, the count stays unknown and the player is asked — the same
  answer as today, not a zero presented as fact.
