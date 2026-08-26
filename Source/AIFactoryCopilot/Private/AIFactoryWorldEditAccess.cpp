#include "AIFactoryWorldEditAccess.h"

#include "AIFactorySubsystem.h"
#include "Engine/World.h"
#include "FGPlayerController.h"
#include "FGPlayerState.h"

namespace AIFactoryWorldEditAccess
{
bool CanEdit(AFGPlayerController* const PlayerController, FString& OutReason)
{
    OutReason.Reset();
    if (!IsValid(PlayerController) || !IsValid(PlayerController->GetWorld()))
    {
        OutReason = TEXT("the requesting player has no active world");
        return false;
    }

    UWorld* const World = PlayerController->GetWorld();
    if (World->GetNetMode() == NM_Client)
    {
        OutReason = TEXT("the world editor must be processed by the authoritative game server");
        return false;
    }

    const AAIFactorySubsystem* const CopilotSubsystem = AAIFactorySubsystem::Get(World);
    if (!IsValid(CopilotSubsystem))
    {
        OutReason = TEXT("AI Factory Copilot's authoritative subsystem is not ready");
        return false;
    }
    if (!CopilotSubsystem->GetSettings().bAllowWriteActions)
    {
        OutReason = TEXT("world writes are disabled; set allowWriteActions to true before using the world editor");
        return false;
    }

    // In single-player, the local player is the only authority. In a networked
    // save, direct editor commands can mutate persistent world-level state, so
    // rely on Satisfactory's explicit server-admin identity rather than trying
    // to infer "host" from the net mode or connection topology.
    if (World->GetNetMode() != NM_Standalone)
    {
        const AFGPlayerState* const PlayerState =
            PlayerController->GetPlayerState<AFGPlayerState>();
        if (!IsValid(PlayerState) || !PlayerState->IsServerAdmin())
        {
            OutReason = TEXT("only a server admin can use the shared world editor in multiplayer");
            return false;
        }
    }
    return true;
}
}
