#pragma once

#include "CoreMinimal.h"
#include "FGLightweightBuildableSubsystem.h"
#include "Templates/SubclassOf.h"

struct FAIFactoryActionContext;
struct FAIFactoryActionResult;
class AFGBuildable;

/** One exact, Blueprint-relative native buildable requested by a planner. */
struct FAIFactoryGeneratedBlueprintPart
{
    FString PartId;
    FString Role;
    FString BuildRecipeClassPath;
    FString ProductionRecipeClassPath;
    FTransform RelativeTransform = FTransform::Identity;
};

/** One directed conveyor edge between two generated buildables. */
struct FAIFactoryGeneratedBlueprintConveyor
{
    FString LinkId;
    FString BuildRecipeClassPath;
    FString FromPartId;
    FString ToPartId;
    FString FromConnectorName;
    FString ToConnectorName;
};

/** One physical circuit wire between two generated buildables. */
struct FAIFactoryGeneratedBlueprintPowerWire
{
    FString LinkId;
    FString BuildRecipeClassPath;
    FString FromPartId;
    FString ToPartId;
    FString FromConnectorName;
    FString ToConnectorName;
};

/**
 * Writing a real `.sbp` from buildings standing in the world.
 *
 * Separate from `AIFactoryActions.cpp` on purpose: that file is the placement
 * lane and is already large, and this one borrows the Blueprint Designer in a
 * way that has to be read carefully rather than skimmed past. See the comment
 * at the top of the .cpp for the hazard and the unwind.
 *
 * The result is a native archive. Once written it appears in the player's own
 * blueprint menu and places through the game's Build Gun like any other, which
 * is the whole point -- no size cap, extractors included, no bespoke UI.
 */
namespace AIFactoryBlueprintExport
{
    /**
     * Exports the given buildables as one native blueprint.
     *
     * Refuses rather than improvises: an empty name, an empty selection, no
     * Blueprint Designer in the world, or a designer that already holds the
     * player's own work in progress. Never spawns a designer -- that is a
     * building the player pays for and places.
     *
     * Dry-runnable. On a real run every buildable it marks is unmarked again
     * before the function returns, on every path.
     */
    /**
     * @param LightweightInstances  Structure the actor iterator cannot see.
     *
     * Foundations and walls are held by AFGLightweightBuildableSubsystem as
     * instance data rather than as actors, so a selection built from
     * TActorIterator captures a building's power poles and ladders and none
     * of its shell. A stable instance ref keeps the selection tied to the
     * exact structural piece even if the subsystem later reuses an array
     * index. A stale ref is refused rather than exporting a replacement.
     * Defaulted, so the bridge lane that passes only actors is unchanged.
     */
    FAIFactoryActionResult ExportSelection(
        const FAIFactoryActionContext& Context,
        const FString& BlueprintName,
        const TArray<AFGBuildable*>& Buildables,
        const TArray<FLightweightBuildableInstanceRef>& LightweightInstances = {});

    /**
     * Writes a solver-computed layout as one native Blueprint.
     *
     * Every part is resolved from an unlocked Build Gun recipe by the game.
     * Commit staging uses RF_Transient deferred-spawned native buildables owned
     * by an empty real Blueprint Designer; they are destroyed on every exit.
     * The archive is accepted only after native readback succeeds.
     *
     * v1 remains the ordinary-standalone-buildable contract. v2 additionally
     * carries explicit directed conveyor edges and physical circuit wires.
     * Those links are built from native connection components, then the saved
     * archive is loaded into FactoryGame's isolated Blueprint world and its
     * reciprocal endpoints are read back before success is reported.
     */
    FAIFactoryActionResult GenerateLayout(
        const FAIFactoryActionContext& Context,
        const FString& BlueprintName,
        const FString& BlueprintDescription,
        const TArray<FAIFactoryGeneratedBlueprintPart>& Parts,
        const TArray<FAIFactoryGeneratedBlueprintConveyor>& Conveyors = {},
        const TArray<FAIFactoryGeneratedBlueprintPowerWire>& PowerWires = {},
        const FString& LayoutSchema = TEXT("aifactory.generated-blueprint/v1"));
}
