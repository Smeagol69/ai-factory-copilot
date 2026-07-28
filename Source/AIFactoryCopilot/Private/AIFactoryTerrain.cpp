#include "AIFactoryTerrain.h"

#include "CollisionQueryParams.h"
#include "CollisionShape.h"
#include "Engine/HitResult.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGWaterVolume.h"

namespace
{
    // Traces start well above and end well below the probe so a probe seeded from
    // a rough centre still finds ground on steep terrain.
    constexpr double GroundTraceUpCm = 30000.0;
    constexpr double GroundTraceDownCm = 60000.0;
    // A machine-sized volume lifted clear of the ground, so the landscape itself
    // is not reported as an obstruction while rocks and cliffs still are.
    constexpr double ObstructionBoxHalfWidthCm = 300.0;
    constexpr double ObstructionBoxHalfHeightCm = 400.0;
    constexpr double ObstructionBoxLiftCm = 60.0;

    void CollectWaterVolumes(UWorld* World, TArray<AFGWaterVolume*>& OutVolumes)
    {
        for (TActorIterator<AFGWaterVolume> It(World); It; ++It)
        {
            if (IsValid(*It))
            {
                OutVolumes.Add(*It);
            }
        }
    }

    bool IsPointInWater(const TArray<AFGWaterVolume*>& Volumes, const FVector& Point)
    {
        for (AFGWaterVolume* Volume : Volumes)
        {
            if (IsValid(Volume) && Volume->EncompassesPoint(Point))
            {
                return true;
            }
        }
        return false;
    }

    // A grid probe runs hundreds of samples, so the water volumes are gathered
    // once per site instead of iterated for every sample.
    FAIFactoryGroundSample SampleGroundWithWater(
        UWorld* World,
        const FVector& ProbeLocation,
        AActor* IgnoreActor,
        const TArray<AFGWaterVolume*>& WaterVolumes)
    {
        FAIFactoryGroundSample Sample;
        Sample.Probe = ProbeLocation;
        if (!IsValid(World))
        {
            return Sample;
        }

        FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(AIFactoryTerrainGroundTrace), true, IgnoreActor);
        QueryParams.bReturnPhysicalMaterial = false;

        FHitResult Hit;
        const FVector Start(ProbeLocation.X, ProbeLocation.Y, ProbeLocation.Z + GroundTraceUpCm);
        const FVector End(ProbeLocation.X, ProbeLocation.Y, ProbeLocation.Z - GroundTraceDownCm);

        if (World->LineTraceSingleByChannel(Hit, Start, End, ECC_Visibility, QueryParams))
        {
            Sample.bHitGround = true;
            Sample.GroundPoint = Hit.ImpactPoint;
            Sample.Normal = Hit.ImpactNormal;
            // A flat surface has an up-facing normal; slope is its deviation from up.
            const double NormalZ = FMath::Clamp(static_cast<double>(Hit.ImpactNormal.Z), -1.0, 1.0);
            Sample.SlopeDegrees = FMath::RadiansToDegrees(FMath::Acos(NormalZ));

            if (IsValid(Hit.GetActor()))
            {
                Sample.BlockingActor = Hit.GetActor()->GetName();
            }

            Sample.bWater = IsPointInWater(WaterVolumes, Hit.ImpactPoint);

            const FVector BoxCenter(
                Hit.ImpactPoint.X,
                Hit.ImpactPoint.Y,
                Hit.ImpactPoint.Z + ObstructionBoxLiftCm + ObstructionBoxHalfHeightCm);
            const FCollisionShape Box = FCollisionShape::MakeBox(FVector3f(
                static_cast<float>(ObstructionBoxHalfWidthCm),
                static_cast<float>(ObstructionBoxHalfWidthCm),
                static_cast<float>(ObstructionBoxHalfHeightCm)));
            Sample.bBlockedAboveGround = World->OverlapBlockingTestByChannel(
                BoxCenter,
                FQuat::Identity,
                ECC_WorldStatic,
                Box,
                QueryParams);
        }

        return Sample;
    }
}

FAIFactoryGroundSample FAIFactoryTerrain::SampleGround(
    UWorld* World,
    const FVector& ProbeLocation,
    AActor* IgnoreActor)
{
    TArray<AFGWaterVolume*> WaterVolumes;
    if (IsValid(World))
    {
        CollectWaterVolumes(World, WaterVolumes);
    }
    return SampleGroundWithWater(World, ProbeLocation, IgnoreActor, WaterVolumes);
}

FAIFactorySiteTerrain FAIFactoryTerrain::ProbeSite(
    UWorld* World,
    const FVector& Center,
    const double FootprintMeters,
    const int32 Resolution,
    AActor* IgnoreActor,
    TArray<FAIFactoryGroundSample>* OutSamples)
{
    FAIFactorySiteTerrain Site;
    Site.Center = Center;
    Site.FootprintMeters = FootprintMeters;

    const int32 ClampedResolution = FMath::Clamp(Resolution, 1, 32);
    const double FootprintCm = FMath::Max(FootprintMeters, 0.0) * 100.0;
    if (!IsValid(World) || FootprintCm <= 0.0)
    {
        Site.Verdict = TEXT("not_sampled");
        return Site;
    }

    const double HalfCm = FootprintCm * 0.5;
    const double Step = ClampedResolution > 1 ? FootprintCm / (ClampedResolution - 1) : 0.0;

    TArray<AFGWaterVolume*> WaterVolumes;
    CollectWaterVolumes(World, WaterVolumes);

    double SlopeTotal = 0.0;
    double HeightTotal = 0.0;
    bool bFirstGround = true;

    for (int32 IndexX = 0; IndexX < ClampedResolution; ++IndexX)
    {
        for (int32 IndexY = 0; IndexY < ClampedResolution; ++IndexY)
        {
            const FVector Probe(
                Center.X - HalfCm + Step * IndexX,
                Center.Y - HalfCm + Step * IndexY,
                Center.Z);

            const FAIFactoryGroundSample Sample =
                SampleGroundWithWater(World, Probe, IgnoreActor, WaterVolumes);
            ++Site.SamplesRequested;
            if (OutSamples)
            {
                OutSamples->Add(Sample);
            }
            if (!Sample.bHitGround)
            {
                continue;
            }

            ++Site.SamplesWithGround;
            SlopeTotal += Sample.SlopeDegrees;
            HeightTotal += Sample.GroundPoint.Z;
            Site.MaxSlopeDegrees = FMath::Max(Site.MaxSlopeDegrees, Sample.SlopeDegrees);
            if (Sample.bWater) ++Site.WaterSamples;
            if (Sample.bBlockedAboveGround) ++Site.BlockedSamples;

            if (bFirstGround)
            {
                Site.MinGroundZ = Sample.GroundPoint.Z;
                Site.MaxGroundZ = Sample.GroundPoint.Z;
                bFirstGround = false;
            }
            else
            {
                Site.MinGroundZ = FMath::Min(Site.MinGroundZ, Sample.GroundPoint.Z);
                Site.MaxGroundZ = FMath::Max(Site.MaxGroundZ, Sample.GroundPoint.Z);
            }
        }
    }

    if (Site.SamplesWithGround == 0)
    {
        Site.Verdict = TEXT("no_ground_found");
        return Site;
    }

    Site.bSampled = true;
    Site.MeanSlopeDegrees = SlopeTotal / Site.SamplesWithGround;
    Site.MeanGroundZ = HeightTotal / Site.SamplesWithGround;
    Site.ElevationRangeCm = Site.MaxGroundZ - Site.MinGroundZ;

    const double WaterFraction = static_cast<double>(Site.WaterSamples) / Site.SamplesWithGround;
    const double BlockedFraction = static_cast<double>(Site.BlockedSamples) / Site.SamplesWithGround;

    // Thresholds describe what the measurements mean for building; the raw
    // numbers travel alongside so a different judgement can be made from them.
    if (WaterFraction >= 0.5)
    {
        Site.Verdict = TEXT("over_water");
    }
    else if (BlockedFraction >= 0.34)
    {
        Site.Verdict = TEXT("obstructed");
    }
    else if (Site.MaxSlopeDegrees >= 35.0 || Site.ElevationRangeCm >= 1200.0)
    {
        Site.Verdict = TEXT("steep");
    }
    else if (Site.MaxSlopeDegrees >= 12.0 || Site.ElevationRangeCm >= 400.0)
    {
        Site.Verdict = TEXT("usable_with_foundations");
    }
    else
    {
        Site.Verdict = TEXT("flat_and_clear");
    }

    return Site;
}
