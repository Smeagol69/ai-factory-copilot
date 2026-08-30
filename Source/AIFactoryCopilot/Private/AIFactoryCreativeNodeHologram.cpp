#include "AIFactoryCreativeNodeHologram.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryCreativeResourceNode.h"
#include "AIFactoryNodeEdit.h"
#include "Components/StaticMeshComponent.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceNodeBase.h"

namespace
{
    constexpr float CreativeNodeMinimumPlanarSeparationCm = 450.0f;
    struct FAIFactoryPendingCreativeNodeConfiguration
    {
        TSubclassOf<UFGResourceDescriptor> ResourceClass = nullptr;
        TEnumAsByte<EResourcePurity> Purity = RP_Normal;
        EResourceNodeType NodeType = EResourceNodeType::Node;
        TSubclassOf<AFGResourceNode> TemplateClass = nullptr;
    };

    TMap<TWeakObjectPtr<UWorld>, FAIFactoryPendingCreativeNodeConfiguration>
        GPendingCreativeNodeConfigurations;

    // Unity builds compile module .cpp files into shared translation units.
    // Blueprint Anchor owns a similarly shaped helper, so use a feature-
    // specific symbol even inside this anonymous namespace.
    bool AIFactoryCreativeNodeConsumePendingConfiguration(
        UWorld* const World,
        FAIFactoryPendingCreativeNodeConfiguration& OutConfiguration)
    {
        if (!IsValid(World))
        {
            return false;
        }

        const TWeakObjectPtr<UWorld> Key(World);
        const FAIFactoryPendingCreativeNodeConfiguration* const Pending =
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
    DOREPLIFETIME(AAIFactoryCreativeNodeHologram, mRequestedTemplateClass);
}

void AAIFactoryCreativeNodeHologram::BeginPlay()
{
    Super::BeginPlay();

    // Only the owning local Build Gun consumes a pending editor choice. Server
    // holograms receive the same values through CustomSerialization below;
    // they never consult process-local client state.
    if (IsLocalHologram())
    {
        FAIFactoryPendingCreativeNodeConfiguration Pending;
        if (AIFactoryCreativeNodeConsumePendingConfiguration(GetWorld(), Pending))
        {
            FString Reason;
            const bool bAccepted = IsValid(Pending.TemplateClass)
                ? SetRequestedTemplateConfiguration(
                    Pending.TemplateClass,
                    Pending.ResourceClass,
                    Pending.Purity,
                    Reason)
                : SetRequestedConfiguration(
                    Pending.ResourceClass,
                    Pending.Purity,
                    Pending.NodeType,
                    Reason);
            if (!bAccepted)
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
    UWorld* const World = GetWorld();
    if (!IsValid(World) || World->GetNetMode() == NM_Client)
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node construction refused outside the authoritative world"));
        return nullptr;
    }

    EResourceNodeType ProvenNodeType = mRequestedNodeType;
    const bool bTemplate = IsValid(mRequestedTemplateClass);
    const bool bConfigurationValid = bTemplate
        ? AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            World,
            mRequestedTemplateClass,
            mRequestedResource,
            mRequestedPurity,
            ProvenNodeType,
            Reason)
        : AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mRequestedResource,
            mRequestedPurity,
            mRequestedNodeType,
            Reason);
    if (!bConfigurationValid || ProvenNodeType != mRequestedNodeType ||
        HasOverlappingResourceNode())
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative node construction refused server-side: %s"),
            Reason.IsEmpty()
                ? ProvenNodeType != mRequestedNodeType
                    ? TEXT("the special template's node type changed before construction")
                    : TEXT("a resource node overlaps this location")
                : *Reason);
        return nullptr;
    }

    const FTransform PlacementTransform = GetActorTransform();

    if (bTemplate)
    {
        // Preserve the mod's exact actor class. Refined Power's Water Turbine
        // node, for example, owns its 8/20/50 MW behavior in that subclass and
        // intentionally reports RF_INVALID/Invalid; a generic Water node is
        // not equivalent. The class/resource pair was proved by a live actor
        // above and is read back again after its Blueprint construction script.
        AFGResourceNode* const Node = World->SpawnActorDeferred<AFGResourceNode>(
            mRequestedTemplateClass,
            PlacementTransform,
            GetOwner(),
            GetConstructionInstigator(),
            ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
        if (!IsValid(Node))
        {
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Creative node Build Gun could not spawn special template %s"),
                *GetNameSafe(mRequestedTemplateClass.Get()));
            return nullptr;
        }

        Node->InitResource(mRequestedResource, RA_Infinite, mRequestedPurity);
        Node->SetResourceClassOverride(mRequestedResource);
        Node->SetResourcePurityOverride(mRequestedPurity);
        Node->FinishSpawning(PlacementTransform);
    // DO NOT clear the Build Gun ownership here. It was tried, on the theory
    // that a placement trace ignores actors the gun owns, and it was wrong
    // twice: the Miner still refused the node, and clearing the owner also
    // broke hand-mining on every newly placed node. The owner is load-bearing
    // for interaction.
    //
    // The evidence was clean: nodes placed before the change still hand-mined
    // afterwards, and they receive the same mResourcesLeft repair on save load,
    // so the only thing unique to the broken ones was the cleared owner.

        // Blueprint construction may reapply class defaults. The overrides are
        // the game's SaveGame/replicated seams, so set them once more and then
        // require the exact custom node contract to survive readback.
        Node->SetResourceClassOverride(mRequestedResource);
        Node->SetResourcePurityOverride(mRequestedPurity);
        if (Node->GetClass() != mRequestedTemplateClass.Get() ||
            Node->GetResourceClass() != mRequestedResource ||
            Node->GetResourcePurity() != mRequestedPurity ||
            Node->GetResourceAmount() != RA_Infinite ||
            Node->GetResourceNodeType() != mRequestedNodeType ||
            !Node->HasAnyResources() ||
            !Node->CanPlaceResourceExtractor())
        {
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Creative special node template failed exact post-construction readback and was removed"));
            Node->Destroy();
            return nullptr;
        }

        Node->FlushNetDormancy();
        Node->ForceNetUpdate();
        FNetConstructionID ConstructionIdForLog = ConstructionID;
        UE_LOG(LogAIFactoryCopilot, Display,
            TEXT("Creative special node constructed through Build Gun at %s ")
            TEXT("(template=%s resource=%s purity=%s construction=%s)"),
            *Node->GetActorLocation().ToCompactString(),
            *mRequestedTemplateClass->GetPathName(),
            *mRequestedResource->GetPathName(),
            *StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
                static_cast<int64>(mRequestedPurity)).ToString(),
            *ConstructionIdForLog.ToString());
        return Node;
    }

    if (mRequestedNodeType == EResourceNodeType::Geyser)
    {
        AAIFactoryCreativeResourceNode* const Node =
            World->SpawnActorDeferred<AAIFactoryCreativeResourceNode>(
                AAIFactoryCreativeResourceNode::StaticClass(),
                PlacementTransform,
                GetOwner(),
                GetConstructionInstigator(),
                ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
        if (!IsValid(Node) || !Node->ConfigureCreativeNode(
                mRequestedResource,
                mRequestedPurity,
                EResourceNodeType::Geyser,
                Reason))
        {
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Creative geyser construct was refused: %s"), *Reason);
            if (IsValid(Node))
            {
                Node->Destroy();
            }
            return nullptr;
        }
        Node->FinishSpawning(PlacementTransform);
    // DO NOT clear the Build Gun ownership here. It was tried, on the theory
    // that a placement trace ignores actors the gun owns, and it was wrong
    // twice: the Miner still refused the node, and clearing the owner also
    // broke hand-mining on every newly placed node. The owner is load-bearing
    // for interaction.
    //
    // The evidence was clean: nodes placed before the change still hand-mined
    // afterwards, and they receive the same mResourcesLeft repair on save load,
    // so the only thing unique to the broken ones was the cleared owner.
        Node->FlushNetDormancy();
        Node->ForceNetUpdate();
        return Node;
    }

    // Ordinary resources use an actual AFGResourceNode subclass. This concrete
    // inheritance is what a native Miner hologram expects when it specializes
    // its snap behavior; changing a geyser's enum to Node is not equivalent.
    AAIFactoryCreativeOrdinaryResourceNode* const Node =
        World->SpawnActorDeferred<AAIFactoryCreativeOrdinaryResourceNode>(
            AAIFactoryCreativeOrdinaryResourceNode::StaticClass(),
            PlacementTransform,
            GetOwner(),
            GetConstructionInstigator(),
            ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
    if (!IsValid(Node) || !Node->ConfigureCreativeNode(
            mRequestedResource,
            mRequestedPurity,
            Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative ordinary node construct was refused: %s"), *Reason);
        if (IsValid(Node))
        {
            Node->Destroy();
        }
        return nullptr;
    }

    Node->FinishSpawning(PlacementTransform);
    // DO NOT clear the Build Gun ownership here. It was tried, on the theory
    // that a placement trace ignores actors the gun owns, and it was wrong
    // twice: the Miner still refused the node, and clearing the owner also
    // broke hand-mining on every newly placed node. The owner is load-bearing
    // for interaction.
    //
    // The evidence was clean: nodes placed before the change still hand-mined
    // afterwards, and they receive the same mResourcesLeft repair on save load,
    // so the only thing unique to the broken ones was the cleared owner.
    Node->FlushNetDormancy();
    Node->ForceNetUpdate();
    FNetConstructionID ConstructionIdForLog = ConstructionID;
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Creative ordinary node constructed through Build Gun at %s ")
        TEXT("(resource=%s purity=%s construction=%s)"),
        *Node->GetActorLocation().ToCompactString(),
        *mRequestedResource->GetPathName(),
        *StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
            static_cast<int64>(mRequestedPurity)).ToString(),
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

    FAIFactoryPendingCreativeNodeConfiguration& Pending =
        GPendingCreativeNodeConfigurations.FindOrAdd(TWeakObjectPtr<UWorld>(World));
    Pending.ResourceClass = Resource;
    Pending.Purity = Purity;
    Pending.NodeType = NodeType;
    Pending.TemplateClass = nullptr;
    return true;
}

bool AAIFactoryCreativeNodeHologram::SetPendingLocalTemplateConfiguration(
    UWorld* const World,
    const TSubclassOf<AFGResourceNode> TemplateClass,
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

    EResourceNodeType NodeType = EResourceNodeType::Invalid;
    if (!AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            World, TemplateClass, Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    FAIFactoryPendingCreativeNodeConfiguration& Pending =
        GPendingCreativeNodeConfigurations.FindOrAdd(TWeakObjectPtr<UWorld>(World));
    Pending.ResourceClass = Resource;
    Pending.Purity = Purity;
    Pending.NodeType = NodeType;
    Pending.TemplateClass = TemplateClass;
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
    EResourceNodeType ProvenNodeType = mRequestedNodeType;
    const bool bConfigurationValid = IsValid(mRequestedTemplateClass)
        ? AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            GetWorld(),
            mRequestedTemplateClass,
            mRequestedResource,
            mRequestedPurity,
            ProvenNodeType,
            Reason)
        : AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mRequestedResource, mRequestedPurity, mRequestedNodeType, Reason);
    if (!bConfigurationValid || ProvenNodeType != mRequestedNodeType)
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
    mRequestedTemplateClass = nullptr;
    UpdateRequestedVisual();
    return true;
}

bool AAIFactoryCreativeNodeHologram::SetRequestedTemplateConfiguration(
    const TSubclassOf<AFGResourceNode> TemplateClass,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    EResourceNodeType NodeType = EResourceNodeType::Invalid;
    if (!AIFactoryNodeEdit::ValidateCreativeNodeTemplate(
            GetWorld(), TemplateClass, Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    mRequestedResource = Resource;
    mRequestedPurity = Purity;
    mRequestedNodeType = NodeType;
    mRequestedTemplateClass = TemplateClass;
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
