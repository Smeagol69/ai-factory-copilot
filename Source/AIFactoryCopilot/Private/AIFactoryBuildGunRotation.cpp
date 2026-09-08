#include "AIFactoryBuildGunRotation.h"
#include "AIFactoryBuildGunHints.h"
#include "AIFactoryCopilotModule.h"

#include "Engine/World.h"
#include "Equipment/FGBuildGun.h"
#include "Equipment/FGBuildGunBuild.h"
#include "FGCharacterPlayer.h"
#include "FGHUD.h"
#include "FGPlayerController.h"
#include "Framework/Application/SlateApplication.h"
#include "Hologram/FGBuildableHologram.h"
#include "Hologram/FGSplineHologram.h"
#include "Hologram/FGWireHologram.h"
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

    // Deliberately NOT gated on GameUI validity or HasActiveInteractWidget().
    //
    // The shipped diagnostic showed every hologram condition green while
    // input=0 with panel=0, cursor=0 and focus=SViewport, so one of those two
    // was silently refusing during ordinary building. HasActiveInteractWidget
    // is true for more UI than a text field - and with a build mod such as
    // SMART! adding its own widgets it can be true the whole time the Build Gun
    // is out, which would make this feature permanently unreachable.
    //
    // The focus test below is the real guard, and it is the strict one: keys are
    // only taken while the game viewport itself owns focus, so a chat box,
    // search field or any menu that takes focus still gets its input untouched.
    // The pause menu is still refused when the game UI is readable, but a null
    // game UI is no longer treated as a refusal.
    const AFGHUD* const HUD = Cast<AFGHUD>(Controller->GetHUD());
    if (const UFGGameUI* const GameUI = IsValid(HUD) ? HUD->GetGameUI() : nullptr;
        IsValid(GameUI) && GameUI->IsPauseMenuOpen())
    {
        return false;
    }

    // A preprocessor runs before both the game and text widgets. Only intercept
    // keys while the game viewport owns focus, never chat/search/menu input.
    const TSharedPtr<SWidget> Focused = FSlateApplication::Get().GetUserFocusedWidget(0);
    return Focused.IsValid() && Focused->GetType() == FName(TEXT("SViewport"));
}

bool FAIFactoryBuildGunRotation::SupportsRotation(AFGHologram* Target)
{
    // This editor rotates a single rigid native preview. Multi-endpoint spline
    // tools must keep their native endpoint routing, not rotate connected ports.
    // Two conditions were removed here, both because their real bodies ship
    // only in the game binary and neither could be checked before use.
    //
    // CanNudgeHologram() is a non-inline virtual whose body is not readable.
    // The flag it is named after defaults to true on AFGBuildableHologram, so
    // it may well have been passing - this is NOT a claim that it returned
    // false. It is dropped because it is simply the wrong question: rotation
    // never nudges. It sets the actor transform and resyncs the scroll
    // rotation, and touches no nudge API at all. Only the *lock* matters, and
    // CanLockHologram() is inline and readable.
    //
    // GetNudgeHologramTarget() == Target was the same kind of unverifiable
    // gate, and an equality test turns an unexpected return into a silent dead
    // feature. Its only real job here is excluding the wire hologram: of the
    // four classes that override it, conveyor belt and pipeline are already
    // refused as splines and the standalone sign would only be refused
    // needlessly. So exclude the wire directly, which is readable and cannot
    // fail quietly.
    return IsValid(Target) && !Target->GetIsPendingToBeConstructed() &&
        !IsValid(Target->GetParentHologram()) && Target->IsA<AFGBuildableHologram>() &&
        !Target->IsA<AFGSplineHologram>() && !Target->IsA<AFGWireHologram>() &&
        Target->CanLockHologram();
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
    // Bracket keys, not PageUp/PageDown: those are the vanilla vertical
    // raise/lower bindings, and you want to keep raising an object while you
    // rotate it. The Build Gun does not bind [ or ].
    if (State.bEnabled && Key == EKeys::Period)
    {
        // Which ramp the Alt step matches: 8x4, then 8x2, then 8x1.
        if (!Event.IsRepeat()) State.CycleRamp();
        return true;
    }
    if (!State.bEnabled || (Key != EKeys::RightBracket && Key != EKeys::LeftBracket)) return false;
    if (!Event.IsRepeat()) State.Cycle(Key == EKeys::RightBracket ? 1 : -1);
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
    // Alt steps by the exact ramp pitch, which none of 15/1/45 degrees can
    // reach - that is what lets a wall sit flush on a ramp rather than near it.
    State.Scroll(Event.GetWheelDelta(), Event.IsControlDown(), Event.IsShiftDown(),
        Event.IsAltDown());
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
    const bool bCanStart = CanStart(Controller, bPanelVisible);
    LogGate(Controller, bPanelVisible, bCanStart);
    Hints->Update(Controller, bCanStart, State.bEnabled,
        State.Axis, State.Rotation.Rotator(), State.RampAngle());
}

void FAIFactoryBuildGunRotation::LogGate(
    AFGPlayerController* const Controller,
    const bool bPanelVisible,
    const bool bCanStart)
{
    // Every condition, individually, so a "nothing happens" report can be
    // answered from the log instead of guessed at. Emitted only when the
    // combination changes, so holding the Build Gun does not flood the file.
    const UFGBuildGunStateBuild* const Build = GetBuildState(Controller);
    AFGHologram* const Target = IsValid(Build) ? Build->GetHologram() : nullptr;

    AFGHUD* const HUD = IsValid(Controller) ? Cast<AFGHUD>(Controller->GetHUD()) : nullptr;
    UFGGameUI* const GameUI = IsValid(HUD) ? HUD->GetGameUI() : nullptr;

    FString Focused = TEXT("none");
    if (FSlateApplication::IsInitialized())
    {
        if (const TSharedPtr<SWidget> Widget = FSlateApplication::Get().GetUserFocusedWidget(0);
            Widget.IsValid())
        {
            Focused = Widget->GetType().ToString();
        }
    }

    const FString Line = FString::Printf(
        TEXT("Axis rotation gate: canStart=%d enabled=%d buildState=%d hologram=%s ")
        TEXT("input=%d panel=%d cursor=%d focus=%s local=%d paused=%d gameUI=%d ")
        TEXT("interact=%d pauseMenu=%d ")
        TEXT("pending=%d parent=%d buildable=%d spline=%d canLock=%d canNudge=%d ")
        TEXT("locked=%d nudgeTargetIsSelf=%d sameWorld=%d instigatorMatch=%d"),
        bCanStart ? 1 : 0,
        State.bEnabled ? 1 : 0,
        IsValid(Build) ? 1 : 0,
        IsValid(Target) ? *Target->GetClass()->GetName() : TEXT("none"),
        CanHandleInput(Controller, bPanelVisible) ? 1 : 0,
        bPanelVisible ? 1 : 0,
        IsValid(Controller) && Controller->bShowMouseCursor ? 1 : 0,
        *Focused,
        IsValid(Controller) && Controller->IsLocalController() ? 1 : 0,
        IsValid(Controller) && IsValid(Controller->GetWorld()) &&
            Controller->GetWorld()->IsPaused() ? 1 : 0,
        IsValid(GameUI) ? 1 : 0,
        IsValid(GameUI) && GameUI->HasActiveInteractWidget() ? 1 : 0,
        IsValid(GameUI) && GameUI->IsPauseMenuOpen() ? 1 : 0,
        IsValid(Target) && Target->GetIsPendingToBeConstructed() ? 1 : 0,
        IsValid(Target) && IsValid(Target->GetParentHologram()) ? 1 : 0,
        IsValid(Target) && Target->IsA<AFGBuildableHologram>() ? 1 : 0,
        IsValid(Target) && Target->IsA<AFGSplineHologram>() ? 1 : 0,
        IsValid(Target) && Target->CanLockHologram() ? 1 : 0,
        IsValid(Target) && Target->CanNudgeHologram() ? 1 : 0,
        IsValid(Target) && Target->IsHologramLocked() ? 1 : 0,
        IsValid(Target) && Target->GetNudgeHologramTarget() == Target ? 1 : 0,
        IsValid(Target) && IsValid(Controller) && Target->GetWorld() == Controller->GetWorld() ? 1 : 0,
        IsValid(Target) && IsValid(Controller) &&
            Target->GetConstructionInstigator() == Controller->GetControlledCharacter() ? 1 : 0);

    if (Line == LastGateLine)
    {
        return;
    }
    LastGateLine = Line;
    UE_LOG(LogAIFactoryCopilot, Display, TEXT("%s"), *Line);
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
