#pragma once

#include "CoreMinimal.h"
#include "FGRecipe.h"
#include "FGSchematic.h"
#include "Resources/FGBuildDescriptor.h"
#include "Unlocks/FGUnlockRecipe.h"
#include "AIFactoryBlueprintResourceAnchorContent.generated.h"

/** Native Build Gun descriptor for an explicitly configured Designer anchor. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorDescriptor final : public UFGBuildDescriptor
{
    GENERATED_BODY()

protected:
    virtual FText GetItemNameInternal() const override;
    virtual FText GetItemDescriptionInternal() const override;
    virtual TSubclassOf<class AFGHologram> GetHologramClassInternal() const override;
    virtual TSubclassOf<AActor> GetBuildClassInternal() const override;
};

/** Zero-cost editor recipe; its solid resource/purity is a signed Hologram message. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorRecipe final : public UFGRecipe
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintResourceAnchorRecipe();
};

UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorUnlockRecipe final : public UFGUnlockRecipe
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintResourceAnchorUnlockRecipe();
};

/** Registered through SML's world-module construction phase. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorSchematic final : public UFGSchematic
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintResourceAnchorSchematic();
};
