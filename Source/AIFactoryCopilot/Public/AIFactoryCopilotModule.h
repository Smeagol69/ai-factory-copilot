#pragma once

#include "Delegates/Delegate.h"
#include "Modules/ModuleManager.h"

DECLARE_LOG_CATEGORY_EXTERN(LogAIFactoryCopilot, Log, All);

class FAIFactoryCopilotModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    /**
     * SML hook that removes only the vanilla BP_ResourceNode_C ancestry gate
     * for a validated Copilot ordinary node, then delegates every remaining
     * extractor compatibility check back to FactoryGame.
     */
    FDelegateHandle mCreativeNodeExtractorCompatibilityHook;
};
