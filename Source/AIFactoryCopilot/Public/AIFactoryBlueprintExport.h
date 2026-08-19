#pragma once

#include "CoreMinimal.h"

struct FAIFactoryActionContext;
struct FAIFactoryActionResult;
class AFGBuildable;

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
    FAIFactoryActionResult ExportSelection(
        const FAIFactoryActionContext& Context,
        const FString& BlueprintName,
        const TArray<AFGBuildable*>& Buildables);
}
