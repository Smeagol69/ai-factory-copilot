#pragma once

#include "CoreMinimal.h"
#include "FGRemoteCallObject.h"
#include "AIFactoryBlueprintPreviewRCO.generated.h"

/**
 * Delivers a verified saved-blueprint selection from the authoritative bridge
 * request back to the player who asked it. The implementation is intentionally
 * client-only: Satisfactory documents Build Gun recipe/blueprint selection as
 * local-player work, and this RCO never constructs a world object itself.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintPreviewRCO final : public UFGRemoteCallObject
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintPreviewRCO();
    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;

    /**
     * Arms the owning local player's normal Blueprint Build Gun state. This is
     * an ordinary Client RPC, not a server-side hologram shortcut.
     */
    UFUNCTION(Client, Reliable)
    void ClientPreviewBlueprint(const FString& BlueprintName);

private:
    // A replicated field mirrors Satisfactory's own RCO classes and ensures
    // this RCO has a stable network field layout even before its first RPC.
    UPROPERTY(Replicated)
    bool bForceNetField_AIFactoryBlueprintPreviewRCO = false;
};
