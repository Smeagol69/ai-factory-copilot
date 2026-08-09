import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("bundled HTTP clients send the bridge schema-version header", () => {
  const benchmark = fs.readFileSync(
    new URL("../../scripts/benchmark-provider.mjs", import.meta.url),
    "utf8",
  );
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  assert.match(benchmark, /"X-AIFactory-Schema":\s*"1"/);
  assert.match(readme, /-Headers @\{ 'X-AIFactory-Schema' = '1' \}/);
});

test("the game refuses stale or oversized action plans whole", () => {
  const subsystem = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(subsystem, /SupportedActionContractVersion\s*=\s*1/);
  assert.match(subsystem, /unsupported action contract/);
  assert.match(subsystem, /bridge\/mod version mismatch/);
  assert.match(subsystem, /action plan contains %d steps/);
  assert.match(subsystem, /game_actions_refused/);
  assert.match(subsystem, /ContainsByPredicate\(IsRefusedActionResult\)/);
  assert.match(subsystem, /FirstActionRefusalReason\(ActionResults\)/);
  assert.match(subsystem, /TEXT\("game_actions_refused"\),\s*bActionsRefused/);
  assert.doesNotMatch(subsystem, /Requested\.SetNum\(/);
});

test("the game defers step-referenced building and belt preflight until actors exist", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /bDeferredStepReferences/);
  assert.match(actions, /\{ TEXT\("target_step"\), TEXT\("target_actor_id"\) \}/);
  assert.match(actions, /target_step_must_refer_to_a_building_placement/);
  assert.match(actions, /must_refer_to_an_earlier_step/);
  assert.match(actions, /must_refer_to_an_actor_creating_step/);
  assert.match(actions, /preflight_deferred_until_step_references_resolve/);
  assert.match(
    actions,
    /ResolveActionStepReferences\(Item\.Spec, OutResults\);[\s\S]*RunActionSpec\(Context, Item\.Spec\)/,
  );

  const deferred = actions.indexOf("if (Item.bDeferredStepReferences)");
  const ordinaryPreflight = actions.indexOf("Item.Preflight = RunActionSpec(Context, Item.Spec)");
  assert.ok(deferred >= 0 && deferred < ordinaryPreflight);
});

test("a missing placement target is refused before a hologram is spawned", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const targetLookup = actions.indexOf("PlacementTarget = FindActionActorByPathName");
  const hologramSpawn = actions.indexOf("AFGHologram* Hologram = AFGHologram::SpawnHologramFromRecipe");
  assert.ok(targetLookup >= 0 && targetLookup < hologramSpawn);
});

test("server holograms clear the initialization sentinel before validation", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /hologram_disqualifiers_reset_before_validation/);
  assert.match(
    actions,
    /Hologram->ResetConstructDisqualifiers\(\);\s*Hologram->ValidatePlacementAndCost\(Inventory\)/,
  );
  assert.match(
    actions,
    /Belt->ResetConstructDisqualifiers\(\);\s*Belt->ValidatePlacementAndCost/,
  );
  assert.doesNotMatch(actions, /Hologram->Tick\(/);

  const reset = actions.indexOf("Hologram->ResetConstructDisqualifiers()");
  const firstValidation = actions.indexOf("Hologram->ValidatePlacementAndCost(Inventory)", reset);
  const constructCheck = actions.indexOf("if (!Hologram->CanConstruct())", firstValidation);
  assert.ok(
    reset >= 0 && reset < firstValidation && firstValidation < constructCheck,
  );
});

test("a successful conveyor snap is not erased by a second placement update", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    actions,
    /const bool bSnappedSource = Belt->TrySnapToActor\(FromHit\);\s*if \(!bSnappedSource\)\s*\{\s*Belt->UpdateHologramPlacement\(FromHit\);\s*\}/,
  );
  assert.match(
    actions,
    /const bool bSnappedDestination = Belt->TrySnapToActor\(ToHit\);\s*if \(!bSnappedDestination\)\s*\{\s*Belt->UpdateHologramPlacement\(ToHit\);\s*\}/,
  );
  assert.doesNotMatch(
    actions,
    /TrySnapToActor\(FromHit\);\s*Belt->UpdateHologramPlacement\(FromHit\)/,
  );
  assert.doesNotMatch(
    actions,
    /TrySnapToActor\(ToHit\);\s*Belt->UpdateHologramPlacement\(ToHit\)/,
  );
});

test("conveyor snap gates name the exact expected endpoint buildables", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /Belt->GetAnyConnectedBuildables\(\)/);
  assert.match(
    actions,
    /IsValid\(FromBuildable\) && SourceSnappedBuildables\.Contains\(FromBuildable\)/,
  );
  assert.match(
    actions,
    /IsValid\(ToBuildable\) && DestinationSnappedBuildables\.Contains\(ToBuildable\)/,
  );
  const sourceGate = actions.indexOf("if (!bExpectedSourceBuildableSnapped)");
  const firstAdvance = actions.indexOf("Belt->DoMultiStepPlacement(false)", sourceGate);
  const destinationGate = actions.indexOf("if (!bExpectedDestinationBuildableSnapped)");
  const validate = actions.indexOf("Belt->ValidatePlacementAndCost", destinationGate);
  assert.ok(sourceGate >= 0 && sourceGate < firstAdvance);
  assert.ok(destinationGate >= 0 && destinationGate < validate);
});

test("new manufacturers receive only a compatible unlocked recipe with empty inventories", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /production_recipe_is_not_unlocked/);
  assert.match(actions, /UFGRecipe::IsProducedIn\(ProductionRecipeClass, BuildableClass\)/);
  assert.match(actions, /Input->IsEmpty\(\) && Output->IsEmpty\(\)/);
  assert.match(actions, /Manufacturer->GetAvailableRecipes\(AvailableRecipes\)/);
  assert.match(actions, /Manufacturer->SetRecipe\(ProductionRecipeClass\)/);
  assert.match(actions, /Manufacturer->GetCurrentRecipe\(\) != ProductionRecipeClass/);

  const setRecipe = actions.indexOf("Manufacturer->SetRecipe(ProductionRecipeClass)");
  const charge = actions.indexOf("ChargeActionCost(Cost, Inventory)", setRecipe);
  assert.ok(setRecipe >= 0 && setRecipe < charge, "recipe readback must precede charging the build cost");
});

test("lightweight foundations are detected exactly, materialized for dependent steps, and journalled", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const actionTypes = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Public/AIFactoryActions.h",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /GetAllLightweightBuildableInstances\(\)/);
  assert.match(actions, /GetRuntimeDataForBuildableClassAndIndex/);
  assert.match(actions, /Data->BuiltWithRecipe != Ref\.BuiltWithRecipe/);
  assert.match(actions, /SpawnTemporaryBuildable\(\)/);
  assert.match(actions, /DismantleLightweightWithRefund/);
  assert.match(actions, /Step\.LightweightBuildables/);
  assert.match(actionTypes, /struct FAIFactoryLightweightUndoRef/);
  assert.match(actionTypes, /TArray<FAIFactoryLightweightUndoRef> LightweightBuildables/);

  const before = actions.indexOf("LightweightIndicesBefore");
  const construct = actions.indexOf("Hologram->Construct", before);
  const after = actions.indexOf("NewLightweightMatches", construct);
  assert.ok(
    before >= 0 && before < construct && construct < after,
    "the exact lightweight index set must be captured before construction and diffed afterward",
  );
});

test("extractors report the current extractable interface, not deprecated node state", () => {
  const snapshot = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(snapshot, /Extractor->GetExtractableResource\(\)/);
  assert.match(snapshot, /Extractor->GetExtractorTypeName\(\)/);
  assert.match(snapshot, /ExtractableInterface->GetResourceClass\(\)/);
  assert.doesNotMatch(snapshot, /Extractor->GetResourceNode\(\)/);
});
