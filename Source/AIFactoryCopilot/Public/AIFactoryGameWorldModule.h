#pragma once

#include "Module/GameWorldModule.h"
#include "AIFactoryGameWorldModule.generated.h"

/**
 * Native root module discovered by SML. Keeping this native avoids requiring a
 * generated Blueprint asset merely to bootstrap the scanner.
 */
UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryGameWorldModule final : public UGameWorldModule
{
    GENERATED_BODY()

public:
    UAIFactoryGameWorldModule();
    virtual void DispatchLifecycleEvent(ELifecyclePhase Phase) override;
};

