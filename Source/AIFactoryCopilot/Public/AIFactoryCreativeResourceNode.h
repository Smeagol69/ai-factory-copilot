#pragma once

#include "CoreMinimal.h"
#include "FGClearanceData.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryCreativeResourceNode.generated.h"

class UFGResourceDescriptor;
class UStaticMeshComponent;

/**
 * The persisted, authoritative identity of a Copilot-created resource node.
 *
 * AFGResourceNode's base resource class, purity and amount do not all carry
 * SaveGame metadata. Reconstructing them from this small configuration after a
 * load is therefore essential: a creative node must never silently turn into
 * an unconfigured vanilla-looking actor after the save is re-opened.
 */
USTRUCT()
struct FAIFactoryCreativeResourceNodeConfiguration
{
    GENERATED_BODY()

    /** Bump only when the persisted interpretation changes. */
    // SaveGame must be on the leaves as well as the containing struct. Unreal
    // filters every reflected field independently while serialising a save.
    UPROPERTY(SaveGame)
    int32 SchemaVersion = 1;

    /** Solid resource supplied by this infinite node. */
    UPROPERTY(SaveGame)
    TSubclassOf<UFGResourceDescriptor> ResourceClass = nullptr;

    /** Normal Satisfactory extractor multiplier, never a guessed rate. */
    UPROPERTY(SaveGame)
    TEnumAsByte<EResourcePurity> Purity = RP_Normal;
};

/**
 * A mod-owned, static resource node for the creative world-editor workflow.
 *
 * This class intentionally never moves, adopts, destroys, or re-registers a
 * vanilla resource node. A player creates one through a normal Build Gun
 * hologram; from then on Satisfactory owns extractor snapping, mining and
 * save/load exactly as it does for every AFGResourceNode.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryCreativeResourceNode final : public AFGResourceNode
{
    GENERATED_BODY()

public:
    AAIFactoryCreativeResourceNode();

    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual void PostLoadGame_Implementation(int32 SaveVersion, int32 GameVersion) override;
    virtual void GetClearanceData_Implementation(
        TArray<FFGClearanceData>& OutData) const override;
    virtual bool CanPlaceResourceExtractor() const override;

    /**
     * Configures a just-spawned or already placed creative node on the host.
     * This is deliberately server-only. Calling it on a client would only make
     * a short-lived visual lie until normal actor replication overwrote it.
     */
    bool ConfigureCreativeNode(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    const FAIFactoryCreativeResourceNodeConfiguration& GetCreativeConfiguration() const
    {
        return mCreativeConfiguration;
    }

    EResourcePurity GetCreativePurity() const
    {
        return mCreativeConfiguration.Purity;
    }

    bool HasValidCreativeConfiguration(FString& OutReason) const;

    /** Shared by the actor and its normal Build Gun hologram. */
    static bool ValidateCreativeConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    /**
     * Applies the selected resource's own ore/deposit presentation to a
     * mod-owned visual component. It deliberately does not attempt to pair a
     * new actor with the private vanilla ResourceNodeManager mesh system.
     */
    static void ApplyCreativeVisual(
        UStaticMeshComponent* Visual,
        TSubclassOf<UFGResourceDescriptor> Resource);

protected:
    UFUNCTION()
    void OnRep_CreativeConfiguration();

private:
    bool ApplyCreativeConfiguration(FString& OutReason);
    void UpdateCreativeVisual();

    /** A visible, traceable mod-owned representation; never a vanilla mesh pair. */
    UPROPERTY(VisibleAnywhere, Category = "AI Factory Copilot|Creative Node")
    TObjectPtr<UStaticMeshComponent> mCreativeVisual;

    /** The source of truth we restore on load and replicate to clients. */
    UPROPERTY(SaveGame, ReplicatedUsing = OnRep_CreativeConfiguration)
    FAIFactoryCreativeResourceNodeConfiguration mCreativeConfiguration;
};
