#include "AIFactoryBlueprintResourceAnchorContent.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorHologram.h"
#include "Equipment/FGBuildGun.h"

FText UAIFactoryBlueprintResourceAnchorDescriptor::GetItemNameInternal() const
{
    return NSLOCTEXT("AIFactoryCopilot", "BlueprintResourceAnchorName", "Blueprint Resource Anchor");
}

FText UAIFactoryBlueprintResourceAnchorDescriptor::GetItemDescriptionInternal() const
{
    return NSLOCTEXT(
        "AIFactoryCopilot",
        "BlueprintResourceAnchorDescription",
        "A configured solid-resource anchor for a native Blueprint Designer. Place a Miner Mk.1–Mk.3 onto its real node, then save the Blueprint.");
}

TSubclassOf<AFGHologram> UAIFactoryBlueprintResourceAnchorDescriptor::GetHologramClassInternal() const
{
    return AAIFactoryBlueprintResourceAnchorHologram::StaticClass();
}

TSubclassOf<AActor> UAIFactoryBlueprintResourceAnchorDescriptor::GetBuildClassInternal() const
{
    return AAIFactoryBlueprintResourceAnchor::StaticClass();
}

UAIFactoryBlueprintResourceAnchorRecipe::UAIFactoryBlueprintResourceAnchorRecipe()
{
    mProduct.Add(FItemAmount(UAIFactoryBlueprintResourceAnchorDescriptor::StaticClass(), 1));
    mProducedIn.Add(AFGBuildGun::StaticClass());
}

UAIFactoryBlueprintResourceAnchorUnlockRecipe::UAIFactoryBlueprintResourceAnchorUnlockRecipe()
{
    mRecipes.Add(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass());
}

UAIFactoryBlueprintResourceAnchorSchematic::UAIFactoryBlueprintResourceAnchorSchematic()
{
    mType = ESchematicType::EST_Cheat;
    mDisplayName = NSLOCTEXT(
        "AIFactoryCopilot",
        "BlueprintResourceAnchorSchematicName",
        "AI Factory Copilot: Blueprint Resource Anchor");
    mDescription = NSLOCTEXT(
        "AIFactoryCopilot",
        "BlueprintResourceAnchorSchematicDescription",
        "Enables a normal Build Gun Blueprint Resource Anchor after you choose a real solid resource and purity.");
    mMenuPriority = 0.0f;
    mTechTier = 0;
    mTimeToComplete = 0.0f;
    mUnlocks.Add(CreateDefaultSubobject<UAIFactoryBlueprintResourceAnchorUnlockRecipe>(
        TEXT("UnlockBlueprintResourceAnchor")));
}
