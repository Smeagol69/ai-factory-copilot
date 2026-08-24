#include "AIFactoryGameWorldModule.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorContent.h"
#include "AIFactoryChatCommand.h"
#include "AIFactorySubsystem.h"

UAIFactoryGameWorldModule::UAIFactoryGameWorldModule()
{
    bRootModule = true;
    mChatCommands.Add(AAIFactoryChatCommand::StaticClass());
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
        AAIFactoryBlueprintResourceAnchor::EnableVanillaMinersInBlueprintDesigner(GetWorld());
    }
}

