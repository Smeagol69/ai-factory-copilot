#include "AIFactoryBlueprintResourceAnchorRCO.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorContent.h"
#include "AIFactoryBlueprintResourceAnchorHologram.h"
#include "AIFactoryCopilotModule.h"
#include "Equipment/FGBuildGun.h"
#include "FGCharacterPlayer.h"
#include "FGRecipeManager.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"
#include "TimerManager.h"

namespace
{
    // The RCO arrives on the PlayerController channel, while recipe updates
    // arrive through AFGRecipeManager replication.  Give that independent
    // channel a short, bounded window to reach a remote client.
    constexpr int32 BlueprintAnchorRecipeReplicationRetryFrames = 180;
}

UAIFactoryBlueprintResourceAnchorRCO::UAIFactoryBlueprintResourceAnchorRCO()
{
    bForceNetField_AIFactoryBlueprintResourceAnchorRCO = false;
}

void UAIFactoryBlueprintResourceAnchorRCO::BeginDestroy()
{
    CancelPendingArmAndConfiguration();
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

    CancelPendingArmAndConfiguration();
    if (!AAIFactoryBlueprintResourceAnchorHologram::SetPendingLocalConfiguration(
            GetWorld(), Resource, Purity, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff could not stage configuration: %s"),
            *Reason);
        return;
    }

    mPendingResource = Resource;
    mPendingPurity = Purity;
    mArmRetryFramesRemaining = BlueprintAnchorRecipeReplicationRetryFrames;
    TryArmPendingBlueprintResourceAnchor();
}

void UAIFactoryBlueprintResourceAnchorRCO::TryArmPendingBlueprintResourceAnchor()
{
    bArmRetryScheduled = false;
    if (!IsValid(mPendingResource))
    {
        return;
    }

    UWorld* const World = GetWorld();
    if (!IsValid(World))
    {
        SchedulePendingArmRetry();
        return;
    }

    FString Reason;
    if (!AAIFactoryBlueprintResourceAnchorHologram::SetPendingLocalConfiguration(
            World, mPendingResource, mPendingPurity, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff lost its staged configuration: %s"),
            *Reason);
        CancelPendingArmAndConfiguration();
        return;
    }

    AFGRecipeManager* const RecipeManager = AFGRecipeManager::Get(World);
    AFGCharacterPlayer* const Player = GetOwnerPlayerCharacter();
    AFGBuildGun* const BuildGun = IsValid(Player) ? Player->GetBuildGun() : nullptr;
    if (IsValid(BuildGun))
    {
        // Keep watching while the recipe is still in flight: changing away
        // from Build mode cancels the pending handoff instead of unexpectedly
        // arming this recipe later.
        ObserveBuildGun(BuildGun);
    }
    if (!IsValid(RecipeManager) || !IsValid(BuildGun) ||
        !RecipeManager->IsRecipeAvailable(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass()))
    {
        if (IsValid(RecipeManager))
        {
            ObserveRecipeManager(RecipeManager);
        }
        SchedulePendingArmRetry();
        return;
    }

    // This is the documented client-side Build Gun path.  It creates the
    // normal hologram and later calls Satisfactory's server construction RPC.
    BuildGun->GotoBuildState(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass());
    if (BuildGun->CompareActiveRecipeTo(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass()))
    {
        // Keep the hologram configuration staged until the normal Build Gun
        // state/recipe callbacks say the player left this recipe, but no
        // longer retain a recipe-manager retry subscription.
        ClearDeferredArm();
        return;
    }

    SchedulePendingArmRetry();
}

void UAIFactoryBlueprintResourceAnchorRCO::SchedulePendingArmRetry()
{
    if (!IsValid(mPendingResource) || bArmRetryScheduled)
    {
        return;
    }
    if (mArmRetryFramesRemaining-- <= 0 || !IsValid(GetWorld()))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor Build Gun handoff timed out waiting for the recipe or Build Gun"));
        CancelPendingArmAndConfiguration();
        return;
    }

    bArmRetryScheduled = true;
    GetWorld()->GetTimerManager().SetTimerForNextTick(
        FTimerDelegate::CreateUObject(
            this,
            &UAIFactoryBlueprintResourceAnchorRCO::TryArmPendingBlueprintResourceAnchor));
}

void UAIFactoryBlueprintResourceAnchorRCO::ClearDeferredArm()
{
    bArmRetryScheduled = false;
    mArmRetryFramesRemaining = 0;
    mPendingResource = nullptr;
    StopObservingRecipeManager();
}

void UAIFactoryBlueprintResourceAnchorRCO::CancelPendingArmAndConfiguration()
{
    ClearDeferredArm();
    AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(GetWorld());
}

void UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunStateChanged(const EBuildGunState NewState)
{
    if (NewState != EBuildGunState::BGS_BUILD)
    {
        CancelPendingArmAndConfiguration();
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::HandleBuildGunRecipeChanged(
    const TSubclassOf<UFGRecipe> NewRecipe)
{
    if (NewRecipe != UAIFactoryBlueprintResourceAnchorRecipe::StaticClass())
    {
        CancelPendingArmAndConfiguration();
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::HandleRecipeAvailable(
    const TSubclassOf<UFGRecipe> NewRecipe)
{
    if (NewRecipe == UAIFactoryBlueprintResourceAnchorRecipe::StaticClass() &&
        IsValid(mPendingResource))
    {
        TryArmPendingBlueprintResourceAnchor();
    }
}

void UAIFactoryBlueprintResourceAnchorRCO::ObserveBuildGun(AFGBuildGun* const BuildGun)
{
    if (mObservedBuildGun.Get() == BuildGun)
    {
        return;
    }

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

void UAIFactoryBlueprintResourceAnchorRCO::ObserveRecipeManager(
    AFGRecipeManager* const RecipeManager)
{
    if (mObservedRecipeManager.Get() == RecipeManager)
    {
        return;
    }

    StopObservingRecipeManager();
    if (!IsValid(RecipeManager))
    {
        return;
    }

    mObservedRecipeManager = RecipeManager;
    RecipeManager->mOnRecipeAvailable.AddUniqueDynamic(
        this, &UAIFactoryBlueprintResourceAnchorRCO::HandleRecipeAvailable);
}

void UAIFactoryBlueprintResourceAnchorRCO::StopObservingRecipeManager()
{
    if (AFGRecipeManager* const RecipeManager = mObservedRecipeManager.Get())
    {
        RecipeManager->mOnRecipeAvailable.RemoveDynamic(
            this, &UAIFactoryBlueprintResourceAnchorRCO::HandleRecipeAvailable);
    }
    mObservedRecipeManager.Reset();
}
