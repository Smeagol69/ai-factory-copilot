#pragma once

#include "CoreMinimal.h"
#include "FGClearanceData.h"
#include "Resources/FGResourceNode.h"
#include "FGResourceNodeGeyser.h"
#include "AIFactoryCreativeResourceNode.generated.h"

class UFGResourceDescriptor;
class UStaticMeshComponent;
class AFGCharacterPlayer;

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
    int32 SchemaVersion = 2;

    /** Resource supplied by this infinite node; its form comes from the descriptor. */
    UPROPERTY(SaveGame)
    TSubclassOf<UFGResourceDescriptor> ResourceClass = nullptr;

    /** Normal Satisfactory extractor multiplier, never a guessed rate. */
    UPROPERTY(SaveGame)
    TEnumAsByte<EResourcePurity> Purity = RP_Normal;

    /**
     * Ordinary nodes cover solid/liquid/gas descriptors. Geyser descriptors
     * must use the native Geyser node type so GeoThermal's normal hologram can
     * recognise the actor. Schema-1 saves default to Node for compatibility.
     */
    UPROPERTY(SaveGame)
    EResourceNodeType NodeType = EResourceNodeType::Node;
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
class AIFACTORYCOPILOT_API AAIFactoryCreativeResourceNode final : public AFGResourceNodeGeyser
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
    virtual FVector GetPlacementLocation(const FVector& HitLocation) const override;
    virtual FRotator GetPlacementRotation(const FVector& HitLocation) const override;
    virtual FText GetLookAtDecription_Implementation(
        AFGCharacterPlayer* ByCharacter,
        const FUseState& State) const override;

    /**
     * Configures a just-spawned or already placed creative node on the host.
     * This is deliberately server-only. Calling it on a client would only make
     * a short-lived visual lie until normal actor replication overwrote it.
     */
    bool ConfigureCreativeNode(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    bool ConfigureCreativeNode(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        EResourceNodeType NodeType,
        FString& OutReason);

    const FAIFactoryCreativeResourceNodeConfiguration& GetCreativeConfiguration() const
    {
        return mCreativeConfiguration;
    }

    EResourcePurity GetCreativePurity() const
    {
        return mCreativeConfiguration.Purity;
    }

    EResourceNodeType GetCreativeNodeType() const
    {
        return mCreativeConfiguration.NodeType;
    }

    /** Derives the only node type this descriptor may represent. */
    static EResourceNodeType NodeTypeForResource(
        TSubclassOf<UFGResourceDescriptor> Resource);

    bool HasValidCreativeConfiguration(FString& OutReason) const;

    /** Shared by the actor and its normal Build Gun hologram. */
    static bool ValidateCreativeConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);

    static bool ValidateCreativeConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        EResourceNodeType NodeType,
        FString& OutReason);

    /**
     * Applies FactoryGame's registered full node mesh, materials, and offset
     * when that authoritative presentation exists. A descriptor deposit mesh
     * remains the compatibility fallback for mod resources that register no
     * node data; liquid/gas markers without either use the existing neutral
     * fallback. This never pairs with or mutates a vanilla map node actor.
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

/**
 * Ordinary creative resource node used for solid, liquid and gas descriptors.
 *
 * This is intentionally an actual AFGResourceNode, not an
 * AFGResourceNodeGeyser whose enum is changed after construction. Extractor
 * holograms are allowed to specialize by concrete node class, so matching the
 * native ordinary-node inheritance is part of the snap contract rather than a
 * cosmetic implementation detail. The older AAIFactoryCreativeResourceNode
 * remains loadable for existing saves and is retained for real geysers.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryCreativeOrdinaryResourceNode final
    : public AFGResourceNode
{
    GENERATED_BODY()

public:
    AAIFactoryCreativeOrdinaryResourceNode();

    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual void PostLoadGame_Implementation(int32 SaveVersion, int32 GameVersion) override;
    virtual void GetClearanceData_Implementation(
        TArray<FFGClearanceData>& OutData) const override;
    virtual bool CanPlaceResourceExtractor() const override;
    virtual FVector GetPlacementLocation(const FVector& HitLocation) const override;
    virtual FRotator GetPlacementRotation(const FVector& HitLocation) const override;
    virtual FText GetLookAtDecription_Implementation(
        AFGCharacterPlayer* ByCharacter,
        const FUseState& State) const override;

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

protected:
    UFUNCTION()
    void OnRep_CreativeConfiguration();

private:
    bool ApplyCreativeConfiguration(FString& OutReason);
    void UpdateCreativeVisual();

    UPROPERTY(VisibleAnywhere, Category = "AI Factory Copilot|Creative Node")
    TObjectPtr<UStaticMeshComponent> mCreativeVisual;

    UPROPERTY(SaveGame, ReplicatedUsing = OnRep_CreativeConfiguration)
    FAIFactoryCreativeResourceNodeConfiguration mCreativeConfiguration;
};
