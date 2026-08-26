#pragma once

#include "CoreMinimal.h"
#include "Equipment/FGBuildGun.h"
#include "FGRemoteCallObject.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryCreativeNodeRCO.generated.h"

class UFGResourceDescriptor;
class UFGRecipe;

/**
 * Per-player client handoff for the Creative Resource Node Build Gun preview.
 * It never creates a world actor; construction remains the normal Build Gun's
 * server RPC after the player confirms the hologram.
 */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryCreativeNodeRCO final : public UFGRemoteCallObject
{
    GENERATED_BODY()

public:
    UAIFactoryCreativeNodeRCO();
    virtual void BeginDestroy() override;
    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;

    UFUNCTION(Client, Reliable)
    void ClientArmCreativeResourceNode(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity);

private:
    /** Clears a staged configuration if the Build Gun leaves this recipe/state. */
    UFUNCTION()
    void HandleBuildGunStateChanged(EBuildGunState NewState);

    /** Recipe changes can arrive before state changes, so both are observed. */
    UFUNCTION()
    void HandleBuildGunRecipeChanged(TSubclassOf<UFGRecipe> NewRecipe);

    void ObserveBuildGun(AFGBuildGun* BuildGun);
    void StopObservingBuildGun();

    /** Weak: the Build Gun owns its delegates and must not be kept alive by an RCO. */
    TWeakObjectPtr<AFGBuildGun> mObservedBuildGun;

    UPROPERTY(Replicated)
    bool bForceNetField_AIFactoryCreativeNodeRCO = false;
};
