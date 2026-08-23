import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const exporter = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp", import.meta.url),
  "utf8",
);
const exporterHeader = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryBlueprintExport.h", import.meta.url),
  "utf8",
);
const selector = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp", import.meta.url),
  "utf8",
);
const selectorHeader = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryCopilotUISubsystem.h", import.meta.url),
  "utf8",
);

test("native export keeps a stable lightweight identity rather than a mutable array slot", () => {
  assert.match(exporterHeader, /TArray<FLightweightBuildableInstanceRef>\s*&?\s*LightweightInstances/);
  assert.match(selectorHeader, /TArray<FLightweightBuildableInstanceRef>\s+SelectionLightweight/);
  assert.match(selector, /Ref\.Initialize\(Lightweight, Pair\.Key, Index\)/);
  assert.match(selector, /SelectionLightweight\.Add\(MoveTemp\(Ref\)\)/);
  assert.match(exporter, /Instance\.ResolveBuildableInstanceData\(\)/);
  assert.doesNotMatch(exporter, /GetAllLightweightBuildableInstances\(\)/);
});

test("a lightweight-only native selection is allowed, but stale or partial selections fail before saving", () => {
  assert.match(
    exporter,
    /if \(Buildables\.Num\(\) == 0 && LightweightInstances\.Num\(\) == 0\)/,
  );
  const staleRefusal = exporter.indexOf("selected_lightweight_instance_changed_repreview_required");
  const save = exporter.indexOf("Designer->SaveBlueprint");
  assert.ok(staleRefusal >= 0 && staleRefusal < save);
  assert.match(exporter, /Materialised\.NumMissing\(\) > 0/);
  assert.match(exporter, /Skipped > 0 \|\| Membership\.Num\(\) != ExpectedAdopted/);
});

test("selection clear and preview reset lightweight state so invisible structure cannot leak into an export", () => {
  const refresh = selector.slice(
    selector.indexOf("void UAIFactoryCopilotUISubsystem::RefreshSelectionPreview()"),
    selector.indexOf("void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()"),
  );
  assert.match(refresh, /SelectionLightweight\.Reset\(\);\s*LightweightCount = 0;/);
  assert.match(refresh, /if \(!Instance\.IsValid\(\)\)/);

  const clear = selector.slice(
    selector.indexOf("void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()"),
    selector.indexOf("void UAIFactoryCopilotUISubsystem::ExportSelectionAsBlueprint()"),
  );
  assert.match(clear, /SelectionLightweight\.Reset\(\);\s*LightweightCount = 0;/);
  assert.match(clear, /SelectionRecipeCounts\.Reset\(\)/);
  assert.match(clear, /RefreshSelectionCost\(\)/);
});

test("lightweight demolition removes the stable selected references directly", () => {
  const demolition = selector.slice(
    selector.indexOf("void UAIFactoryCopilotUISubsystem::DemolishSelection()"),
    selector.indexOf("void UAIFactoryCopilotUISubsystem::BeginStagedExport("),
  );
  assert.match(demolition, /for \(FLightweightBuildableInstanceRef& Ref : SelectionLightweight\)/);
  assert.match(demolition, /Ref\.IsValid\(\) && Ref\.Remove\(\)/);
  assert.doesNotMatch(demolition, /SelectionLightweight\.Sort/);
});
