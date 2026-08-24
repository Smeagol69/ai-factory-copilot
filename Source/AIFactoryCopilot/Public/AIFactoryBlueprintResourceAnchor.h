#pragma once

#include "CoreMinimal.h"
#include "Buildables/FGBuildable.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryBlueprintResourceAnchor.generated.h"

class AFGBuildableResourceExtractorBase;
class UFGResourceDescriptor;
class UStaticMeshComponent;

/**
 * The authored part of a Designer Resource Anchor.
 *
 * This is intentionally persisted on the buildable root, rather than on its
 * runtime node child.  The child is a real extractor target while the factory
 * is running, but it is deliberately transient during native Blueprint
 * serialization: the root owns the exact resource/purity and exact miners to
 * rebind after the game loads the Blueprint into the destination world.
 */
USTRUCT()
struct FAIFactoryBlueprintResourceAnchorConfiguration
{
    GENERATED_BODY()

    UPROPERTY(SaveGame)
    int32 SchemaVersion = 1;

    UPROPERTY(SaveGame)
    TSubclassOf<UFGResourceDescriptor> ResourceClass = nullptr;

    UPROPERTY(SaveGame)
    TEnumAsByte<EResourcePurity> Purity = RP_Normal;
};

class AAIFactoryBlueprintResourceAnchor;

/**
 * A real, solid AFGResourceNode owned by one Resource Anchor while that
 * anchor exists in the live world.  It intentionally opts out of ordinary
 * save/Blueprint collection: the anchor re-creates it from its persisted
 * configuration and reconnects only explicitly recorded miners.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryBlueprintAnchorNode final : public AFGResourceNode
{
    GENERATED_BODY()

public:
    AAIFactoryBlueprintAnchorNode();

    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual bool ShouldSave_Implementation() const override { return false; }
    virtual void GetClearanceData_Implementation(
        TArray<FFGClearanceData>& OutData) const override;
    virtual bool CanPlaceResourceExtractor() const override;

    bool Configure(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    bool HasValidConfiguration(FString& OutReason) const;

    static bool ValidateConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    static void ApplyResourceVisual(
        UStaticMeshComponent* Visual,
        TSubclassOf<UFGResourceDescriptor> Resource);

protected:
    UFUNCTION()
    void OnRep_Configuration();

private:
    bool ApplyConfiguration(FString& OutReason);

    /** Replicated for a client-side visual and native resource readback. */
    UPROPERTY(ReplicatedUsing = OnRep_Configuration)
    FAIFactoryBlueprintResourceAnchorConfiguration mConfiguration;
};

/**
 * A serializable native Blueprint member which owns a transient real resource
 * node in a live world.  The root is an AFGBuildable, so Designer membership,
 * native .sbp collection, Blueprint proxy membership, cost and dismantle all
 * remain Satisfactory-owned.  Only Miner Mk.1–Mk.3 receive the corresponding
 * Designer eligibility opt-in; fluids, oil, fracking and modded extractors
 * are intentionally not broadened here.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryBlueprintResourceAnchor final : public AFGBuildable
{
    GENERATED_BODY()

public:
    AAIFactoryBlueprintResourceAnchor();

    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void Dismantle_Implementation() override;
    virtual void PreSaveGame_Implementation(int32 SaveVersion, int32 GameVersion) override;
    virtual void PostSaveGame_Implementation(int32 SaveVersion, int32 GameVersion) override;
    virtual void PreSerializedToBlueprint() override;
    virtual void PostSerializedToBlueprint() override;
    virtual void PostSerializedFromBlueprint(bool bIsBlueprintWorld = false) override;
    virtual void PostLoadGame_Implementation(int32 SaveVersion, int32 GameVersion) override;

    bool ConfigureAnchor(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    const FAIFactoryBlueprintResourceAnchorConfiguration& GetConfiguration() const
    {
        return mConfiguration;
    }

    AAIFactoryBlueprintAnchorNode* GetRuntimeNode() const
    {
        return mRuntimeNode.Get();
    }

    /**
     * Called only after Satisfactory's own extractor binding succeeds.  It
     * records an exact object relationship; rebind never searches by distance
     * or chooses a nearby miner.
     */
    void RegisterBoundExtractor(AFGBuildableResourceExtractorBase* Extractor);

    /** Native hook target registered by the module at startup. */
    static void ObserveExtractorBinding(
        AFGBuildableResourceExtractorBase* Extractor,
        TScriptInterface<class IFGExtractableResourceInterface> Extractable);

    /** Called per world after the Blueprint subsystem is initialized. */
    static void EnableVanillaMinersInBlueprintDesigner(UWorld* World);

private:
    bool EnsureRuntimeNode(FString& OutReason);
    void DestroyRuntimeNode();
    void DisconnectBoundExtractorsFromRuntimeNode();
    void ScheduleExactRebind();
    void CompleteDeferredRebind();
    void RebindRecordedExtractors();
    void TemporarilyDisconnectBoundExtractorsForSerialization(const TCHAR* SerializationKind);
    void RestoreTemporarilyDisconnectedExtractors();
    void UpdateAnchorVisual();

    static TScriptInterface<class IFGExtractableResourceInterface>
        MakeExtractableInterface(AAIFactoryBlueprintAnchorNode* Node);

    UPROPERTY(VisibleAnywhere, Category = "AI Factory Copilot|Blueprint Anchor")
    TObjectPtr<UStaticMeshComponent> mAnchorVisual;

    UPROPERTY(SaveGame, ReplicatedUsing = OnRep_Configuration)
    FAIFactoryBlueprintResourceAnchorConfiguration mConfiguration;

    /**
     * Blueprint-safe identity mapping: each reference is an authored
     * buildable in the same native Blueprint root set, never a spatial guess.
     */
    UPROPERTY(SaveGame)
    TArray<TObjectPtr<AFGBuildableResourceExtractorBase>> mBoundExtractors;

    /** This actor is intentionally transient and never a Blueprint root. */
    UPROPERTY(Transient)
    TObjectPtr<AAIFactoryBlueprintAnchorNode> mRuntimeNode;

    /** Temporarily detached only during WriteBlueprintToArchive. */
    TArray<TWeakObjectPtr<AFGBuildableResourceExtractorBase>> mTemporarilyDisconnectedExtractors;

    bool bRebindScheduled = false;

    UFUNCTION()
    void OnRep_Configuration();
};

/** Installed once by the game module before any player Build Gun holograms exist. */
void RegisterAIFactoryBlueprintResourceAnchorHooks();
