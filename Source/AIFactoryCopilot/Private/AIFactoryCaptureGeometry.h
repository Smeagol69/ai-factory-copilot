#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

namespace AIFactoryCaptureGeometry
{
    // FGBuildableBlueprintDesigner.h (CL 502094): mDimensions uses 800-unit
    // increments on every axis. XY is centred on the pivot; Z starts at its base.
    constexpr double CellCm = 800.0;

    inline bool ComputeDimensions(
        const std::array<double, 3>& Minimum,
        const std::array<double, 3>& Maximum,
        const std::array<double, 3>& Origin,
        std::array<std::int32_t, 3>& OutDimensions)
    {
        std::array<std::int32_t, 3> Dimensions{};
        for (std::size_t Axis = 0; Axis < 3; ++Axis)
        {
            if (!std::isfinite(Minimum[Axis]) || !std::isfinite(Maximum[Axis]) ||
                !std::isfinite(Origin[Axis]) || Minimum[Axis] > Maximum[Axis])
            {
                return false;
            }
            // A snapped pivot need not be the bounds centre. Using size alone
            // would clip the farther edge, including on negative coordinates.
            const double Span = Axis < 2
                ? 2.0 * std::max(std::abs(Minimum[Axis] - Origin[Axis]),
                                 std::abs(Maximum[Axis] - Origin[Axis]))
                : Maximum[Axis] - Origin[Axis];
            if (Axis == 2 && Minimum[Axis] < Origin[Axis])
            {
                return false;
            }
            const double Cells = std::max(1.0, std::ceil(Span / CellCm));
            if (!std::isfinite(Cells) || Cells > std::numeric_limits<std::int32_t>::max())
            {
                return false;
            }
            Dimensions[Axis] = static_cast<std::int32_t>(Cells);
        }
        OutDimensions = Dimensions;
        return true;
    }
}
