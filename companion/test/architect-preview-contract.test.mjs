import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const header = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryOverlay.h", import.meta.url),
  "utf8",
);
const overlay = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryOverlay.cpp", import.meta.url),
  "utf8",
);
const actions = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp", import.meta.url),
  "utf8",
);
const subsystem = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp", import.meta.url),
  "utf8",
);

test("Shipping overlay draws bounded oriented semantic volumes with floor rings", () => {
  assert.match(header, /struct FAIFactoryArchitectPreviewEntry/);
  assert.match(header, /FAIFactoryArchitectPreviewResult DrawArchitectPreview\(/);
  assert.match(overlay, /MaximumArchitectPreviewEntries = 256/);
  assert.match(overlay, /MaximumArchitectPreviewLines = 16384/);
  assert.match(overlay, /Rotation\.RotateVector\(LocalCorners\[Index\]\)/);
  assert.match(overlay, /FloorHeightCm/);
  assert.match(overlay, /AIFactoryArchitectColor\(Entry\.Kind\)/);
  assert.match(overlay, /Batcher->DrawLines\(Lines\)/);
  assert.doesNotMatch(overlay, /DrawDebug/);
});

test("game revalidates Architect schema, fingerprints, styles, kinds, and geometry", () => {
  const start = actions.indexOf('if (Kind == TEXT("architect_preview"))');
  const end = actions.indexOf("FAIFactoryOverlayQuery Query;", start);
  assert.ok(start >= 0 && end > start);
  const branch = actions.slice(start, end);

  assert.match(branch, /ai-architect\.preview\/v1/);
  assert.match(branch, /megabase\.design\/v1/);
  assert.match(branch, /IsAIFactoryExactSha256\(ManifestFingerprint\)/);
  assert.match(branch, /IsAIFactoryExactSha256\(FamilyFingerprint\)/);
  assert.match(branch, /IsAIFactoryExactSha256\(UnlockFingerprint\)/);
  assert.match(branch, /captured_world_revision/);
  assert.match(branch, /AllowedStyles/);
  assert.match(branch, /AllowedKinds/);
  assert.match(branch, /ElementValues->Num\(\) > 256/);
  assert.match(branch, /SeenIds\.Contains\(Entry\.Id\)/);
  assert.match(branch, /AIFactoryOverlay::DrawArchitectPreview\(/);
  assert.match(overlay, /draw_only_not_a_blueprint_hologram_or_placement_validation/);
});

test("Architect preview stays outside world writes and native Build Gun placement", () => {
  assert.match(actions, /Kind == TEXT\("highlight"\) \|\| Kind == TEXT\("architect_preview"\)/);
  assert.match(subsystem, /Action != TEXT\("architect_preview"\)/);
  const start = actions.indexOf('if (Kind == TEXT("architect_preview"))');
  const end = actions.indexOf("FAIFactoryOverlayQuery Query;", start);
  const branch = actions.slice(start, end);
  assert.doesNotMatch(branch, /Destroy\(|SpawnActor|Construct|Dismantle|SetDesiredBlueprint|GotoBuildState/);
});
