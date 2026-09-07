#pragma once

#include "AIFactoryAxisRotationState.h"

class AFGHologram;
class AFGPlayerController;
class UFGBuildGunStateBuild;
class FAIFactoryBuildGunHints;
struct FKeyEvent;
struct FPointerEvent;

/** Manual edits to one local native preview, never to a constructed actor. */
class FAIFactoryBuildGunRotation
{
public:
    FAIFactoryBuildGunRotation();
    ~FAIFactoryBuildGunRotation();
    bool HandleKeyDown(AFGPlayerController* Controller, bool bPanelVisible, const FKeyEvent& Event);
    bool HandleWheel(AFGPlayerController* Controller, bool bPanelVisible, const FPointerEvent& Event);
    bool CanStart(AFGPlayerController* Controller, bool bPanelVisible) const;
    void BeforeWorldTick(AFGPlayerController* Controller);
    void AfterWorldTick(AFGPlayerController* Controller, bool bPanelVisible);
    void Shutdown();
    bool IsEnabled() const { return State.bEnabled; }

private:
    FAIFactoryAxisRotationState State;
    TWeakObjectPtr<AFGHologram> Hologram;
    FQuat NativeRotation = FQuat::Identity;
    bool bAppliedRotation = false;
    bool bOwnsPositionLock = false;
    TUniquePtr<FAIFactoryBuildGunHints> Hints;
    FString LastGateLine;

    static UFGBuildGunStateBuild* GetBuildState(AFGPlayerController* Controller);
    static bool CanHandleInput(AFGPlayerController* Controller, bool bPanelVisible);
    static bool SupportsRotation(AFGHologram* Target);
    static void ApplyNativeRotation(AFGHologram* Target, const FQuat& Rotation);
    void Reset(bool bRestore);
    /** Logs every gate condition, once per change, so "nothing happens" is answerable. */
    void LogGate(AFGPlayerController* Controller, bool bPanelVisible, bool bCanStart);
};
