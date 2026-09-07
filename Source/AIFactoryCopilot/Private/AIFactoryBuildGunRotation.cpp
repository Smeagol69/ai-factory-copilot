#include "AIFactoryBuildGunRotation.h"
#include "AIFactoryBuildGunHints.h"

#include "Engine/World.h"
#include "Equipment/FGBuildGun.h"
#include "Equipment/FGBuildGunBuild.h"
#include "FGCharacterPlayer.h"
#include "FGHUD.h"
#include "FGPlayerController.h"
#include "Framework/Application/SlateApplication.h"
#include "Hologram/FGBuildableHologram.h"
#include "Hologram/FGSplineHologram.h"
#include "Input/Events.h"
#include "InputCoreTypes.h"
#include "UI/FGGameUI.h"
#include "Widgets/SWidget.h"

FAIFactoryBuildGunRotation::FAIFactoryBuildGunRotation()
    : Hints(MakeUnique<FAIFactoryBuildGunHints>())
{
}

FAIFactoryBuildGunRotation::~FAIFactoryBuildGunRotation()
{
    Shutdown();
}

UFGBuildGunStateBuild* FAIFactoryBuildGunRotation::GetBuildState(AFGPlayerController* Controller)
{
    if (!IsValid(Controller) || !Controller->IsLocalController()) return nullptr;
    const AFGCharacterPlayer* Character = Cast<AFGCharacterPlayer>(Controller->GetControlledCharacter());
    const AFGBuildGun* Gun = IsValid(Character) ? Character->GetBuildGun() : nullptr;
    return IsValid(Gun) ? Cast<UFGBuildGunStateBuild>(Gun->GetCurrentState()) : nullptr;
}

bool FAIFactoryBuildGunRotation::CanHandleInput(AFGPlayerController* Controller, const bool bPanelVisible)
{
    if (bPanelVisible || !IsValid(Controller) || !Controller->IsLocalController() ||
        Controller->bShowMouseCursor || !IsValid(Controller->GetWorld()) ||
        Controller->GetWorld()->IsPaused() || !FSlateApplication::IsInitialized()) return false;

    AFGHUD* HUD = Cast<AFGHUD>(Controller->GetHUD());
    UFGGameUI* GameUI = IsValid(HUD) ? HUD->GetGameUI() : nullptr;
    if (!IsValid(GameUI) || GameUI->HasActiveInteractWidget() || GameUI->IsPauseMenuOpen()) return false;

    // A preprocessor runs before both the game and text widgets. Only intercept
    // keys while the game viewport owns focus, never chat/search/menu input.
    const TSharedPtr<SWidget> Focused = FSlateApplication::Get().GetUserFocusedWidget(0);
    return Focused.IsValid() && Focused->GetType() == FName(TEXT("SViewport"));
}

bool FAIFactoryBuildGunRotation::SupportsRotation(AFGHologram* Target)
{
    // This editor rotates a single rigid native preview. Multi-endpoint spline
    // tools must keep their native endpoint routing, not rotate connected ports.
    return IsValid(Target) && !Target->GetIsPendingToBeConstructed() &&
        !IsValid(Target->GetParentHologram()) && Target->IsA<AFGBuildableHologram>() &&
        !Target->IsA<AFGSplineHologram>() && Target->CanLockHologram() &&
        Target->CanNudgeHologram() && Target->GetNudgeHologramTarget() == Target;
}

bool FAIFactoryBuildGunRotation::CanStart(AFGPlayerController* Controller, const bool bPanelVisible) const
{
    const UFGBuildGunStateBuild* Build = GetBuildState(Controller);
    AFGHologram* Target = IsValid(Build) ? Build->GetHologram() : nullptr;
    return CanHandleInput(Controller, bPanelVisible) && SupportsRotation(Target) &&
        Target->GetWorld() == Controller->GetWorld() &&
        Target->GetConstructionInstigator() == Controller->GetControlledCharacter();
}

void FAIFactoryBuildGunRotation::ApplyNativeRotation(AFGHologram* Target, const FQuat& Rotation)
{
    if (!IsValid(Target) || Target->GetIsPendingToBeConstructed()) return;
    Target->SetActorLocationAndRotation(Target->GetActorLocation(), Rotation,
        false, nullptr, ETeleportType::TeleportPhysics);

    // "Take the current transform and apply it to the scroll rotation value."
    // (CL 502094 FGHologram.h). Moving the actor alone leaves mScrollRotation
    // describing the old pose, and that serialized value is what construction
    // carries - so without this the built actor loses the pitch and roll.
    //
    // The protected OnHologramTransformUpdated() is the game's other resync,
    // for sub-holograms and snapping. It is deliberately not called: it needs a
    // friend access transformer, and UHT rejects that entry as unused, so the
    // call does not compile (C2248). Nothing is lost for what this edits -
    // SupportsRotation() already refuses child, parent-owning and spline
    // holograms - and ValidatePlacementAndCost still runs every frame, so
    // clearance and placement stay live.
    Target->UpdateRotationValuesFromTransform();
}

bool FAIFactoryBuildGunRotation::HandleKeyDown(AFGPlayerController* Controller,
    const bool bPanelVisible, const FKeyEvent& Event)
{
    if (!CanHandleInput(Controller, bPanelVisible)) return false;
    const FKey Key = Event.GetKey();
    if (Key == EKeys::F5)
    {
        if (Event.IsRepeat()) return State.bEnabled;
        if (State.bEnabled)
        {
            Reset(true);
            return true;
        }
        if (!CanStart(Controller, bPanelVisible)) return false;
        AFGHologram* Target = GetBuildState(Controller)->GetHologram();
        NativeRotation = Target->GetActorQuat();
        Hologram = Target;
        // Native lock keeps the full transform alive during input/construction,
        // not only in the rendered frame. H remains the native unlock/cancel key.
        bOwnsPositionLock = !Target->IsHologramLocked();
        if (bOwnsPositionLock) Target->LockHologramPosition(true);
        State.Begin(NativeRotation);
        return true;
    }
    if (!State.bEnabled || (Key != EKeys::PageUp && Key != EKeys::PageDown)) return false;
    if (!Event.IsRepeat()) State.Cycle(Key == EKeys::PageUp ? 1 : -1);
    return true;
}

bool FAIFactoryBuildGunRotation::HandleWheel(AFGPlayerController* Controller,
    const bool bPanelVisible, const FPointerEvent& Event)
{
    if (!State.bEnabled || !CanHandleInput(Controller, bPanelVisible)) return false;
    const UFGBuildGunStateBuild* Build = GetBuildState(Controller);
    AFGHologram* Target = Hologram.Get();
    if (!IsValid(Build) || Build->GetHologram() != Target || !SupportsRotation(Target) ||
        !Target->IsHologramLocked()) return false;
    State.Scroll(Event.GetWheelDelta(), Event.IsControlDown(), Event.IsShiftDown());
    ApplyNativeRotation(Target, State.Rotation);
    bAppliedRotation = true;
    return true;
}

void FAIFactoryBuildGunRotation::BeforeWorldTick(AFGPlayerController* Controller)
{
    if (!State.bEnabled) return;
    const UFGBuildGunStateBuild* Build = GetBuildState(Controller);
    AFGHologram* Target = Hologram.Get();
    if (!IsValid(Build) || Build->GetHologram() != Target || !IsValid(Target) ||
        Target->GetIsPendingToBeConstructed())
    {
        Reset(false);
    }
    // Never restore the native yaw here: PrimaryFire may serialize the preview
    // during this actor tick. The actual native lock preserves the edited pose.
}

void FAIFactoryBuildGunRotation::AfterWorldTick(AFGPlayerController* Controller, const bool bPanelVisible)
{
    const UFGBuildGunStateBuild* Build = GetBuildState(Controller);
    AFGHologram* Target = IsValid(Build) ? Build->GetHologram() : nullptr;
    if (State.bEnabled)
    {
        if (!IsValid(Target) || Target != Hologram.Get() || Target->GetIsPendingToBeConstructed())
        {
            Reset(false);
        }
        else if (!Target->IsHologramLocked() || !CanHandleInput(Controller, bPanelVisible))
        {
            Reset(true);
        }
        else
        {
            ApplyNativeRotation(Target, State.Rotation);
            bAppliedRotation = true;
            const AFGCharacterPlayer* Character = Cast<AFGCharacterPlayer>(Controller->GetControlledCharacter());
            const AFGBuildGun* Gun = IsValid(Character) ? Character->GetBuildGun() : nullptr;
            if (IsValid(Gun)) Target->ValidatePlacementAndCost(Gun->GetInventory());
        }
    }
    Hints->Update(Controller, CanStart(Controller, bPanelVisible), State.bEnabled,
        State.Axis, State.Rotation.Rotator());
}

void FAIFactoryBuildGunRotation::Reset(const bool bRestore)
{
    AFGHologram* Target = Hologram.Get();
    // Pending native holograms belong to construction/server response handling.
    // Even cancellation must not mutate them or unlock a replacement preview.
    if (bRestore && IsValid(Target) && !Target->GetIsPendingToBeConstructed())
    {
        if (bAppliedRotation) ApplyNativeRotation(Target, NativeRotation);
        if (bOwnsPositionLock && Target->IsHologramLocked()) Target->LockHologramPosition(false);
    }
    Hologram.Reset();
    State.Reset();
    bAppliedRotation = false;
    bOwnsPositionLock = false;
}

void FAIFactoryBuildGunRotation::Shutdown()
{
    Reset(true);
    Hints->Clear();
}
