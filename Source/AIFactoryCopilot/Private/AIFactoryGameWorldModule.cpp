#include "AIFactoryGameWorldModule.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorContent.h"
#include "AIFactoryBlueprintResourceAnchorPlacement.h"
#include "AIFactoryCopilotModule.h"
#include "AIFactoryChatCommand.h"
#include "AIFactoryCreativeNodeContent.h"
#include "AIFactorySubsystem.h"
#include "FGRecipeManager.h"

UAIFactoryGameWorldModule::UAIFactoryGameWorldModule()
{
    bRootModule = true;
    mChatCommands.Add(AAIFactoryChatCommand::StaticClass());
    mSchematics.Add(UAIFactoryCreativeNodeSchematic::StaticClass());
    ModSubsystems.Add(AAIFactorySubsystem::StaticClass());
    mSchematics.Add(UAIFactoryBlueprintResourceAnchorSchematic::StaticClass());
}

void UAIFactoryGameWorldModule::DispatchLifecycleEvent(const ELifecyclePhase Phase)
{
    Super::DispatchLifecycleEvent(Phase);

    // The subsystem asset is fully initialized only after every world module
    // has registered its construction-phase content.  Do this on each world
    // (server and client) before a player chooses a Miner recipe, so a normal
    // Build Gun hologram inherits the exact opt-in flag from its CDO.
    if (Phase == ELifecyclePhase::POST_INITIALIZATION)
    {
        // Generated native Blueprints use this mod-owned recipe as a signed
        // resource anchor.  The companion must see it in the live catalog on
        // the very first snapshot; waiting for the player to run `/ai anchor`
        // would make the one-command generation route impossible.  This is
        // idempotent and does not unlock any vanilla progression recipe.
        if (!AIFactoryBlueprintResourceAnchorPlacement::EnsureRecipeAvailable(GetWorld()))
        {
            UE_LOG(LogAIFactoryCopilot, Warning,
                TEXT("Blueprint Resource Anchor recipe is not available yet; the recipe manager was not ready during world initialization."));
        }

        AAIFactoryBlueprintResourceAnchor::EnableVanillaMinersInBlueprintDesigner(GetWorld());
    }
}

