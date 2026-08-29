#include "AIFactoryCreativeNodeRCO.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryCreativeNodeContent.h"
#include "AIFactoryCreativeNodeHologram.h"
#include "AIFactoryCreativeResourceNode.h"
#include "Equipment/FGBuildGun.h"
#include "Equipment/FGBuildGunBuild.h"
#include "FGCharacterPlayer.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"

UAIFactoryCreativeNodeRCO::UAIFactoryCreativeNodeRCO()
{
    bForceNetField_AIFactoryCreativeNodeRCO = false;
}

void UAIFactoryCreativeNodeRCO::BeginDestroy()
{
    // A configuration only belongs to the currently armed client Build Gun.
    // Never let one survive an RCO/world teardown and get consumed by a later
    // Creative Node hologram in the same process.
    AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
    StopObservingBuildGun();
    Super::BeginDestroy();
}

void UAIFactoryCreativeNodeRCO::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(UAIFactoryCreativeNodeRCO, bForceNetField_AIFactoryCreativeNodeRCO);
}

void UAIFactoryCreativeNodeRCO::ClientArmCreativeResourceNode_Implementation(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType)
{
    FString Reason;
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource, Purity, NodeType, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun handoff rejected its invalid configuration: %s"), *Reason);
        return;
    }

    AFGCharacterPlayer* const Player = GetOwnerPlayerCharacter();
    AFGBuildGun* const BuildGun = IsValid(Player) ? Player->GetBuildGun() : nullptr;
    if (!IsValid(BuildGun))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun handoff could not find the requesting player's Build Gun"));
        return;
    }

    // The Build Gun may defer hologram construction by a tick. Observe both
    // transitions before staging so Escape, dismantle, unequip, or a recipe
    // swap cannot leave a world-scoped configuration for a later hologram.
    // The engine documents that its recipe event can precede state changes.
    ObserveBuildGun(BuildGun);

    // A universal recipe can already be active. Do not leave an old local
    // hologram carrying Copper when the player has just chosen Caterium: update
    // the active Creative Node preview in place when the Build Gun exposes it.
    // CustomSerialization then carries the exact replacement values when the
    // normal server construction RPC is eventually sent.
    AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
    if (BuildGun->CompareActiveRecipeTo(UAIFactoryCreativeNodeRecipe::StaticClass()))
    {
        UFGBuildGunStateBuild* const BuildState = BuildGun->IsInState(EBuildGunState::BGS_BUILD)
            ? Cast<UFGBuildGunStateBuild>(BuildGun->GetCurrentState())
            : nullptr;
        if (AAIFactoryCreativeNodeHologram* const ExistingHologram = IsValid(BuildState)
                ? Cast<AAIFactoryCreativeNodeHologram>(BuildState->GetHologram())
                : nullptr)
        {
            // A normal Build Gun construct message may already be queued for
            // this exact preview. Mutating its CustomSerialization fields at
            // that point could make the visual say Caterium while the queued
            // server message still constructs Copper. Preserve the pending
            // placement exactly as the player clicked it; they can re-arm
            // after the Build Gun has completed that construction.
            if (ExistingHologram->GetIsPendingToBeConstructed())
            {
                UE_LOG(LogAIFactoryCopilot, Warning,
                    TEXT("Creative node Build Gun reconfiguration ignored because the current placement is already pending; wait for it to finish, then run the command again"));
                return;
            }

            if (ExistingHologram->SetRequestedConfiguration(
                    Resource, Purity, NodeType, Reason))
            {
                UE_LOG(LogAIFactoryCopilot, Display,
                    TEXT("Creative node Build Gun preview reconfigured locally (resource=%s purity=%s)"),
                    *Resource->GetPathName(),
                    *StaticEnum<EResourcePurity>()->GetNameStringByValue(static_cast<int64>(Purity)));
                return;
            }

            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Creative node Build Gun reconfiguration was refused locally: %s"), *Reason);
            return;
        }

        // There is no live Creative Node hologram to update even though this
        // recipe is remembered as active. Leave and re-enter Build state so a
        // fresh native hologram consumes the staged configuration below.
        BuildGun->GotoMenuState();
    }

    // Store before the normal local Build Gun call. If Hologram creation is
    // deferred to the next client tick, the entry remains world-scoped until
    // that particular Creative Node preview consumes it.
    if (!AAIFactoryCreativeNodeHologram::SetPendingLocalConfiguration(
            GetWorld(), Resource, Purity, NodeType, Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun handoff could not stage its configuration: %s"), *Reason);
        return;
    }

    BuildGun->GotoBuildState(UAIFactoryCreativeNodeRecipe::StaticClass());
    if (!BuildGun->CompareActiveRecipeTo(UAIFactoryCreativeNodeRecipe::StaticClass()))
    {
        AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun handoff reached the client but did not activate its recipe"));
        return;
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Creative node Build Gun hologram armed locally (resource=%s purity=%s)"),
        *Resource->GetPathName(),
        *StaticEnum<EResourcePurity>()->GetNameStringByValue(static_cast<int64>(Purity)));
}

void UAIFactoryCreativeNodeRCO::HandleBuildGunStateChanged(const EBuildGunState NewState)
{
    if (NewState != EBuildGunState::BGS_BUILD)
    {
        AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
    }
}

void UAIFactoryCreativeNodeRCO::HandleBuildGunRecipeChanged(
    const TSubclassOf<UFGRecipe> NewRecipe)
{
    if (NewRecipe != UAIFactoryCreativeNodeRecipe::StaticClass())
    {
        AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
    }
}

void UAIFactoryCreativeNodeRCO::ObserveBuildGun(AFGBuildGun* const BuildGun)
{
    if (mObservedBuildGun.Get() == BuildGun)
    {
        return;
    }

    // A staged value belongs to the old Build Gun, not the player/world in
    // general. Discard it before changing observers.
    AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(GetWorld());
    StopObservingBuildGun();
    if (!IsValid(BuildGun))
    {
        return;
    }

    mObservedBuildGun = BuildGun;
    BuildGun->mOnStateChanged.AddUniqueDynamic(
        this, &UAIFactoryCreativeNodeRCO::HandleBuildGunStateChanged);
    BuildGun->mOnRecipeChanged.AddUniqueDynamic(
        this, &UAIFactoryCreativeNodeRCO::HandleBuildGunRecipeChanged);
}

void UAIFactoryCreativeNodeRCO::StopObservingBuildGun()
{
    if (AFGBuildGun* const BuildGun = mObservedBuildGun.Get())
    {
        BuildGun->mOnStateChanged.RemoveDynamic(
            this, &UAIFactoryCreativeNodeRCO::HandleBuildGunStateChanged);
        BuildGun->mOnRecipeChanged.RemoveDynamic(
            this, &UAIFactoryCreativeNodeRCO::HandleBuildGunRecipeChanged);
    }
    mObservedBuildGun.Reset();
}
