#include "AIFactoryCreativeNodeHologram.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryCreativeResourceNode.h"
#include "Components/StaticMeshComponent.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceNodeBase.h"

namespace
{
    constexpr float CreativeNodeMinimumPlanarSeparationCm = 450.0f;
    TMap<TWeakObjectPtr<UWorld>, FAIFactoryCreativeResourceNodeConfiguration>
        GPendingCreativeNodeConfigurations;

    // Unity builds compile module .cpp files into shared translation units.
    // Blueprint Anchor owns a similarly shaped helper, so use a feature-
    // specific symbol even inside this anonymous namespace.
    bool AIFactoryCreativeNodeConsumePendingConfiguration(
        UWorld* const World,
        FAIFactoryCreativeResourceNodeConfiguration& OutConfiguration)
    {
        if (!IsValid(World))
        {
            return false;
        }

        const TWeakObjectPtr<UWorld> Key(World);
        const FAIFactoryCreativeResourceNodeConfiguration* const Pending =
            GPendingCreativeNodeConfigurations.Find(Key);
        if (Pending == nullptr)
        {
            return false;
        }

        OutConfiguration = *Pending;
        GPendingCreativeNodeConfigurations.Remove(Key);
        return true;
    }
}

void AAIFactoryCreativeNodeHologram::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AAIFactoryCreativeNodeHologram, mRequestedResource);
    DOREPLIFETIME(AAIFactoryCreativeNodeHologram, mRequestedPurity);
    DOREPLIFETIME(AAIFactoryCreativeNodeHologram, mRequestedNodeType);
}

void AAIFactoryCreativeNodeHologram::BeginPlay()
{
    Super::BeginPlay();

    // Only the owning local Build Gun consumes a pending editor choice. Server
    // holograms receive the same values through CustomSerialization below;
    // they never consult process-local client state.
    if (IsLocalHologram())
    {
        FAIFactoryCreativeResourceNodeConfiguration Pending;
        if (AIFactoryCreativeNodeConsumePendingConfiguration(GetWorld(), Pending))
        {
            FString Reason;
            if (!SetRequestedConfiguration(
                    Pending.ResourceClass,
                    Pending.Purity,
                    Pending.NodeType,
                    Reason))
            {
                UE_LOG(LogAIFactoryCopilot, Warning,
                    TEXT("Creative node Build Gun configuration was rejected locally: %s"),
                    *Reason);
            }
        }
    }

    UpdateRequestedVisual();
}

void AAIFactoryCreativeNodeHologram::PostConstructMessageDeserialization()
{
    Super::PostConstructMessageDeserialization();
    UpdateRequestedVisual();
}

void AAIFactoryCreativeNodeHologram::SetHologramLocationAndRotation(
    const FHitResult& HitResult)
{
    // Let the normal Build Gun own terrain alignment, scroll rotation, range,
    // and its green/red preview lifecycle. This override is intentionally
    // narrow so resource nodes do not silently invent a parallel placement UI.
    Super::SetHologramLocationAndRotation(HitResult);
}

AActor* AAIFactoryCreativeNodeHologram::Construct(
    TArray<AActor*>& OutChildren,
    const FNetConstructionID ConstructionID)
{
    FString Reason;
    if (GetWorld() == nullptr || GetWorld()->GetNetMode() == NM_Client ||
        !AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mRequestedResource, mRequestedPurity, mRequestedNodeType, Reason) ||
        HasOverlappingResourceNode())
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node construction refused server-side: %s"),
            Reason.IsEmpty() ? TEXT("a resource node overlaps this location") : *Reason);
        return nullptr;
    }

    // This construct path runs only inside UFGBuildGunStateBuild's normal
    // server RPC. The deferred spawn lets us install the saved configuration
    // before BeginPlay; there is no companion-side spawn and no client write.
    const FTransform PlacementTransform = GetActorTransform();
    AAIFactoryCreativeResourceNode* const Node =
        GetWorld()->SpawnActorDeferred<AAIFactoryCreativeResourceNode>(
            AAIFactoryCreativeResourceNode::StaticClass(),
            PlacementTransform,
            GetOwner(),
            GetConstructionInstigator(),
            ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
    if (!IsValid(Node))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun construct could not spawn its mod-owned actor"));
        return nullptr;
    }

    if (!Node->ConfigureCreativeNode(
            mRequestedResource,
            mRequestedPurity,
            mRequestedNodeType,
            Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node Build Gun construct rolled back before finish: %s"), *Reason);
        Node->Destroy();
        return nullptr;
    }

    Node->FinishSpawning(PlacementTransform);
    // AAIFactoryCreativeResourceNode inherits static-actor dormancy. The
    // configuration is set while deferred, before the actor is necessarily
    // registered with a replication graph, so wake it again after the normal
    // Build Gun finish point for remote players.
    Node->FlushNetDormancy();
    Node->ForceNetUpdate();
    FNetConstructionID ConstructionIdForLog = ConstructionID;
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Creative node constructed through Build Gun at %s (resource=%s purity=%s construction=%s)"),
        *Node->GetActorLocation().ToCompactString(),
        *mRequestedResource->GetPathName(),
        *StaticEnum<EResourcePurity>()->GetNameStringByValue(
            static_cast<int64>(mRequestedPurity)),
        *ConstructionIdForLog.ToString());
    return Node;
}

bool AAIFactoryCreativeNodeHologram::SetPendingLocalConfiguration(
    UWorld* const World,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    return SetPendingLocalConfiguration(
        World,
        Resource,
        Purity,
        AAIFactoryCreativeResourceNode::NodeTypeForResource(Resource),
        OutReason);
}

bool AAIFactoryCreativeNodeHologram::SetPendingLocalConfiguration(
    UWorld* const World,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(World))
    {
        OutReason = TEXT("the local world is unavailable");
        return false;
    }
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    FAIFactoryCreativeResourceNodeConfiguration& Pending =
        GPendingCreativeNodeConfigurations.FindOrAdd(TWeakObjectPtr<UWorld>(World));
    Pending.SchemaVersion = 2;
    Pending.ResourceClass = Resource;
    Pending.Purity = Purity;
    Pending.NodeType = NodeType;
    return true;
}

void AAIFactoryCreativeNodeHologram::ClearPendingLocalConfiguration(UWorld* const World)
{
    if (IsValid(World))
    {
        GPendingCreativeNodeConfigurations.Remove(TWeakObjectPtr<UWorld>(World));
    }
}

void AAIFactoryCreativeNodeHologram::CheckValidPlacement()
{
    Super::CheckValidPlacement();

    FString Reason;
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mRequestedResource, mRequestedPurity, mRequestedNodeType, Reason))
    {
        AddConstructDisqualifier(
            UAIFactoryCreativeNodeInvalidConfigurationDisqualifier::StaticClass());
        return;
    }

    if (HasOverlappingResourceNode())
    {
        AddConstructDisqualifier(
            UAIFactoryCreativeNodeOverlapsResourceDisqualifier::StaticClass());
    }
}

bool AAIFactoryCreativeNodeHologram::SetRequestedConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    FString& OutReason)
{
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    mRequestedResource = Resource;
    mRequestedPurity = Purity;
    mRequestedNodeType = NodeType;
    UpdateRequestedVisual();
    return true;
}

bool AAIFactoryCreativeNodeHologram::HasOverlappingResourceNode() const
{
    UWorld* const World = GetWorld();
    if (!IsValid(World))
    {
        return true;
    }

    const float MinimumDistanceSquared = FMath::Square(CreativeNodeMinimumPlanarSeparationCm);
    for (TActorIterator<AFGResourceNodeBase> It(World); It; ++It)
    {
        const AFGResourceNodeBase* const Node = *It;
        if (!IsValid(Node))
        {
            continue;
        }

        const FVector Offset = Node->GetActorLocation() - GetActorLocation();
        if (FVector2D(Offset.X, Offset.Y).SizeSquared() < MinimumDistanceSquared)
        {
            return true;
        }
    }
    return false;
}

void AAIFactoryCreativeNodeHologram::UpdateRequestedVisual()
{
    TInlineComponentArray<UStaticMeshComponent*> Visuals(this);
    for (UStaticMeshComponent* const Visual : Visuals)
    {
        if (IsValid(Visual) &&
            Visual->ComponentTags.Contains(TEXT("AIFactoryCreativeNodeVisual")))
        {
            AAIFactoryCreativeResourceNode::ApplyCreativeVisual(Visual, mRequestedResource);
        }
    }
}
