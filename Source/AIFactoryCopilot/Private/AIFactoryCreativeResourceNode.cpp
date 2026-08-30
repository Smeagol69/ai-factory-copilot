#include "AIFactoryCreativeResourceNode.h"

#include "AIFactoryCopilotModule.h"
#include "Components/BoxComponent.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstance.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceDescriptorGeyser.h"
#include "UObject/UObjectGlobals.h"

namespace
{
    constexpr float CreativeNodeClearanceRadiusCm = 225.0f;
    constexpr float CreativeNodeClearanceHeightCm = 320.0f;

    bool IsCreativePurity(const EResourcePurity Purity)
    {
        return Purity == RP_Inpure || Purity == RP_Normal || Purity == RP_Pure;
    }

    UStaticMesh* CreativeFallbackMesh()
    {
        // Resource descriptors for fluids and geysers intentionally do not
        // always carry an ore-deposit mesh. Keep the node visible and easy to
        // aim without inventing a game asset: the engine's basic cylinder is
        // always available in a packaged Unreal game.
        static TWeakObjectPtr<UStaticMesh> Cached;
        if (!Cached.IsValid())
        {
            Cached = LoadObject<UStaticMesh>(
                nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
        }
        return Cached.Get();
    }

    bool IsSupportedNodeType(const EResourceNodeType NodeType)
    {
        return NodeType == EResourceNodeType::Node ||
            NodeType == EResourceNodeType::Geyser;
    }

    FText CreativeNodeLookAtDescription(const AFGResourceNode& Node)
    {
        const FText Purity = StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
            static_cast<int64>(Node.GetResourcePurity()));
        return FText::Format(
            NSLOCTEXT(
                "AIFactoryCopilot",
                "CreativeResourceNodeLookAtDescription",
                "{0} ({1})"),
            Node.GetResourceName(),
            Purity);
    }
}

AAIFactoryCreativeResourceNode::AAIFactoryCreativeResourceNode()
{
    // This actor is static once the Build Gun constructs it. It is not a
    // movable world-object editor handle and can never relocate vanilla data.
    // AFGResourceNodeGeyser's constructor defaults this class to Geyser. The
    // requested kind is persisted and ordinary liquid/gas/solid nodes must
    // explicitly reset it until a valid configuration is applied.
    mResourceNodeType = EResourceNodeType::Node;
    // Never expose a usable extractor target before a saved/replicated
    // resource configuration survives the game's own readback. In particular,
    // portable miners consult their flag directly rather than our overridden
    // CanPlaceResourceExtractor() method.
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;

    // Vanilla BP_ResourceNode exposes its BoxComponent as the actor root. The
    // resource extractor hologram can use that exact root/component contract
    // when it resolves a hit; a scene root with a resource box below it is a
    // visually plausible actor but is not equivalent to a native node. Keep
    // the root transform at the Build Gun's chosen actor transform so the
    // saved XYZ is the node origin, not the top of its visual mesh.
    mBoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("CreativeNodeCollision"));
    SetRootComponent(mBoxComponent);
    mBoxComponent->SetBoxExtent(FVector(
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceHeightCm * 0.5f));
    mBoxComponent->SetRelativeLocation(FVector::ZeroVector);
    // Vanilla resource nodes carry FactoryGame's own shipped "Resource"
    // collision profile: object type Resource (ECC_GameTraceChannel3) with the
    // Hologram channel set to overlap. AFGResourceExtractorHologram finds its
    // target through that object type -- TrySnapToActor/
    // TrySnapToExtractableResource only ever see what the query returns.
    //
    // A box that is object type WorldStatic and blocks only ECC_Visibility is
    // therefore configured perfectly on the inside and invisible to every
    // miner on the outside: mCanPlaceResourceExtractor is true, the readback
    // passes, and no extractor can ever snap to it. That is why a creative
    // node placed as scenery and did nothing.
    //
    // Use the shipped profile by name rather than hand-rolled channel
    // responses so this tracks the game's own definition across updates
    // instead of drifting from it.
    mBoxComponent->SetCollisionProfileName(TEXT("Resource"));
    // Resource is intentionally ignored by Visibility in the vanilla profile;
    // the Build Gun's extractor hologram also performs a BuildGun-channel
    // query. Overlap that channel explicitly so a generated node is discoverable
    // by both paths, while the normal resource object query remains intact.
    mBoxComponent->SetCollisionResponseToChannel(ECC_GameTraceChannel5, ECR_Overlap);
    mBoxComponent->SetGenerateOverlapEvents(true);
    // One deliberate addition on top of the shipped profile. AIFactoryNodeEdit
    // keeps an ECC_Visibility line trace as its fallback for a node whose use
    // state has not been cached yet, and vanilla's Resource profile ignores
    // that channel. Blocking it here keeps `/ai node ...` able to resolve a
    // creative node by aim, and only ever makes the node easier to find.
    mBoxComponent->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);

    mCreativeVisual = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("CreativeNodeVisual"));
    mCreativeVisual->SetupAttachment(mBoxComponent);
    mCreativeVisual->ComponentTags.Add(TEXT("AIFactoryCreativeNodeVisual"));
    // The box stays the resource-query surface. The deposit mesh is what the
    // player physically meets, and a real ore deposit is solid rock you can
    // walk into and stand on -- leaving it NoCollision is what made a placed
    // creative node feel like a decal you walk straight through.
    //
    // Pawn/Visibility/Camera are blocked so it behaves like world geometry.
    // Hologram, Resource and Clearance are deliberately left ignored: the
    // original concern was real, and the mesh must not become a second
    // resource-dependent volume or block a miner's hologram through itself.
    // Physics is enabled because query-only collision never stops a character.
    mCreativeVisual->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    mCreativeVisual->SetCollisionObjectType(ECC_WorldStatic);
    mCreativeVisual->SetCollisionResponseToAllChannels(ECR_Ignore);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Pawn, ECR_Block);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Camera, ECR_Block);
    mCreativeVisual->SetGenerateOverlapEvents(false);
}

void AAIFactoryCreativeResourceNode::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AAIFactoryCreativeResourceNode, mCreativeConfiguration);
}

void AAIFactoryCreativeResourceNode::PostLoadGame_Implementation(
    const int32 SaveVersion,
    const int32 GameVersion)
{
    Super::PostLoadGame_Implementation(SaveVersion, GameVersion);

    FString Reason;
    if (!ApplyCreativeConfiguration(Reason))
    {
        // Never "repair" a bad saved entry by destroying it or inventing a
        // resource. The actor stays visible to the snapshot and reports its
        // invalid state through its missing normal resource fields.
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative resource node %s could not restore its saved configuration: %s"),
            *GetPathName(),
            *Reason);
    }
}

void AAIFactoryCreativeResourceNode::GetClearanceData_Implementation(
    TArray<FFGClearanceData>& OutData) const
{
    Super::GetClearanceData_Implementation(OutData);

    // This is native Satisfactory hologram clearance, not a post-spawn overlap
    // guess. It gives the Build Gun a real green/red preview against ordinary
    // buildables before it ever asks the server to construct this node.
    FFGClearanceData Clearance;
    Clearance.Type = EClearanceType::CT_Default;
    Clearance.ClearanceBox = FBox(
        FVector(-CreativeNodeClearanceRadiusCm, -CreativeNodeClearanceRadiusCm, 0.0f),
        FVector(CreativeNodeClearanceRadiusCm, CreativeNodeClearanceRadiusCm,
            CreativeNodeClearanceHeightCm));
    Clearance.ExcludeForSnapping = true;
    OutData.Add(Clearance);
}

bool AAIFactoryCreativeResourceNode::CanPlaceResourceExtractor() const
{
    FString Reason;
    // The base C++ implementation is backed by the Blueprint CDO field
    // mCanPlaceResourceExtractor. This native class deliberately sets that
    // field after its exact configuration readback; returning it directly
    // avoids a CDO/default mismatch making a valid node look like a deposit.
    return HasValidCreativeConfiguration(Reason) && HasAnyResources() && !IsOccupied();
}

FVector AAIFactoryCreativeResourceNode::GetPlacementLocation(
    const FVector& HitLocation) const
{
    // Resource extractor holograms ask the node for its canonical snap point.
    // The Build Gun already put this actor at the chosen ground location; do
    // not return the visible deposit's top face (which made creative nodes
    // behave like hand-mined deposits sitting above their real source).
    return GetActorLocation();
}

FRotator AAIFactoryCreativeResourceNode::GetPlacementRotation(
    const FVector& HitLocation) const
{
    return GetActorRotation();
}

FText AAIFactoryCreativeResourceNode::GetLookAtDecription_Implementation(
    AFGCharacterPlayer* const,
    const FUseState&) const
{
    // Native BP_ResourceNode fills a private purity-text array in its Blueprint
    // CDO. A native mod subclass has no access to that array, so the inherited
    // formatter falls back to the internal enum token (for example RP_Pure).
    // The enum already carries localized DisplayName metadata; use that exact
    // player-facing text instead of leaking the implementation name.
    return CreativeNodeLookAtDescription(*this);
}

bool AAIFactoryCreativeResourceNode::ConfigureCreativeNode(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    return ConfigureCreativeNode(
        Resource,
        Purity,
        NodeTypeForResource(Resource),
        OutReason);
}

bool AAIFactoryCreativeResourceNode::ConfigureCreativeNode(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can configure a creative resource node");
        return false;
    }

    if (!ValidateCreativeConfiguration(Resource, Purity, NodeType, OutReason))
    {
        return false;
    }

    const FAIFactoryCreativeResourceNodeConfiguration Previous = mCreativeConfiguration;
    mCreativeConfiguration.SchemaVersion = 2;
    mCreativeConfiguration.ResourceClass = Resource;
    mCreativeConfiguration.Purity = Purity;
    mCreativeConfiguration.NodeType = NodeType;

    if (!ApplyCreativeConfiguration(OutReason))
    {
        mCreativeConfiguration = Previous;
        FString RestoreReason;
        ApplyCreativeConfiguration(RestoreReason);
        return false;
    }

    // AFGResourceNode inherits static-actor dormancy. Wake the actor for this
    // deliberate editor change so an already connected client sees the exact
    // resource and purity instead of waiting for an unrelated replication wake.
    FlushNetDormancy();
    ForceNetUpdate();
    return true;
}

bool AAIFactoryCreativeResourceNode::HasValidCreativeConfiguration(FString& OutReason) const
{
    if (mCreativeConfiguration.SchemaVersion != 1 &&
        mCreativeConfiguration.SchemaVersion != 2)
    {
        OutReason = FString::Printf(
            TEXT("creative node configuration schema %d is unsupported"),
            mCreativeConfiguration.SchemaVersion);
        return false;
    }
    const EResourceNodeType NodeType = mCreativeConfiguration.SchemaVersion == 1
        ? EResourceNodeType::Node
        : mCreativeConfiguration.NodeType;
    return ValidateCreativeConfiguration(
        mCreativeConfiguration.ResourceClass,
        mCreativeConfiguration.Purity,
        NodeType,
        OutReason);
}

EResourceNodeType AAIFactoryCreativeResourceNode::NodeTypeForResource(
    const TSubclassOf<UFGResourceDescriptor> Resource)
{
    return IsValid(Resource) &&
        Resource->IsChildOf(UFGResourceDescriptorGeyser::StaticClass())
        ? EResourceNodeType::Geyser
        : EResourceNodeType::Node;
}

bool AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    return ValidateCreativeConfiguration(
        Resource,
        Purity,
        NodeTypeForResource(Resource),
        OutReason);
}

bool AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    const EResourceNodeType NodeType,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(Resource))
    {
        OutReason = TEXT("a creative node needs a known resource descriptor");
        return false;
    }
    if (!IsSupportedNodeType(NodeType))
    {
        OutReason = TEXT("creative nodes support ordinary or geyser node types only");
        return false;
    }

    const bool bIsGeyserDescriptor =
        Resource->IsChildOf(UFGResourceDescriptorGeyser::StaticClass());
    if (NodeType == EResourceNodeType::Geyser && !bIsGeyserDescriptor)
    {
        OutReason = TEXT(
            "a geyser node requires a registered UFGResourceDescriptorGeyser resource");
        return false;
    }
    if (NodeType == EResourceNodeType::Node && bIsGeyserDescriptor)
    {
        OutReason = TEXT(
            "a geyser descriptor must use the native Geyser node type");
        return false;
    }

    const EResourceForm Form = UFGItemDescriptor::GetForm(Resource);
    if (NodeType == EResourceNodeType::Node &&
        Form != EResourceForm::RF_SOLID &&
        Form != EResourceForm::RF_LIQUID &&
        Form != EResourceForm::RF_GAS)
    {
        OutReason = TEXT(
            "ordinary creative nodes require a solid, liquid, or gas resource descriptor");
        return false;
    }
    if (NodeType == EResourceNodeType::Node &&
        Form == EResourceForm::RF_SOLID &&
        !IsValid(UFGResourceDescriptor::GetDepositMesh(Resource)))
    {
        OutReason = TEXT(
            "this resource has no deposit mesh, so the editor refuses to create an invisible node");
        return false;
    }
    if (!IsCreativePurity(Purity))
    {
        OutReason = TEXT("creative node purity must be Impure, Normal, or Pure");
        return false;
    }
    return true;
}

void AAIFactoryCreativeResourceNode::ApplyCreativeVisual(
    UStaticMeshComponent* const Visual,
    const TSubclassOf<UFGResourceDescriptor> Resource)
{
    if (!IsValid(Visual))
    {
        return;
    }

    UStaticMesh* const DescriptorMesh = IsValid(Resource)
        ? UFGResourceDescriptor::GetDepositMesh(Resource)
        : nullptr;
    Visual->SetStaticMesh(IsValid(DescriptorMesh) ? DescriptorMesh : CreativeFallbackMesh());
    Visual->SetMaterial(0, IsValid(Resource)
        ? UFGResourceDescriptor::GetDepositMaterial(Resource)
        : nullptr);

    // A deposit mesh is already authored at the correct scale. The fallback
    // cylinder is intentionally smaller and flatter so a liquid/gas/geyser
    // marker reads as a source point rather than a giant ore boulder.
    const EResourceForm Form = IsValid(Resource)
        ? UFGItemDescriptor::GetForm(Resource)
        : EResourceForm::RF_INVALID;
    Visual->SetRelativeScale3D(
        IsValid(DescriptorMesh) ? FVector::OneVector
        : Form == EResourceForm::RF_LIQUID ? FVector(0.70f, 0.70f, 0.25f)
        : Form == EResourceForm::RF_GAS ? FVector(0.55f, 0.55f, 0.90f)
        : FVector(0.80f, 0.80f, 0.45f));
}

void AAIFactoryCreativeResourceNode::OnRep_CreativeConfiguration()
{
    FString Reason;
    if (!ApplyCreativeConfiguration(Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative resource node %s received an invalid replicated configuration: %s"),
            *GetPathName(),
            *Reason);
    }
}

bool AAIFactoryCreativeResourceNode::ApplyCreativeConfiguration(FString& OutReason)
{
    // A malformed save or replication packet must stay an inert editor actor;
    // it must not become a mineable node from constructor defaults or a prior
    // configuration. This is deliberately reset before every validation.
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;
    if (!HasValidCreativeConfiguration(OutReason))
    {
        ApplyCreativeVisual(mCreativeVisual, nullptr);
        return false;
    }

    const TSubclassOf<UFGResourceDescriptor> Resource = mCreativeConfiguration.ResourceClass;
    const EResourcePurity Purity = mCreativeConfiguration.Purity;

    const EResourceNodeType NodeType = mCreativeConfiguration.SchemaVersion == 1
        ? EResourceNodeType::Node
        : mCreativeConfiguration.NodeType;
    mResourceNodeType = NodeType;
    InitResource(Resource, RA_Infinite, Purity);
    // InitResource sets the amount ENUM but never writes mResourcesLeft, which
    // is the field an extractor actually reads. A live snapshot diff against a
    // working map node showed map=-1 (infinite) versus ours=0 -- the game saw a
    // depleted node and refused every Miner, while HasAnyResources() kept
    // returning true because it consults the enum. That is exactly why the gate
    // diagnostic read all-green for hours while placement still failed.
    mResourcesLeft = -1;
    SetResourceClassOverride(Resource);
    SetResourcePurityOverride(Purity);

    // The data which matters for a miner is read back from Satisfactory's own
    // node implementation. Do not report configuration as accepted merely
    // because the setters returned void.
    if (GetResourceClass() != Resource ||
        GetResourcePurity() != Purity ||
        GetResourceAmount() != RA_Infinite ||
        !HasAnyResources())
    {
        ApplyCreativeVisual(mCreativeVisual, nullptr);
        OutReason = TEXT("Satisfactory did not retain the requested node configuration");
        return false;
    }

    mCanPlaceResourceExtractor = true;
    mCanPlacePortableMiner = NodeType == EResourceNodeType::Node &&
        UFGItemDescriptor::GetForm(Resource) == EResourceForm::RF_SOLID;
    UpdateCanPlacePortableMiner();

    // NOTE: AFGResourceNodeBase::UpdateMeshFromDescriptor(bool, UMaterial*) looks
    // like the right seam here -- it is public in the header and its needRegister
    // argument is the registration this actor never performs -- but it is NOT
    // exported from the shipping FactoryGame DLL. Calling it compiles against the
    // editor target and then fails the Shipping link with LNK2019. The header
    // declaring it is not evidence that a mod can call it, and an editor-target
    // compile is not evidence that the packaged build will link.
    UpdateCreativeVisual();

    // Report every gate an extractor consults. If a miner still refuses after
    // this, the log says which one said no instead of another round of reading
    // headers whose .cpp bodies are stubs in the Starter Project.
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Creative node gates: canPlaceExtractor=%d canBecomeOccupied=%d isOccupied=%d ")
        TEXT("nodeType=%d hasResources=%d resourcesLeft=%d amount=%d resource=%s purity=%s"),
        CanPlaceResourceExtractor() ? 1 : 0,
        CanBecomeOccupied() ? 1 : 0,
        IsOccupied() ? 1 : 0,
        static_cast<int32>(mResourceNodeType),
        HasAnyResources() ? 1 : 0,
        mResourcesLeft,
        static_cast<int32>(GetResourceAmount()),
        *GetNameSafe(GetResourceClass()),
        *StaticEnum<EResourcePurity>()->GetNameStringByValue(
            static_cast<int64>(GetResourcePurity())));
    return true;
}

void AAIFactoryCreativeResourceNode::UpdateCreativeVisual()
{
    ApplyCreativeVisual(mCreativeVisual, mCreativeConfiguration.ResourceClass);
}

AAIFactoryCreativeOrdinaryResourceNode::AAIFactoryCreativeOrdinaryResourceNode()
{
    mResourceNodeType = EResourceNodeType::Node;
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;

    // Match the component contract of BP_ResourceNode: the Resource-profile
    // box is the actor root and therefore the exact hit actor/component seen by
    // AFGResourceExtractorHologram. This class deliberately derives directly
    // from AFGResourceNode so a Miner never sees a disguised geyser subclass.
    mBoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("CreativeOrdinaryNodeCollision"));
    SetRootComponent(mBoxComponent);
    mBoxComponent->SetBoxExtent(FVector(
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceHeightCm * 0.5f));
    mBoxComponent->SetRelativeLocation(FVector::ZeroVector);
    mBoxComponent->SetCollisionProfileName(TEXT("Resource"));
    mBoxComponent->SetCollisionResponseToChannel(ECC_GameTraceChannel5, ECR_Overlap);
    mBoxComponent->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    mBoxComponent->SetGenerateOverlapEvents(true);

    mCreativeVisual = CreateDefaultSubobject<UStaticMeshComponent>(
        TEXT("CreativeOrdinaryNodeVisual"));
    mCreativeVisual->SetupAttachment(mBoxComponent);
    mCreativeVisual->ComponentTags.Add(TEXT("AIFactoryCreativeNodeVisual"));
    mCreativeVisual->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    mCreativeVisual->SetCollisionObjectType(ECC_WorldStatic);
    mCreativeVisual->SetCollisionResponseToAllChannels(ECR_Ignore);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Pawn, ECR_Block);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    mCreativeVisual->SetCollisionResponseToChannel(ECC_Camera, ECR_Block);
    mCreativeVisual->SetGenerateOverlapEvents(false);
}

void AAIFactoryCreativeOrdinaryResourceNode::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(
        AAIFactoryCreativeOrdinaryResourceNode,
        mCreativeConfiguration);
}

void AAIFactoryCreativeOrdinaryResourceNode::PostLoadGame_Implementation(
    const int32 SaveVersion,
    const int32 GameVersion)
{
    Super::PostLoadGame_Implementation(SaveVersion, GameVersion);

    FString Reason;
    if (!ApplyCreativeConfiguration(Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative ordinary resource node %s could not restore its saved configuration: %s"),
            *GetPathName(),
            *Reason);
    }
}

void AAIFactoryCreativeOrdinaryResourceNode::GetClearanceData_Implementation(
    TArray<FFGClearanceData>& OutData) const
{
    Super::GetClearanceData_Implementation(OutData);

    FFGClearanceData Clearance;
    Clearance.Type = EClearanceType::CT_Default;
    Clearance.ClearanceBox = FBox(
        FVector(-CreativeNodeClearanceRadiusCm, -CreativeNodeClearanceRadiusCm, 0.0f),
        FVector(
            CreativeNodeClearanceRadiusCm,
            CreativeNodeClearanceRadiusCm,
            CreativeNodeClearanceHeightCm));
    Clearance.ExcludeForSnapping = true;
    OutData.Add(Clearance);
}

bool AAIFactoryCreativeOrdinaryResourceNode::CanPlaceResourceExtractor() const
{
    FString Reason;
    return (mCreativeConfiguration.SchemaVersion == 1 ||
            mCreativeConfiguration.SchemaVersion == 2) &&
        AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mCreativeConfiguration.ResourceClass,
            mCreativeConfiguration.Purity,
            EResourceNodeType::Node,
            Reason) &&
        Super::CanPlaceResourceExtractor();
}

FVector AAIFactoryCreativeOrdinaryResourceNode::GetPlacementLocation(
    const FVector& HitLocation) const
{
    return GetActorLocation();
}

FRotator AAIFactoryCreativeOrdinaryResourceNode::GetPlacementRotation(
    const FVector& HitLocation) const
{
    return GetActorRotation();
}

FText AAIFactoryCreativeOrdinaryResourceNode::GetLookAtDecription_Implementation(
    AFGCharacterPlayer* const,
    const FUseState&) const
{
    return CreativeNodeLookAtDescription(*this);
}

bool AAIFactoryCreativeOrdinaryResourceNode::ConfigureCreativeNode(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can configure a creative ordinary resource node");
        return false;
    }
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            Resource,
            Purity,
            EResourceNodeType::Node,
            OutReason))
    {
        return false;
    }

    const FAIFactoryCreativeResourceNodeConfiguration Previous = mCreativeConfiguration;
    mCreativeConfiguration.SchemaVersion = 2;
    mCreativeConfiguration.ResourceClass = Resource;
    mCreativeConfiguration.Purity = Purity;
    mCreativeConfiguration.NodeType = EResourceNodeType::Node;
    if (!ApplyCreativeConfiguration(OutReason))
    {
        mCreativeConfiguration = Previous;
        FString RestoreReason;
        ApplyCreativeConfiguration(RestoreReason);
        return false;
    }

    FlushNetDormancy();
    ForceNetUpdate();
    return true;
}

void AAIFactoryCreativeOrdinaryResourceNode::OnRep_CreativeConfiguration()
{
    FString Reason;
    if (!ApplyCreativeConfiguration(Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Creative ordinary resource node %s received an invalid configuration: %s"),
            *GetPathName(),
            *Reason);
    }
}

bool AAIFactoryCreativeOrdinaryResourceNode::ApplyCreativeConfiguration(
    FString& OutReason)
{
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;

    if ((mCreativeConfiguration.SchemaVersion != 1 &&
         mCreativeConfiguration.SchemaVersion != 2) ||
        !AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            mCreativeConfiguration.ResourceClass,
            mCreativeConfiguration.Purity,
            EResourceNodeType::Node,
            OutReason))
    {
        AAIFactoryCreativeResourceNode::ApplyCreativeVisual(mCreativeVisual, nullptr);
        if (OutReason.IsEmpty())
        {
            OutReason = FString::Printf(
                TEXT("creative ordinary node configuration schema %d is unsupported"),
                mCreativeConfiguration.SchemaVersion);
        }
        return false;
    }

    const TSubclassOf<UFGResourceDescriptor> Resource =
        mCreativeConfiguration.ResourceClass;
    const EResourcePurity Purity = mCreativeConfiguration.Purity;
    mResourceNodeType = EResourceNodeType::Node;
    InitResource(Resource, RA_Infinite, Purity);
    // InitResource sets the amount ENUM but never writes mResourcesLeft, which
    // is the field an extractor actually reads. A live snapshot diff against a
    // working map node showed map=-1 (infinite) versus ours=0 -- the game saw a
    // depleted node and refused every Miner, while HasAnyResources() kept
    // returning true because it consults the enum. That is exactly why the gate
    // diagnostic read all-green for hours while placement still failed.
    mResourcesLeft = -1;
    SetResourceClassOverride(Resource);
    SetResourcePurityOverride(Purity);

    if (GetResourceClass() != Resource ||
        GetResourcePurity() != Purity ||
        GetResourceAmount() != RA_Infinite ||
        !HasAnyResources())
    {
        AAIFactoryCreativeResourceNode::ApplyCreativeVisual(mCreativeVisual, nullptr);
        OutReason = TEXT("Satisfactory did not retain the requested ordinary node configuration");
        return false;
    }

    mCanPlaceResourceExtractor = true;
    mCanPlacePortableMiner = UFGItemDescriptor::GetForm(Resource) == EResourceForm::RF_SOLID;
    UpdateCanPlacePortableMiner();
    UpdateCreativeVisual();

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Creative ordinary node gates: canPlaceExtractor=%d canBecomeOccupied=%d ")
        TEXT("isOccupied=%d hasResources=%d resourcesLeft=%d resource=%s purity=%s"),
        CanPlaceResourceExtractor() ? 1 : 0,
        CanBecomeOccupied() ? 1 : 0,
        IsOccupied() ? 1 : 0,
        HasAnyResources() ? 1 : 0,
        mResourcesLeft,
        *GetNameSafe(GetResourceClass()),
        *StaticEnum<EResourcePurity>()->GetNameStringByValue(
            static_cast<int64>(GetResourcePurity())));
    return true;
}

void AAIFactoryCreativeOrdinaryResourceNode::UpdateCreativeVisual()
{
    AAIFactoryCreativeResourceNode::ApplyCreativeVisual(
        mCreativeVisual,
        mCreativeConfiguration.ResourceClass);
}
