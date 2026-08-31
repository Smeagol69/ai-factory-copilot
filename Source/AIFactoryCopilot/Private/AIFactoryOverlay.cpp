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
     * Overlay names are scoped to the world that owns their line batcher. A
     * process-global name -> id map can survive a save transition and clear an
     * unrelated batch carrying the same numeric id in the next world.
     */
    TMap<TWeakObjectPtr<UWorld>, TMap<FString, uint32>> GOverlayBatchIdsByWorld;
    uint32 GNextOverlayBatchId = 1;

    constexpr int32 MaximumOverlayResults = 500;
    constexpr int32 MaximumExplicitActorIds = 4096;
    constexpr int32 MaximumActorIdCharacters = 2048;
    constexpr double MaximumOverlayRadiusMeters = 100000.0;
    /**
     * A native editor selection may contain an entire megabase. Its volume is
     * still exact at any size, but tens of thousands of individual wireframes
     * would make moving one size slider hitch the game. Above this measured
     * render budget the UI states that individual outlines are condensed; it
     * never silently draws a prefix.
     */
    constexpr int32 MaximumSelectionOverlayEntries = 2048;
    constexpr int32 MaximumArchitectPreviewEntries = 256;
    constexpr int32 MaximumArchitectPreviewLines = 16384;
    constexpr int32 MaximumArchitectFloorsPerElement = 32;

    /** Depth priority 1 (SDPG_Foreground) renders over world geometry. */
    constexpr uint8 OverlayDepthWorld = 0;
    constexpr uint8 OverlayDepthForeground = 1;

    struct FAIFactoryOverlayCandidate
    {
        FAIFactoryOverlayHit Hit;
        TWeakObjectPtr<AActor> Actor;
    };

    void PruneOverlayWorldStates()
    {
        for (auto It = GOverlayBatchIdsByWorld.CreateIterator(); It; ++It)
        {
            if (!It.Key().IsValid())
            {
                It.RemoveCurrent();
            }
        }
    }

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

    void AIFactoryAppendSelectionBoxLines(
        TArray<FBatchedLine>& OutLines,
        const FVector& Origin,
        const FVector& Extent,
        const FLinearColor& Color,
        const float Lifetime,
        const float Thickness,
        const uint8 Depth,
        const uint32 BatchId)
    {
        const FVector SafeExtent = Extent.ComponentMax(FVector(10.0, 10.0, 10.0));
        const FVector Min = Origin - SafeExtent;
        const FVector Max = Origin + SafeExtent;
        const FVector Corners[8] = {
            FVector(Min.X, Min.Y, Min.Z), FVector(Max.X, Min.Y, Min.Z),
            FVector(Max.X, Max.Y, Min.Z), FVector(Min.X, Max.Y, Min.Z),
            FVector(Min.X, Min.Y, Max.Z), FVector(Max.X, Min.Y, Max.Z),
            FVector(Max.X, Max.Y, Max.Z), FVector(Min.X, Max.Y, Max.Z),
        };
        static constexpr int32 Edges[12][2] = {
            { 0, 1 }, { 1, 2 }, { 2, 3 }, { 3, 0 },
            { 4, 5 }, { 5, 6 }, { 6, 7 }, { 7, 4 },
            { 0, 4 }, { 1, 5 }, { 2, 6 }, { 3, 7 },
        };
        for (const int32 (&Edge)[2] : Edges)
        {
            OutLines.Emplace(
                Corners[Edge[0]],
                Corners[Edge[1]],
                Color,
                Lifetime,
                Thickness,
                Depth,
                BatchId);
        }
    }

    bool AIFactorySelectionEntryIsFinite(const FAIFactorySelectionOverlayEntry& Entry)
    {
        return !Entry.Origin.ContainsNaN() &&
            !Entry.Extent.ContainsNaN() &&
            Entry.Extent.X >= 0.0 &&
            Entry.Extent.Y >= 0.0 &&
            Entry.Extent.Z >= 0.0;
    }

    bool AIFactoryArchitectEntryIsFinite(const FAIFactoryArchitectPreviewEntry& Entry)
    {
        return !Entry.Origin.ContainsNaN() &&
            !Entry.Size.ContainsNaN() &&
            FMath::IsFinite(Entry.YawDegrees) &&
            Entry.Size.X > 0.0 && Entry.Size.Y > 0.0 && Entry.Size.Z > 0.0 &&
            !Entry.Id.IsEmpty() && !Entry.Kind.IsEmpty();
    }

    FLinearColor AIFactoryArchitectColor(const FString& Kind)
    {
        if (Kind == TEXT("production_zone")) return FLinearColor(0.1f, 1.0f, 0.4f, 1.0f);
        if (Kind == TEXT("structural_platform")) return FLinearColor(0.2f, 0.5f, 1.0f, 1.0f);
        if (Kind == TEXT("glazed_facade")) return FLinearColor(0.1f, 0.9f, 1.0f, 1.0f);
        if (Kind == TEXT("sloped_roof_intent")) return FLinearColor(0.7f, 0.3f, 1.0f, 1.0f);
        if (Kind == TEXT("support_pylon")) return FLinearColor(1.0f, 0.5f, 0.05f, 1.0f);
        if (Kind == TEXT("skybridge")) return FLinearColor(1.0f, 0.9f, 0.1f, 1.0f);
        if (Kind == TEXT("vertical_landmark")) return FLinearColor::White;
        return FLinearColor(1.0f, 0.15f, 0.15f, 1.0f);
    }

    void AIFactoryAppendArchitectBoxLines(
        TArray<FBatchedLine>& OutLines,
        const FAIFactoryArchitectPreviewEntry& Entry,
        const double FloorHeightCm,
        const float Lifetime,
        const float Thickness,
        const uint8 Depth,
        const uint32 BatchId)
    {
        const FQuat Rotation(FRotator(0.0, Entry.YawDegrees, 0.0));
        const FVector LocalCorners[8] = {
            FVector(0.0, 0.0, 0.0),
            FVector(Entry.Size.X, 0.0, 0.0),
            FVector(Entry.Size.X, Entry.Size.Y, 0.0),
            FVector(0.0, Entry.Size.Y, 0.0),
            FVector(0.0, 0.0, Entry.Size.Z),
            FVector(Entry.Size.X, 0.0, Entry.Size.Z),
            FVector(Entry.Size.X, Entry.Size.Y, Entry.Size.Z),
            FVector(0.0, Entry.Size.Y, Entry.Size.Z),
        };
        FVector Corners[8];
        for (int32 Index = 0; Index < 8; ++Index)
        {
            Corners[Index] = Entry.Origin + Rotation.RotateVector(LocalCorners[Index]);
        }
        static constexpr int32 Edges[12][2] = {
            { 0, 1 }, { 1, 2 }, { 2, 3 }, { 3, 0 },
            { 4, 5 }, { 5, 6 }, { 6, 7 }, { 7, 4 },
            { 0, 4 }, { 1, 5 }, { 2, 6 }, { 3, 7 },
        };
        const FLinearColor Color = AIFactoryArchitectColor(Entry.Kind);
        for (const int32 (&Edge)[2] : Edges)
        {
            OutLines.Emplace(
                Corners[Edge[0]], Corners[Edge[1]], Color,
                Lifetime, Thickness, Depth, BatchId);
        }

        const int32 FloorCount = FMath::Clamp(
            FMath::FloorToInt(Entry.Size.Z / FloorHeightCm),
            1,
            MaximumArchitectFloorsPerElement);
        for (int32 Floor = 1; Floor < FloorCount; ++Floor)
        {
            const double Z = FMath::Min(Floor * FloorHeightCm, Entry.Size.Z);
            const FVector Ring[4] = {
                Entry.Origin + Rotation.RotateVector(FVector(0.0, 0.0, Z)),
                Entry.Origin + Rotation.RotateVector(FVector(Entry.Size.X, 0.0, Z)),
                Entry.Origin + Rotation.RotateVector(FVector(Entry.Size.X, Entry.Size.Y, Z)),
                Entry.Origin + Rotation.RotateVector(FVector(0.0, Entry.Size.Y, Z)),
            };
            for (int32 Edge = 0; Edge < 4; ++Edge)
            {
                OutLines.Emplace(
                    Ring[Edge], Ring[(Edge + 1) % 4], Color,
                    Lifetime, Thickness * 0.65f, Depth, BatchId);
            }
        }
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

    if (!IsValid(World))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_world");
        return Result;
    }

    if (!FMath::IsFinite(Query.RadiusMeters) || Query.RadiusMeters <= 0.0)
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("radius_must_be_finite_and_positive");
        return Result;
    }
    if (Query.ActorIds.Num() > MaximumExplicitActorIds)
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("too_many_explicit_actor_ids");
        return Result;
    }
    for (const FString& ActorId : Query.ActorIds)
    {
        if (ActorId.Len() > MaximumActorIdCharacters)
        {
            Result.Status = TEXT("refused");
            Result.Reason = TEXT("explicit_actor_id_too_long");
            return Result;
        }
    }

    const double SearchRadiusMeters =
        FMath::Min(Query.RadiusMeters, MaximumOverlayRadiusMeters);
    const int32 Limit = FMath::Clamp(Query.MaxResults, 1, MaximumOverlayResults);
    Result.RadiusMeters = SearchRadiusMeters;

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

    const double RadiusCm = SearchRadiusMeters * 100.0;
    const TSet<FString> WantedIds(Query.ActorIds);
    const bool bByIdOnly = WantedIds.Num() > 0;

    TArray<FAIFactoryOverlayCandidate> Candidates;
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

        FAIFactoryOverlayCandidate Candidate;
        Candidate.Actor = Actor;
        Candidate.Hit.ActorId = ActorId;
        Candidate.Hit.Kind = ClassifyActor(Actor);
        Candidate.Hit.Location = Actor->GetActorLocation();
        Candidate.Hit.DisplayName = DescribeActor(Actor, Candidate.Hit.ItemCount);
        Candidate.Hit.DistanceMeters =
            bHasPlayer ? FVector::Dist(Origin, Candidate.Hit.Location) / 100.0 : 0.0;
        Candidates.Add(MoveTemp(Candidate));
    }

    Result.Matched = Candidates.Num();

    // Nearest first, so a truncated list keeps the ones the player can act on.
    Candidates.Sort([](const FAIFactoryOverlayCandidate& A, const FAIFactoryOverlayCandidate& B)
    {
        return A.Hit.DistanceMeters < B.Hit.DistanceMeters;
    });
    if (Candidates.Num() > Limit)
    {
        Result.Truncated = Candidates.Num() - Limit;
        Candidates.SetNum(Limit);
    }

    if (Candidates.Num() == 0)
    {
        Result.Status = TEXT("nothing_matched");
        return Result;
    }

    // Replacing an overlay of the same name clears the old geometry first, so
    // re-running a query updates in place instead of stacking.
    Clear(World, Result.OverlayName);
    const uint32 BatchId = GNextOverlayBatchId++;
    PruneOverlayWorldStates();
    GOverlayBatchIdsByWorld.FindOrAdd(TWeakObjectPtr<UWorld>(World))
        .Add(Result.OverlayName, BatchId);

    const uint8 Depth = Style.bDrawThroughWalls ? OverlayDepthForeground : OverlayDepthWorld;
    const float Lifetime = FMath::Max(0.0f, Style.LifetimeSeconds);

    for (const FAIFactoryOverlayCandidate& Candidate : Candidates)
    {
        const FAIFactoryOverlayHit& Hit = Candidate.Hit;
        AActor* Actor = Candidate.Actor.Get();

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

    Result.Hits.Reserve(Candidates.Num());
    for (FAIFactoryOverlayCandidate& Candidate : Candidates)
    {
        Result.Hits.Add(MoveTemp(Candidate.Hit));
    }
    Result.bDrawn = true;
    Result.Status = TEXT("drawn");
    return Result;
}

FAIFactorySelectionOverlayResult DrawSelection(
    UWorld* World,
    const FString& OverlayName,
    const FBox& SelectionVolume,
    const TArray<FAIFactorySelectionOverlayEntry>& Entries,
    const FAIFactoryOverlayStyle& Style)
{
    FAIFactorySelectionOverlayResult Result;
    Result.OverlayName = OverlayName.IsEmpty() ? TEXT("selection") : OverlayName;
    Result.SelectedCount = Entries.Num();

    if (!IsValid(World))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_world");
        return Result;
    }

    // Do not leave an old selection lit when the current input is malformed.
    Clear(World, Result.OverlayName);
    if (SelectionVolume.IsValid == 0 ||
        SelectionVolume.Min.ContainsNaN() ||
        SelectionVolume.Max.ContainsNaN())
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("selection_volume_is_not_finite");
        return Result;
    }

    ULineBatchComponent* Batcher = GetOverlayBatcher(World, Style.bDrawThroughWalls);
    if (!IsValid(Batcher))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_line_batcher_available");
        return Result;
    }

    for (const FAIFactorySelectionOverlayEntry& Entry : Entries)
    {
        if (!AIFactorySelectionEntryIsFinite(Entry))
        {
            ++Result.InvalidBoundsCount;
        }
    }

    // An invalid bound cannot be made visually honest by omitting just that
    // piece. Keep the exact selection volume, mark every individual outline as
    // condensed, and name the condition in the UI result.
    const bool bAllBoundsRenderable = Result.InvalidBoundsCount == 0;
    Result.DetailedCount =
        bAllBoundsRenderable && Entries.Num() <= MaximumSelectionOverlayEntries
            ? Entries.Num()
            : 0;
    Result.CondensedCount = Result.SelectedCount - Result.DetailedCount;
    Result.bCondensed = Result.CondensedCount > 0;

    const uint32 BatchId = GNextOverlayBatchId++;
    PruneOverlayWorldStates();
    GOverlayBatchIdsByWorld.FindOrAdd(TWeakObjectPtr<UWorld>(World))
        .Add(Result.OverlayName, BatchId);

    const uint8 Depth = Style.bDrawThroughWalls ? OverlayDepthForeground : OverlayDepthWorld;
    const float Lifetime = FMath::Max(0.0f, Style.LifetimeSeconds);
    TArray<FBatchedLine> Lines;
    Lines.Reserve((1 + Result.DetailedCount) * 12);
    AIFactoryAppendSelectionBoxLines(
        Lines,
        SelectionVolume.GetCenter(),
        SelectionVolume.GetExtent(),
        Style.Color,
        Lifetime,
        Style.Thickness,
        Depth,
        BatchId);
    for (int32 Index = 0; Index < Result.DetailedCount; ++Index)
    {
        const FAIFactorySelectionOverlayEntry& Entry = Entries[Index];
        AIFactoryAppendSelectionBoxLines(
            Lines,
            Entry.Origin,
            Entry.Extent,
            Style.Color,
            Lifetime,
            Style.Thickness,
            Depth,
            BatchId);
    }
    Batcher->DrawLines(Lines);

    Result.bDrawn = true;
    Result.Status = Result.bCondensed
        ? TEXT("selection_volume_drawn_individual_bounds_condensed")
        : TEXT("selection_volume_and_all_bounds_drawn");
    if (Result.InvalidBoundsCount > 0)
    {
        Result.Reason = TEXT("selected_bounds_not_finite");
    }
    else if (Result.bCondensed)
    {
        Result.Reason = TEXT("selection_exceeds_individual_outline_budget");
    }
    return Result;
}

FAIFactoryArchitectPreviewResult DrawArchitectPreview(
    UWorld* World,
    const FString& OverlayName,
    const TArray<FAIFactoryArchitectPreviewEntry>& Entries,
    const double FloorHeightCm,
    const FAIFactoryOverlayStyle& Style)
{
    FAIFactoryArchitectPreviewResult Result;
    Result.OverlayName = OverlayName.IsEmpty() ? TEXT("ai-architect") : OverlayName;
    Result.ElementCount = Entries.Num();

    if (!IsValid(World))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_world");
        return Result;
    }
    Clear(World, Result.OverlayName);
    if (!FMath::IsFinite(FloorHeightCm) || FloorHeightCm <= 0.0)
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("architect_floor_height_is_not_finite_and_positive");
        return Result;
    }
    if (Entries.IsEmpty() || Entries.Num() > MaximumArchitectPreviewEntries)
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("architect_preview_element_count_is_out_of_bounds");
        return Result;
    }

    int32 ExpectedLines = 0;
    for (const FAIFactoryArchitectPreviewEntry& Entry : Entries)
    {
        if (!AIFactoryArchitectEntryIsFinite(Entry))
        {
            Result.Status = TEXT("refused");
            Result.Reason = TEXT("architect_preview_element_is_invalid");
            return Result;
        }
        const int32 Floors = FMath::Clamp(
            FMath::FloorToInt(Entry.Size.Z / FloorHeightCm),
            1,
            MaximumArchitectFloorsPerElement);
        ExpectedLines += 12 + (Floors - 1) * 4;
        if (ExpectedLines > MaximumArchitectPreviewLines)
        {
            Result.Status = TEXT("refused");
            Result.Reason = TEXT("architect_preview_exceeds_line_budget");
            return Result;
        }
    }

    ULineBatchComponent* Batcher = GetOverlayBatcher(World, Style.bDrawThroughWalls);
    if (!IsValid(Batcher))
    {
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("no_line_batcher_available");
        return Result;
    }
    const uint32 BatchId = GNextOverlayBatchId++;
    PruneOverlayWorldStates();
    GOverlayBatchIdsByWorld.FindOrAdd(TWeakObjectPtr<UWorld>(World))
        .Add(Result.OverlayName, BatchId);
    const uint8 Depth = Style.bDrawThroughWalls ? OverlayDepthForeground : OverlayDepthWorld;
    const float Lifetime = FMath::Max(0.0f, Style.LifetimeSeconds);
    TArray<FBatchedLine> Lines;
    Lines.Reserve(ExpectedLines);
    for (const FAIFactoryArchitectPreviewEntry& Entry : Entries)
    {
        AIFactoryAppendArchitectBoxLines(
            Lines,
            Entry,
            FloorHeightCm,
            Lifetime,
            Style.Thickness,
            Depth,
            BatchId);
    }
    Batcher->DrawLines(Lines);

    Result.bDrawn = true;
    Result.LineCount = Lines.Num();
    Result.Status = TEXT("architect_preview_drawn");
    return Result;
}

bool Clear(UWorld* World, const FString& OverlayName)
{
    if (!IsValid(World))
    {
        return false;
    }
    PruneOverlayWorldStates();
    const TWeakObjectPtr<UWorld> WorldKey(World);
    TMap<FString, uint32>* WorldBatches = GOverlayBatchIdsByWorld.Find(WorldKey);
    if (!WorldBatches)
    {
        return false;
    }
    const uint32* BatchId = WorldBatches->Find(OverlayName);
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
    WorldBatches->Remove(OverlayName);
    if (WorldBatches->IsEmpty())
    {
        GOverlayBatchIdsByWorld.Remove(WorldKey);
    }
    return true;
}

int32 ClearAll(UWorld* World)
{
    if (!IsValid(World))
    {
        return 0;
    }
    PruneOverlayWorldStates();
    TArray<FString> Names;
    const TWeakObjectPtr<UWorld> WorldKey(World);
    if (const TMap<FString, uint32>* WorldBatches = GOverlayBatchIdsByWorld.Find(WorldKey))
    {
        WorldBatches->GetKeys(Names);
    }
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
    PruneOverlayWorldStates();
    TArray<FString> Names;
    for (const TPair<TWeakObjectPtr<UWorld>, TMap<FString, uint32>>& WorldEntry :
        GOverlayBatchIdsByWorld)
    {
        for (const TPair<FString, uint32>& OverlayEntry : WorldEntry.Value)
        {
            Names.AddUnique(OverlayEntry.Key);
        }
    }
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

TSharedPtr<FJsonObject> ResultToJson(const FAIFactoryArchitectPreviewResult& Result)
{
    TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("overlay"), Result.OverlayName);
    Object->SetStringField(TEXT("status"), Result.Status);
    Object->SetBoolField(TEXT("drawn"), Result.bDrawn);
    Object->SetNumberField(TEXT("element_count"), Result.ElementCount);
    Object->SetNumberField(TEXT("line_count"), Result.LineCount);
    if (!Result.Reason.IsEmpty())
    {
        Object->SetStringField(TEXT("reason"), Result.Reason);
    }
    Object->SetStringField(
        TEXT("source"),
        TEXT("validated_megabase_manifest_semantic_geometry_drawn_in_world"));
    Object->SetStringField(
        TEXT("construction_status"),
        TEXT("draw_only_not_a_blueprint_hologram_or_placement_validation"));
    return Object;
}

}
