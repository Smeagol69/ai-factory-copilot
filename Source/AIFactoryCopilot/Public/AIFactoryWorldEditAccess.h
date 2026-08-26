#pragma once

#include "CoreMinimal.h"

class AFGPlayerController;

/**
 * One authoritative permission gate for direct world-editor chat commands.
 *
 * Bridge actions already use `allowWriteActions`; native editor commands must
 * never become an unguarded second write channel. Multiplayer also needs the
 * game's real server-admin flag because editor unlocks persist at world scope.
 */
namespace AIFactoryWorldEditAccess
{
    bool CanEdit(AFGPlayerController* PlayerController, FString& OutReason);
}
