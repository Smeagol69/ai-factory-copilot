#include "AIFactorySettings.h"

#include "AIFactoryCopilotModule.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
    template <typename TValue>
    void ReadNumber(const TSharedPtr<FJsonObject>& Json, const TCHAR* Name, TValue& Target)
    {
        double Value = 0.0;
        if (Json->TryGetNumberField(Name, Value))
        {
            Target = static_cast<TValue>(Value);
        }
    }
}

FString FAIFactorySettings::GetConfigPath()
{
    return FPaths::Combine(FPaths::ProjectDir(), TEXT("Configs"), TEXT("AIFactoryCopilot.cfg"));
}

FAIFactorySettings FAIFactorySettings::Load()
{
    FAIFactorySettings Settings;
    FString Contents;
    const FString Path = GetConfigPath();

    if (!FFileHelper::LoadFileToString(Contents, *Path))
    {
        UE_LOG(LogAIFactoryCopilot, Display, TEXT("Using default settings; no config found at %s"), *Path);
        return Settings;
    }

    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Contents);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
    {
        UE_LOG(LogAIFactoryCopilot, Error, TEXT("Invalid JSON config at %s; using defaults"), *Path);
        return Settings;
    }

    Json->TryGetStringField(TEXT("bridgeUrl"), Settings.BridgeUrl);
    ReadNumber(Json, TEXT("defaultScanRadiusMeters"), Settings.DefaultScanRadiusMeters);
    ReadNumber(Json, TEXT("viewTraceDistanceMeters"), Settings.ViewTraceDistanceMeters);
    ReadNumber(Json, TEXT("observerIntervalSeconds"), Settings.ObserverIntervalSeconds);
    ReadNumber(Json, TEXT("maxActorsPerSnapshot"), Settings.MaxActorsPerSnapshot);
    ReadNumber(Json, TEXT("maxReflectedPropertiesPerObject"), Settings.MaxReflectedPropertiesPerObject);
    ReadNumber(Json, TEXT("maxReflectedValueCharacters"), Settings.MaxReflectedValueCharacters);
    Json->TryGetBoolField(TEXT("includeContentCatalog"), Settings.bIncludeContentCatalog);
    Json->TryGetBoolField(TEXT("includeReflectedProperties"), Settings.bIncludeReflectedProperties);
    Json->TryGetBoolField(TEXT("uiWholeWorldSnapshot"), Settings.bUIWholeWorldSnapshot);
    Json->TryGetBoolField(TEXT("includeTerrain"), Settings.bIncludeTerrain);
    ReadNumber(Json, TEXT("terrainFootprintMeters"), Settings.TerrainFootprintMeters);
    ReadNumber(Json, TEXT("terrainResolution"), Settings.TerrainResolution);
    ReadNumber(Json, TEXT("maxTerrainProbes"), Settings.MaxTerrainProbes);
    ReadNumber(Json, TEXT("terrainProbeRadiusMeters"), Settings.TerrainProbeRadiusMeters);
    Json->TryGetBoolField(TEXT("startupSelfTest"), Settings.bStartupSelfTest);
    ReadNumber(Json, TEXT("startupSelfTestDelaySeconds"), Settings.StartupSelfTestDelaySeconds);
    Json->TryGetStringField(TEXT("startupSelfTestQuestion"), Settings.StartupSelfTestQuestion);
    Json->TryGetBoolField(TEXT("allowWriteActions"), Settings.bAllowWriteActions);
    ReadNumber(Json, TEXT("maxActionsPerReply"), Settings.MaxActionsPerReply);
    Settings.MaxActionsPerReply = FMath::Clamp(Settings.MaxActionsPerReply, 0, 512);

    Settings.DefaultScanRadiusMeters = FMath::Clamp(Settings.DefaultScanRadiusMeters, 1.0f, 100000.0f);
    Settings.ViewTraceDistanceMeters = FMath::Clamp(Settings.ViewTraceDistanceMeters, 1.0f, 100000.0f);
    Settings.ObserverIntervalSeconds = FMath::Clamp(Settings.ObserverIntervalSeconds, 0.25f, 60.0f);
    Settings.MaxActorsPerSnapshot = FMath::Clamp(Settings.MaxActorsPerSnapshot, 1, 100000);
    Settings.MaxReflectedPropertiesPerObject = FMath::Clamp(Settings.MaxReflectedPropertiesPerObject, 0, 4096);
    Settings.MaxReflectedValueCharacters = FMath::Clamp(Settings.MaxReflectedValueCharacters, 64, 65536);
    Settings.StartupSelfTestDelaySeconds = FMath::Clamp(Settings.StartupSelfTestDelaySeconds, 1.0f, 120.0f);
    // Each probe is Resolution^2 line traces, so both are bounded to keep a
    // whole-world capture inside a single frame's budget.
    Settings.TerrainFootprintMeters = FMath::Clamp(Settings.TerrainFootprintMeters, 1.0f, 500.0f);
    Settings.TerrainResolution = FMath::Clamp(Settings.TerrainResolution, 1, 16);
    Settings.MaxTerrainProbes = FMath::Clamp(Settings.MaxTerrainProbes, 0, 2000);
    Settings.TerrainProbeRadiusMeters = FMath::Clamp(Settings.TerrainProbeRadiusMeters, -1.0f, 100000.0f);
    if (Settings.StartupSelfTestQuestion.TrimStartAndEnd().IsEmpty())
    {
        Settings.StartupSelfTestQuestion =
            TEXT("Using only the authoritative snapshot, what should the player do next?");
    }
    return Settings;
}
