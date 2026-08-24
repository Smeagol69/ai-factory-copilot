#pragma once

#include "CoreMinimal.h"
#include "FGRemoteCallObject.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryBlueprintResourceAnchorRCO.generated.h"

class AFGBuildGun;
class UFGRecipe;
class UFGResourceDescriptor;

/** Client handoff that arms the player's real Build Gun, never a direct spawn. */
UCLASS(NotBlueprintable)
class AIFACTORYCOPILOT_API UAIFactoryBlueprintResourceAnchorRCO final
    : public UFGRemoteCallObject
{
    GENERATED_BODY()

public:
    UAIFactoryBlueprintResourceAnchorRCO();
    virtual void BeginDestroy() override;
    virtual void GetLifetimeReplicatedProps(
        TArray<class FLifetimeProperty>& OutLifetimeProps) const override;

    UFUNCTION(Client, Reliable)
    void ClientArmBlueprintResourceAnchor(
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity);

private:
    UFUNCTION()
    void HandleBuildGunStateChanged(EBuildGunState NewState);

    UFUNCTION()
    void HandleBuildGunRecipeChanged(TSubclassOf<UFGRecipe> NewRecipe);

    void ObserveBuildGun(AFGBuildGun* BuildGun);
    void StopObservingBuildGun();

    TWeakObjectPtr<AFGBuildGun> mObservedBuildGun;

    UPROPERTY(Replicated)
    bool bForceNetField_AIFactoryBlueprintResourceAnchorRCO = false;
};
