#pragma once

#include "CoreMinimal.h"
#include "FGConstructDisqualifier.h"
#include "Hologram/FGHologram.h"
#include "Resources/FGResourceNode.h"
#include "Resources/FGResourceNodeBase.h"
#include "AIFactoryCreativeNodeHologram.generated.h"

class UFGResourceDescriptor;
class UAIFactoryCreativeNodeRCO;

/** Clear player-facing explanation for a malformed client construction message. */
UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeInvalidConfigurationDisqualifier final
    : public UFGConstructDisqualifier
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeInvalidConfigurationDisqualifier()
    {
        mDisqfualifyingText = NSLOCTEXT(
            "AIFactoryCopilot",
            "CreativeNodeInvalidConfiguration",
            "Creative Resource Node needs a valid solid, liquid, gas, or geyser resource and purity.");
    }
};

/** Prevents a new creative node from being hidden inside another resource node. */
UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeOverlapsResourceDisqualifier final
    : public UFGConstructDisqualifier
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeOverlapsResourceDisqualifier()
    {
        mDisqfualifyingText = NSLOCTEXT(
            "AIFactoryCopilot",
            "CreativeNodeOverlapsResource",
            "Creative Resource Nodes must be placed clear of another resource node.");
    }
};

/**
 * Native non-buildable hologram for AAIFactoryCreativeResourceNode.
 *
 * UFGBuildDescriptor + AFGHologram is Satisfactory's supported Build Gun seam
 * for actors such as vehicles. This deliberately does not inherit the
 * AFGBuildable-only hologram path or reuse the companion's direct write API.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryCreativeNodeHologram final : public AFGHologram
{
    GENERATED_BODY()

public:
    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual void BeginPlay() override;
    virtual void PostConstructMessageDeserialization() override;
    virtual void SetHologramLocationAndRotation(const FHitResult& HitResult) override;
    virtual AActor* Construct(
        TArray<AActor*>& OutChildren,
        FNetConstructionID ConstructionID) override;
    virtual bool ShouldSetupPendingConstructionHologram() const override { return false; }

    /**
     * The client RCO stores the next explicit editor choice before calling the
     * normal local Build Gun entry point. The just-created local hologram then
     * consumes it and carries it in Satisfactory's construction message.
     */
    static bool SetPendingLocalConfiguration(
        UWorld* World,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
    static bool SetPendingLocalConfiguration(
        UWorld* World,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        EResourceNodeType NodeType,
        FString& OutReason);
    static bool SetPendingLocalTemplateConfiguration(
        UWorld* World,
        TSubclassOf<AFGResourceNode> TemplateClass,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
    static void ClearPendingLocalConfiguration(UWorld* World);

protected:
    virtual void CheckValidPlacement() override;

private:
    // The RCO is the only non-hologram caller allowed to update an already
    // active local preview. That avoids a same-recipe arm request silently
    // retaining the previous resource/purity.
    friend class UAIFactoryCreativeNodeRCO;

    bool SetRequestedConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        EResourceNodeType NodeType,
        FString& OutReason);
    bool SetRequestedTemplateConfiguration(
        TSubclassOf<AFGResourceNode> TemplateClass,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
    bool HasOverlappingResourceNode() const;
    void UpdateRequestedVisual();

    /** Serialized by the game's hologram construction-message pipeline. */
    UPROPERTY(Replicated, CustomSerialization)
    TSubclassOf<UFGResourceDescriptor> mRequestedResource = nullptr;

    /** Serialized beside the resource so a server never infers purity. */
    UPROPERTY(Replicated, CustomSerialization)
    TEnumAsByte<EResourcePurity> mRequestedPurity = RP_Normal;

    /** Serialized node kind; Geyser is the only special supported type. */
    UPROPERTY(Replicated, CustomSerialization)
    EResourceNodeType mRequestedNodeType = EResourceNodeType::Node;

    /**
     * Exact loaded special-node class, or null for a mod-owned ordinary/geyser
     * node. The server re-proves this class/resource pair against a live node
     * before it can construct anything.
     */
    UPROPERTY(Replicated, CustomSerialization)
    TSubclassOf<AFGResourceNode> mRequestedTemplateClass = nullptr;
};
