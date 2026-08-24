#pragma once

#include "CoreMinimal.h"
#include "Resources/FGResourceNode.h"

class AFGPlayerController;
class UFGResourceDescriptor;

/** Grants and arms the native Build Gun workflow for one explicitly chosen resource. */
namespace AIFactoryBlueprintResourceAnchorPlacement
{
    bool ArmForPlayer(
        AFGPlayerController* PlayerController,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
}
