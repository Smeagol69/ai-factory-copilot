#pragma once
#include <cmath>

namespace AIFactoryFixturePosePolicy
{
    // Only v8's two exact fixture classes may use this policy. Lamps shrink
    // uniformly; beams shorten local X while retaining width and thickness.
    inline bool AllowsScale(double X, double Y, double Z, double AxisXVertical, bool IsBeam)
    {
        if (!std::isfinite(X) || !std::isfinite(Y) || !std::isfinite(Z) ||
            !std::isfinite(AxisXVertical)) return false;
        return IsBeam ? X >= .01 && X <= 1 && Y == 1 && Z == 1 && std::abs(AxisXVertical) <= .0001
            : X >= .05 && X <= 1 && X == Y && X == Z;
    }
}
