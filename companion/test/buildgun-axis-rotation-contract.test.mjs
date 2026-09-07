import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Source-shape slices search for multi-line literals. Git checks these files out
// with CRLF on Windows, so reading them raw makes the slices pass or fail on a
// checkout setting rather than on the code. Normalise once, here.
const readSource = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const state = readSource("../../Source/AIFactoryCopilot/Private/AIFactoryAxisRotationState.h");
const rotation = readSource("../../Source/AIFactoryCopilot/Private/AIFactoryBuildGunRotation.cpp");
const hints = readSource("../../Source/AIFactoryCopilot/Private/AIFactoryBuildGunHints.cpp");
const ui = readSource("../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp");
const header = readSource("../../Source/AIFactoryCopilot/Public/AIFactoryCopilotUISubsystem.h");
const buildCs = readSource("../../Source/AIFactoryCopilot/AIFactoryCopilot.Build.cs");

test("rotation is edited as a quaternion about the object's own axes", () => {
  // Euler editing gimbal-locks at a 90 degree tilt, which is exactly the pose
  // this feature exists to reach.
  assert.match(state, /FQuat Rotation = FQuat::Identity/);
  assert.match(state, /FQuat\(LocalAxis, FMath::DegreesToRadians\(Degrees\)\)/);
  assert.match(state, /Rotation = \(Rotation \* FQuat/, "post-multiply keeps the axis local");
  assert.match(state, /GetNormalized\(\)/);
  // Inert until explicitly begun, so a stray wheel event cannot rotate anything.
  assert.match(state, /if \(!bEnabled \|\| !FMath::IsFinite\(Delta\)\)/);
});

test("the serialized rotation is resynced after every pose change", () => {
  // Moving the actor alone leaves mScrollRotation describing the old pose,
  // and that serialized value is what native construction carries - so
  // without this resync the built actor loses its pitch and roll.
  const apply = rotation.slice(
    rotation.indexOf("void FAIFactoryBuildGunRotation::ApplyNativeRotation("),
    rotation.indexOf("bool FAIFactoryBuildGunRotation::HandleKeyDown("),
  );
  assert.ok(apply.length > 0);
  assert.match(apply, /SetActorLocationAndRotation\(/);
  assert.match(apply, /UpdateRotationValuesFromTransform\(\)/);
  assert.ok(
    apply.indexOf("SetActorLocationAndRotation(") <
      apply.indexOf("UpdateRotationValuesFromTransform()"),
    "the resync must follow the transform change",
  );

  // OnHologramTransformUpdated is protected and its friend access transformer
  // is rejected by UHT as unused, so calling it does not compile (C2248).
  // Keep it out rather than reintroducing a build break.
  // A call through the hologram, not the comment that explains why it is absent.
  assert.doesNotMatch(apply, /->\s*OnHologramTransformUpdated\s*\(/);
});

test("editing never touches a constructed actor or a pending preview", () => {
  assert.match(rotation, /GetIsPendingToBeConstructed\(\)/);
  // Calls only: the source discusses PrimaryFire in a comment explaining why
  // the native yaw is never restored mid-tick.
  assert.doesNotMatch(
    rotation,
    /(?<![A-Za-z])(?:PrimaryFire|Server_Construct\w*|InternalConstructHologram)\s*\(/,
  );
  // Spline tools route endpoints natively; rotating them would fight that.
  assert.match(rotation, /!Target->IsA<AFGSplineHologram>\(\)/);
  assert.match(rotation, /GetNudgeHologramTarget\(\) == Target/);
  assert.match(rotation, /Target->GetConstructionInstigator\(\) == Controller->GetControlledCharacter\(\)/);
});

test("input is refused in menus, text fields and on remote controllers", () => {
  const gate = rotation.slice(
    rotation.indexOf("bool FAIFactoryBuildGunRotation::CanHandleInput("),
    rotation.indexOf("bool FAIFactoryBuildGunRotation::SupportsRotation("),
  );
  assert.match(gate, /Controller->IsLocalController\(\)/);
  assert.match(gate, /HasActiveInteractWidget\(\)/);
  assert.match(gate, /IsPauseMenuOpen\(\)/);
  assert.match(gate, /IsPaused\(\)/);
  // A preprocessor sees keys before text widgets do, so viewport focus is the
  // only safe signal that the game, not a chat box, should get this key.
  assert.match(gate, /GetUserFocusedWidget\(0\)/);
  assert.match(gate, /SViewport/);
});

test("the editor restores the preview it borrowed", () => {
  const reset = rotation.slice(
    rotation.indexOf("void FAIFactoryBuildGunRotation::Reset("),
    rotation.indexOf("void FAIFactoryBuildGunRotation::Shutdown("),
  );
  assert.match(reset, /ApplyNativeRotation\(Target, NativeRotation\)/);
  assert.match(reset, /bOwnsPositionLock && Target->IsHologramLocked\(\)/);
  assert.match(reset, /LockHologramPosition\(false\)/);
  // Only a lock this editor took is given back.
  assert.match(rotation, /bOwnsPositionLock = !Target->IsHologramLocked\(\)/);
});

test("hints go into the game's own bar and only ever remove their own rows", () => {
  assert.match(hints, /UFGButtonHintBar/);
  assert.match(hints, /InsertButtonHint\(/);
  assert.match(hints, /RemoveButtonHintAtIndex\(/);
  assert.match(hints, /OwnedHintTexts\.Contains\(Text\)/, "removal is scoped to our own hints");
  assert.match(hints, /mHintBarIsAlwaysHidden/);
  assert.match(hints, /IsInViewport\(\) && Candidate->IsVisible\(\)/);
  // Re-asserted each frame because the bar rebuilds from focus changes, but
  // only when something actually changed.
  assert.match(hints, /Signature == LastSignature && bStillPresent/);
  assert.match(hints, /EKeys::F5/);
  assert.match(hints, /EKeys::PageUp/);
  assert.match(hints, /EKeys::MouseScrollUp/);
});

test("the subsystem drives rotation from the input and tick paths it already owns", () => {
  assert.match(header, /bool HandleBuildGunRotationKey\(const FKeyEvent& KeyEvent\)/);
  assert.match(header, /bool HandleBuildGunRotationWheel\(const FPointerEvent& WheelEvent\)/);
  assert.match(header, /TSharedPtr<FAIFactoryBuildGunRotation> BuildGunRotation/);

  assert.match(ui, /HandleMouseWheelOrGestureEvent\(/);
  assert.match(ui, /BuildGunRotation->BeforeWorldTick\(/);
  assert.match(ui, /BuildGunRotation->AfterWorldTick\(/);
  assert.match(ui, /BuildGunRotation->Shutdown\(\)/);

  // Rotation is independent of the precision frame, so it must run before the
  // bPrecisionFrameEnabled early return in both tick handlers.
  for (const handler of ["HandlePrecisionWorldPreActorTick", "HandlePrecisionWorldPostActorTick"]) {
    const body = ui.slice(ui.indexOf(`void UAIFactoryCopilotUISubsystem::${handler}(`));
    const rotationAt = body.indexOf("BuildGunRotation->");
    const guardAt = body.indexOf("if (!bPrecisionFrameEnabled)");
    assert.ok(rotationAt > 0 && guardAt > rotationAt, `${handler} runs rotation before the guard`);
  }
});

test("the hint struct's module dependency is declared", () => {
  // FGButtonHintBar.h pulls InputAction.h for FFGButtonHintDescription.
  assert.match(buildCs, /"EnhancedInput"/);
  assert.match(buildCs, /"UMG"/);
});
