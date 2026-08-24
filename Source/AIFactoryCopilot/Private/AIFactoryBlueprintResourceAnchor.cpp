#include "AIFactoryBlueprintResourceAnchor.h"

#include "AIFactoryCopilotModule.h"

#include "Buildables/FGBuildableResourceExtractorBase.h"
#include "Components/BoxComponent.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "FGBlueprintSubsystem.h"
#include "Hologram/FGHologram.h"
#include "Net/UnrealNetwork.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceDescriptor.h"
#include "TimerManager.h"
#include "UObject/UnrealType.h"

namespace
{
    constexpr float BlueprintAnchorClearanceRadiusCm = 225.0f;
    constexpr float BlueprintAnchorClearanceHeightCm = 320.0f;

    bool IsSupportedPurity(const EResourcePurity Purity)
    {
        return Purity == RP_Inpure || Purity == RP_Normal || Purity == RP_Pure;
    }

    bool IsTargetedVanillaMinerClass(const UClass* BuildableClass)
    {
        if (!IsValid(BuildableClass) ||
            !BuildableClass->IsChildOf(AFGBuildableResourceExtractorBase::StaticClass()))
        {
            return false;
        }

        const FName Name = BuildableClass->GetFName();
        return Name == TEXT("Build_MinerMk1_C") ||
            Name == TEXT("Build_MinerMk2_C") ||
            Name == TEXT("Build_MinerMk3_C");
    }

    bool EnableMinerHologramDesignerFlag(UClass* BuildableClass, FString& OutReason)
    {
        OutReason.Reset();
        if (!IsTargetedVanillaMinerClass(BuildableClass))
        {
            OutReason = TEXT("not_a_targeted_vanilla_miner");
            return false;
        }

        const AFGBuildableResourceExtractorBase* ExtractorDefault =
            Cast<AFGBuildableResourceExtractorBase>(BuildableClass->GetDefaultObject());
        UClass* HologramClass = IsValid(ExtractorDefault)
            ? ExtractorDefault->mHologramClass.Get()
            : nullptr;
        if (!IsValid(HologramClass) || !HologramClass->IsChildOf(AFGHologram::StaticClass()))
        {
            OutReason = TEXT("miner_hologram_class_unavailable");
            return false;
        }

        AFGHologram* HologramDefault = Cast<AFGHologram>(HologramClass->GetDefaultObject());
        FBoolProperty* CanPlaceInDesigner = FindFProperty<FBoolProperty>(
            HologramClass,
            TEXT("mCanBePlacedInBlueprintDesigner"));
        if (!IsValid(HologramDefault) || CanPlaceInDesigner == nullptr)
        {
            OutReason = TEXT("miner_hologram_designer_flag_unavailable");
            return false;
        }

        // This changes only the default value copied into future normal Build
        // Gun holograms.  It does not touch CheckValidPlacement, the resource
        // snap path, cost, or any Construct disqualifier.
        CanPlaceInDesigner->SetPropertyValue_InContainer(HologramDefault, true);
        return true;
    }
}

AAIFactoryBlueprintAnchorNode::AAIFactoryBlueprintAnchorNode()
{
    mResourceNodeType = EResourceNodeType::Node;
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;

    USceneComponent* const Root = CreateDefaultSubobject<USceneComponent>(TEXT("BlueprintAnchorNodeRoot"));
    SetRootComponent(Root);

    // Resource extractor holograms and native node logic use the base
    // mBoxComponent field, not an arbitrary extra collision component.
    mBoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("BlueprintAnchorNodeCollision"));
    mBoxComponent->SetupAttachment(Root);
    mBoxComponent->SetBoxExtent(FVector(
        BlueprintAnchorClearanceRadiusCm,
        BlueprintAnchorClearanceRadiusCm,
        BlueprintAnchorClearanceHeightCm * 0.5f));
    mBoxComponent->SetRelativeLocation(FVector(
        0.0f,
        0.0f,
        BlueprintAnchorClearanceHeightCm * 0.5f));
    mBoxComponent->SetCollisionEnabled(ECollisionEnabled::QueryOnly);
    mBoxComponent->SetCollisionObjectType(ECC_WorldStatic);
    mBoxComponent->SetCollisionResponseToAllChannels(ECR_Ignore);
    mBoxComponent->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    mBoxComponent->SetGenerateOverlapEvents(false);
}

void AAIFactoryBlueprintAnchorNode::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AAIFactoryBlueprintAnchorNode, mConfiguration);
}

void AAIFactoryBlueprintAnchorNode::GetClearanceData_Implementation(
    TArray<FFGClearanceData>& OutData) const
{
    Super::GetClearanceData_Implementation(OutData);

    FFGClearanceData Clearance;
    Clearance.Type = EClearanceType::CT_Default;
    Clearance.ClearanceBox = FBox(
        FVector(-BlueprintAnchorClearanceRadiusCm, -BlueprintAnchorClearanceRadiusCm, 0.0f),
        FVector(
            BlueprintAnchorClearanceRadiusCm,
            BlueprintAnchorClearanceRadiusCm,
            BlueprintAnchorClearanceHeightCm));
    // A Miner is supposed to snap into this exact volume.  Let the game's own
    // resource-extractor hologram decide the rest of the placement validity.
    Clearance.ExcludeForSnapping = true;
    OutData.Add(Clearance);
}

bool AAIFactoryBlueprintAnchorNode::CanPlaceResourceExtractor() const
{
    FString Reason;
    return HasValidConfiguration(Reason) && Super::CanPlaceResourceExtractor();
}

bool AAIFactoryBlueprintAnchorNode::Configure(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can configure a Blueprint Resource Anchor node");
        return false;
    }
    if (!ValidateConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }

    const FAIFactoryBlueprintResourceAnchorConfiguration Previous = mConfiguration;
    mConfiguration.SchemaVersion = 1;
    mConfiguration.ResourceClass = Resource;
    mConfiguration.Purity = Purity;
    if (!ApplyConfiguration(OutReason))
    {
        mConfiguration = Previous;
        FString RestoreReason;
        ApplyConfiguration(RestoreReason);
        return false;
    }

    FlushNetDormancy();
    ForceNetUpdate();
    return true;
}

bool AAIFactoryBlueprintAnchorNode::HasValidConfiguration(FString& OutReason) const
{
    if (mConfiguration.SchemaVersion != 1)
    {
        OutReason = FString::Printf(
            TEXT("Blueprint Resource Anchor node schema %d is unsupported"),
            mConfiguration.SchemaVersion);
        return false;
    }
    return ValidateConfiguration(mConfiguration.ResourceClass, mConfiguration.Purity, OutReason);
}

bool AAIFactoryBlueprintAnchorNode::ValidateConfiguration(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(Resource))
    {
        OutReason = TEXT("a Blueprint Resource Anchor needs a known resource descriptor");
        return false;
    }
    if (UFGItemDescriptor::GetForm(Resource) != EResourceForm::RF_SOLID)
    {
        OutReason = TEXT("Blueprint Resource Anchors currently support solid resources only");
        return false;
    }
    if (!IsValid(UFGResourceDescriptor::GetDepositMesh(Resource)))
    {
        OutReason = TEXT("this resource has no deposit mesh, so the anchor would be invisible");
        return false;
    }
    if (!IsSupportedPurity(Purity))
    {
        OutReason = TEXT("anchor purity must be Impure, Normal, or Pure");
        return false;
    }
    return true;
}

void AAIFactoryBlueprintAnchorNode::ApplyResourceVisual(
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

void AAIFactoryBlueprintAnchorNode::OnRep_Configuration()
{
    FString Reason;
    if (!ApplyConfiguration(Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor node %s received an invalid configuration: %s"),
            *GetPathName(),
            *Reason);
    }
}

bool AAIFactoryBlueprintAnchorNode::ApplyConfiguration(FString& OutReason)
{
    mCanPlaceResourceExtractor = false;
    mCanPlacePortableMiner = false;
    if (!HasValidConfiguration(OutReason))
    {
        return false;
    }

    const TSubclassOf<UFGResourceDescriptor> Resource = mConfiguration.ResourceClass;
    const EResourcePurity Purity = mConfiguration.Purity;
    mResourceNodeType = EResourceNodeType::Node;
    InitResource(Resource, RA_Infinite, Purity);
    SetResourceClassOverride(Resource);
    SetResourcePurityOverride(Purity);

    if (GetResourceClass() != Resource ||
        GetResourcePurity() != Purity ||
        GetResourceAmount() != RA_Infinite ||
        !HasAnyResources())
    {
        OutReason = TEXT("Satisfactory did not retain the anchor node configuration");
        return false;
    }

    mCanPlaceResourceExtractor = true;
    // The Designer extension deliberately covers only the three built Miner
    // tiers.  A portable miner would be a separate gameplay capability, so
    // leave the node unavailable to it.
    mCanPlacePortableMiner = false;
    return true;
}

AAIFactoryBlueprintResourceAnchor::AAIFactoryBlueprintResourceAnchor()
{
    USceneComponent* const Root = CreateDefaultSubobject<USceneComponent>(TEXT("BlueprintAnchorRoot"));
    SetRootComponent(Root);

    mAnchorVisual = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("BlueprintAnchorVisual"));
    mAnchorVisual->SetupAttachment(Root);
    mAnchorVisual->ComponentTags.Add(TEXT("AIFactoryBlueprintAnchorVisual"));
    mAnchorVisual->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    mAnchorVisual->SetGenerateOverlapEvents(false);
}

void AAIFactoryBlueprintResourceAnchor::GetLifetimeReplicatedProps(
    TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AAIFactoryBlueprintResourceAnchor, mConfiguration);
}

void AAIFactoryBlueprintResourceAnchor::BeginPlay()
{
    Super::BeginPlay();
    UpdateAnchorVisual();
    if (HasAuthority())
    {
        ScheduleExactRebind();
    }
}

void AAIFactoryBlueprintResourceAnchor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (HasAuthority())
    {
        // EndPlay can also be reached by map teardown or a forced rollback,
        // after normal dismantle validation is no longer available.  Make one
        // best-effort native detach before the transient node disappears.  A
        // failed detach is logged explicitly; the normal player-facing path
        // is prevented earlier by CanDismantle_Implementation.
        if (!DisconnectBoundExtractorsFromRuntimeNode())
        {
            UE_LOG(LogAIFactoryCopilot, Error,
                TEXT("Blueprint Resource Anchor %s reached EndPlay with an extractor that could not be fully detached"),
                *GetPathName());
        }
        DestroyRuntimeNode();
    }
    else
    {
        mRuntimeNode = nullptr;
    }
    Super::EndPlay(EndPlayReason);
}

bool AAIFactoryBlueprintResourceAnchor::CanDismantle_Implementation() const
{
    // Never allow an anchor to be dismantled out from under a live native
    // Miner.  The miner must be dismantled first, which leaves no SaveGame
    // resource pointer for this transient node to invalidate.  This is a
    // gate on the exact current runtime relation, not on stale saved entries.
    return Super::CanDismantle_Implementation() && !HasBoundExtractorOnRuntimeNode();
}

void AAIFactoryBlueprintResourceAnchor::Dismantle_Implementation()
{
    // A miner stores the resource interface as a SaveGame reference.  Release
    // only the exact miners this anchor owns before destroying the transient
    // node, so a manual anchor dismantle cannot leave a miner pointing at a
    // destroyed actor.  This deliberately never searches for nearby miners.
    // The game normally calls CanDismantle before this method. Repeat the
    // exact guard for direct interface callers and avoid turning a race or a
    // failed native detach into a destroyed-node reference.
    if (!CanDismantle_Implementation())
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor %s refused dismantle while a bound Miner still targets its runtime node"),
            *GetPathName());
        return;
    }
    if (!DisconnectBoundExtractorsFromRuntimeNode())
    {
        UE_LOG(LogAIFactoryCopilot, Error,
            TEXT("Blueprint Resource Anchor %s refused dismantle because an extractor did not fully detach"),
            *GetPathName());
        return;
    }
    DestroyRuntimeNode();
    Super::Dismantle_Implementation();
}

void AAIFactoryBlueprintResourceAnchor::PreSaveGame_Implementation(
    const int32 SaveVersion,
    const int32 GameVersion)
{
    // The child node is intentionally not a normal save actor.  Its miners
    // therefore need the same full detach/readback rule as a .sbp archive;
    // otherwise either extractor SaveGame pointer could retain a transient
    // actor across a normal world save.
    SynchronizeBoundExtractorsFromRuntimeNode();
    TemporarilyDisconnectBoundExtractorsForSerialization(TEXT("world save"));
    Super::PreSaveGame_Implementation(SaveVersion, GameVersion);
}

void AAIFactoryBlueprintResourceAnchor::PostSaveGame_Implementation(
    const int32 SaveVersion,
    const int32 GameVersion)
{
    Super::PostSaveGame_Implementation(SaveVersion, GameVersion);
    RestoreTemporarilyDisconnectedExtractors();
}

void AAIFactoryBlueprintResourceAnchor::PreSerializedToBlueprint()
{
    Super::PreSerializedToBlueprint();

    // SML cannot safely detour SetExtractableResource on every supported
    // engine build (some generated implementations are too small for its
    // trampoline). At this authoritative serializer boundary we can instead
    // read the exact native binding the engine already made. It is a pointer
    // identity comparison against this anchor's own transient node, so it
    // cannot accidentally capture a nearby miner or resource node.
    SynchronizeBoundExtractorsFromRuntimeNode();
    TemporarilyDisconnectBoundExtractorsForSerialization(TEXT("Blueprint archive"));
}

void AAIFactoryBlueprintResourceAnchor::TemporarilyDisconnectBoundExtractorsForSerialization(
    const TCHAR* const SerializationKind)
{

    // The miner's normal resource pointer is SaveGame.  Disconnect it for
    // each native serializer so collection cannot smuggle our transient child
    // actor into either a .sbp or ordinary save. The persisted root mapping is
    // the sole exact source used to reconnect it after a load.
    mTemporarilyDisconnectedExtractors.Reset();
    if (!HasAuthority() || !IsValid(mRuntimeNode))
    {
        return;
    }

    for (AFGBuildableResourceExtractorBase* const Extractor : mBoundExtractors)
    {
        if (!IsValid(Extractor) ||
            Extractor->GetExtractableResource().GetObject() != mRuntimeNode)
        {
            continue;
        }

        // Use the extractor's full native disconnect path, rather than only
        // clearing mExtractableResource.  The class still carries a legacy
        // SaveGame AFGResourceNode pointer for old saves, and this is the
        // only public engine API that promises to release both relationships.
        if (Extractor->DisconnectExtractableResource() &&
            Extractor->GetExtractableResource().GetObject() == nullptr &&
            Extractor->GetResourceNode() == nullptr)
        {
            mTemporarilyDisconnectedExtractors.Add(Extractor);
        }
        else
        {
            UE_LOG(LogAIFactoryCopilot, Error,
                TEXT("Blueprint Resource Anchor %s could not fully detach %s before %s serialization"),
                *GetPathName(),
                *Extractor->GetPathName(),
                SerializationKind);
        }
    }
}

void AAIFactoryBlueprintResourceAnchor::PostSerializedToBlueprint()
{
    Super::PostSerializedToBlueprint();
    RestoreTemporarilyDisconnectedExtractors();
}

void AAIFactoryBlueprintResourceAnchor::PostSerializedFromBlueprint(const bool bIsBlueprintWorld)
{
    Super::PostSerializedFromBlueprint(bIsBlueprintWorld);
    // A loaded Designer world needs the same real, transient node as a placed
    // world: without it, a restored Miner has nothing to snap/rebind to.  The
    // child itself opts out of Blueprint/save collection, while this root's
    // persisted configuration and explicit miner list rebuild it next tick.
    if (HasAuthority())
    {
        ScheduleExactRebind();
    }
}

void AAIFactoryBlueprintResourceAnchor::PostLoadGame_Implementation(
    const int32 SaveVersion,
    const int32 GameVersion)
{
    Super::PostLoadGame_Implementation(SaveVersion, GameVersion);
    UpdateAnchorVisual();
    if (HasAuthority())
    {
        ScheduleExactRebind();
    }
}

bool AAIFactoryBlueprintResourceAnchor::ConfigureAnchor(
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can configure a Blueprint Resource Anchor");
        return false;
    }
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(Resource, Purity, OutReason))
    {
        return false;
    }

    const FAIFactoryBlueprintResourceAnchorConfiguration Previous = mConfiguration;
    mConfiguration.SchemaVersion = 1;
    mConfiguration.ResourceClass = Resource;
    mConfiguration.Purity = Purity;
    UpdateAnchorVisual();

    if (HasActorBegunPlay() && !EnsureRuntimeNode(OutReason))
    {
        mConfiguration = Previous;
        UpdateAnchorVisual();
        return false;
    }

    FlushNetDormancy();
    ForceNetUpdate();
    return true;
}

void AAIFactoryBlueprintResourceAnchor::EnableVanillaMinersInBlueprintDesigner(UWorld* const World)
{
    AFGBlueprintSubsystem* const Blueprints = IsValid(World)
        ? AFGBlueprintSubsystem::Get(World)
        : nullptr;
    if (!IsValid(Blueprints))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor could not find the Blueprint subsystem; Miner Designer opt-in was not applied"));
        return;
    }

    int32 Enabled = 0;
    int32 Failed = 0;
    for (int32 Index = Blueprints->mBlacklistedDesignerBuildables.Num() - 1; Index >= 0; --Index)
    {
        UClass* const BuildableClass = Blueprints->mBlacklistedDesignerBuildables[Index].Get();
        if (!IsTargetedVanillaMinerClass(BuildableClass))
        {
            continue;
        }

        FString Reason;
        if (!EnableMinerHologramDesignerFlag(BuildableClass, Reason))
        {
            ++Failed;
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Blueprint Resource Anchor kept %s blocked in the Designer: %s"),
                IsValid(BuildableClass) ? *BuildableClass->GetPathName() : TEXT("unknown"),
                *Reason);
            continue;
        }

        Blueprints->mBlacklistedDesignerBuildables.RemoveAtSwap(Index);
        ++Enabled;
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Blueprint Resource Anchor Designer opt-in: enabled=%d failed=%d (only Miner Mk.1–Mk.3; normal node validation remains active)"),
        Enabled,
        Failed);
}

bool AAIFactoryBlueprintResourceAnchor::EnsureRuntimeNode(FString& OutReason)
{
    OutReason.Reset();
    if (!HasAuthority())
    {
        OutReason = TEXT("only the host can create an anchor node");
        return false;
    }
    if (!AAIFactoryBlueprintAnchorNode::ValidateConfiguration(
            mConfiguration.ResourceClass,
            mConfiguration.Purity,
            OutReason))
    {
        return false;
    }

    if (IsValid(mRuntimeNode))
    {
        return mRuntimeNode->Configure(
            mConfiguration.ResourceClass,
            mConfiguration.Purity,
            OutReason);
    }

    UWorld* const World = GetWorld();
    if (!IsValid(World))
    {
        OutReason = TEXT("the anchor has no world");
        return false;
    }

    const FTransform Transform = GetActorTransform();
    AAIFactoryBlueprintAnchorNode* const Node =
        World->SpawnActorDeferred<AAIFactoryBlueprintAnchorNode>(
            AAIFactoryBlueprintAnchorNode::StaticClass(),
            Transform,
            this,
            nullptr,
            ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
    if (!IsValid(Node))
    {
        OutReason = TEXT("Satisfactory could not spawn the anchor node");
        return false;
    }

    Node->SetFlags(RF_Transient);
    if (!Node->Configure(mConfiguration.ResourceClass, mConfiguration.Purity, OutReason))
    {
        Node->Destroy();
        return false;
    }

    Node->FinishSpawning(Transform);
    Node->AttachToActor(this, FAttachmentTransformRules::KeepWorldTransform);
    Node->FlushNetDormancy();
    Node->ForceNetUpdate();
    mRuntimeNode = Node;
    return true;
}

void AAIFactoryBlueprintResourceAnchor::DestroyRuntimeNode()
{
    if (AAIFactoryBlueprintAnchorNode* const Node = mRuntimeNode.Get())
    {
        mRuntimeNode = nullptr;
        if (IsValid(Node) && !Node->IsActorBeingDestroyed())
        {
            Node->DetachFromActor(FDetachmentTransformRules::KeepWorldTransform);
            Node->Destroy();
        }
    }
}

void AAIFactoryBlueprintResourceAnchor::SynchronizeBoundExtractorsFromRuntimeNode()
{
    UWorld* const World = GetWorld();
    if (!HasAuthority() || !IsValid(World) || !IsValid(mRuntimeNode))
    {
        return;
    }

    for (TActorIterator<AFGBuildableResourceExtractorBase> It(World); It; ++It)
    {
        AFGBuildableResourceExtractorBase* const Extractor = *It;
        if (IsValid(Extractor) &&
            Extractor->GetExtractableResource().GetObject() == mRuntimeNode)
        {
            // The resource interface is the engine's authoritative ownership
            // relationship. No location, class, or name heuristic is used.
            mBoundExtractors.AddUnique(Extractor);
        }
    }
}

bool AAIFactoryBlueprintResourceAnchor::HasBoundExtractorOnRuntimeNode() const
{
    if (!IsValid(mRuntimeNode))
    {
        return false;
    }

    UWorld* const World = GetWorld();
    if (!IsValid(World))
    {
        return false;
    }

    for (TActorIterator<AFGBuildableResourceExtractorBase> It(World); It; ++It)
    {
        AFGBuildableResourceExtractorBase* const Extractor = *It;
        if (IsValid(Extractor) && Extractor->GetWorld() == GetWorld() &&
            Extractor->GetExtractableResource().GetObject() == mRuntimeNode)
        {
            return true;
        }
    }
    return false;
}

bool AAIFactoryBlueprintResourceAnchor::DisconnectBoundExtractorsFromRuntimeNode()
{
    if (!HasAuthority() || !IsValid(mRuntimeNode))
    {
        return true;
    }

    SynchronizeBoundExtractorsFromRuntimeNode();
    bool bAllDetached = true;
    for (AFGBuildableResourceExtractorBase* const Extractor : mBoundExtractors)
    {
        if (IsValid(Extractor) && Extractor->GetWorld() == GetWorld() &&
            Extractor->GetExtractableResource().GetObject() == mRuntimeNode)
        {
            if (!Extractor->DisconnectExtractableResource() ||
                Extractor->GetExtractableResource().GetObject() != nullptr ||
                Extractor->GetResourceNode() != nullptr)
            {
                bAllDetached = false;
                UE_LOG(LogAIFactoryCopilot, Error,
                    TEXT("Blueprint Resource Anchor %s could not fully detach extractor %s before destroying its runtime node"),
                    *GetPathName(),
                    *Extractor->GetPathName());
            }
        }
    }
    return bAllDetached;
}

void AAIFactoryBlueprintResourceAnchor::ScheduleExactRebind()
{
    if (!HasAuthority() || bRebindScheduled || !IsValid(GetWorld()))
    {
        return;
    }

    bRebindScheduled = true;
    GetWorld()->GetTimerManager().SetTimerForNextTick(
        FTimerDelegate::CreateUObject(this, &AAIFactoryBlueprintResourceAnchor::CompleteDeferredRebind));
}

void AAIFactoryBlueprintResourceAnchor::CompleteDeferredRebind()
{
    bRebindScheduled = false;
    if (!HasAuthority())
    {
        return;
    }

    FString Reason;
    if (!EnsureRuntimeNode(Reason))
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor %s could not restore its runtime node: %s"),
            *GetPathName(),
            *Reason);
        return;
    }
    RebindRecordedExtractors();
    SynchronizeBoundExtractorsFromRuntimeNode();
}

void AAIFactoryBlueprintResourceAnchor::RebindRecordedExtractors()
{
    if (!HasAuthority() || !IsValid(mRuntimeNode))
    {
        return;
    }

    const TScriptInterface<IFGExtractableResourceInterface> Resource =
        MakeExtractableInterface(mRuntimeNode);
    if (!IsValid(Resource.GetObject()) || Resource.GetInterface() == nullptr)
    {
        UE_LOG(LogAIFactoryCopilot, Warning,
            TEXT("Blueprint Resource Anchor %s did not produce a valid extractable interface"),
            *GetPathName());
        return;
    }

    for (AFGBuildableResourceExtractorBase* const Extractor : mBoundExtractors)
    {
        if (!IsValid(Extractor) || Extractor->GetWorld() != GetWorld())
        {
            continue;
        }

        if (Extractor->GetExtractableResource().GetObject() != mRuntimeNode)
        {
            // This is a persisted explicit anchor↔miner relationship from the
            // same .sbp root set.  It is never a nearest-node or nearest-miner
            // guess, and the extractor's own setter claims occupancy.
            Extractor->SetExtractableResource(Resource);
        }

        if (Extractor->GetExtractableResource().GetObject() != mRuntimeNode)
        {
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Blueprint Resource Anchor %s could not rebind extractor %s"),
                *GetPathName(),
                *Extractor->GetPathName());
        }
    }
}

void AAIFactoryBlueprintResourceAnchor::RestoreTemporarilyDisconnectedExtractors()
{
    if (mTemporarilyDisconnectedExtractors.IsEmpty() || !IsValid(mRuntimeNode))
    {
        mTemporarilyDisconnectedExtractors.Reset();
        return;
    }

    const TScriptInterface<IFGExtractableResourceInterface> Resource =
        MakeExtractableInterface(mRuntimeNode);
    for (const TWeakObjectPtr<AFGBuildableResourceExtractorBase>& WeakExtractor :
        mTemporarilyDisconnectedExtractors)
    {
        if (AFGBuildableResourceExtractorBase* const Extractor = WeakExtractor.Get();
            IsValid(Extractor) && Extractor->GetWorld() == GetWorld())
        {
            Extractor->SetExtractableResource(Resource);
        }
    }
    mTemporarilyDisconnectedExtractors.Reset();
}

void AAIFactoryBlueprintResourceAnchor::UpdateAnchorVisual()
{
    AAIFactoryBlueprintAnchorNode::ApplyResourceVisual(
        mAnchorVisual,
        mConfiguration.ResourceClass);
}

TScriptInterface<IFGExtractableResourceInterface>
AAIFactoryBlueprintResourceAnchor::MakeExtractableInterface(
    AAIFactoryBlueprintAnchorNode* const Node)
{
    TScriptInterface<IFGExtractableResourceInterface> Result;
    if (IsValid(Node))
    {
        Result.SetObject(Node);
        Result.SetInterface(static_cast<IFGExtractableResourceInterface*>(Node));
    }
    return Result;
}

void AAIFactoryBlueprintResourceAnchor::OnRep_Configuration()
{
    UpdateAnchorVisual();
}
