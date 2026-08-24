#include "AIFactoryBlueprintAudit.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableResourceExtractorBase.h"
#include "Dom/JsonObject.h"
#include "FGBlueprintProxy.h"
#include "GameFramework/Actor.h"
#include "Resources/FGItemDescriptor.h"
#include "UObject/Class.h"

namespace
{
    // A Blueprint can contain thousands of pieces. Keep the interaction
    // grounding small enough to reach the bridge, while preserving exact
    // totals and the number whose per-extractor state could not be returned.
    constexpr int32 AIFactoryBlueprintAuditMaximumExtractorDetails = 32;
    constexpr int32 AIFactoryBlueprintAuditMaximumResourceAnchorDetails = 32;

    FString AIFactoryBlueprintAuditClassPath(const UClass* Class)
    {
        return IsValid(Class) ? Class->GetPathName() : FString();
    }

    FString AIFactoryBlueprintAuditPurityName(const EResourcePurity Purity)
    {
        switch (Purity)
        {
        case RP_Inpure:
            return TEXT("impure");
        case RP_Normal:
            return TEXT("normal");
        case RP_Pure:
            return TEXT("pure");
        default:
            return TEXT("unknown");
        }
    }

    void AIFactoryBlueprintAuditSetResourceDescriptor(
        const TSharedRef<FJsonObject>& Object,
        const TSubclassOf<UFGResourceDescriptor> ResourceClass)
    {
        Object->SetStringField(TEXT("resource_class"), AIFactoryBlueprintAuditClassPath(ResourceClass.Get()));
        Object->SetStringField(
            TEXT("resource_name"),
            ResourceClass ? UFGItemDescriptor::GetItemName(ResourceClass).ToString() : TEXT(""));
    }

    void AIFactoryBlueprintAuditSetResourceAnchorDetail(
        TSharedRef<FJsonObject>& Detail,
        const AAIFactoryBlueprintResourceAnchor* Anchor,
        const TArray<AFGBuildableResourceExtractorBase*>& ExactBoundExtractors,
        const bool bProxyReady,
        const bool bProxyHasAuthority,
        const int32 LightweightExtractorCount)
    {
        Detail->SetStringField(TEXT("anchor_actor_id"), Anchor->GetPathName());
        Detail->SetStringField(TEXT("anchor_actor_name"), Anchor->GetName());
        Detail->SetStringField(TEXT("anchor_actor_class_path"), AIFactoryBlueprintAuditClassPath(Anchor->GetClass()));

        const FAIFactoryBlueprintResourceAnchorConfiguration& Configuration = Anchor->GetConfiguration();
        const TSubclassOf<UFGResourceDescriptor> ConfiguredResource = Configuration.ResourceClass;
        const EResourcePurity ConfiguredPurity = Configuration.Purity;
        FString ConfigurationReason;
        const bool bConfigurationValid =
            Configuration.SchemaVersion == 1 &&
            AAIFactoryBlueprintAnchorNode::ValidateConfiguration(
                ConfiguredResource,
                ConfiguredPurity,
                ConfigurationReason);

        const TSharedRef<FJsonObject> ConfigurationJson = MakeShared<FJsonObject>();
        ConfigurationJson->SetNumberField(TEXT("schema_version"), Configuration.SchemaVersion);
        ConfigurationJson->SetStringField(
            TEXT("state"),
            bConfigurationValid ? TEXT("configured") : TEXT("invalid_or_unsupported"));
        AIFactoryBlueprintAuditSetResourceDescriptor(ConfigurationJson, ConfiguredResource);
        ConfigurationJson->SetStringField(TEXT("purity"), AIFactoryBlueprintAuditPurityName(ConfiguredPurity));
        if (!bConfigurationValid && !ConfigurationReason.IsEmpty())
        {
            ConfigurationJson->SetStringField(TEXT("reason"), ConfigurationReason);
        }
        Detail->SetObjectField(TEXT("configuration"), ConfigurationJson);

        const AAIFactoryBlueprintAnchorNode* RuntimeNode = Anchor->GetRuntimeNode();
        const TSharedRef<FJsonObject> RuntimeNodeJson = MakeShared<FJsonObject>();
        // The authoritative world owns the transient node and its current
        // extractor interfaces. A client may retain replicated configuration
        // for visuals, but it cannot prove a live node/miner relationship.
        if (!bProxyHasAuthority)
        {
            RuntimeNodeJson->SetStringField(TEXT("state"), TEXT("unknown_on_client"));
            Detail->SetObjectField(TEXT("runtime_node"), RuntimeNodeJson);
            Detail->SetStringField(TEXT("binding_census_state"), TEXT("unknown_on_client"));
            return;
        }
        if (!IsValid(RuntimeNode))
        {
            RuntimeNodeJson->SetStringField(TEXT("state"), TEXT("missing_on_authority"));
            Detail->SetObjectField(TEXT("runtime_node"), RuntimeNodeJson);
            Detail->SetStringField(TEXT("binding_census_state"), TEXT("unknown_runtime_node_missing_on_authority"));
            return;
        }

        const bool bExactOwner = RuntimeNode->GetOwner() == Anchor;
        const TSubclassOf<UFGResourceDescriptor> RuntimeResource = RuntimeNode->GetResourceClass();
        const EResourcePurity RuntimePurity = RuntimeNode->GetResourcePurity();
        const bool bMatchesConfiguration =
            bExactOwner &&
            bConfigurationValid &&
            RuntimeResource.Get() == ConfiguredResource.Get() &&
            RuntimePurity == ConfiguredPurity;
        RuntimeNodeJson->SetStringField(
            TEXT("state"),
            !bExactOwner
                ? TEXT("owner_mismatch")
                : bMatchesConfiguration ? TEXT("observed") : TEXT("configuration_mismatch"));
        RuntimeNodeJson->SetStringField(TEXT("actor_id"), RuntimeNode->GetPathName());
        RuntimeNodeJson->SetBoolField(TEXT("owned_by_anchor_exactly"), bExactOwner);
        RuntimeNodeJson->SetBoolField(TEXT("occupied"), RuntimeNode->IsOccupied());
        RuntimeNodeJson->SetBoolField(TEXT("matches_configuration"), bMatchesConfiguration);
        AIFactoryBlueprintAuditSetResourceDescriptor(RuntimeNodeJson, RuntimeResource);
        RuntimeNodeJson->SetStringField(TEXT("purity"), AIFactoryBlueprintAuditPurityName(RuntimePurity));
        Detail->SetObjectField(TEXT("runtime_node"), RuntimeNodeJson);

        if (!bExactOwner)
        {
            Detail->SetStringField(TEXT("binding_census_state"), TEXT("unknown_runtime_node_owner_mismatch"));
            return;
        }

        const int32 DetailCount = FMath::Min(
            ExactBoundExtractors.Num(),
            AIFactoryBlueprintAuditMaximumExtractorDetails);
        TArray<TSharedPtr<FJsonValue>> BoundExtractorIds;
        BoundExtractorIds.Reserve(DetailCount);
        for (int32 Index = 0; Index < DetailCount; ++Index)
        {
            const AFGBuildableResourceExtractorBase* Extractor = ExactBoundExtractors[Index];
            if (IsValid(Extractor))
            {
                BoundExtractorIds.Add(MakeShared<FJsonValueString>(Extractor->GetPathName()));
            }
        }
        Detail->SetNumberField(TEXT("bound_extractor_count_observed"), ExactBoundExtractors.Num());
        Detail->SetNumberField(TEXT("bound_extractor_details_returned"), BoundExtractorIds.Num());
        Detail->SetNumberField(
            TEXT("bound_extractor_details_capped_omitted"),
            ExactBoundExtractors.Num() - BoundExtractorIds.Num());
        Detail->SetArrayField(TEXT("bound_extractor_actor_ids"), BoundExtractorIds);
        Detail->SetStringField(
            TEXT("binding_census_state"),
            !bProxyReady
                ? TEXT("partial_proxy_replication")
                : LightweightExtractorCount > 0
                    ? TEXT("incomplete_lightweight_extractors")
                    : bMatchesConfiguration
                        ? TEXT("complete")
                        : TEXT("complete_with_configuration_mismatch"));
    }

    AFGBlueprintProxy* AIFactoryBlueprintAuditFindProxy(
        AActor* Candidate,
        FString& OutRelation)
    {
        OutRelation = TEXT("none");
        if (!IsValid(Candidate))
        {
            return nullptr;
        }

        if (AFGBlueprintProxy* DirectProxy = Cast<AFGBlueprintProxy>(Candidate))
        {
            OutRelation = TEXT("blueprint_proxy");
            return DirectProxy;
        }

        if (AFGBuildable* Buildable = Cast<AFGBuildable>(Candidate))
        {
            if (AFGBlueprintProxy* MemberProxy = Buildable->GetBlueprintProxy())
            {
                OutRelation = TEXT("actor_member");
                return MemberProxy;
            }
        }

        return nullptr;
    }

    void AIFactoryBlueprintAuditSetExtractorDetail(
        TSharedRef<FJsonObject>& Detail,
        const AFGBuildableResourceExtractorBase* Extractor,
        const bool bProxyReady,
        const bool bProxyHasAuthority,
        int32& BoundCount,
        int32& UnboundCount,
        int32& PendingCount,
        int32& UnknownCount)
    {
        Detail->SetStringField(TEXT("actor_id"), Extractor->GetPathName());
        Detail->SetStringField(TEXT("actor_name"), Extractor->GetName());
        Detail->SetStringField(TEXT("actor_class_path"), AIFactoryBlueprintAuditClassPath(Extractor->GetClass()));
        Detail->SetStringField(TEXT("extractor_type"), Extractor->GetExtractorTypeName().ToString());

        const TScriptInterface<IFGExtractableResourceInterface> Extractable =
            Extractor->GetExtractableResource();
        UObject* ExtractableObject = Extractable.GetObject();
        const IFGExtractableResourceInterface* ExtractableInterface = Extractable.GetInterface();
        const bool bObjectValid = IsValid(ExtractableObject);
        const bool bInterfaceValid = ExtractableInterface != nullptr;

        if (bObjectValid && bInterfaceValid)
        {
            const TSubclassOf<UFGResourceDescriptor> ResourceClass =
                ExtractableInterface->GetResourceClass();
            Detail->SetStringField(TEXT("binding_state"), TEXT("bound"));
            Detail->SetStringField(TEXT("extractable_object_id"), ExtractableObject->GetPathName());
            const AActor* ExtractableActor = Cast<AActor>(ExtractableObject);
            Detail->SetStringField(
                TEXT("extractable_actor_id"),
                IsValid(ExtractableActor) ? ExtractableActor->GetPathName() : TEXT(""));
            Detail->SetStringField(TEXT("resource_class"), AIFactoryBlueprintAuditClassPath(ResourceClass.Get()));
            Detail->SetStringField(
                TEXT("resource_name"),
                ResourceClass ? UFGItemDescriptor::GetItemName(ResourceClass).ToString() : TEXT(""));
            ++BoundCount;
            return;
        }

        if (!bObjectValid && !bInterfaceValid)
        {
            // The proxy itself says not all member references have replicated,
            // so a currently blank extractor relationship is not proof it will
            // remain blank. Report the wait state instead of a false failure.
            if (!bProxyReady)
            {
                Detail->SetStringField(TEXT("binding_state"), TEXT("replication_pending"));
                ++PendingCount;
            }
            else if (bProxyHasAuthority)
            {
                Detail->SetStringField(TEXT("binding_state"), TEXT("unbound"));
                ++UnboundCount;
            }
            else
            {
                // mExtractableResource has an independent replicated property.
                // A ready proxy on a client does not prove that a null extractor
                // binding is permanent, so only the authority may call it
                // unbound.
                Detail->SetStringField(TEXT("binding_state"), TEXT("unknown"));
                Detail->SetStringField(
                    TEXT("reason"),
                    TEXT("extractable_resource_not_replicated_or_unbound"));
                ++UnknownCount;
            }
            return;
        }

        // A TScriptInterface whose object and interface halves disagree is not
        // a normal valid binding, but neither public accessor lets us prove why.
        Detail->SetStringField(TEXT("binding_state"), TEXT("unknown"));
        Detail->SetStringField(TEXT("reason"), TEXT("extractable_resource_interface_incomplete"));
        ++UnknownCount;
    }
}

TSharedRef<FJsonObject> AIFactoryBlueprintAudit::Capture(
    AActor* PrimaryTarget,
    AActor* CameraFallbackTarget)
{
    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(
        TEXT("source"),
        TEXT("AFGBlueprintProxy, AFGBuildableResourceExtractorBase, and Blueprint Resource Anchor public accessors"));
    Result->SetStringField(TEXT("certainty"), TEXT("unknown"));
    Result->SetBoolField(TEXT("available"), false);
    Result->SetNumberField(TEXT("maximum_extractor_details"), AIFactoryBlueprintAuditMaximumExtractorDetails);
    Result->SetNumberField(TEXT("maximum_resource_anchor_details"), AIFactoryBlueprintAuditMaximumResourceAnchorDetails);

    FString TargetRelation;
    AActor* AuditedTarget = PrimaryTarget;
    AFGBlueprintProxy* Proxy = AIFactoryBlueprintAuditFindProxy(AuditedTarget, TargetRelation);
    FString SelectedFrom = TEXT("preferred_target");

    // The use trace may intentionally target the resource node beneath a miner.
    // The camera trace normally sees the miner itself. Use that second witness
    // only for this read-only audit, leaving preferred_target unchanged for the
    // rest of the snapshot/action contract.
    if (!IsValid(Proxy) &&
        IsValid(CameraFallbackTarget) &&
        CameraFallbackTarget != PrimaryTarget)
    {
        FString FallbackRelation;
        if (AFGBlueprintProxy* FallbackProxy =
                AIFactoryBlueprintAuditFindProxy(CameraFallbackTarget, FallbackRelation))
        {
            AuditedTarget = CameraFallbackTarget;
            Proxy = FallbackProxy;
            TargetRelation = FallbackRelation;
            SelectedFrom = TEXT("camera_visibility_trace_fallback");
        }
    }

    if (IsValid(PrimaryTarget))
    {
        Result->SetStringField(TEXT("preferred_target_actor_id"), PrimaryTarget->GetPathName());
    }
    if (IsValid(CameraFallbackTarget) && CameraFallbackTarget != PrimaryTarget)
    {
        Result->SetStringField(TEXT("camera_fallback_actor_id"), CameraFallbackTarget->GetPathName());
    }

    if (!IsValid(AuditedTarget))
    {
        Result->SetStringField(TEXT("reason"), TEXT("preferred_target_unavailable"));
        return Result;
    }

    if (!IsValid(Proxy))
    {
        Result->SetStringField(
            TEXT("reason"),
            TEXT("preferred_target_is_not_a_native_blueprint_proxy_or_actor_member"));
        Result->SetStringField(TEXT("target_actor_id"), AuditedTarget->GetPathName());
        return Result;
    }

    const bool bProxyReady = Proxy->AreProxyBuildingsRegisteredAndValid();
    const bool bProxyHasAuthority = Proxy->HasAuthority();
    TArray<AFGBuildable*> Members;
    Proxy->CollectBuildables(Members);
    Members.RemoveAll([](const AFGBuildable* Member)
    {
        return !IsValid(Member);
    });
    Members.Sort([](const AFGBuildable& Left, const AFGBuildable& Right)
    {
        return Left.GetPathName() < Right.GetPathName();
    });

    int32 LightweightCount = 0;
    int32 LightweightExtractorCount = 0;
    int32 LightweightResourceAnchorCount = 0;
    for (const FBuildableClassLightweightIndices& Entry : Proxy->GetLightweightClassAndIndices())
    {
        LightweightCount += Entry.Indices.Num();
        const UClass* LightweightClass = Entry.BuildableClass.Get();
        if (IsValid(LightweightClass) &&
            LightweightClass->IsChildOf(AFGBuildableResourceExtractorBase::StaticClass()))
        {
            LightweightExtractorCount += Entry.Indices.Num();
        }
        if (IsValid(LightweightClass) &&
            LightweightClass->IsChildOf(AAIFactoryBlueprintResourceAnchor::StaticClass()))
        {
            // An anchor that the proxy kept lightweight has no public actor
            // accessor. Its count is useful, but its configuration/node/miner
            // relationship is unknown until it is actor-backed.
            LightweightResourceAnchorCount += Entry.Indices.Num();
        }
    }

    TArray<AFGBuildableResourceExtractorBase*> Extractors;
    TArray<AAIFactoryBlueprintResourceAnchor*> ResourceAnchors;
    for (AFGBuildable* Member : Members)
    {
        if (AFGBuildableResourceExtractorBase* Extractor = Cast<AFGBuildableResourceExtractorBase>(Member))
        {
            Extractors.Add(Extractor);
        }
        if (AAIFactoryBlueprintResourceAnchor* ResourceAnchor = Cast<AAIFactoryBlueprintResourceAnchor>(Member))
        {
            ResourceAnchors.Add(ResourceAnchor);
        }
    }
    Extractors.Sort([](const AFGBuildableResourceExtractorBase& Left, const AFGBuildableResourceExtractorBase& Right)
    {
        return Left.GetPathName() < Right.GetPathName();
    });
    ResourceAnchors.Sort([](const AAIFactoryBlueprintResourceAnchor& Left, const AAIFactoryBlueprintResourceAnchor& Right)
    {
        return Left.GetPathName() < Right.GetPathName();
    });

    // Map only exact, live extractor-interface identities. An anchor match is
    // never inferred from a similar resource, a nearby node, or an actor name:
    // the transient node must be owned by this anchor and be the exact current
    // object in the extractor's public resource interface.
    TSet<AAIFactoryBlueprintResourceAnchor*> ResourceAnchorSet;
    for (AAIFactoryBlueprintResourceAnchor* ResourceAnchor : ResourceAnchors)
    {
        if (IsValid(ResourceAnchor))
        {
            ResourceAnchorSet.Add(ResourceAnchor);
        }
    }
    TMap<AAIFactoryBlueprintResourceAnchor*, TArray<AFGBuildableResourceExtractorBase*>> ExactAnchorBindings;
    TMap<AFGBuildableResourceExtractorBase*, AAIFactoryBlueprintResourceAnchor*> ExtractorAnchorOwners;
    for (AFGBuildableResourceExtractorBase* Extractor : Extractors)
    {
        if (!IsValid(Extractor))
        {
            continue;
        }
        const TScriptInterface<IFGExtractableResourceInterface> ExtractableResource =
            Extractor->GetExtractableResource();
        AAIFactoryBlueprintAnchorNode* const RuntimeNode =
            ExtractableResource.GetInterface() != nullptr
                ? Cast<AAIFactoryBlueprintAnchorNode>(ExtractableResource.GetObject())
                : nullptr;
        AAIFactoryBlueprintResourceAnchor* const ResourceAnchor =
            IsValid(RuntimeNode) ? Cast<AAIFactoryBlueprintResourceAnchor>(RuntimeNode->GetOwner()) : nullptr;
        if (bProxyHasAuthority &&
            IsValid(ResourceAnchor) &&
            ResourceAnchorSet.Contains(ResourceAnchor) &&
            ResourceAnchor->GetRuntimeNode() == RuntimeNode &&
            RuntimeNode->GetOwner() == ResourceAnchor)
        {
            ExactAnchorBindings.FindOrAdd(ResourceAnchor).Add(Extractor);
            ExtractorAnchorOwners.Add(Extractor, ResourceAnchor);
        }
    }

    int32 BoundCount = 0;
    int32 UnboundCount = 0;
    int32 PendingCount = 0;
    int32 UnknownCount = 0;
    TArray<TSharedPtr<FJsonValue>> ExtractorDetails;
    ExtractorDetails.Reserve(FMath::Min(Extractors.Num(), AIFactoryBlueprintAuditMaximumExtractorDetails));
    for (int32 Index = 0; Index < Extractors.Num(); ++Index)
    {
        AFGBuildableResourceExtractorBase* Extractor = Extractors[Index];
        if (!IsValid(Extractor))
        {
            ++UnknownCount;
            continue;
        }

        // Totals remain complete even when the detailed JSON is capped. Build
        // one temporary record to classify every extractor, then retain only a
        // deterministic prefix for the model and UI.
        TSharedRef<FJsonObject> Detail = MakeShared<FJsonObject>();
        AIFactoryBlueprintAuditSetExtractorDetail(
            Detail,
            Extractor,
            bProxyReady,
            bProxyHasAuthority,
            BoundCount,
            UnboundCount,
            PendingCount,
            UnknownCount);
        if (AAIFactoryBlueprintResourceAnchor* const* ResourceAnchor = ExtractorAnchorOwners.Find(Extractor))
        {
            Detail->SetStringField(TEXT("resource_anchor_actor_id"), (*ResourceAnchor)->GetPathName());
        }
        if (Index < AIFactoryBlueprintAuditMaximumExtractorDetails)
        {
            ExtractorDetails.Add(MakeShared<FJsonValueObject>(Detail));
        }
    }

    // Lightweight instances have a class and instance index, but the public
    // API does not turn a current aim hit into their extractor object. Their
    // count is known, their binding is not. Preserve that uncertainty rather
    // than inventing temporary actors or resource associations.
    UnknownCount += LightweightExtractorCount;

    TArray<TSharedPtr<FJsonValue>> ResourceAnchorDetails;
    ResourceAnchorDetails.Reserve(FMath::Min(
        ResourceAnchors.Num(),
        AIFactoryBlueprintAuditMaximumResourceAnchorDetails));
    for (int32 Index = 0; Index < ResourceAnchors.Num(); ++Index)
    {
        AAIFactoryBlueprintResourceAnchor* const ResourceAnchor = ResourceAnchors[Index];
        if (!IsValid(ResourceAnchor))
        {
            continue;
        }
        const TArray<AFGBuildableResourceExtractorBase*>* const ExactBoundExtractors =
            ExactAnchorBindings.Find(ResourceAnchor);
        const TArray<AFGBuildableResourceExtractorBase*> EmptyExtractors;
        const TArray<AFGBuildableResourceExtractorBase*>& BoundExtractors =
            ExactBoundExtractors != nullptr ? *ExactBoundExtractors : EmptyExtractors;
        const TSharedRef<FJsonObject> Detail = MakeShared<FJsonObject>();
        AIFactoryBlueprintAuditSetResourceAnchorDetail(
            Detail,
            ResourceAnchor,
            BoundExtractors,
            bProxyReady,
            bProxyHasAuthority,
            LightweightExtractorCount);
        if (Index < AIFactoryBlueprintAuditMaximumResourceAnchorDetails)
        {
            ResourceAnchorDetails.Add(MakeShared<FJsonValueObject>(Detail));
        }
    }

    const TSharedRef<FJsonObject> Counts = MakeShared<FJsonObject>();
    Counts->SetNumberField(TEXT("bound"), BoundCount);
    Counts->SetNumberField(TEXT("unbound"), UnboundCount);
    Counts->SetNumberField(TEXT("replication_pending"), PendingCount);
    Counts->SetNumberField(TEXT("unknown"), UnknownCount);

    Result->SetBoolField(TEXT("available"), true);
    Result->SetStringField(TEXT("certainty"), bProxyReady ? TEXT("authoritative") : TEXT("partial"));
    Result->SetStringField(TEXT("target_actor_id"), AuditedTarget->GetPathName());
    Result->SetStringField(TEXT("audited_actor_id"), AuditedTarget->GetPathName());
    Result->SetStringField(TEXT("selected_from"), SelectedFrom);
    Result->SetStringField(TEXT("target_relation"), TargetRelation);
    Result->SetStringField(TEXT("blueprint_proxy_id"), Proxy->GetPathName());
    Result->SetStringField(TEXT("blueprint_name"), Proxy->GetBlueprintName().ToString());
    Result->SetStringField(TEXT("replication_state"), bProxyReady ? TEXT("ready") : TEXT("replication_pending"));
    Result->SetBoolField(TEXT("proxy_buildings_registered_and_valid"), bProxyReady);
    Result->SetBoolField(TEXT("proxy_has_authority"), bProxyHasAuthority);
    // The proxy's public readiness contract explicitly says some actor or
    // lightweight references can still be pending replication. Keep every
    // number observed in that intermediate state labeled as partial; emitting
    // a zero total here would falsely say a miner cannot be present or bound.
    Result->SetNumberField(TEXT("actor_member_count_observed"), Members.Num());
    Result->SetNumberField(TEXT("lightweight_member_count_observed"), LightweightCount);
    Result->SetNumberField(TEXT("member_count_observed"), Members.Num() + LightweightCount);
    Result->SetNumberField(TEXT("extractor_count_observed"), Extractors.Num() + LightweightExtractorCount);
    Result->SetNumberField(TEXT("actor_extractor_count_observed"), Extractors.Num());
    Result->SetNumberField(TEXT("lightweight_extractor_count_uninspected"), LightweightExtractorCount);
    Result->SetNumberField(TEXT("resource_anchor_count_observed"), ResourceAnchors.Num());
    Result->SetNumberField(
        TEXT("lightweight_resource_anchor_count_uninspected"),
        LightweightResourceAnchorCount);
    Result->SetBoolField(
        TEXT("resource_anchor_observation_complete"),
        bProxyReady && LightweightResourceAnchorCount == 0);
    Result->SetBoolField(TEXT("member_counts_complete"), bProxyReady);
    Result->SetBoolField(TEXT("extractor_observation_complete"), bProxyReady && LightweightExtractorCount == 0);
    if (bProxyReady)
    {
        Result->SetNumberField(TEXT("actor_member_count"), Members.Num());
        Result->SetNumberField(TEXT("lightweight_member_count"), LightweightCount);
        Result->SetNumberField(TEXT("member_count"), Members.Num() + LightweightCount);
        Result->SetNumberField(TEXT("extractor_count"), Extractors.Num() + LightweightExtractorCount);
        Result->SetNumberField(
            TEXT("resource_anchor_count"),
            ResourceAnchors.Num() + LightweightResourceAnchorCount);
        Result->SetObjectField(TEXT("extractor_binding_counts"), Counts);
        Result->SetBoolField(
            TEXT("extractor_binding_states_fully_inspected"),
            LightweightExtractorCount == 0);
    }
    Result->SetNumberField(TEXT("extractor_details_returned"), ExtractorDetails.Num());
    Result->SetNumberField(
        TEXT("extractor_details_capped_omitted"),
        Extractors.Num() - ExtractorDetails.Num());
    Result->SetArrayField(TEXT("extractors"), ExtractorDetails);
    Result->SetNumberField(TEXT("resource_anchor_details_returned"), ResourceAnchorDetails.Num());
    Result->SetNumberField(
        TEXT("resource_anchor_details_capped_omitted"),
        ResourceAnchors.Num() - ResourceAnchorDetails.Num());
    Result->SetArrayField(TEXT("resource_anchors"), ResourceAnchorDetails);
    if (!bProxyReady)
    {
        Result->SetStringField(TEXT("reason"), TEXT("blueprint_proxy_replication_pending"));
    }
    else if (LightweightExtractorCount > 0)
    {
        Result->SetStringField(
            TEXT("binding_caveat"),
            TEXT("lightweight_extractor_members_cannot_be_resolved_from_this_aim"));
    }
    return Result;
}
