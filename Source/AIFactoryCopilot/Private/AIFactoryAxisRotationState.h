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
        Rotation = FQuat::Identity;
    }

    void Cycle(const int32 Direction)
    {
        if (bEnabled)
        {
            Axis = (Axis + (Direction >= 0 ? 1 : 2)) % 3;
        }
    }

    void Scroll(const float Delta, const bool bFine, const bool bCoarse)
    {
        if (!bEnabled || !FMath::IsFinite(Delta))
        {
            return;
        }
        const double Degrees = FMath::Clamp(Delta, -20.0f, 20.0f) *
            (bFine ? 1.0 : bCoarse ? 45.0 : 15.0);
        const FVector LocalAxis = Axis == 0 ? FVector::ForwardVector
            : Axis == 1 ? FVector::RightVector : FVector::UpVector;
        Rotation = (Rotation * FQuat(LocalAxis, FMath::DegreesToRadians(Degrees))).GetNormalized();
    }
};
