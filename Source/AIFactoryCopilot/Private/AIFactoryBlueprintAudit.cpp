#include "AIFactoryBlueprintAudit.h"

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

    FString AIFactoryBlueprintAuditClassPath(const UClass* Class)
    {
        return IsValid(Class) ? Class->GetPathName() : FString();
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
        const TSharedRef<FJsonObject>& Detail,
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
        TEXT("AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors"));
    Result->SetStringField(TEXT("certainty"), TEXT("unknown"));
    Result->SetBoolField(TEXT("available"), false);
    Result->SetNumberField(TEXT("maximum_extractor_details"), AIFactoryBlueprintAuditMaximumExtractorDetails);

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
    for (const FBuildableClassLightweightIndices& Entry : Proxy->GetLightweightClassAndIndices())
    {
        LightweightCount += Entry.Indices.Num();
        const UClass* LightweightClass = Entry.BuildableClass.Get();
        if (IsValid(LightweightClass) &&
            LightweightClass->IsChildOf(AFGBuildableResourceExtractorBase::StaticClass()))
        {
            LightweightExtractorCount += Entry.Indices.Num();
        }
    }

    TArray<AFGBuildableResourceExtractorBase*> Extractors;
    for (AFGBuildable* Member : Members)
    {
        if (AFGBuildableResourceExtractorBase* Extractor = Cast<AFGBuildableResourceExtractorBase>(Member))
        {
            Extractors.Add(Extractor);
        }
    }
    Extractors.Sort([](const AFGBuildableResourceExtractorBase& Left, const AFGBuildableResourceExtractorBase& Right)
    {
        return Left.GetPathName() < Right.GetPathName();
    });

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
        const TSharedRef<FJsonObject> Detail = MakeShared<FJsonObject>();
        AIFactoryBlueprintAuditSetExtractorDetail(
            Detail,
            Extractor,
            bProxyReady,
            bProxyHasAuthority,
            BoundCount,
            UnboundCount,
            PendingCount,
            UnknownCount);
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
    Result->SetBoolField(TEXT("member_counts_complete"), bProxyReady);
    Result->SetBoolField(TEXT("extractor_observation_complete"), bProxyReady && LightweightExtractorCount == 0);
    if (bProxyReady)
    {
        Result->SetNumberField(TEXT("actor_member_count"), Members.Num());
        Result->SetNumberField(TEXT("lightweight_member_count"), LightweightCount);
        Result->SetNumberField(TEXT("member_count"), Members.Num() + LightweightCount);
        Result->SetNumberField(TEXT("extractor_count"), Extractors.Num() + LightweightExtractorCount);
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
