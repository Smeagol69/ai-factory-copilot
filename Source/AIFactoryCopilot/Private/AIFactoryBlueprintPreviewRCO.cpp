#include "AIFactoryBlueprintPreviewRCO.h"

#include "AIFactoryCopilotModule.h"
#include "Equipment/FGBuildGun.h"
#include "FGBlueprintSettings.h"
#include "FGBlueprintSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGRecipe.h"
#include "Net/UnrealNetwork.h"

UAIFactoryBlueprintPreviewRCO::UAIFactoryBlueprintPreviewRCO()
{
    bForceNetField_AIFactoryBlueprintPreviewRCO = false;
}

void UAIFactoryBlueprintPreviewRCO::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(UAIFactoryBlueprintPreviewRCO, bForceNetField_AIFactoryBlueprintPreviewRCO);
}

void UAIFactoryBlueprintPreviewRCO::ClientPreviewBlueprint_Implementation(
    const FString& BlueprintName)
{
    // These are explicitly local-player APIs in FGBuildGun.h. Do not call the
    // private Server_* helpers from a server executor: the normal Build Gun
    // owns that lifecycle and will synchronise its own selected state.
    if (BlueprintName.IsEmpty())
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Build Gun preview was requested without a blueprint name"));
        return;
    }

    AFGCharacterPlayer* Player = GetOwnerPlayerCharacter();
    AFGBuildGun* BuildGun = IsValid(Player) ? Player->GetBuildGun() : nullptr;
    if (!IsValid(BuildGun))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Build Gun preview for %s could not find the owning player's Build Gun"),
            *BlueprintName);
        return;
    }

    UWorld* World = GetWorld();
    AFGBlueprintSubsystem* Blueprints = IsValid(World)
        ? AFGBlueprintSubsystem::Get(World)
        : nullptr;
    // The server refreshes before dispatch, but Blueprint descriptors are a
    // local client concern too. Repeat the public active-session refresh here
    // so a normal Satisfactory file transfer that completed between the RPC
    // and this lookup can register itself without a fabricated descriptor.
    if (IsValid(Blueprints))
    {
        Blueprints->RefreshBlueprintsAndDescriptors();
        Blueprints->RefreshBlueprintRecipeRequirements();
    }
    UFGBlueprintDescriptor* Descriptor = IsValid(Blueprints)
        ? Blueprints->GetBlueprintDescriptorByNameString(BlueprintName)
        : nullptr;
    if (!IsValid(Descriptor))
    {
        // A client can be missing a server blueprint until Satisfactory's own
        // blueprint manifest/file transfer completes. We deliberately do not
        // invent a local descriptor or bypass that system.
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Build Gun preview for %s was not armed because this client has no descriptor"),
            *BlueprintName);
        return;
    }

    const UFGBlueprintSettings* Settings = UFGBlueprintSettings::Get();
    UClass* BlueprintRecipeObject = IsValid(Settings)
        ? Settings->mBlueprintRecipeClass.LoadSynchronous()
        : nullptr;
    if (!BlueprintRecipeObject ||
        !BlueprintRecipeObject->IsChildOf(UFGRecipe::StaticClass()))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Build Gun preview for %s could not load the game's blueprint recipe"),
            *BlueprintName);
        return;
    }
    const TSubclassOf<UFGRecipe> BlueprintRecipe = BlueprintRecipeObject;

    // The documented order matters: SetDesiredBlueprint chooses the descriptor
    // used when the universal blueprint recipe enters the Build Gun state.
    BuildGun->SetDesiredBlueprint(BlueprintName);
    BuildGun->GotoBuildState(BlueprintRecipe);

    if (!BuildGun->IsBlueprintDescriptorActive(Descriptor))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Build Gun preview request for %s reached the client but the native Build Gun did not activate it"),
            *BlueprintName);
        return;
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Blueprint Build Gun preview armed locally for %s"),
        *BlueprintName);
}
