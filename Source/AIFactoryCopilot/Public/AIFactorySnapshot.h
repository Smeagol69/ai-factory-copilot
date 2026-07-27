#pragma once

#include "CoreMinimal.h"

class AFGPlayerController;
class UWorld;
struct FAIFactorySettings;

struct FAIFactorySnapshotRequest
{
    AFGPlayerController* PlayerController = nullptr;
    FVector Center = FVector::ZeroVector;
    float RadiusMeters = 250.0f;
    bool bUseRadius = false;
    bool bIncludeContentCatalog = true;
    bool bIncludeReflectedProperties = true;
};

struct FAIFactorySnapshotResult
{
    FString Json;
    int32 ActorCount = 0;
    int32 BuildableCount = 0;
    int32 ResourceNodeCount = 0;
    int32 PlayerCount = 0;
    int32 VehicleCount = 0;
    int32 PickupCount = 0;
    int32 AdapterActorCount = 0;
    int32 RecipeCount = 0;
    int32 ItemCount = 0;
    int32 ModCount = 0;
    bool bActorLimitReached = false;
};

/**
 * Creates an evidence-bearing JSON representation of live game objects. Values
 * are read from SML registries, FactoryGame accessors, and Unreal reflection.
 */
class AIFACTORYCOPILOT_API FAIFactorySnapshot
{
public:
    static FAIFactorySnapshotResult Build(
        UWorld* World,
        const FAIFactorySnapshotRequest& Request,
        const FAIFactorySettings& Settings,
        uint64 WorldRevision);

    static uint32 ComputeWorldFingerprint(UWorld* World);
};
