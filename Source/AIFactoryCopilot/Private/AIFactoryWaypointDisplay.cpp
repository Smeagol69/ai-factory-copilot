#include "AIFactoryWaypointDisplay.h"

#include "FGCharacterPlayer.h"
#include "FGMapManager.h"
#include "FGMapMarker.h"

namespace
{
    const FString DistanceSeparator = TEXT(" | ");

    bool IsCopilotDistanceSuffix(const FString& Candidate)
    {
        if (!Candidate.EndsWith(TEXT(" m"), ESearchCase::CaseSensitive))
        {
            return false;
        }

        const FString Number = Candidate.LeftChop(2).TrimStartAndEnd();
        if (Number.IsEmpty())
        {
            return false;
        }

        for (const TCHAR Character : Number)
        {
            if (!FChar::IsDigit(Character))
            {
                return false;
            }
        }
        return true;
    }
}

FString AIFactoryWaypointDisplay::StripDistanceSuffix(const FString& Name)
{
    int32 SeparatorIndex = INDEX_NONE;
    if (!Name.FindLastChar(TEXT('|'), SeparatorIndex))
    {
        return Name;
    }

    const FString Candidate = Name.Mid(SeparatorIndex + 1).TrimStartAndEnd();
    return IsCopilotDistanceSuffix(Candidate)
        ? Name.Left(SeparatorIndex).TrimEnd()
        : Name;
}

FString AIFactoryWaypointDisplay::FormatName(
    const FString& BaseName,
    const FVector& PlayerLocation,
    const FVector& WaypointLocation)
{
    const FString CleanName = StripDistanceSuffix(BaseName);
    const int32 DistanceMeters = FMath::Max(
        0,
        FMath::RoundToInt(FVector::Dist(PlayerLocation, WaypointLocation) / 100.0));
    return FString::Printf(
        TEXT("%s%s%d m"),
        *CleanName,
        *DistanceSeparator,
        DistanceMeters);
}

void AIFactoryWaypointDisplay::Refresh(UWorld* World, const AFGCharacterPlayer* Player)
{
    if (!IsValid(World) || !IsValid(Player))
    {
        return;
    }

    AFGMapManager* MapManager = AFGMapManager::Get(World);
    if (!IsValid(MapManager))
    {
        return;
    }

    TArray<FMapMarker> Markers;
    MapManager->GetMapMarkers(Markers);
    const FVector PlayerLocation = Player->GetActorLocation();

    for (FMapMarker& Marker : Markers)
    {
        if (Marker.CategoryName != Category)
        {
            continue;
        }

        const FString UpdatedName = FormatName(
            Marker.Name,
            PlayerLocation,
            FVector(Marker.Location));
        if (UpdatedName != Marker.Name)
        {
            Marker.Name = UpdatedName;
            MapManager->UpdateMapMarker(Marker);
        }
    }
}
