#pragma once

#include "CoreMinimal.h"

class AFGPlayerController;
class UFGButtonHintBar;

/**
 * Axis-rotation keys shown in Satisfactory's own Build Gun hint bar.
 *
 * The owner asked for these controls to appear where every other Build Gun
 * control already does, not in the mod panel. `UFGButtonHintBar` is the native
 * widget that renders that row, and its `mButtonHints` array plus
 * Insert/Remove are the game's own public way to change it.
 *
 * The bar rebuilds itself from focus and input-mapping changes, so this is
 * re-asserted every frame rather than inserted once. It is idempotent: a
 * signature of what should be showing is compared first, and the hints are only
 * touched when that signature changes or the bar has dropped them. Everything
 * added is removed again by exact hint text, so a rebuilt bar is never left
 * with a stale mod row and no native hint is ever removed.
 */
class FAIFactoryBuildGunHints
{
public:
    /**
     * @param bCanStart  the aimed preview could enter rotation mode
     * @param bEnabled   rotation mode is active
     * @param Axis       0 = local X, 1 = local Y, 2 = local Z
     */
    void Update(
        AFGPlayerController* Controller,
        bool bCanStart,
        bool bEnabled,
        int32 Axis,
        const FRotator& Rotation);

    /** Removes every hint this added. Safe to call when nothing was added. */
    void Clear();

private:
    TWeakObjectPtr<UFGButtonHintBar> Bar;
    /** Exact hint texts currently owned, used to remove only our own rows. */
    TArray<FString> OwnedHintTexts;
    FString LastSignature;

    static UFGButtonHintBar* FindGameplayHintBar(AFGPlayerController* Controller);
    void RemoveOwnedHints(UFGButtonHintBar* Target);
};
