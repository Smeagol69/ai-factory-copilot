#pragma once

#include "CoreMinimal.h"
#include "Resources/FGResourceNode.h"

class AFGPlayerController;
class UFGResourceDescriptor;

/** Authoritative entry point that grants and arms the opt-in creative editor. */
namespace AIFactoryCreativeNodePlacement
{
    bool ArmForPlayer(
        AFGPlayerController* PlayerController,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
}
