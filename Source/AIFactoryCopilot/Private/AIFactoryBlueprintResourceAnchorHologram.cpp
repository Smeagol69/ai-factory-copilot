#include "AIFactoryBlueprintResourceAnchorHologram.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryCopilotModule.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"

namespace
{
    TMap<TWeakObjectPtr<UWorld>, FAIFactoryBlueprintResourceAnchorConfiguration>
        GPendingBlueprintAnchorConfigurations;

    bool ConsumePendingConfiguration(
        UWorld* const World,
        FAIFactoryBlueprintResourceAnchorConfiguration& OutConfiguration)
    {
        if (!IsValid(World))
        {
            return false;
        }

        const TWeakObjectPtr<UWorld> Key(World);
        const FAIFactoryBlueprintResourceAnchorConfiguration* const Pending =
            GPendingBlueprintAnchorConfigurations.Find(Key);
        if (Pending == nullptr)
        {
            return false;
        }

        OutConfiguration = *Pending;
        GPendingBlueprintAnchorConfigurations.Remove(Key);
        return true;
    }
}

AAIFactoryBlueprintResourceAnchorHologram::AAIFactoryBlueprintResourceAnchorHologram()
{
    // The root anchor itself is an ordinary Designer member.  This is not a
    // bypass for miners: their own holograms are separately opted in and still
    // require a successful snap to the anchor's AFGResourceNode child.
    mCanBePlacedInBlueprintDesigner = true;
}

void AAIFactoryBlueprintResourceAnchorHologram::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AAIFactoryBlueprintResourceAnchorHologram, mRequestedResource);
    DOREPLIFETIME(AAIFactoryBlueprintResourceAnchorHologram, mRequestedPurity);
}

void AAIFactoryBlueprintResourceAnchorHologram::BeginPlay()
{
    Super::BeginPlay();

    if (IsLocalHologram())
    {
        FAIFactoryBlueprintResourceAnchorConfiguration Pending;
        if (ConsumePendingConfiguration(GetWorld(), Pending))
        {
            FString Reason;
            if (!SetRequestedConfiguration(Pending.ResourceClass, Pending.Purity, Reason))
            {
                UE_LOG(LogAIFactoryCopilot, Warning,
                    TEXT("Blueprint Resource Anchor Build Gun configuration was rejected locally: %s"),
                    *Reason);
            }
        }
    }
    UpdateRequestedVisual();
}

void AAIFactoryBlueprintResourceAnchorHologram::PostConstructMessageDeserialization()
{
    Super::PostConstructMessageDeserialization();
    UpdateRequestedVisual();
}

bool AAIFactoryBlueprintResourceAnchorHologram::SetPendingLocalConfiguration(
    UWorld* const World,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(World))
    {
        OutReason = TEXT("the local world is unavailable");
        return false;
    }
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }

    FAIFactoryBlueprintResourceAnchorConfiguration& Pending =
        GPendingBlueprintAnchorConfigurations.FindOrAdd(TWeakObjectPtr<UWorld>(World));
    Pending.SchemaVersion = 1;
    Pending.ResourceClass = Resource;
    Pending.Purity = Purity;
    return true;
}

void AAIFactoryBlueprintResourceAnchorHologram::ClearPendingLocalConfiguration(UWorld* const World)
{
    if (IsValid(World))
    {
        GPendingBlueprintAnchorConfigurations.Remove(TWeakObjectPtr<UWorld>(World));
    }
}

void AAIFactoryBlueprintResourceAnchorHologram::CheckValidPlacement()
{
    Super::CheckValidPlacement();

    FString Reason;
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(
            mRequestedResource,
            mRequestedPurity,
            Reason))
    {
        AddConstructDisqualifier(
            UAIFactoryBlueprintResourceAnchorInvalidConfigurationDisqualifier::StaticClass());
    }
}

void AAIFactoryBlueprintResourceAnchorHologram::ConfigureActor(
    AFGBuildable* const InBuildable) const
{
    Super::ConfigureActor(InBuildable);

    AAIFactoryBlueprintResourceAnchor* const Anchor =
        Cast<AAIFactoryBlueprintResourceAnchor>(InBuildable);
    if (!IsValid(Anchor) || !Anchor->HasAuthority())
    {
        return;
    }

    FString Reason;
    if (!Anchor->ConfigureAnchor(mRequestedResource, mRequestedPurity, Reason))
    {
        // The same validated values are attached to the construct message, so
        // this can only fail on an unavailable world/lifecycle transition.
        // Refuse visibly in the log instead of yielding an unconfigured root.
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor construction could not configure %s: %s"),
            *Anchor->GetPathName(),
            *Reason);
    }
}

bool AAIFactoryBlueprintResourceAnchorHologram::SetRequestedConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }
    mRequestedResource = Resource;
    mRequestedPurity = Purity;
    UpdateRequestedVisual();
    return true;
}

void AAIFactoryBlueprintResourceAnchorHologram::UpdateRequestedVisual()
{
    TInlineComponentArray<UStaticMeshComponent*> Visuals(this);
    for (UStaticMeshComponent* const Visual : Visuals)
    {
        if (IsValid(Visual) &&
            Visual->ComponentTags.Contains(TEXT("AIFactoryBlueprintAnchorVisual")))
        {
            AAIFactoryBlueprintAnchorNode::ApplyResourceVisual(Visual, mRequestedResource);
        }
    }
}
