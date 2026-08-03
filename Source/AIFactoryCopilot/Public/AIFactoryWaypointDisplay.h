#pragma once

#include "CoreMinimal.h"

class AFGCharacterPlayer;
class UWorld;

namespace AIFactoryWaypointDisplay
{
    /** Category shared with the waypoint action; never touches the player's markers. */
    inline const FString Category = TEXT("AI Factory Copilot");

    /** Removes only the suffix produced by FormatName, preserving the user's label. */
    FString StripDistanceSuffix(const FString& Name);

    /** Adds an authoritative straight-line player distance, rounded to one metre. */
    FString FormatName(
        const FString& BaseName,
        const FVector& PlayerLocation,
        const FVector& WaypointLocation);

    /**
     * Refreshes Copilot marker labels from live game positions.
     *
     * UpdateMapMarker is only called when the rounded metre changes, avoiding a
     * saved-marker write every observer tick while the player is standing still.
     */
    void Refresh(UWorld* World, const AFGCharacterPlayer* Player);
}
