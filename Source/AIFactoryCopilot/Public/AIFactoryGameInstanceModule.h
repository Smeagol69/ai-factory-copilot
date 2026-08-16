#pragma once

#include "Module/GameInstanceModule.h"
#include "AIFactoryGameInstanceModule.generated.h"

/**
 * Client/server lifecycle module used solely to register Copilot RCOs. It is
 * separate from the existing world module: the latter owns authoritative world
 * scanning, while this one owns per-player client handoffs.
 */
UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryGameInstanceModule final : public UGameInstanceModule
{
    GENERATED_BODY()

public:
    UAIFactoryGameInstanceModule();
};
