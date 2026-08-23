import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const overlay = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryOverlay.cpp", import.meta.url),
  "utf8",
);
const selector = fs.readFileSync(
  new URL(
    "../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp",
    import.meta.url,
  ),
  "utf8",
);

function functionSlice(source, start, next) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(next, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${start} must precede ${next}`);
  return source.slice(startIndex, endIndex);
}

test("the native Blueprint selection preview receives the exact actor and lightweight bounds it exports", () => {
  const refresh = functionSlice(
    selector,
    "void UAIFactoryCopilotUISubsystem::RefreshSelectionPreview()",
    "void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()",
  );

  assert.match(refresh, /TArray<FAIFactorySelectionOverlayEntry>\s+SelectionOverlayEntries/);
  assert.match(refresh, /ActorEntry\.Origin = VisualBounds\.GetCenter\(\)/);
  assert.match(refresh, /ActorEntry\.Extent = VisualBounds\.GetExtent\(\)/);
  assert.match(refresh, /LightweightEntry\.Origin = InstanceBounds\.GetCenter\(\)/);
  assert.match(refresh, /LightweightEntry\.Extent = InstanceBounds\.GetExtent\(\)/);
  assert.match(
    refresh,
    /AIFactoryOverlay::DrawSelection\(\s*World,\s*TEXT\("selection"\),\s*SelectionBox,\s*SelectionOverlayEntries,\s*Style\)/,
  );
  assert.doesNotMatch(refresh, /AIFactoryOverlay::Draw\(/);
  assert.doesNotMatch(refresh, /FAIFactoryOverlayQuery/);
  assert.match(refresh, /SelectionOverlay\.bCondensed/);
  assert.match(refresh, /orange selection volume shown/);
  assert.match(refresh, /orange outlines show every selected piece/);
});

test("selection overlay always draws its volume and explicitly accounts for every non-detailed outline", () => {
  const drawSelection = functionSlice(
    overlay,
    "FAIFactorySelectionOverlayResult DrawSelection(",
    "bool Clear(UWorld* World, const FString& OverlayName)",
  );

  assert.match(drawSelection, /Clear\(World, Result\.OverlayName\)/);
  assert.match(drawSelection, /AIFactoryAppendSelectionBoxLines\(\s*Lines,\s*SelectionVolume\.GetCenter\(\)/);
  assert.match(drawSelection, /Result\.CondensedCount = Result\.SelectedCount - Result\.DetailedCount/);
  assert.match(drawSelection, /Result\.bCondensed = Result\.CondensedCount > 0/);
  assert.match(drawSelection, /Batcher->DrawLines\(Lines\)/);
  assert.match(drawSelection, /selection_volume_drawn_individual_bounds_condensed/);
  assert.doesNotMatch(drawSelection, /MaximumOverlayResults|MaximumExplicitActorIds|DrawDebug/);

  const clear = functionSlice(
    selector,
    "void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()",
    "void UAIFactoryCopilotUISubsystem::SelectAimedBuildable()",
  );
  assert.match(clear, /AIFactoryOverlay::Clear\(World, TEXT\("selection"\)\)/);
});
