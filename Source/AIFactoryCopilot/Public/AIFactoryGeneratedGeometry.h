#pragma once
#include "CoreMinimal.h"

// Pure comparison of planned archive-space pieces to objects reconstructed by
// the native Blueprint loader. Destination/world clearance is a separate check.
namespace AIFactoryGeneratedGeometry
{
    inline constexpr double PositionToleranceCm = 0.1;
    inline constexpr double RotationComponentTolerance = 0.0001;
    inline constexpr double ScaleTolerance = 0.0001;
    struct FPart
    {
        FString PartId;
        FString ClassPath;
        FTransform Transform;
    };
    inline bool Match(const TArray<FPart>& Expected, const TArray<FPart>& Actual,
        int32& OutMatched, FString& OutReason)
    {
        OutMatched = 0; OutReason.Reset();
        TSet<int32> Used; TSet<FString> PartIds;
        if (Expected.IsEmpty()) { OutReason = TEXT("native_blueprint_no_expected_parts"); return false; }
        for (const FPart& Observed : Actual)
        {
            if (Observed.ClassPath.IsEmpty() || !Observed.Transform.IsValid())
            { OutReason = TEXT("native_blueprint_invalid_observed_geometry"); return false; }
        }
        for (const FPart& Planned : Expected)
        {
            if (Planned.PartId.IsEmpty() || PartIds.Contains(Planned.PartId) ||
                Planned.ClassPath.IsEmpty() || !Planned.Transform.IsValid())
            { OutReason = TEXT("native_blueprint_invalid_expected_geometry"); return false; }
            PartIds.Add(Planned.PartId);
            int32 MatchIndex = INDEX_NONE; int32 Matches = 0;
            for (int32 Index = 0; Index < Actual.Num(); ++Index)
            {
                const FPart& Observed = Actual[Index];
                if (Observed.ClassPath == Planned.ClassPath &&
                    Observed.Transform.GetLocation().Equals(Planned.Transform.GetLocation(), PositionToleranceCm) &&
                    Observed.Transform.GetRotation().Equals(Planned.Transform.GetRotation(), RotationComponentTolerance) &&
                    Observed.Transform.GetScale3D().Equals(Planned.Transform.GetScale3D(), ScaleTolerance))
                { ++Matches; MatchIndex = Index; }
            }
            if (Matches != 1 || Used.Contains(MatchIndex))
            {
                OutReason = TEXT("native_blueprint_part_transform_readback_failed:") + Planned.PartId +
                    (Matches == 0 ? TEXT(":missing") : Matches > 1 ? TEXT(":ambiguous") : TEXT(":reused"));
                return false;
            }
            Used.Add(MatchIndex); ++OutMatched;
        }
        // Transport actors are validated by the existing topology/count checks;
        // they may be additional to the explicit structural/machine part list.
        return true;
    }
}
