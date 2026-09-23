import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Normalised: Git checks C++ out as CRLF on Windows, and a multi-line literal
// searched with \n newlines can never match such a checkout. That bit this
// suite once already.
const exporter = fs
  .readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp", import.meta.url),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

test("a capture is serialised against its own origin, not the designer's", () => {
  // The bug this pins: SaveBlueprint has no origin parameter and uses the
  // designer's GetOffsetTransform, so buildings adopted where they already
  // stand were recorded at their true world offset from a designer that could
  // be a kilometre away. Decoded captures measured 140-649 m from pivot against
  // 6-14 m for vanilla-saved files.
  assert.match(
    exporter,
    /ComputeCaptureFrame\(\s*\n?\s*Members, Designer->GetBlueprintDimensions\(\), CaptureOrigin, CaptureDimensions\)/,
  );
  assert.match(
    exporter,
    /WriteSubsystem->WriteBlueprintToArchive\(\s*\n?\s*Record, CaptureOrigin, Members, ExpectedCaptureDimensions\);/,
  );
  assert.match(exporter, /WriteSubsystem->WriteBlueprintToDisk\(Record\);/);
});

test("the origin is grid-snapped in XY and sits on the selection's own floor", () => {
  // A grid-aligned build must stay grid-aligned once re-expressed, or every
  // piece lands on a fractional offset and stops snapping.
  assert.match(exporter, /constexpr double AIFactoryGridCellCm = 800\.0;/);
  assert.match(
    exporter,
    /FMath::RoundToDouble\(Centre\.X \/ AIFactoryGridCellCm\) \* AIFactoryGridCellCm/,
  );
  assert.match(
    exporter,
    /FMath::RoundToDouble\(Centre\.Y \/ AIFactoryGridCellCm\) \* AIFactoryGridCellCm/,
  );
  // Z is the floor of the selection, so the blueprint sits on its own base.
  assert.match(exporter, /Bounds\.Min\.Z\);/);
  // Identity rotation: rotating the frame would turn the entire capture.
  assert.match(exporter, /FTransform\(FQuat::Identity, Snapped, FVector::OneVector\)/);
});

test("the designer is never moved to achieve the recentring", () => {
  // AFGBuildable's root component is created with EComponentMobility::Static,
  // and USceneComponent::MoveComponentImpl refuses a registered static
  // component outright - silently, because the warning is compiled out of
  // Shipping. Moving the designer would have looked correct and done nothing.
  // Anchored on the receiver so this cannot be satisfied by a comment.
  assert.doesNotMatch(exporter, /Designer->SetActorTransform\(/);
  assert.doesNotMatch(exporter, /Designer->SetActorLocation\(/);
  assert.doesNotMatch(exporter, /Designer->SetActorLocationAndRotation\(/);
  assert.doesNotMatch(exporter, /Designer->GetRootComponent\(\)->SetMobility\(/);
});

test("a degenerate selection refuses the new frame rather than writing NaN", () => {
  // Invalid origins cannot fall back to writing invalid transforms.
  assert.match(exporter, /if \(Location\.ContainsNaN\(\)\)/);
  assert.match(exporter, /if \(!Bounds\.IsValid \|\| Bounds\.Min\.ContainsNaN\(\)/);
  assert.match(exporter, /if \(Snapped\.ContainsNaN\(\)\)/);
  assert.match(exporter, /capture_selection_has_invalid_origins/);
});

test("capture dimensions use complete native bounds and verify archive and disk results", () => {
  const helper = exporter.slice(exporter.indexOf("bool ComputeCaptureDimensions("), exporter.indexOf("class FScopedGeneratedBuildables"));
  assert.match(helper, /ResolveGeneratedNativeBounds\(Member, MemberBounds, Source\)/);
  assert.match(helper, /Bounds \+= MemberBounds/);
  assert.match(helper, /Bounds \+= Member->GetActorLocation\(\)/);
  assert.match(helper, /Origin\.Z = Bounds\.Min\.Z/);
  assert.match(helper, /AIFactoryCaptureGeometry::ComputeDimensions/);
  assert.match(exporter, /native_capture_archive_dimensions_mismatch/);
  assert.match(exporter, /const bool bWrittenToDisk = WriteSubsystem->WriteBlueprintToDisk\(Record\)/);
  assert.match(exporter, /if \(!bWrittenToDisk\)[\s\S]*?native_capture_write_to_disk_failed/);
  assert.match(exporter, /ReadHeader->Dimensions == ExpectedCaptureDimensions/);
  assert.match(exporter, /native_capture_disk_dimensions_mismatch/);
  assert.match(exporter, /designer_dimensions_fallback_selection_extent_unknown/);
  assert.match(exporter, /capture_dimensions_unknown_reason/);
});

test("the designer-relative path survives as an explicit fallback", () => {
  // Never erase progress: if the subsystem is unavailable the capture still
  // produces a file. A blueprint saved in the wrong frame beats no blueprint,
  // and the result says which frame was used so it is never a silent downgrade.
  assert.match(exporter, /Designer->SaveBlueprint\(Record, Controller\);/);
  assert.match(exporter, /const bool bRecentred =/);
  assert.match(
    exporter,
    /Predicted->SetBoolField\(TEXT\("recentred_on_selection"\), bRecentred\);/,
  );
  assert.match(exporter, /Predicted->SetObjectField\(TEXT\("blueprint_origin_cm"\), OriginJson\);/);
});

test("the readback that proves the file exists is unchanged", () => {
  // The fix must not weaken the existing fail-closed gate: a capture is only
  // committed when the subsystem can read the archive back off disk.
  assert.match(exporter, /Subsystem->ReadBlueprintFromDisc\(BlueprintName\)/);
  assert.match(exporter, /save_ran_but_no_archive_could_be_read_back/);
});

test("a capture declares a box that actually contains it", () => {
  // Measured across a real library: all 49 blueprints saved by the game's own
  // Designer fit the dimensions they declare, without exception. Six of this
  // mod's captures did not - one held 80 x 160 m of content in a 48 x 48 m box -
  // because dimensions were copied from whichever designer stood in the world.
  assert.match(exporter, /FIntVector& OutDimensions/);
  assert.match(exporter, /CellsFor\(Size\.X\)/);
  assert.match(exporter, /CellsFor\(Size\.Y\)/);
  assert.match(exporter, /CellsFor\(Size\.Z\)/);
  // One spare cell per axis, because bounds come from actor origins and a piece
  // at the edge extends past its own origin.
  assert.match(exporter, /\(Extent \+ AIFactoryGridCellCm\) \/ AIFactoryGridCellCm/);
  // The designer's dimensions are the floor, never the ceiling: a small capture
  // declares exactly what it declared before, only an oversized one grows.
  assert.match(exporter, /FMath::Max\(DesignerDimensions\.X, CellsFor\(Size\.X\)\)/);
  assert.match(exporter, /Predicted->SetObjectField\(TEXT\("declared_dimensions_cells"\), DimensionJson\);/);
});
