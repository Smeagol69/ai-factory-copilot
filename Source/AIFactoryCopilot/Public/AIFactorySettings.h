#pragma once

#include "CoreMinimal.h"

struct FAIFactorySettings
{
    FString BridgeUrl = TEXT("http://127.0.0.1:8142/v1/ask");
    float DefaultScanRadiusMeters = 250.0f;
    float ViewTraceDistanceMeters = 250.0f;
    float ObserverIntervalSeconds = 1.0f;
    int32 MaxActorsPerSnapshot = 5000;
    int32 MaxReflectedPropertiesPerObject = 256;
    int32 MaxReflectedValueCharacters = 2048;
    bool bIncludeContentCatalog = true;
    bool bIncludeReflectedProperties = true;
    /** Ground, slope, and water probing for build-site suitability. */
    bool bIncludeTerrain = true;
    float TerrainFootprintMeters = 24.0f;
    int32 TerrainResolution = 5;
    int32 MaxTerrainProbes = 150;
    float TerrainProbeRadiusMeters = 500.0f;
    bool bUIWholeWorldSnapshot = true;
    bool bStartupSelfTest = false;
    float StartupSelfTestDelaySeconds = 10.0f;
    FString StartupSelfTestQuestion = TEXT(
        "Using only the authoritative snapshot, what should the player do next and what placement facts are known?");

    /**
     * Master switch for world-mutating actions. When false the mod still runs
     * every requested action's validation and reports what *would* happen, but
     * commits nothing — the game side decides whether a write lands, not the
     * model and not the bridge.
     */
    bool bAllowWriteActions = false;
    /** Upper bound on actions executed from one reply, so a runaway plan stops. */
    int32 MaxActionsPerReply = 64;

    static FAIFactorySettings Load();
    static FString GetConfigPath();
};
