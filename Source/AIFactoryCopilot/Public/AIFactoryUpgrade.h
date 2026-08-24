#pragma once

#include "CoreMinimal.h"
#include "Templates/SubclassOf.h"

class AFGBuildable;
class UFGRecipe;
class UWorld;

/**
 * Upgrading a building to the highest tier the player has unlocked.
 *
 * The owner's words: *"I wanted all the mk1 machines miners constructors and
 * belts to get upgraded to max level"*. The game already knows how to do the
 * swap -- it is what happens when you build a Mk.2 belt over a Mk.1 -- through
 * `AFGHologram::TryUpgrade`, which preserves connections. What is missing is
 * knowing *which* recipe is the top of a given building's family.
 *
 * There is no tier metadata anywhere in the descriptors, so the family has to be
 * read off class names. That is workable but has two traps, and both were found
 * by enumerating this install rather than by reasoning:
 *
 *   Constructor    Mk1        vanilla, Build_ConstructorMk1_C
 *   Constructor_   Mk2, Mk3   modded,  Build_Constructor_Mk2_C
 *
 * The same machine family, split by a trailing underscore. Keying on the exact
 * base name would decide a Constructor Mk.1 is already at max tier -- silently
 * doing nothing for precisely the machines worth upgrading. Same for Smelter,
 * Foundry, Assembler, Manufacturer, Refinery, and Miner (Mk1-3 vanilla, Mk4
 * modded).
 *
 * And `Desc_GunpowderMk2_C` ("Smokeless Powder") is tiered but is an *item*.
 * Walking recipes by descriptor name would try to upgrade gunpowder. Resolving
 * through `UFGBuildingDescriptor::GetBuildableClass` removes that whole class of
 * mistake: only building descriptors yield a buildable class at all.
 */
namespace AIFactoryUpgrade
{
    /** A family's top tier, and how to build it. */
    struct FUpgradeTarget
    {
        TSubclassOf<AFGBuildable> BuildableClass = nullptr;
        TSubclassOf<UFGRecipe> Recipe = nullptr;
        int32 Tier = 0;
        bool IsValid() const { return BuildableClass != nullptr && Recipe != nullptr; }
    };

    /**
     * Split a buildable class name into family and tier.
     *
     * `Build_ConveyorBeltMk3_C` -> ("ConveyorBelt", 3)
     * `Build_Constructor_Mk2_C` -> ("Constructor", 2)   trailing _ normalised
     * `Build_Foundation_8x4_C`  -> ("", 0)              untiered
     *
     * Exposed for tests: the underscore normalisation is the load-bearing part
     * and deserves to be checkable without a world.
     */
    bool ParseTier(const FString& BuildableClassName, FString& OutFamily, int32& OutTier);

    /**
     * The highest unlocked tier in this buildable's family.
     *
     * Returns an invalid target when the building is untiered, already at the
     * top, or when nothing higher is unlocked -- all three are ordinary and not
     * failures.
     */
    FUpgradeTarget FindMaxTier(UWorld* World, TSubclassOf<AFGBuildable> BuildableClass);
}
