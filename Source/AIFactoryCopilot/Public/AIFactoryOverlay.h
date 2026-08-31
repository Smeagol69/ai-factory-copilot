#pragma once

#include "CoreMinimal.h"

class AActor;
class AFGCharacterPlayer;
class UWorld;

/**
 * In-world overlays: tracer lines, bounding boxes, and markers drawn live.
 *
 * Drawn through `ULineBatchComponent`, deliberately, **not** through the
 * `DrawDebug*` helpers. Those are compiled out of Shipping builds
 * (`ENABLE_DRAW_DEBUG` is off), so they would silently no-op in the packaged
 * mod. The line batcher is a real render component and survives.
 *
 * Every overlay is drawn under a named batch id so it can be cleared on its own
 * without disturbing the others.
 */

/** What to highlight. Either explicit ids, a live query, or both. */
struct FAIFactoryOverlayQuery
{
    /** Exact actor ids, matching the scanner's `actor_id` (the actor path name). */
    TArray<FString> ActorIds;

    /** Case-insensitive substring of the item a pickup holds, e.g. "Nut", "Berry". */
    FString ItemNameContains;
    /** Case-insensitive substring of the actor's class name. */
    FString ClassNameContains;
    /** Case-insensitive substring of the actor's display name. */
    FString DisplayNameContains;

    /** Only one of these kinds is considered when set: pickup, resource_node, buildable, any. */
    FString Kind = TEXT("any");

    /** Search radius from the player, in metres. */
    double RadiusMeters = 100.0;
    /** Hard cap so a loose query cannot fill the screen. */
    int32 MaxResults = 200;
};

/** How to draw it. */
struct FAIFactoryOverlayStyle
{
    FLinearColor Color = FLinearColor(0.1f, 1.0f, 0.4f, 1.0f);
    bool bDrawTracers = true;
    bool bDrawBoxes = true;
    /** Draws a vertical pillar at each hit, visible from a distance over terrain. */
    bool bDrawPillars = true;
    float Thickness = 3.0f;
    float PillarHeightCm = 800.0f;
    /** Seconds; 0 means until explicitly cleared. */
    float LifetimeSeconds = 0.0f;
    /** Draw over geometry so targets are visible through terrain and buildings. */
    bool bDrawThroughWalls = true;
};

/** One highlighted thing, reported back so the answer can name what it drew. */
struct FAIFactoryOverlayHit
{
    FString ActorId;
    FString DisplayName;
    FString Kind;
    FVector Location = FVector::ZeroVector;
    double DistanceMeters = 0.0;
    int32 ItemCount = 0;
};

struct FAIFactoryOverlayResult
{
    bool bDrawn = false;
    FString OverlayName;
    FString Status = TEXT("not_run");
    FString Reason;
    TArray<FAIFactoryOverlayHit> Hits;
    int32 Matched = 0;
    int32 Truncated = 0;
    double RadiusMeters = 0.0;
};

/**
 * One exact bound from the native Blueprint editor's current selection.
 *
 * This deliberately carries geometry rather than an actor id. Lightweight
 * foundations and walls are not actors, and actor overlays re-query bounds at
 * draw time; neither is an honest picture of the set the editor will export.
 */
struct FAIFactorySelectionOverlayEntry
{
    FVector Origin = FVector::ZeroVector;
    FVector Extent = FVector::ZeroVector;
};

/** Result for the editor-only selection visual. Never a world mutation. */
struct FAIFactorySelectionOverlayResult
{
    bool bDrawn = false;
    /** True when the exact selection volume replaces individual outlines. */
    bool bCondensed = false;
    FString OverlayName;
    FString Status = TEXT("not_run");
    FString Reason;
    /** Every actor and lightweight instance the editor selected. */
    int32 SelectedCount = 0;
    /** Individual bounds actually drawn; zero when condensed. */
    int32 DetailedCount = 0;
    /** Selected bounds represented by the volume rather than individual lines. */
    int32 CondensedCount = 0;
    /** Bounds that could not be rendered exactly, always reported to the UI. */
    int32 InvalidBoundsCount = 0;
};

/** One exact semantic volume from a validated AI Architect manifest. */
struct FAIFactoryArchitectPreviewEntry
{
    FString Id;
    FString Kind;
    /** Rotated lower corner, exactly as emitted by `megabase.design/v1`. */
    FVector Origin = FVector::ZeroVector;
    /** Positive local X/Y/Z size before yaw is applied. */
    FVector Size = FVector::ZeroVector;
    double YawDegrees = 0.0;
};

/** Authoritative readback for a draw-only Architect preview. */
struct FAIFactoryArchitectPreviewResult
{
    bool bDrawn = false;
    FString OverlayName;
    FString Status = TEXT("not_run");
    FString Reason;
    int32 ElementCount = 0;
    int32 LineCount = 0;
};

namespace AIFactoryOverlay
{
    /**
     * Resolves the query against the live world and draws the result.
     *
     * Resolution happens in C++ against actual actors, not against the snapshot,
     * so an overlay is always current even if the snapshot the model reasoned
     * about has gone stale.
     */
    FAIFactoryOverlayResult Draw(
        UWorld* World,
        AFGCharacterPlayer* Player,
        const FString& OverlayName,
        const FAIFactoryOverlayQuery& Query,
        const FAIFactoryOverlayStyle& Style);

    /**
     * Draws a native Blueprint editor selection.
     *
     * The selection volume is always drawn. Individual actor and lightweight
     * bounds are drawn only when their complete set fits the explicit render
     * budget; otherwise the result marks every omitted outline as condensed so
     * the UI can never imply that a partial drawing is the whole export.
     */
    FAIFactorySelectionOverlayResult DrawSelection(
        UWorld* World,
        const FString& OverlayName,
        const FBox& SelectionVolume,
        const TArray<FAIFactorySelectionOverlayEntry>& Entries,
        const FAIFactoryOverlayStyle& Style);

    /**
     * Draws a bounded semantic campus manifest as oriented wireframe volumes.
     * This is never a placement hologram and never mutates the save.
     */
    FAIFactoryArchitectPreviewResult DrawArchitectPreview(
        UWorld* World,
        const FString& OverlayName,
        const TArray<FAIFactoryArchitectPreviewEntry>& Entries,
        double FloorHeightCm,
        const FAIFactoryOverlayStyle& Style);

    /** Removes one named overlay. Returns false if no such overlay is drawn. */
    bool Clear(UWorld* World, const FString& OverlayName);

    /** Removes every overlay this mod drew. */
    int32 ClearAll(UWorld* World);

    /** Names of the overlays currently drawn. */
    TArray<FString> ActiveOverlays();

    TSharedPtr<class FJsonObject> ResultToJson(const FAIFactoryOverlayResult& Result);
    TSharedPtr<class FJsonObject> ResultToJson(const FAIFactoryArchitectPreviewResult& Result);
}
