#include "AIFactoryCopilotModule.h"

#include "AIFactoryBlueprintResourceAnchor.h"

DEFINE_LOG_CATEGORY(LogAIFactoryCopilot);

void FAIFactoryCopilotModule::StartupModule()
{
    RegisterAIFactoryBlueprintResourceAnchorHooks();
    UE_LOG(LogAIFactoryCopilot, Display, TEXT("AI Factory Copilot module loaded"));
}

void FAIFactoryCopilotModule::ShutdownModule()
{
    UE_LOG(LogAIFactoryCopilot, Display, TEXT("AI Factory Copilot module unloaded"));
}

IMPLEMENT_GAME_MODULE(FAIFactoryCopilotModule, AIFactoryCopilot);

