#pragma once

#include "CoreMinimal.h"
#include "FGConstructDisqualifier.h"
#include "Hologram/FGBuildableHologram.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryBlueprintResourceAnchorHologram.generated.h"

class UFGResourceDescriptor;

UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorInvalidConfigurationDisqualifier final
    : public UFGConstructDisqualifier
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintResourceAnchorInvalidConfigurationDisqualifier()
    {
        mDisqfualifyingText = NSLOCTEXT(
            "AIFactoryCopilot",
            "BlueprintResourceAnchorInvalidConfiguration",
            "Blueprint Resource Anchor needs a valid solid resource and purity.");
    }
};

/**
 * Standard Build Gun hologram for the Designer Resource Anchor.
 *
 * The resource choice is carried through Satisfactory's own construction
 * message.  The client only stages it; the server validates it again before
 * the normal AFGBuildableHologram construction path configures the root.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API AAIFactoryBlueprintResourceAnchorHologram final
    : public AFGBuildableHologram
{
    GENERATED_BODY()

public:
    AAIFactoryBlueprintResourceAnchorHologram();

    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;
    virtual void BeginPlay() override;
    virtual void PostConstructMessageDeserialization() override;

    static bool SetPendingLocalConfiguration(
        UWorld* World,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
    static void ClearPendingLocalConfiguration(UWorld* World);

protected:
    virtual void CheckValidPlacement() override;
    virtual void ConfigureActor(class AFGBuildable* InBuildable) const override;

private:
    friend class UAIFactoryBlueprintResourceAnchorRCO;

    bool SetRequestedConfiguration(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        FString& OutReason);
    void UpdateRequestedVisual();

    /** Hologram CustomSerialization ensures the server sees the same choice. */
    UPROPERTY(Replicated, CustomSerialization)
    TSubclassOf<UFGResourceDescriptor> mRequestedResource = nullptr;

    UPROPERTY(Replicated, CustomSerialization)
    TEnumAsByte<EResourcePurity> mRequestedPurity = RP_Normal;
};
