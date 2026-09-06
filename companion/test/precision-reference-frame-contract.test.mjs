import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const header = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryCopilotUISubsystem.h", import.meta.url),
  "utf8",
);
const ui = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp", import.meta.url),
  "utf8",
);
const moduleSource = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryCopilotModule.cpp", import.meta.url),
  "utf8",
);

function slice(start, end) {
  const first = ui.indexOf(start);
  const last = ui.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${start} must precede ${end}`);
  return ui.slice(first, last);
}

test("precision frame resolves live actor or stable lightweight identity before using yaw-local coordinates", () => {
  assert.match(header, /TWeakObjectPtr<AFGBuildable> PrecisionFrameAnchor/);
  assert.match(header, /FVector PrecisionLocalOffsetCm/);
  assert.match(header, /float PrecisionYawOffsetDegrees/);

  const target = slice(
    "bool UAIFactoryCopilotUISubsystem::GetPrecisionTarget(",
    "FString UAIFactoryCopilotUISubsystem::GetPrecisionFrameStatus() const",
  );
  const resolve = slice(
    "bool UAIFactoryCopilotUISubsystem::GetPrecisionAnchorTransform(",
    "bool UAIFactoryCopilotUISubsystem::GetPrecisionTarget(",
  );
  assert.match(resolve, /ResolveBuildableInstanceData\(\)/);
  assert.match(resolve, /OutTransform = Instance->Transform/);
  assert.match(resolve, /Anchor->GetWorld\(\) != GetWorld\(\)/);
  assert.match(target, /GetPrecisionAnchorTransform\(AnchorTransform\)/);
  assert.match(target, /AnchorTransform.Rotator\(\)\.Yaw/);
  assert.match(target, /FRotator YawFrame\(0\.0f, AnchorYaw, 0\.0f\)/);
  assert.match(target, /YawFrame\.RotateVector\(PrecisionLocalOffsetCm\)/);
  assert.match(target, /AnchorTransform.GetLocation\(\)/);
  assert.match(target, /NormalizeAxis\(AnchorYaw \+ PrecisionYawOffsetDegrees\)/);
  assert.doesNotMatch(target, /GetActorScale|GetActorTransform\(\)\.TransformPosition/);
});

test("selecting an origin is inert until the owner explicitly enables snapping", () => {
  const select = slice(
    "void UAIFactoryCopilotUISubsystem::SetPrecisionFrameFromAim()",
    "void UAIFactoryCopilotUISubsystem::ReleasePrecisionHologram()",
  );
  assert.match(select, /Manager->ResolveHit\(Hit, Handle\)/);
  assert.match(select, /ResolveLightweightInstance\(Handle, SelectedInstance\)/);
  assert.match(select, /GetIsLightweightTemporary\(\)/);
  assert.match(select, /SelectedInstance.InitializeFromTemporary\(Buildable\)/);
  assert.match(select, /GetLightweightBuildableInstanceFromConvertedBuildableOrTemporary/);
  assert.match(select, /Gun->TraceForBuildingSample\(Character, SampleHit\)/);
  assert.match(select, /PrecisionFrameAnchor = SelectedActor/);
  assert.match(select, /PrecisionLightweightAnchor = SelectedInstance/);
  assert.match(select, /SetPrecisionFrameEnabled\(false\)/);
  assert.doesNotMatch(select, /SpawnTemporaryBuildable|FindOrSpawnBuildable|TActorIterator/);
  assert.doesNotMatch(select, /bPrecisionFrameEnabled = true/);
  assert.doesNotMatch(select, /SetNudgeOffset|LockHologramPosition|Construct\(/);

  const section = slice(
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildPrecisionFrameSection()",
    "/**\n * The selection section.",
  );
  assert.match(section, /Use aimed as origin/);
  assert.match(section, /Snap Build Gun/);
  assert.match(section, /Release Build Gun/);
  assert.match(section, /Mirror X/);
  assert.match(section, /Mirror Y/);
  assert.match(section, /RotatePrecisionFrame\(-90\.0f\)/);
  assert.match(section, /RotatePrecisionFrame\(90\.0f\)/);
});

test("the native Build Gun owns placement, validation, and construction", () => {
  const apply = slice(
    "void UAIFactoryCopilotUISubsystem::ApplyPrecisionFrameToBuildState(",
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildPrecisionFrameSection()",
  );
  assert.match(apply, /BuildState->GetHologram\(\)/);
  assert.match(apply, /GetConstructionInstigator\(\)/);
  assert.match(apply, /IsLocallyControlled\(\)/);
  assert.match(apply, /CanLockHologram\(\)/);
  assert.match(apply, /CanNudgeHologram\(\)/);
  assert.match(apply, /SetScrollRotateValue\(/);
  assert.match(apply, /LockHologramPosition\(true\)/);
  assert.match(apply, /SetNudgeOffset\(TargetLocation - Hologram->GetHologramLockLocation\(\)\)/);
  assert.match(apply, /ValidatePlacementAndCost\(BuildGun->GetInventory\(\)\)/);
  assert.doesNotMatch(apply, /SetActorLocation|SetActorRotation|SetActorTransform/);
  assert.doesNotMatch(
    apply,
    /(?:PrimaryFire|Server_ConstructHologram|InternalConstructHologram|Construct)\s*\(/,
  );
});

test("precision uses world tick delegates and never startup-hooks the virtual Build Gun override", () => {
  assert.doesNotMatch(moduleSource, /TickState_Implementation/);
  assert.doesNotMatch(moduleSource, /mPrecisionFrameBeforeBuildTickHook/);
  assert.doesNotMatch(moduleSource, /mPrecisionFrameAfterBuildTickHook/);

  const worldTick = slice(
    "UFGBuildGunStateBuild* UAIFactoryCopilotUISubsystem::GetPrecisionBuildStateForWorld(",
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildPrecisionFrameSection()",
  );
  assert.match(header, /FDelegateHandle PrecisionPreActorTickHandle/);
  assert.match(header, /FDelegateHandle PrecisionPostActorTickHandle/);
  assert.match(ui, /FWorldDelegates::OnWorldPreActorTick\.AddUObject/);
  assert.match(ui, /FWorldDelegates::OnWorldPostActorTick\.AddUObject/);
  assert.match(ui, /FWorldDelegates::OnWorldPreActorTick\.Remove/);
  assert.match(ui, /FWorldDelegates::OnWorldPostActorTick\.Remove/);
  assert.match(worldTick, /Controller->GetWorld\(\) != World/);
  assert.equal((worldTick.match(/World != GetWorld\(\)/g) ?? []).length, 2);
  assert.match(worldTick, /BuildGun->GetCurrentState\(\)/);
  assert.match(worldTick, /ApplyPrecisionFrameToBuildState\(BuildState, true\)/);
  assert.match(worldTick, /ApplyPrecisionFrameToBuildState\(BuildState, false\)/);
});

test("one-shot snapping releases on native success or hologram replacement without constructing anything", () => {
  const success = slice(
    "void UAIFactoryCopilotUISubsystem::OnPrecisionBuildableConstructed(",
    "void UAIFactoryCopilotUISubsystem::ReleasePrecisionHologram()",
  );
  assert.match(success, /bPrecisionFrameEnabled && bPrecisionHasBoundHologram/);
  assert.match(success, /bPrecisionReleasePending = true/);
  assert.doesNotMatch(success, /SetNudgeOffset|LockHologramPosition/);
  assert.match(ui, /BuildableConstructedDelegate.AddUniqueDynamic/);
  assert.match(ui, /BuildableConstructedDelegate.RemoveDynamic/);
  assert.match(ui, /Controller->GetPlayerState<AFGPlayerState>\(\)/);
  const apply = slice(
    "void UAIFactoryCopilotUISubsystem::ApplyPrecisionFrameToBuildState(",
    "UFGBuildGunStateBuild* UAIFactoryCopilotUISubsystem::GetPrecisionBuildStateForWorld(",
  );
  const replacementGuard = apply.indexOf("bPrecisionHasBoundHologram && PrecisionHologram.Get() != Hologram");
  assert.ok(replacementGuard >= 0 && replacementGuard < apply.indexOf("PrecisionHologram = Hologram"));
  assert.match(apply, /bPrecisionReleasePending\)[\s\S]*?SetPrecisionFrameEnabled\(false\)/);
  assert.match(apply.slice(replacementGuard), /SetPrecisionFrameEnabled\(false\);\s*return;/);
});

test("releasing precision restores the native movable hologram", () => {
  const release = slice(
    "void UAIFactoryCopilotUISubsystem::ReleasePrecisionHologram()",
    "void UAIFactoryCopilotUISubsystem::SetPrecisionFrameEnabled(",
  );
  assert.match(release, /SetNudgeOffset\(FVector::ZeroVector\)/);
  assert.match(release, /LockHologramPosition\(false\)/);
  assert.match(release, /PrecisionHologram\.Reset\(\)/);
  assert.match(release, /!Hologram->GetIsPendingToBeConstructed\(\)/);
});
