#include "AIFactoryOverlay.h"

#include "Buildables/FGBuildable.h"
#include "Components/LineBatchComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGCharacterPlayer.h"
#include "FGItemPickup.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceNode.h"

namespace
{
    /**
     * Overlay name -> line-batcher batch id, so `Clear("beryl")` removes exactly
     * that overlay's geometry and leaves everything else on screen.
     */
    TMap<FString, uint32> GOverlayBatchIds;
    uint32 GNextOverlayBatchId = 1;

    /** Depth priority 1 (SDPG_Foreground) renders over world geometry. */
    constexpr uint8 OverlayDepthWorld = 0;
    constexpr uint8 OverlayDepthForeground = 1;

    ULineBatchComponent* GetOverlayBatcher(UWorld* World, bool bThroughWalls)
    {
        if (!IsValid(World))
        {
            return nullptr;
        }
        // Persistent batchers keep geometry until it is explicitly cleared, which
        // is what an overlay the player asked for should do.
        return World->GetLineBatcher(
            bThroughWalls
                ? UWorld::ELineBatcherType::ForegroundPersistent
                : UWorld::ELineBatcherType::WorldPersistent);
    }

    bool ContainsInsensitive(const FString& Haystack, const FString& Needle)
    {
        return Needle.IsEmpty() || Haystack.Contains(Needle, ESearchCase::IgnoreCase);
    }

    FString ClassifyActor(AActor* Actor)
    {
        if (Actor->IsA<AFGItemPickup>()) return TEXT("item_pickup");
        if (Actor->IsA<AFGResourceNode>()) return TEXT("resource_node");
        if (Actor->IsA<AFGBuildable>()) return TEXT("buildable");
        return TEXT("actor");
    }

    /** The name a player would recognise, which differs by actor kind. */
    FString DescribeActor(AActor* Actor, int32& OutItemCount)
    {
        OutItemCount = 0;
        if (AFGItemPickup* Pickup = Cast<AFGItemPickup>(Actor))
        {
            const TSubclassOf<UFGItemDescriptor> ItemClass = Pickup->GetPickupItemClass();
            OutItemCount = Pickup->GetNumItems();
            if (ItemClass)
            {
                return UFGItemDescriptor::GetItemName(ItemClass).ToString();
            }
        }
        if (AFGResourceNode* Node = Cast<AFGResourceNode>(Actor))
        {
            const TSubclassOf<UFGItemDescriptor> ResourceClass = Node->GetResourceClass();
            if (ResourceClass)
            {
                return UFGItemDescriptor::GetItemName(ResourceClass).ToString();
            }
        }
        return Actor->GetClass()->GetName();
    }
}

namespace AIFactoryOverlay
{

FAIFactoryOverlayResult Draw(
    UWorld* World,
    AFGCharacterPlayer* Player,
    const FString& OverlayName,
    const FAIFactoryOverlayQuery& Query,
    const FAIFactoryOverlayStyle& Style)
{
    FAIFactoryOverlayResult Result;
    Result.OverlayName = OverlayName.IsEmpty() ? TEXT("overlay") : OverlayName;
    Result.RadiusMeters = Query.RadiusMeters;

    if (!IsValid(World))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_world");
        return Result;
    }

    ULineBatchComponent* Batcher = GetOverlayBatcher(World, Style.bDrawThroughWalls);
    if (!IsValid(Batcher))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_line_batcher_available");
        return Result;
    }

    // Tracers are drawn from the player's eye so they read as lines of sight
    // rather than lines along the floor.
    const bool bHasPlayer = IsValid(Player);
    const FVector Origin = bHasPlayer
        ? Player->GetActorLocation() + FVector(0.0, 0.0, 50.0)
        : FVector::ZeroVector;
    if (!bHasPlayer && Query.ActorIds.Num() == 0)
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_player_to_search_around_and_no_explicit_actor_ids");
        return Result;
    }

    const double RadiusCm = FMath::Max(1.0, Query.RadiusMeters) * 100.0;
    const TSet<FString> WantedIds(Query.ActorIds);
    const bool bByIdOnly = WantedIds.Num() > 0;

    TArray<FAIFactoryOverlayHit> Hits;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        if (!IsValid(Actor))
        {
            continue;
        }

        // Explicit ids bypass every other filter, including the radius: the
        // caller named these exactly and should get them wherever they are.
        const FString ActorId = Actor->GetPathName();
        if (bByIdOnly)
        {
            if (!WantedIds.Contains(ActorId))
            {
                continue;
            }
        }
        else
        {
            const FString Kind = ClassifyActor(Actor);
            if (!Query.Kind.IsEmpty() && Query.Kind != TEXT("any") && Kind != Query.Kind)
            {
                continue;
            }
            const double DistanceCm = FVector::Dist(Origin, Actor->GetActorLocation());
            if (DistanceCm > RadiusCm)
            {
                continue;
            }
            if (!ContainsInsensitive(Actor->GetClass()->GetName(), Query.ClassNameContains))
            {
                continue;
            }
            int32 Ignored = 0;
            const FString Described = DescribeActor(Actor, Ignored);
            if (!ContainsInsensitive(Described, Query.ItemNameContains))
            {
                continue;
            }
            if (!ContainsInsensitive(Described, Query.DisplayNameContains) &&
                !ContainsInsensitive(Actor->GetName(), Query.DisplayNameContains))
            {
                continue;
            }
        }

        FAIFactoryOverlayHit Hit;
        Hit.ActorId = ActorId;
        Hit.Kind = ClassifyActor(Actor);
        Hit.Location = Actor->GetActorLocation();
        Hit.DisplayName = DescribeActor(Actor, Hit.ItemCount);
        Hit.DistanceMeters = bHasPlayer ? FVector::Dist(Origin, Hit.Location) / 100.0 : 0.0;
        Hits.Add(Hit);
    }

    Result.Matched = Hits.Num();

    // Nearest first, so a truncated list keeps the ones the player can act on.
    Hits.Sort([](const FAIFactoryOverlayHit& A, const FAIFactoryOverlayHit& B)
    {
        return A.DistanceMeters < B.DistanceMeters;
    });
    const int32 Limit = FMath::Max(1, Query.MaxResults);
    if (Hits.Num() > Limit)
    {
        Result.Truncated = Hits.Num() - Limit;
        Hits.SetNum(Limit);
    }

    if (Hits.Num() == 0)
    {
        Result.Status = TEXT("nothing_matched");
        return Result;
    }

    // Replacing an overlay of the same name clears the old geometry first, so
    // re-running a query updates in place instead of stacking.
    Clear(World, Result.OverlayName);
    const uint32 BatchId = GNextOverlayBatchId++;
    GOverlayBatchIds.Add(Result.OverlayName, BatchId);

    const uint8 Depth = Style.bDrawThroughWalls ? OverlayDepthForeground : OverlayDepthWorld;
    const float Lifetime = FMath::Max(0.0f, Style.LifetimeSeconds);

    for (const FAIFactoryOverlayHit& Hit : Hits)
    {
        AActor* Actor = nullptr;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetPathName() == Hit.ActorId)
            {
                Actor = *It;
                break;
            }
        }

        FVector BoxOrigin = Hit.Location;
        FVector BoxExtent(60.0, 60.0, 60.0);
        if (IsValid(Actor))
        {
            Actor->GetActorBounds(false, BoxOrigin, BoxExtent, true);
            // A zero-extent actor still needs a visible box.
            BoxExtent = BoxExtent.ComponentMax(FVector(40.0, 40.0, 40.0));
        }

        if (Style.bDrawBoxes)
        {
            Batcher->DrawBox(BoxOrigin, BoxExtent, Style.Color, Lifetime, Depth, Style.Thickness, BatchId);
        }
        if (Style.bDrawTracers && bHasPlayer)
        {
            Batcher->DrawLine(Origin, BoxOrigin, Style.Color, Depth, Style.Thickness, Lifetime, BatchId);
        }
        if (Style.bDrawPillars)
        {
            const FVector Top = BoxOrigin + FVector(0.0, 0.0, BoxExtent.Z + Style.PillarHeightCm);
            Batcher->DrawLine(BoxOrigin, Top, Style.Color, Depth, Style.Thickness, Lifetime, BatchId);
        }
    }

    Result.Hits = MoveTemp(Hits);
    Result.bDrawn = true;
    Result.Status = TEXT("drawn");
    return Result;
}

bool Clear(UWorld* World, const FString& OverlayName)
{
    if (!IsValid(World))
    {
        return false;
    }
    const uint32* BatchId = GOverlayBatchIds.Find(OverlayName);
    if (!BatchId)
    {
        return false;
    }
    // The overlay may have been drawn into either batcher; clearing the id from
    // both is harmless and avoids tracking which was used.
    if (ULineBatchComponent* Foreground = GetOverlayBatcher(World, true))
    {
        Foreground->ClearBatch(*BatchId);
    }
    if (ULineBatchComponent* World_ = GetOverlayBatcher(World, false))
    {
        World_->ClearBatch(*BatchId);
    }
    GOverlayBatchIds.Remove(OverlayName);
    return true;
}

int32 ClearAll(UWorld* World)
{
    TArray<FString> Names;
    GOverlayBatchIds.GetKeys(Names);
    int32 Cleared = 0;
    for (const FString& Name : Names)
    {
        if (Clear(World, Name))
        {
            ++Cleared;
        }
    }
    return Cleared;
}

TArray<FString> ActiveOverlays()
{
    TArray<FString> Names;
    GOverlayBatchIds.GetKeys(Names);
    return Names;
}

TSharedPtr<FJsonObject> ResultToJson(const FAIFactoryOverlayResult& Result)
{
    TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("overlay"), Result.OverlayName);
    Object->SetStringField(TEXT("status"), Result.Status);
    Object->SetBoolField(TEXT("drawn"), Result.bDrawn);
    if (!Result.Reason.IsEmpty())
    {
        Object->SetStringField(TEXT("reason"), Result.Reason);
    }
    Object->SetNumberField(TEXT("matched"), Result.Matched);
    Object->SetNumberField(TEXT("drawn_count"), Result.Hits.Num());
    Object->SetNumberField(TEXT("radius_m"), Result.RadiusMeters);
    if (Result.Truncated > 0)
    {
        Object->SetNumberField(TEXT("not_drawn_over_limit"), Result.Truncated);
    }

    TArray<TSharedPtr<FJsonValue>> Hits;
    for (const FAIFactoryOverlayHit& Hit : Result.Hits)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("actor_id"), Hit.ActorId);
        Entry->SetStringField(TEXT("name"), Hit.DisplayName);
        Entry->SetStringField(TEXT("kind"), Hit.Kind);
        Entry->SetNumberField(TEXT("distance_m"), FMath::RoundToDouble(Hit.DistanceMeters * 10.0) / 10.0);
        if (Hit.ItemCount > 0)
        {
            Entry->SetNumberField(TEXT("item_count"), Hit.ItemCount);
        }
        TSharedPtr<FJsonObject> Location = MakeShared<FJsonObject>();
        Location->SetNumberField(TEXT("x"), Hit.Location.X);
        Location->SetNumberField(TEXT("y"), Hit.Location.Y);
        Location->SetNumberField(TEXT("z"), Hit.Location.Z);
        Entry->SetObjectField(TEXT("location"), Location);
        Hits.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Object->SetArrayField(TEXT("hits"), Hits);
    Object->SetStringField(TEXT("source"), TEXT("resolved_against_live_actors_and_drawn_in_world"));
    return Object;
}

}
