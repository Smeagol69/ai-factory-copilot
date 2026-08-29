#include "AIFactoryCreativeResourceNode.h"

#include "AIFactoryCopilotModule.h"
#include "Components/BoxComponent.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstance.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceDescriptor.h"

namespace
{
    constexpr float CreativeNodeClearanceRadiusCm = 225.0f;
    constexpr float CreativeNodeClearanceHeightCm = 320.0f;

    bool IsCreativePurity(const EResourcePurity Purity)
    {
        return Purity == RP_Inpure || Purity == RP_Normal || Purity == RP_Pure;
    }
}

AAIFactoryCreativeResourceNode::AAIFactoryCreativeResourceNode()
{
    // This actor is static once the Build Gun constructs it. It is not a
    // movable world-object editor handle and can never relocate vanilla data.
    mResourceNodeType = EResourceNodeType::Node;
    // Never expose a usable extractor target before a saved/replicated
    // resource configuration survives the game's own readback. In particular,
    // portable miners consult their flag directly rather than our overridden
    // CanPlaceResourceExtractor() method.
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;

    // Vanilla map nodes receive their optional collision component from their
    // Blueprint asset. A concrete native child has none, so it must own a root
    // explicitly; attaching a visible mesh to a null root produces an actor
    // that the Build Gun cannot trace or place reliably.
    // Keep the actor/root transform identical to the Build Gun hologram. The
    // collision volume itself is raised around the visible deposit, but it is
    // a child rather than an offset root so deferred spawning never applies
    // that height twice and snapshots report the precise chosen XYZ.
    USceneComponent* const Root = CreateDefaultSubobject<USceneComponent>(TEXT("CreativeNodeRoot"));
    SetRootComponent(Root);
    mBoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("CreativeNodeCollision"));
    mBoxComponent->SetupAttachment(Root);
    mBoxComponent->SetBoxExtent(FVector(
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceRadiusCm,
        CreativeNodeClearanceHeightCm * 0.5f));
    mBoxComponent->SetRelativeLocation(FVector(0.0f, 0.0f, CreativeNodeClearanceHeightCm * 0.5f));
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
    // One deliberate addition on top of the shipped profile. AIFactoryNodeEdit
    // keeps an ECC_Visibility line trace as its fallback for a node whose use
    // state has not been cached yet, and vanilla's Resource profile ignores
    // that channel. Blocking it here keeps `/ai node ...` able to resolve a
    // creative node by aim, and only ever makes the node easier to find.
    mBoxComponent->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    mBoxComponent->SetGenerateOverlapEvents(false);

    mCreativeVisual = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("CreativeNodeVisual"));
    mCreativeVisual->SetupAttachment(Root);
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
    return HasValidCreativeConfiguration(Reason) && Super::CanPlaceResourceExtractor();
}

bool AAIFactoryCreativeResourceNode::ConfigureCreativeNode(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can configure a creative resource node");
        return false;
    }

    if (!ValidateCreativeConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }

    const FAIFactoryCreativeResourceNodeConfiguration Previous = mCreativeConfiguration;
    mCreativeConfiguration.SchemaVersion = 1;
    mCreativeConfiguration.ResourceClass = Resource;
    mCreativeConfiguration.Purity = Purity;

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
    if (mCreativeConfiguration.SchemaVersion != 1)
    {
        OutReason = FString::Printf(
            TEXT("creative node configuration schema %d is unsupported"),
            mCreativeConfiguration.SchemaVersion);
        return false;
    }
    return ValidateCreativeConfiguration(
        mCreativeConfiguration.ResourceClass,
        mCreativeConfiguration.Purity,
        OutReason);
}

bool AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(Resource))
    {
        OutReason = TEXT("a creative node needs a known resource descriptor");
        return false;
    }
    if (UFGItemDescriptor::GetForm(Resource) != EResourceForm::RF_SOLID)
    {
        OutReason = TEXT("creative nodes currently support solid resources only");
        return false;
    }
    if (!IsValid(UFGResourceDescriptor::GetDepositMesh(Resource)))
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

    Visual->SetStaticMesh(IsValid(Resource)
        ? UFGResourceDescriptor::GetDepositMesh(Resource)
        : nullptr);
    Visual->SetMaterial(0, IsValid(Resource)
        ? UFGResourceDescriptor::GetDepositMaterial(Resource)
        : nullptr);
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

    mResourceNodeType = EResourceNodeType::Node;
    InitResource(Resource, RA_Infinite, Purity);
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
    mCanPlacePortableMiner = true;
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
        TEXT("nodeType=%d hasResources=%d amount=%d resource=%s purity=%s"),
        CanPlaceResourceExtractor() ? 1 : 0,
        CanBecomeOccupied() ? 1 : 0,
        IsOccupied() ? 1 : 0,
        static_cast<int32>(mResourceNodeType),
        HasAnyResources() ? 1 : 0,
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
