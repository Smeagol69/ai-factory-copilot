#include "AIFactoryCreativeNodePlacement.h"

#include "AIFactoryCreativeNodeContent.h"
#include "AIFactoryCreativeNodeRCO.h"
#include "AIFactoryCreativeResourceNode.h"
#include "AIFactoryWorldEditAccess.h"
#include "Engine/World.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "FGRecipeManager.h"
#include "FGSchematicManager.h"
#include "Resources/FGResourceDescriptor.h"

namespace AIFactoryCreativeNodePlacement
{
bool ArmForPlayer(
    AFGPlayerController* const PlayerController,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    return ArmForPlayer(
        PlayerController,
        Resource,
        Purity,
        AAIFactoryCreativeResourceNode::NodeTypeForResource(Resource),
        OutReason);
}

bool ArmForPlayer(
    AFGPlayerController* const PlayerController,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(PlayerController) || !IsValid(PlayerController->GetWorld()))
    {
        OutReason = TEXT("the requesting player has no active world");
        return false;
    }

    if (!AIFactoryWorldEditAccess::CanEdit(PlayerController, OutReason))
    {
        return false;
    }

    UWorld* const World = PlayerController->GetWorld();

    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    AFGCharacterPlayer* const Player = Cast<AFGCharacterPlayer>(PlayerController->GetPawn());
    AFGSchematicManager* const Schematics = AFGSchematicManager::Get(World);
    AFGRecipeManager* const Recipes = AFGRecipeManager::Get(World);
    if (!IsValid(Player) || !IsValid(Schematics) || !IsValid(Recipes))
    {
        OutReason = TEXT("Satisfactory's player, schematic, or recipe system is not ready");
        return false;
    }

    // Grant through the real schematic system first so the normal Build Gun
    // availability list is persistent and multiplayer-aware. The recipe
    // availability itself is world/save scoped, so it must never be presented
    // as a per-player entitlement; the write/admin gates above protect arming.
    // The explicit fallback only covers a same-frame recipe-manager refresh gap.
    if (!Schematics->IsSchematicPurchased(UAIFactoryCreativeNodeSchematic::StaticClass(), PlayerController))
    {
        Schematics->GiveAccessToSchematic(
            UAIFactoryCreativeNodeSchematic::StaticClass(),
            Player,
            ESchematicUnlockFlags::Force | ESchematicUnlockFlags::SuppressNarrativeMessages);
    }
    if (!Recipes->IsRecipeAvailable(UAIFactoryCreativeNodeRecipe::StaticClass()))
    {
        Recipes->AddAvailableRecipe(UAIFactoryCreativeNodeRecipe::StaticClass());
    }
    if (!Recipes->IsRecipeAvailable(UAIFactoryCreativeNodeRecipe::StaticClass()))
    {
        OutReason = TEXT("the Creative Resource Node recipe did not become available");
        return false;
    }

    UAIFactoryCreativeNodeRCO* const RCO = Cast<UAIFactoryCreativeNodeRCO>(
        PlayerController->GetRemoteCallObjectOfClass(UAIFactoryCreativeNodeRCO::StaticClass()));
    if (!IsValid(RCO))
    {
        OutReason = TEXT("the requesting client's creative-node Build Gun channel is not ready");
        return false;
    }

    // The RCO is a client-only selection handoff. The player still sees and
    // confirms a normal hologram; its construction returns through the Build
    // Gun's own server-authoritative RPC.
    RCO->ClientArmCreativeResourceNode(Resource, Purity, NodeType);
    return true;
}
}
