#include "AIFactoryBlueprintResourceAnchorPlacement.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorContent.h"
#include "AIFactoryBlueprintResourceAnchorRCO.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "FGRecipeManager.h"
#include "FGSchematicManager.h"
#include "Resources/FGResourceDescriptor.h"

namespace AIFactoryBlueprintResourceAnchorPlacement
{
bool EnsureRecipeAvailable(UWorld* const World)
{
    if (!IsValid(World))
    {
        return false;
    }

    AFGRecipeManager* const Recipes = AFGRecipeManager::Get(World);
    if (!IsValid(Recipes))
    {
        return false;
    }

    const TSubclassOf<UFGRecipe> Recipe = UAIFactoryBlueprintResourceAnchorRecipe::StaticClass();
    if (!Recipes->IsRecipeAvailable(Recipe))
    {
        Recipes->AddAvailableRecipe(Recipe);
    }
    return Recipes->IsRecipeAvailable(Recipe);
}

bool ArmForPlayer(
    AFGPlayerController* const PlayerController,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(PlayerController) || !IsValid(PlayerController->GetWorld()))
    {
        OutReason = TEXT("the requesting player has no active world");
        return false;
    }
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }

    UWorld* const World = PlayerController->GetWorld();
    AFGCharacterPlayer* const Player = Cast<AFGCharacterPlayer>(PlayerController->GetPawn());
    AFGSchematicManager* const Schematics = AFGSchematicManager::Get(World);
    AFGRecipeManager* const Recipes = AFGRecipeManager::Get(World);
    if (!IsValid(Player) || !IsValid(Schematics) || !IsValid(Recipes))
    {
        OutReason = TEXT("Satisfactory's player, schematic, or recipe system is not ready");
        return false;
    }

    if (!Schematics->IsSchematicPurchased(
            UAIFactoryBlueprintResourceAnchorSchematic::StaticClass(), PlayerController))
    {
        Schematics->GiveAccessToSchematic(
            UAIFactoryBlueprintResourceAnchorSchematic::StaticClass(),
            Player,
            ESchematicUnlockFlags::Force | ESchematicUnlockFlags::SuppressNarrativeMessages);
    }
    if (!EnsureRecipeAvailable(World))
    {
        OutReason = TEXT("the Blueprint Resource Anchor recipe did not become available");
        return false;
    }

    UAIFactoryBlueprintResourceAnchorRCO* const RCO =
        Cast<UAIFactoryBlueprintResourceAnchorRCO>(
            PlayerController->GetRemoteCallObjectOfClass(
                UAIFactoryBlueprintResourceAnchorRCO::StaticClass()));
    if (!IsValid(RCO))
    {
        OutReason = TEXT("the requesting client's Blueprint Resource Anchor Build Gun channel is not ready");
        return false;
    }

    RCO->ClientArmBlueprintResourceAnchor(Resource, Purity);
    return true;
}
}
