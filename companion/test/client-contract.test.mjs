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

test("conveyor endpoint hits run one complete engine placement frame", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const beltStart = actions.indexOf("FAIFactoryActionResult PlaceBelt(");
  const beltEnd = actions.indexOf("FAIFactoryActionResult DismantleActor(", beltStart);
  const belt = actions.slice(beltStart, beltEnd);

  assert.ok(beltStart >= 0 && beltEnd > beltStart);
  assert.match(actions, /bool AIFactoryAllowConveyorEndpointOwners\(/);
  assert.match(
    actions,
    /FindFunction\(FunctionName\)/,
  );
  assert.match(
    actions,
    /Function->NumParms != 1[\s\S]*Function->ParmsSize != sizeof\(FAddValidHitClassParams\)/,
  );
  assert.match(
    actions,
    /Belt->ProcessEvent\(Function, &Params\)/,
  );
  const helper = actions.slice(
    actions.indexOf("bool AIFactoryAllowConveyorEndpointOwners("),
    actions.indexOf("UFGFactoryConnectionComponent* FindFreeActionConnection("),
  );
  const sourceClass = helper.indexOf("FAddValidHitClassParams Params{FromBuildable->GetClass()}");
  const firstProcessEvent = helper.indexOf("Belt->ProcessEvent(Function, &Params)");
  const destinationClass = helper.indexOf("Params.hitClass = ToBuildable->GetClass()");
  const secondProcessEvent = helper.indexOf(
    "Belt->ProcessEvent(Function, &Params)",
    firstProcessEvent + 1,
  );
  assert.ok(
    sourceClass >= 0 &&
      sourceClass < firstProcessEvent &&
      firstProcessEvent < destinationClass &&
      destinationClass < secondProcessEvent,
    "the reflected contract must admit the source class before the destination class",
  );
  assert.equal(
    helper.match(/Belt->ProcessEvent\(Function, &Params\)/g)?.length,
    2,
  );
  assert.match(
    belt,
    /AIFactoryAllowConveyorEndpointOwners\(Belt, FromBuildable, ToBuildable\)/,
  );
  assert.match(belt, /Belt->IsValidHitResult\(FromHit\)/);
  assert.match(belt, /Belt->IsValidHitResult\(ToHit\)/);
  assert.match(belt, /source_hologram_visible/);
  assert.match(belt, /destination_hologram_visible/);
  assert.equal(
    belt.match(/Belt->UpdateHologramPlacement\(FromHit\)/g)?.length,
    1,
  );
  assert.equal(
    belt.match(/Belt->UpdateHologramPlacement\(ToHit\)/g)?.length,
    1,
  );
  assert.doesNotMatch(belt, /Belt->TrySnapToActor\(/);
  assert.doesNotMatch(actions, /SnapBeltEndpointWithAim/);

  const sourceValid = belt.indexOf("Belt->IsValidHitResult(FromHit)");
  const sourceUpdate = belt.indexOf("Belt->UpdateHologramPlacement(FromHit)");
  const firstAdvance = belt.indexOf("Belt->DoMultiStepPlacement(false)");
  const destinationValid = belt.indexOf("Belt->IsValidHitResult(ToHit)");
  const destinationUpdate = belt.indexOf("Belt->UpdateHologramPlacement(ToHit)");
  const destinationReadback = belt.indexOf(
    "const TArray<AFGBuildable*> DestinationSnappedBuildables",
  );
  const validate = belt.indexOf("Belt->ValidatePlacementAndCost", destinationReadback);
  assert.ok(sourceValid >= 0 && sourceValid < sourceUpdate && sourceUpdate < firstAdvance);
  assert.ok(
    destinationValid >= 0 &&
      destinationValid < destinationUpdate &&
      destinationUpdate < destinationReadback &&
      destinationReadback < validate,
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
    /FromBuildable = Cast<AFGBuildable>\(From->GetOwner\(\)\)/,
  );
  assert.match(
    actions,
    /ToBuildable = Cast<AFGBuildable>\(To->GetOwner\(\)\)/,
  );
  assert.match(
    actions,
    /DestinationSnappedBuildables\.Contains\(FromBuildable\)/,
  );
  const firstAdvance = actions.indexOf("Belt->DoMultiStepPlacement(false)");
  const sourceReadback = actions.indexOf("const TArray<AFGBuildable*> SourceSnappedBuildables");
  const sourceGate = actions.indexOf("if (!bExpectedSourceBuildableSnapped)");
  const destinationSnap = actions.indexOf("Belt->UpdateHologramPlacement(ToHit)");
  const destinationGate = actions.indexOf(
    "if (!bExpectedSourceBuildableStillSnapped || !bExpectedDestinationBuildableSnapped)",
  );
  const validate = actions.indexOf("Belt->ValidatePlacementAndCost", destinationGate);
  assert.ok(firstAdvance >= 0 && firstAdvance < sourceReadback);
  assert.ok(sourceReadback < sourceGate && sourceGate < destinationSnap);
  assert.ok(destinationGate >= 0 && destinationGate < validate);
});

test("a conveyor is revalidated, charged, and accepted only after exact endpoint readback", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const beltStart = actions.indexOf("FAIFactoryActionResult PlaceBelt(");
  const beltEnd = actions.indexOf("FAIFactoryActionResult DismantleActor(", beltStart);
  const belt = actions.slice(beltStart, beltEnd);

  assert.match(belt, /AFGBuildableConveyorBase/);
  assert.match(belt, /ConstructedBelt->GetConnection0\(\)/);
  assert.match(belt, /ConstructedBelt->GetConnection1\(\)/);
  assert.match(
    belt,
    /IsExactPair\(Belt0, To\) && IsExactPair\(Belt1, From\)/,
  );
  assert.match(
    belt,
    /Left->GetConnection\(\) == Right &&\s*Right->GetConnection\(\) == Left/,
  );
  assert.match(belt, /constructed_belt_endpoints_did_not_match_requested_components/);
  assert.match(belt, /IFGDismantleInterface::Execute_Dismantle\(Buildable\)/);

  const finalStep = belt.indexOf("Belt->DoMultiStepPlacement(true)");
  const finalRevalidation = belt.indexOf("hologram_revalidated_after_final_build_step");
  const cost = belt.indexOf("NormalizeActionCost(Belt->GetCost(true))");
  const exactReadback = belt.indexOf("const bool bExactEndpoints");
  const exactGate = belt.indexOf("if (!bExactEndpoints)");
  const charge = belt.indexOf("ChargeActionCost(Cost, Inventory)");
  const journal = belt.indexOf("RecordActionUndo(MoveTemp(Step))");
  assert.ok(finalStep >= 0 && finalStep < finalRevalidation && finalRevalidation < cost);
  assert.ok(cost < exactReadback && exactReadback < exactGate);
  assert.ok(exactGate < charge && charge < journal);
});

test("the game rejects a locked belt recipe before spawning its hologram", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const beltStart = actions.indexOf("FAIFactoryActionResult PlaceBelt(");
  const beltEnd = actions.indexOf("FAIFactoryActionResult DismantleActor(", beltStart);
  const belt = actions.slice(beltStart, beltEnd);

  assert.match(belt, /AFGRecipeManager::Get\(Context\.World\)/);
  assert.match(belt, /RecipeManager->IsRecipeAvailable\(BeltRecipeClass\)/);
  assert.match(belt, /belt_recipe_is_not_unlocked/);
  const unlockGate = belt.indexOf("RecipeManager->IsRecipeAvailable(BeltRecipeClass)");
  const hologramSpawn = belt.indexOf("AFGHologram::SpawnHologramFromRecipe");
  assert.ok(unlockGate >= 0 && unlockGate < hologramSpawn);
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

test("an unconfigured manufacturer stays an unknown cycle rate instead of crashing the snapshot", () => {
  const snapshot = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  const recipe = snapshot.indexOf(
    "const TSubclassOf<UFGRecipe> Recipe =",
  );
  const validRecipeGuard = snapshot.indexOf(
    "const bool bProductionCycleKnown = !Manufacturer || IsValid(Recipe.Get());",
  );
  const cycleGuard = snapshot.indexOf("if (bProductionCycleKnown)");
  const cycle = snapshot.indexOf("Factory->GetProductionCycleTime()", cycleGuard);
  const defaultCycle = snapshot.indexOf("Factory->GetDefaultProductionCycleTime()", cycleGuard);
  const unknown = snapshot.indexOf("manufacturer_has_no_valid_current_recipe", cycleGuard);
  assert.ok(
    recipe >= 0 &&
      recipe < validRecipeGuard &&
      validRecipeGuard < cycleGuard &&
      cycleGuard < cycle &&
      cycle < defaultCycle &&
      unknown > defaultCycle,
    "cycle accessors must be guarded by the captured current-recipe validity",
  );
  assert.match(snapshot, /production_cycle_known/);
  assert.match(snapshot, /production_cycle_unavailable_reason/);
});

test("game action outcomes are append-only diagnostics after authoritative execution", () => {
  const subsystem = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(subsystem, /action-outcomes\.jsonl/);
  assert.match(subsystem, /EFileWrite::FILEWRITE_Append/);
  assert.match(subsystem, /OutcomeJson \+ TEXT\("\\n"\)/);
  for (const field of [
    "game_action_results",
    "game_action_summary",
    "game_actions_refused",
    "game_world_was_mutated",
    "game_actions_requested_count",
    "game_actions_executed_count",
    "game_world_revision_after",
  ]) {
    assert.match(subsystem, new RegExp(`Outcome->Set(?:Array|String|Bool|Number)Field\\(\\s*TEXT\\("${field}"\\)`));
  }

  const execute = subsystem.indexOf("AIFactoryActions::ExecutePlan(");
  const enrichedResults = subsystem.indexOf('ResponseJson->SetArrayField(TEXT("game_action_results")', execute);
  const appendGate = subsystem.indexOf("if (Actions->Num() > 0)", enrichedResults);
  const append = subsystem.indexOf("action-outcomes.jsonl", appendGate);
  assert.ok(
    execute >= 0 && enrichedResults > execute && appendGate > enrichedResults && append > appendGate,
    "outcomes must be appended only after the game has enriched the response",
  );
});
