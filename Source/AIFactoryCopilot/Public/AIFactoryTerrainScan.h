#pragma once

#include "CoreMinimal.h"

/**
 * A wide terrain scan, written to disk for the assistant to read.
 *
 * `FAIFactoryTerrain::ProbeSite` already samples a square footprint and reports
 * ground height, slope and water per point -- but it clamps resolution to 32,
 * so a single call cannot cover a whole cove at a useful spacing. This tiles it:
 * a grid of ProbeSite calls, their raw samples concatenated into one height
 * field.
 *
 * Why tile rather than loop `SampleGround` directly: `SampleGround` re-collects
 * every water volume in the world on each call. Over thousands of probes that
 * cost dominates. `ProbeSite` collects once per tile, so tiling is the cheap
 * path as well as the one built on already-tested code.
 *
 * The output pairs with a vision frame. A screenshot says "there is a rock
 * island in the middle of the cove"; the scan says it is 11 m above the water
 * and 24 m across. Neither alone is enough to place a foundation.
 */
namespace AIFactoryTerrainScan
{
    /** `Saved/AIFactoryCopilot/Terrain`, created on demand. */
    FString TerrainDirectory();

    /**
     * Scan a square centred on `Center` and write it as JSON.
     *
     * @param RadiusMeters   Half-width of the scanned square.
     * @param StepMeters     Desired spacing between probes. Honoured
     *                       approximately -- the real spacing is reported in the
     *                       output, because a caller measuring a rock face needs
     *                       to know the actual sample pitch, not the one asked
     *                       for.
     * @return Absolute path of the file written, or empty on failure.
     *
     * Synchronous and not cheap: this is thousands of line traces in one frame.
     * It is a deliberate one-off command, never something to put on a timer.
     */
    FString ScanToFile(
        UWorld* World,
        const FVector& Center,
        double RadiusMeters,
        double StepMeters,
        const FString& Reason);
}
