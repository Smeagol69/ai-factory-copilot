#pragma once

#include "CoreMinimal.h"

/** Local-axis quaternion editing avoids Euler-angle singularities at 90-degree tilts. */
struct FAIFactoryAxisRotationState
{
    bool bEnabled = false;
    int32 Axis = 2;
    FQuat Rotation = FQuat::Identity;

    void Begin(const FQuat& InitialRotation)
    {
        bEnabled = true;
        Axis = 2;
        Rotation = InitialRotation.GetNormalized();
    }

    void Reset()
    {
        bEnabled = false;
        Axis = 2;
        RampStep = 0;
        Rotation = FQuat::Identity;
    }

    void Cycle(const int32 Direction)
    {
        if (bEnabled)
        {
            Axis = (Axis + (Direction >= 0 ? 1 : 2)) % 3;
        }
    }

    /**
     * Ramp pitches, so a wall can be laid flush on a ramp instead of merely
     * near it. A vanilla ramp rises its thickness over one 8 m cell, so the
     * angle is atan(rise / 8 m): 8x1, 8x2 and 8x4 respectively. None of these
     * is reachable from the 15/1/45 degree steps, which is the whole reason
     * they exist as their own increment.
     */
    static constexpr double RampDegrees8x1 = 7.125016348901798;
    static constexpr double RampDegrees8x2 = 14.036243467926479;
    static constexpr double RampDegrees8x4 = 26.565051177077994;

    /** 0 = 8x4 (the common ramp), 1 = 8x2, 2 = 8x1. */
    int32 RampStep = 0;

    double RampAngle() const
    {
        return RampStep == 1 ? RampDegrees8x2
            : RampStep == 2 ? RampDegrees8x1 : RampDegrees8x4;
    }

    void CycleRamp()
    {
        if (bEnabled)
        {
            RampStep = (RampStep + 1) % 3;
        }
    }

    /**
     * Turns the selected local axis to point along a surface normal.
     *
     * This is the exact match the scroll steps can only approach: aim at a
     * ramp face, and the chosen axis is laid along its normal in one press,
     * whatever odd angle that face happens to be.
     *
     * FindBetweenNormals gives the *minimal* rotation between the two
     * directions, so whatever spin the object already had about that axis is
     * preserved rather than reset - press again on a different face and only
     * the tilt changes. Nothing here is destructive: the manual steps still
     * work afterwards, so a snap can be nudged if it is not quite wanted.
     *
     * @return false when the normal is unusable, so the caller can leave the
     *         preview untouched rather than applying a garbage pose.
     */
    bool AlignAxisToNormal(const FVector& Normal)
    {
        if (!bEnabled || !Normal.IsNormalized() || Normal.IsNearlyZero())
        {
            return false;
        }
        const FVector LocalAxis = Axis == 0 ? FVector::ForwardVector
            : Axis == 1 ? FVector::RightVector : FVector::UpVector;
        const FVector CurrentDirection = Rotation.RotateVector(LocalAxis);
        Rotation = (FQuat::FindBetweenNormals(CurrentDirection, Normal) * Rotation)
            .GetNormalized();
        return true;
    }

    void Scroll(const float Delta, const bool bFine, const bool bCoarse, const bool bRamp = false)
    {
        if (!bEnabled || !FMath::IsFinite(Delta))
        {
            return;
        }
        // Step sizes, coarsest to finest:
        //   Alt        exact ramp pitch, for sitting flush on a slope
        //   Shift      45   quarter turns
        //   none       15   the default detent
        //   Ctrl+Shift  1   the previous fine step, kept rather than dropped
        //   Ctrl        0.1 precise, for closing the last fraction of a degree
        // Ctrl+Shift is deliberately the middle rung: Ctrl alone is now ten
        // times finer than it was, and one degree is still wanted often enough
        // that removing it would be a regression.
        const double Degrees = FMath::Clamp(Delta, -20.0f, 20.0f) *
            (bRamp ? RampAngle()
                : (bFine && bCoarse) ? 1.0
                : bFine ? 0.1
                : bCoarse ? 45.0
                : 15.0);
        const FVector LocalAxis = Axis == 0 ? FVector::ForwardVector
            : Axis == 1 ? FVector::RightVector : FVector::UpVector;
        Rotation = (Rotation * FQuat(LocalAxis, FMath::DegreesToRadians(Degrees))).GetNormalized();
    }
};
