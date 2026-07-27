#include "AIFactoryGameWorldModule.h"

#include "AIFactoryChatCommand.h"
#include "AIFactorySubsystem.h"

UAIFactoryGameWorldModule::UAIFactoryGameWorldModule()
{
    bRootModule = true;
    mChatCommands.Add(AAIFactoryChatCommand::StaticClass());
    ModSubsystems.Add(AAIFactorySubsystem::StaticClass());
}

