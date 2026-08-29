#pragma once

#include "CoreMinimal.h"
#include "Resources/FGResourceNode.h"

class AFGPlayerController;
class UWorld;
class UFGResourceDescriptor;

/** Grants and arms the native Build Gun workflow for one explicitly chosen resource. */
namespace AIFactoryBlueprintResourceAnchorPlacement
{
    /**
     * Makes the mod-owned helper recipe visible to Satisfactory's recipe
     * manager.  This is deliberately world-scoped and idempotent: the recipe
     * is an editor control channel, not a progression unlock.  The generated
     * Blueprint path uses this before reading the live catalog, while the
     * explicit /ai anchor path reuses the same check.
     */
    bool EnsureRecipeAvailable(UWorld* World);

    bool ArmForPlayer(
        AFGPlayerController* PlayerController,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
}
