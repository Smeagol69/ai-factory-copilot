#pragma once

#include "CoreMinimal.h"
#include "FGRemoteCallObject.h"
#include "Resources/FGResourceNode.h"
#include "AIFactoryBlueprintResourceAnchorRCO.generated.h"

class AFGBuildGun;
class AFGRecipeManager;
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

    UFUNCTION()
    void HandleRecipeAvailable(TSubclassOf<UFGRecipe> NewRecipe);

    void ObserveBuildGun(AFGBuildGun* BuildGun);
    void StopObservingBuildGun();
    void ObserveRecipeManager(AFGRecipeManager* RecipeManager);
    void StopObservingRecipeManager();
    void TryArmPendingBlueprintResourceAnchor();
    void SchedulePendingArmRetry();
    void ClearDeferredArm();
    void CancelPendingArmAndConfiguration();

    TWeakObjectPtr<AFGBuildGun> mObservedBuildGun;
    TWeakObjectPtr<AFGRecipeManager> mObservedRecipeManager;

    TSubclassOf<UFGResourceDescriptor> mPendingResource;
    TEnumAsByte<EResourcePurity> mPendingPurity = RP_Normal;
    int32 mArmRetryFramesRemaining = 0;
    bool bArmRetryScheduled = false;

    UPROPERTY(Replicated)
    bool bForceNetField_AIFactoryBlueprintResourceAnchorRCO = false;
};
