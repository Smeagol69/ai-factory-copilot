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
  assert.match(section, /Re-snap/);
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
  // The offset is seeded onto whatever the game nominates as the nudge target,
  // because a compound hologram nudges a child rather than its root.
  assert.match(apply, /GetNudgeHologramTarget\(\)/);
  assert.match(
    apply,
    /SetNudgeOffset\(TargetLocation - PlacementTarget->GetHologramLockLocation\(\)\)/,
  );
  assert.match(apply, /ValidatePlacementAndCost\(BuildGun->GetInventory\(\)\)/);
  assert.doesNotMatch(apply, /SetActorLocation|SetActorRotation|SetActorTransform/);
  assert.doesNotMatch(
    apply,
    /(?:PrimaryFire|Server_ConstructHologram|InternalConstructHologram|Construct)\s*\(/,
  );
});

test("precision rotation runs before the native hologram tick and nudge runs after", () => {
  // TickState_Implementation is `virtual ... override`. SML cannot resolve a
  // virtual's implementation from a member-function pointer alone, so the
  // non-virtual macros assert "Attempt to hook virtual function override
  // without providing object instance" and take the game down at startup. The
  // virtual variants plus a sample instance are mandatory here, not stylistic.
  const before = moduleSource.indexOf(
    "mPrecisionFrameBeforeBuildTickHook = SUBSCRIBE_METHOD_VIRTUAL(",
  );
  const after = moduleSource.indexOf(
    "mPrecisionFrameAfterBuildTickHook = SUBSCRIBE_METHOD_VIRTUAL_AFTER(",
  );
  assert.ok(before >= 0 && after > before);
  assert.doesNotMatch(
    moduleSource,
    /(?:mPrecisionFrameBeforeBuildTickHook|mPrecisionFrameAfterBuildTickHook) = SUBSCRIBE_METHOD(?:_AFTER)?\(/,
    "the non-virtual macros crash on this virtual override",
  );
  // Both registrations must hand SML something to read the vtable from.
  const sampleInstances = moduleSource.match(
    /GetMutableDefault<UFGBuildGunStateBuild>\(\)/g,
  );
  assert.equal(sampleInstances?.length, 2, "both hooks pass a sample object instance");
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

test("position is seeded once so the native arrow keys keep their nudge", () => {
  const apply = slice(
    "void UAIFactoryCopilotUISubsystem::ApplyPrecisionFrameToBuildState(",
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildPrecisionFrameSection()",
  );

  // FactoryGame's own arrow-key path accumulates through AddNudgeOffset, while
  // SetNudgeOffset replaces. Writing the offset on every post-tick therefore
  // overwrote the player's input one frame after each key press. Position must
  // be seeded behind a generation guard, exactly as rotation already is.
  assert.match(apply, /PrecisionPositionGeneration == PrecisionFrameGeneration/);
  assert.match(apply, /PrecisionPositionGeneration = PrecisionFrameGeneration;/);

  // The guard has to short-circuit before the offset is written, or it is not a
  // guard at all.
  const guardAt = apply.indexOf("PrecisionPositionGeneration == PrecisionFrameGeneration");
  const seedAt = apply.indexOf("SetNudgeOffset(TargetLocation");
  assert.ok(guardAt > 0 && seedAt > guardAt, "the seed must sit behind the generation check");

  // The mod must never reach for the accumulating native input path itself;
  // that belongs to the player.
  // Lookbehind so the capability probe CanNudgeHologram() and the accessor
  // GetNudgeHologramTarget() are not mistaken for the input path itself.
  assert.doesNotMatch(
    apply,
    /(?<![A-Za-z])(?:AddNudgeOffset|NudgeHologram|NudgeTowardsWorldDirection)\(/,
  );
});

test("a fresh or released hologram re-seeds instead of staying stale", () => {
  // Every place that resets the rotation generation must reset position too,
  // or a new hologram would skip its seed and sit wherever the mouse points.
  const rotationResets = ui.match(/PrecisionRotationGeneration = 0;/g) ?? [];
  const positionResets = ui.match(/PrecisionPositionGeneration = 0;/g) ?? [];
  assert.ok(rotationResets.length >= 3, "rotation generation is reset on the known paths");
  assert.equal(
    positionResets.length,
    rotationResets.length,
    "position generation resets wherever rotation generation does",
  );
});
