#pragma once

#include <cmath>

// Kept independent of engine objects so the production comparison can be
// replayed against native-loader readbacks without spawning another base.
namespace AIFactoryBaseTransformMatch
{
    constexpr double RotationComponentTolerance = 1e-12;
    constexpr double UnitLengthTolerance = 1e-5;

    struct FComponents
    {
        double Translation[3];
        double Rotation[4];
        double Scale[3];
    };

    inline bool Matches(const FComponents& Saved, const FComponents& Observed)
    {
        for (int Axis = 0; Axis < 3; ++Axis)
        {
            // No position/scale tolerance: even a one-ULP displacement fails.
            if (!std::isfinite(Saved.Translation[Axis]) || !std::isfinite(Saved.Scale[Axis]) ||
                Saved.Translation[Axis] != Observed.Translation[Axis] ||
                Saved.Scale[Axis] != Observed.Scale[Axis]) return false;
        }
        double SavedLengthSquared = 0, ObservedLengthSquared = 0;
        for (int Axis = 0; Axis < 4; ++Axis)
        {
            if (!std::isfinite(Saved.Rotation[Axis]) || !std::isfinite(Observed.Rotation[Axis])) return false;
            SavedLengthSquared += Saved.Rotation[Axis] * Saved.Rotation[Axis];
            ObservedLengthSquared += Observed.Rotation[Axis] * Observed.Rotation[Axis];
        }
        if (!std::isfinite(SavedLengthSquared) || !std::isfinite(ObservedLengthSquared) ||
            std::abs(SavedLengthSquared - 1.0) > UnitLengthTolerance ||
            std::abs(ObservedLengthSquared - 1.0) > UnitLengthTolerance) return false;

        // Save/Blueprint float quaternions are not exactly unit length. Native
        // SceneComponent rotation is normalized and may roundtrip via FRotator.
        // Compare orientation after normalization; q and -q are the same turn.
        // Only double arithmetic roundoff is allowed, never a placement angle.
        const double SavedInverseLength = 1.0 / std::sqrt(SavedLengthSquared);
        const double ObservedInverseLength = 1.0 / std::sqrt(ObservedLengthSquared);
        bool SameSign = true, OppositeSign = true;
        for (int Axis = 0; Axis < 4; ++Axis)
        {
            const double A = Saved.Rotation[Axis] * SavedInverseLength;
            const double B = Observed.Rotation[Axis] * ObservedInverseLength;
            SameSign = SameSign && std::abs(A - B) <= RotationComponentTolerance;
            OppositeSign = OppositeSign && std::abs(A + B) <= RotationComponentTolerance;
        }
        return SameSign || OppositeSign;
    }
}
