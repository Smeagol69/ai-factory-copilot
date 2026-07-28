#pragma once

#include "CoreMinimal.h"

class UWorld;

/** One downward probe of the ground at a world XY. */
struct FAIFactoryGroundSample
{
    FVector Probe = FVector::ZeroVector;
    bool bHitGround = false;
    FVector GroundPoint = FVector::ZeroVector;
    FVector Normal = FVector::UpVector;
    double SlopeDegrees = 0.0;
    bool bWater = false;
    bool bBlockedAboveGround = false;
    FString BlockingActor;
};

/**
 * Terrain statistics for a candidate build footprint, produced by probing a grid
 * of ground samples. Everything is measured; nothing is estimated. When a probe
 * finds no ground the sample is excluded and the shortfall is reported.
 */
struct FAIFactorySiteTerrain
{
    bool bSampled = false;
    FVector Center = FVector::ZeroVector;
    double FootprintMeters = 0.0;
    int32 SamplesRequested = 0;
    int32 SamplesWithGround = 0;
    int32 WaterSamples = 0;
    int32 BlockedSamples = 0;
    double MinGroundZ = 0.0;
    double MaxGroundZ = 0.0;
    double MeanGroundZ = 0.0;
    double ElevationRangeCm = 0.0;
    double MeanSlopeDegrees = 0.0;
    double MaxSlopeDegrees = 0.0;
    FString Verdict = TEXT("not_sampled");
};

/**
 * Ground, slope, and water probing.
 *
 * Building overlap is deliberately not tested here: the snapshot already carries
 * every buildable's bounds, so the solvers compute that without another trace.
 */
class AIFACTORYCOPILOT_API FAIFactoryTerrain
{
public:
    /** Trace straight down at an XY to find the ground, its slope, and water. */
    static FAIFactoryGroundSample SampleGround(
        UWorld* World,
        const FVector& ProbeLocation,
        AActor* IgnoreActor = nullptr);

    /** Probe a square footprint and summarise how buildable it is. */
    static FAIFactorySiteTerrain ProbeSite(
        UWorld* World,
        const FVector& Center,
        double FootprintMeters,
        int32 Resolution,
        AActor* IgnoreActor = nullptr,
        TArray<FAIFactoryGroundSample>* OutSamples = nullptr);
};
