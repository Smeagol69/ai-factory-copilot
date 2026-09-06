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

test("precision frame is anchored to a real buildable and uses yaw-local coordinates", () => {
  assert.match(header, /TWeakObjectPtr<AFGBuildable> PrecisionFrameAnchor/);
  assert.match(header, /FVector PrecisionLocalOffsetCm/);
  assert.match(header, /float PrecisionYawOffsetDegrees/);

  const target = slice(
    "bool UAIFactoryCopilotUISubsystem::GetPrecisionTarget(",
    "FString UAIFactoryCopilotUISubsystem::GetPrecisionFrameStatus() const",
  );
  assert.match(target, /Anchor->GetActorRotation\(\)\.Yaw/);
  assert.match(target, /FRotator YawFrame\(0\.0f, AnchorYaw, 0\.0f\)/);
  assert.match(target, /YawFrame\.RotateVector\(PrecisionLocalOffsetCm\)/);
  assert.match(target, /Anchor->GetActorLocation\(\)/);
  assert.match(target, /NormalizeAxis\(AnchorYaw \+ PrecisionYawOffsetDegrees\)/);
  assert.doesNotMatch(target, /GetActorScale|GetActorTransform\(\)\.TransformPosition/);
});

test("selecting an origin is inert until the owner explicitly enables snapping", () => {
  const select = slice(
    "void UAIFactoryCopilotUISubsystem::SetPrecisionFrameFromAim()",
    "void UAIFactoryCopilotUISubsystem::ReleasePrecisionHologram()",
  );
  assert.match(select, /Cast<AFGBuildable>\(GetAimedActor\(true\)\)/);
  assert.match(select, /PrecisionFrameAnchor = Buildable/);
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

test("precision rotation runs before the native hologram tick and nudge runs after", () => {
  const before = moduleSource.indexOf("mPrecisionFrameBeforeBuildTickHook = SUBSCRIBE_METHOD(");
  const after = moduleSource.indexOf("mPrecisionFrameAfterBuildTickHook = SUBSCRIBE_METHOD_AFTER(");
  assert.ok(before >= 0 && after > before);
  assert.match(moduleSource, /ApplyPrecisionFrameToBuildState\(BuildState, true\)/);
  assert.match(moduleSource, /ApplyPrecisionFrameToBuildState\(BuildState, false\)/);
  assert.match(moduleSource, /UNSUBSCRIBE_METHOD\([\s\S]*TickState_Implementation/);
});

test("releasing precision restores the native movable hologram", () => {
  const release = slice(
    "void UAIFactoryCopilotUISubsystem::ReleasePrecisionHologram()",
    "void UAIFactoryCopilotUISubsystem::SetPrecisionFrameEnabled(",
  );
  assert.match(release, /SetNudgeOffset\(FVector::ZeroVector\)/);
  assert.match(release, /LockHologramPosition\(false\)/);
  assert.match(release, /PrecisionHologram\.Reset\(\)/);
});
