#pragma once
#include <cmath>

namespace AIFactoryFoundationPosePolicy
{
    // Unit-scale legacy poses remain unchanged. V7 may only shorten one local
    // horizontal axis; height/thickness, mirroring and expansion stay forbidden.
    inline bool AllowsScale(double X, double Y, double Z,
        double AxisXVertical, double AxisYVertical, bool AllowShortening)
    {
        if (!std::isfinite(X) || !std::isfinite(Y) || !std::isfinite(Z) ||
            !std::isfinite(AxisXVertical) || !std::isfinite(AxisYVertical) ||
            Z != 1.0 || X < 0.01 || X > 1.0 || Y < 0.01 || Y > 1.0 ||
            (X != 1.0 && Y != 1.0)) return false;
        if (!AllowShortening) return X == 1.0 && Y == 1.0;
        return (X == 1.0 || std::abs(AxisXVertical) <= 0.0001) &&
            (Y == 1.0 || std::abs(AxisYVertical) <= 0.0001);
    }
}
