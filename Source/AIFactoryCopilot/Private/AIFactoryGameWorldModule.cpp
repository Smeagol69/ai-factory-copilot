#include "AIFactoryGameWorldModule.h"

#include "AIFactoryChatCommand.h"
#include "AIFactoryCreativeNodeContent.h"
#include "AIFactorySubsystem.h"

UAIFactoryGameWorldModule::UAIFactoryGameWorldModule()
{
    bRootModule = true;
    mChatCommands.Add(AAIFactoryChatCommand::StaticClass());
    mSchematics.Add(UAIFactoryCreativeNodeSchematic::StaticClass());
    ModSubsystems.Add(AAIFactorySubsystem::StaticClass());
}

