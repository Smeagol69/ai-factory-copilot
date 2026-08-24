import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const uiHeader = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryCopilotUISubsystem.h", import.meta.url),
  "utf8",
);
const ui = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp", import.meta.url),
  "utf8",
);

test("the native Blueprint UI can select exactly the aimed buildable", () => {
  assert.match(uiHeader, /AActor\* GetAimedActor\(bool bRequireBuildable = false\) const/);
  assert.match(uiHeader, /void SelectAimedBuildable\(\)/);
  assert.match(ui, /TEXT\("Select aimed"\)/);

  const select = ui.slice(
    ui.indexOf("void UAIFactoryCopilotUISubsystem::SelectAimedBuildable()"),
    ui.indexOf("void UAIFactoryCopilotUISubsystem::ExportSelectionAsBlueprint()"),
  );
  assert.match(select, /Cast<AFGBuildable>\(GetAimedActor\(true\)\)/);
  assert.match(select, /SelectionActorIds\.Add\(Buildable->GetPathName\(\)\)/);
  assert.match(select, /ClearSelectionPreview\(\)/);
  assert.match(select, /RefreshSelectionCost\(\)/);
  assert.match(select, /AIFactoryOverlay::DrawSelection\(/);
  assert.match(select, /ExactEntries/);
  assert.doesNotMatch(select, /Query\.MaxResults/);
  assert.doesNotMatch(select, /RefreshSelectionPreview\(\)/);
});

test("aimed selection follows the authoritative usable hit before a visibility fallback", () => {
  const aim = ui.slice(
    ui.indexOf("AActor* UAIFactoryCopilotUISubsystem::GetAimedActor(const bool bRequireBuildable) const"),
    ui.indexOf("void UAIFactoryCopilotUISubsystem::UpdateLiveStatus()"),
  );
  const usableHit = aim.indexOf("UseState->UseHitResult.GetActor()");
  const buildableOnlyFallback = aim.indexOf("bRequireBuildable && !IsValid(Cast<AFGBuildable>(FocusActor))");
  const fallbackTrace = aim.indexOf("LineTraceSingleByChannel");
  assert.ok(
    usableHit >= 0 &&
      buildableOnlyFallback > usableHit &&
      fallbackTrace > buildableOnlyFallback,
  );
});

test("aimed selection stays fail-closed around the serializer and visible filters", () => {
  const select = ui.slice(
    ui.indexOf("void UAIFactoryCopilotUISubsystem::SelectAimedBuildable()"),
    ui.indexOf("void UAIFactoryCopilotUISubsystem::ExportSelectionAsBlueprint()"),
  );
  assert.match(select, /BlueprintDesigner/);
  assert.match(select, /IsBuildableInsideBlueprintDesigner\(\)/);
  assert.match(select, /!SelectionCategoryEnabled\[Category\]/);
  assert.match(select, /ClearSelectionPreview\(\)/);
  assert.match(select, /move a slider to start a new box selection/);
});

test("an exact selection cannot retain lightweight pieces from an earlier box", () => {
  const clear = ui.slice(
    ui.indexOf("void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()"),
    ui.indexOf("void UAIFactoryCopilotUISubsystem::SelectAimedBuildable()"),
  );
  assert.match(clear, /SelectionLightweight\.Reset\(\)/);
  assert.match(clear, /LightweightCount = 0/);
  assert.match(clear, /SelectionRecipeCounts\.Reset\(\)/);
});
