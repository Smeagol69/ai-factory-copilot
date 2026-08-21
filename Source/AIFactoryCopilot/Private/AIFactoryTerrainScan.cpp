#include "AIFactoryTerrainScan.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryTerrain.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace AIFactoryTerrainScan
{
namespace
{
    /**
     * ProbeSite clamps resolution to 32, so one tile covers TileMeters at
     * TileMeters/31 spacing. 96 m gives ~3.1 m -- fine enough to find the edge
     * of a rock shelf, coarse enough that a 240 m scan stays under ten thousand
     * traces.
     */
    constexpr double TileMeters = 96.0;
    constexpr int32 TileResolution = 32;

    /**
     * A ceiling on total probes.
     *
     * Every probe is a line trace and the whole scan runs inside one frame. At
     * roughly ten thousand the hitch is noticeable but brief; well beyond that
     * it reads as a freeze, and a player who thinks the game has hung will
     * alt-F4 rather than wait. Better to return a smaller honest scan.
     */
    constexpr int32 MaxProbes = 12000;
}

FString TerrainDirectory()
{
    const FString Directory = FPaths::Combine(
        FPaths::ProjectSavedDir(),
        TEXT("AIFactoryCopilot"),
        TEXT("Terrain"));
    IPlatformFile& File = FPlatformFileManager::Get().GetPlatformFile();
    if (!File.DirectoryExists(*Directory))
    {
        File.CreateDirectoryTree(*Directory);
    }
    return Directory;
}

FString ScanToFile(
    UWorld* World,
    const FVector& Center,
    const double RadiusMeters,
    const double StepMeters,
    const FString& Reason)
{
    if (!IsValid(World))
    {
        return FString();
    }

    const double Radius = FMath::Clamp(RadiusMeters, 8.0, 400.0);
    const double Span = Radius * 2.0;

    // Tiles are sized to land near the requested step. The achieved spacing is
    // reported rather than the requested one, because a caller measuring a rock
    // face needs the real pitch.
    const double WantedStep = FMath::Clamp(StepMeters, 1.0, 32.0);
    const double TileSpan = FMath::Min(TileMeters, WantedStep * (TileResolution - 1));
    const double AchievedStep = TileSpan / (TileResolution - 1);

    const int32 TilesPerSide = FMath::Max(1, FMath::CeilToInt(Span / TileSpan));
    const int32 Estimated = TilesPerSide * TilesPerSide * TileResolution * TileResolution;
    const bool bTruncated = Estimated > MaxProbes;

    TArray<TSharedPtr<FJsonValue>> Samples;
    int32 Probed = 0;
    int32 WaterCount = 0;
    int32 GroundCount = 0;
    double MinZ = TNumericLimits<double>::Max();
    double MaxZ = TNumericLimits<double>::Lowest();

    const double Origin = -Radius + TileSpan * 0.5;
    for (int32 TileX = 0; TileX < TilesPerSide && Probed < MaxProbes; ++TileX)
    {
        for (int32 TileY = 0; TileY < TilesPerSide && Probed < MaxProbes; ++TileY)
        {
            const FVector TileCentre(
                Center.X + (Origin + TileX * TileSpan) * 100.0,
                Center.Y + (Origin + TileY * TileSpan) * 100.0,
                Center.Z);

            TArray<FAIFactoryGroundSample> TileSamples;
            FAIFactoryTerrain::ProbeSite(
                World,
                TileCentre,
                TileSpan,
                TileResolution,
                nullptr,
                &TileSamples);

            for (const FAIFactoryGroundSample& Sample : TileSamples)
            {
                if (Probed >= MaxProbes)
                {
                    break;
                }
                ++Probed;
                if (!Sample.bHitGround)
                {
                    // Recorded rather than dropped: a hole in the height field
                    // is information -- it is usually open water or a cave mouth
                    // -- and silently omitting it would make the grid lie about
                    // its own coverage.
                    const TSharedRef<FJsonObject> Miss = MakeShared<FJsonObject>();
                    Miss->SetNumberField(TEXT("x"), Sample.Probe.X);
                    Miss->SetNumberField(TEXT("y"), Sample.Probe.Y);
                    Miss->SetBoolField(TEXT("hit"), false);
                    Samples.Add(MakeShared<FJsonValueObject>(Miss));
                    continue;
                }

                ++GroundCount;
                if (Sample.bWater)
                {
                    ++WaterCount;
                }
                MinZ = FMath::Min(MinZ, Sample.GroundPoint.Z);
                MaxZ = FMath::Max(MaxZ, Sample.GroundPoint.Z);

                const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
                Entry->SetNumberField(TEXT("x"), Sample.GroundPoint.X);
                Entry->SetNumberField(TEXT("y"), Sample.GroundPoint.Y);
                Entry->SetNumberField(TEXT("z"), Sample.GroundPoint.Z);
                Entry->SetNumberField(TEXT("slope_deg"), Sample.SlopeDegrees);
                Entry->SetBoolField(TEXT("water"), Sample.bWater);
                if (Sample.bBlockedAboveGround)
                {
                    Entry->SetBoolField(TEXT("blocked"), true);
                    Entry->SetStringField(TEXT("blocked_by"), Sample.BlockingActor);
                }
                Samples.Add(MakeShared<FJsonValueObject>(Entry));
            }
        }
    }

    const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("captured_at_utc"), FDateTime::UtcNow().ToIso8601());
    Root->SetStringField(TEXT("reason"), Reason);

    const TSharedRef<FJsonObject> CentreJson = MakeShared<FJsonObject>();
    CentreJson->SetNumberField(TEXT("x"), Center.X);
    CentreJson->SetNumberField(TEXT("y"), Center.Y);
    CentreJson->SetNumberField(TEXT("z"), Center.Z);
    Root->SetObjectField(TEXT("center"), CentreJson);

    Root->SetNumberField(TEXT("radius_meters"), Radius);
    Root->SetNumberField(TEXT("requested_step_meters"), WantedStep);
    Root->SetNumberField(TEXT("achieved_step_meters"), AchievedStep);
    Root->SetNumberField(TEXT("tiles_per_side"), TilesPerSide);
    Root->SetNumberField(TEXT("probes"), Probed);
    Root->SetNumberField(TEXT("ground_hits"), GroundCount);
    Root->SetNumberField(TEXT("water_samples"), WaterCount);
    Root->SetBoolField(TEXT("truncated"), bTruncated);
    if (GroundCount > 0)
    {
        Root->SetNumberField(TEXT("min_ground_z"), MinZ);
        Root->SetNumberField(TEXT("max_ground_z"), MaxZ);
        Root->SetNumberField(TEXT("elevation_range_cm"), MaxZ - MinZ);
    }
    Root->SetArrayField(TEXT("samples"), Samples);

    FString Serialised;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialised);
    FJsonSerializer::Serialize(Root, Writer);

    const FString Path = FPaths::Combine(TerrainDirectory(), TEXT("latest.json"));
    if (!FFileHelper::SaveStringToFile(Serialised, *Path))
    {
        UE_LOG(LogAIFactoryCopilot, Warning, TEXT("Terrain scan could not be written to %s"), *Path);
        return FString();
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Terrain scan: %d probes, %d ground, %d water, %.1f m step -> %s"),
        Probed, GroundCount, WaterCount, AchievedStep, *Path);
    return Path;
}
}
