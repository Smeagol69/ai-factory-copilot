#pragma once
#include <cstdint>

namespace AIFactoryDismantleMarks
{
    struct FSelection
    {
        bool Valid = false;
        std::int32_t KeepCount = 0;
        bool AimedOnly = false;
    };

    // CL513885 native GetPendingDismantleActors copies the pending array, then
    // AddUnique's the selected crosshair actor. GetNumPending...(false) counts
    // just the pending array. Retain that exact prefix; never add an unmarked
    // target when marks exist, or disguise missing marks as an aimed fallback.
    inline FSelection Resolve(std::int32_t Pending, std::int32_t Returned, bool LastIsAimed)
    {
        if (Pending < 0 || Returned < 0) return {};
        if (Pending == 0)
        {
            if (Returned == 0) return {true, 0, false};
            if (Returned == 1 && LastIsAimed) return {true, 1, true};
            return {};
        }
        if (Returned == Pending || (Returned > Pending && Returned - Pending == 1 && LastIsAimed))
            return {true, Pending, false};
        return {};
    }
}
