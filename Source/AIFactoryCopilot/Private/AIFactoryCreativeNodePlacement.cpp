#include "AIFactoryCreativeNodePlacement.h"

#include "AIFactoryCreativeNodeContent.h"
#include "AIFactoryCreativeNodeRCO.h"
#include "AIFactoryCreativeResourceNode.h"
#include "AIFactoryNodeEdit.h"
#include "AIFactoryWorldEditAccess.h"
#include "Engine/World.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "FGRecipeManager.h"
#include "FGSchematicManager.h"
#include "Resources/FGResourceDescriptor.h"

namespace
{
bool AIFactoryArmCreativeNodeValidated(
    AFGPlayerController* const PlayerController,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    const TSubclassOf<AFGResourceNode> TemplateClass,
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
    EResourceNodeType ProvenNodeType = NodeType;
    const bool bTemplate = IsValid(TemplateClass);
    const bool bConfigurationValid = bTemplate
        ? AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            World, TemplateClass, Resource, Purity, ProvenNodeType, OutReason)
        : AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource, Purity, NodeType, OutReason);
    if (!bConfigurationValid || ProvenNodeType != NodeType)
    {
        if (OutReason.IsEmpty())
        {
            OutReason = TEXT("the special node template changed before the Build Gun could be armed");
        }
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
    // availability list is persistent and multiplayer-aware. The exact special
    // node class is not granted as a recipe; it remains a validated payload on
    // this mod's one universal editor hologram.
    if (!Schematics->IsSchematicPurchased(
            UAIFactoryCreativeNodeSchematic::StaticClass(), PlayerController))
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

    if (bTemplate)
    {
        RCO->ClientArmCreativeResourceNodeTemplate(TemplateClass, Resource, Purity);
    }
    else
    {
        RCO->ClientArmCreativeResourceNode(Resource, Purity, NodeType);
    }
    return true;
}
}

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
    return AIFactoryArmCreativeNodeValidated(
        PlayerController, Resource, Purity, NodeType, nullptr, OutReason);
}

bool ArmTemplateForPlayer(
    AFGPlayerController* const PlayerController,
    const TSubclassOf<AFGResourceNode> TemplateClass,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    EResourceNodeType NodeType = EResourceNodeType::Invalid;
    if (!IsValid(PlayerController) ||
        !AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            PlayerController->GetWorld(),
            TemplateClass,
            Resource,
            Purity,
            NodeType,
            OutReason))
    {
        if (OutReason.IsEmpty())
        {
            OutReason = TEXT("the requested special node template is unavailable");
        }
        return false;
    }
    return AIFactoryArmCreativeNodeValidated(
        PlayerController, Resource, Purity, NodeType, TemplateClass, OutReason);
}
}
