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

    void Scroll(const float Delta, const bool bFine, const bool bCoarse, const bool bRamp = false)
    {
        if (!bEnabled || !FMath::IsFinite(Delta))
        {
            return;
        }
        const double Degrees = FMath::Clamp(Delta, -20.0f, 20.0f) *
            (bRamp ? RampAngle() : bFine ? 1.0 : bCoarse ? 45.0 : 15.0);
        const FVector LocalAxis = Axis == 0 ? FVector::ForwardVector
            : Axis == 1 ? FVector::RightVector : FVector::UpVector;
        Rotation = (Rotation * FQuat(LocalAxis, FMath::DegreesToRadians(Degrees))).GetNormalized();
    }
};
