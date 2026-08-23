#include "AIFactoryCreativeNodeContent.h"

#include "AIFactoryCreativeNodeHologram.h"
#include "AIFactoryCreativeResourceNode.h"
#include "Equipment/FGBuildGun.h"

FText UAIFactoryCreativeNodeDescriptor::GetItemNameInternal() const
{
    return NSLOCTEXT(
        "AIFactoryCopilot",
        "CreativeResourceNodeName",
        "Creative Resource Node");
}

FText UAIFactoryCreativeNodeDescriptor::GetItemDescriptionInternal() const
{
    return NSLOCTEXT(
        "AIFactoryCopilot",
        "CreativeResourceNodeDescription",
        "A mod-owned infinite solid resource node. Choose its resource and purity before placing it with the normal Build Gun.");
}

TSubclassOf<AFGHologram> UAIFactoryCreativeNodeDescriptor::GetHologramClassInternal() const
{
    return AAIFactoryCreativeNodeHologram::StaticClass();
}

TSubclassOf<AActor> UAIFactoryCreativeNodeDescriptor::GetBuildClassInternal() const
{
    return AAIFactoryCreativeResourceNode::StaticClass();
}

UAIFactoryCreativeNodeRecipe::UAIFactoryCreativeNodeRecipe()
{
    mProduct.Add(FItemAmount(UAIFactoryCreativeNodeDescriptor::StaticClass(), 1));
    mProducedIn.Add(AFGBuildGun::StaticClass());
}

UAIFactoryCreativeNodeUnlockRecipe::UAIFactoryCreativeNodeUnlockRecipe()
{
    mRecipes.Add(UAIFactoryCreativeNodeRecipe::StaticClass());
}

UAIFactoryCreativeNodeSchematic::UAIFactoryCreativeNodeSchematic()
{
    // This is a deliberate creative/editor capability, not a progression
    // reward. It has no material cost and is only granted after the player
    // explicitly invokes the editor command.
    mType = ESchematicType::EST_Cheat;
    mDisplayName = NSLOCTEXT(
        "AIFactoryCopilot",
        "CreativeResourceNodeSchematicName",
        "AI Factory Copilot: Creative Resource Node");
    mDescription = NSLOCTEXT(
        "AIFactoryCopilot",
        "CreativeResourceNodeSchematicDescription",
        "Enables the normal Build Gun workflow for mod-owned Creative Resource Nodes.");
    mMenuPriority = 0.0f;
    mTechTier = 0;
    mTimeToComplete = 0.0f;
    mUnlocks.Add(CreateDefaultSubobject<UAIFactoryCreativeNodeUnlockRecipe>(
        TEXT("UnlockCreativeResourceNode")));
}
