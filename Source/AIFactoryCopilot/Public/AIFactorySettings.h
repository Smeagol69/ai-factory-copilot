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
    bool bUIWholeWorldSnapshot = true;
    bool bStartupSelfTest = false;
    float StartupSelfTestDelaySeconds = 10.0f;
    FString StartupSelfTestQuestion = TEXT(
        "Using only the authoritative snapshot, what should the player do next and what placement facts are known?");

    static FAIFactorySettings Load();
    static FString GetConfigPath();
};
