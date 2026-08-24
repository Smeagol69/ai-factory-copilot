#include "AIFactoryBlueprintResourceAnchorRCO.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorContent.h"
#include "AIFactoryBlueprintResourceAnchorHologram.h"
#include "AIFactoryCopilotModule.h"
#include "Equipment/FGBuildGun.h"
#include "FGCharacterPlayer.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"

UAIFactoryBlueprintResourceAnchorRCO::UAIFactoryBlueprintResourceAnchorRCO()
{
    bForceNetField_AIFactoryBlueprintResourceAnchorRCO = false;
}

void UAIFactoryBlueprintResourceAnchorRCO::BeginDestroy()
{
    AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
    StopObservingBuildGun();
    Super::BeginDestroy();
}

void UAIFactoryBlueprintResourceAnchorRCO::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(UAIFactoryBlueprintResourceAnchorRCO, bForceNetField_AIFactoryBlueprintResourceAnchorRCO);
}

void UAIFactoryBlueprintResourceAnchorRCO::ClientArmBlueprintResourceAnchor_Implementation(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity)
{
    FString Reason;
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(Resource, Purity, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff rejected invalid configuration: %s"),
            *Reason);
        return;
    }

    AFGCharacterPlayer* const Player = GetOwnerPlayerCharacter();
    AFGBuildGun* const BuildGun = IsValid(Player) ? Player->GetBuildGun() : nullptr;
    if (!IsValid(BuildGun))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff could not find the requesting player's Build Gun"));
        return;
    }

    ObserveBuildGun(BuildGun);
    AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
    if (!AAIFactoryBlueprintResourceAnchorHologram::SetPendingLocalConfiguration(
            GetWorld(), Resource, Purity, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff could not stage configuration: %s"),
            *Reason);
        return;
    }

    // This is the documented client-side Build Gun path.  It creates the
    // normal hologram and later calls Satisfactory's server construction RPC.
    BuildGun->GotoBuildState(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass());
    if (!BuildGun->CompareActiveRecipeTo(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass()))
    {
        AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff did not activate its recipe"));
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunStateChanged(const EBuildGunState NewState)
{
    if (NewState != EBuildGunState::BGS_BUILD)
    {
        AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunRecipeChanged(
    const TSubclassOf<UFGRecipe> NewRecipe)
{
    if (NewRecipe != UAIFactoryBlueprintResourceAnchorRecipe::StaticClass())
    {
        AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::ObserveBuildGun(AFGBuildGun* const BuildGun)
{
    if (mObservedBuildGun.Get() == BuildGun)
    {
        return;
    }

    AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
    StopObservingBuildGun();
    if (!IsValid(BuildGun))
    {
        return;
    }

    mObservedBuildGun = BuildGun;
    BuildGun->mOnStateChanged.AddUniqueDynamic(
        this, &UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunStateChanged);
    BuildGun->mOnRecipeChanged.AddUniqueDynamic(
        this, &UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunRecipeChanged);
}

void UAIFactoryBlueprintResourceAnchorRCO::StopObservingBuildGun()
{
    if (AFGBuildGun* const BuildGun = mObservedBuildGun.Get())
    {
        BuildGun->mOnStateChanged.RemoveDynamic(
            this, &UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunStateChanged);
        BuildGun->mOnRecipeChanged.RemoveDynamic(
            this, &UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunRecipeChanged);
    }
    mObservedBuildGun.Reset();
}
