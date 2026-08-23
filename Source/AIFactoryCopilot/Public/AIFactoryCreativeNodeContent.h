#pragma once

#include "CoreMinimal.h"
#include "FGRecipe.h"
#include "FGSchematic.h"
#include "Resources/FGBuildDescriptor.h"
#include "Unlocks/FGUnlockRecipe.h"
#include "AIFactoryCreativeNodeContent.generated.h"

/** A generic Build Gun descriptor for a mod-owned Creative Resource Node. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeDescriptor final : public UFGBuildDescriptor
{
    GENERATED_BODY()

protected:
    virtual FText GetItemNameInternal() const override;
    virtual FText GetItemDescriptionInternal() const override;
    virtual TSubclassOf<class AFGHologram> GetHologramClassInternal() const override;
    virtual TSubclassOf<AActor> GetBuildClassInternal() const override;
};

/**
 * A zero-cost creative-mode Build Gun recipe. The actual resource/purity is
 * custom hologram state, not a fake family of one recipe per ore.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeRecipe final : public UFGRecipe
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeRecipe();
};

/** Unlock payload owned by the opt-in Creative Resource Node schematic. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeUnlockRecipe final : public UFGUnlockRecipe
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeUnlockRecipe();
};

/**
 * Registered through the SML world module and granted only when a player asks
 * to arm the editor. This makes the recipe visible to the normal Build Gun
 * availability system instead of bypassing it with a direct spawn.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeSchematic final : public UFGSchematic
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeSchematic();
};
