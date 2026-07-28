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

    /** Removes one named overlay. Returns false if no such overlay is drawn. */
    bool Clear(UWorld* World, const FString& OverlayName);

    /** Removes every overlay this mod drew. */
    int32 ClearAll(UWorld* World);

    /** Names of the overlays currently drawn. */
    TArray<FString> ActiveOverlays();

    TSharedPtr<class FJsonObject> ResultToJson(const FAIFactoryOverlayResult& Result);
}
