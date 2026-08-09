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

  // Both endpoints go through the one helper, so the rule is stated once.
  assert.match(actions, /SnapBeltEndpointWithAim\(Belt, FromHit\)/);
  assert.match(actions, /SnapBeltEndpointWithAim\(Belt, ToHit\)/);

  // The original invariant, kept and widened: a successful snap must never be
  // followed by a placement update, which erases the connection it recorded.
  // The belt path now calls UpdateHologramPlacement nowhere at all, so assert
  // that outright rather than only forbidding the adjacent pair.
  const beltStart = actions.indexOf("FAIFactoryActionResult PlaceBelt(");
  const beltEnd = actions.indexOf("FAIFactoryActionResult DismantleActor(", beltStart);
  const belt = actions.slice(beltStart, beltEnd);
  assert.ok(beltStart >= 0 && beltEnd > beltStart);
  // The call, not the word: the comments above the helper explain why this
  // call is absent, and a bare word match would fail on its own explanation.
  assert.doesNotMatch(belt, /->UpdateHologramPlacement\(/);

  // And the reason the helper exists: snapping outside the placement envelope
  // left the hologram with a connection and no aim, which the game refuses as
  // FGCDInvalidAimLocation. Pre and Post must bracket the snap.
  const helper = actions.slice(
    actions.indexOf("bool SnapBeltEndpointWithAim("),
    actions.indexOf("FHitResult MakeActionConnectionHit("),
  );
  const pre = helper.indexOf("PreHologramPlacement");
  const snap = helper.indexOf("TrySnapToActor");
  const fallback = helper.indexOf("SetHologramLocationAndRotation");
  const post = helper.indexOf("PostHologramPlacement");
  assert.ok(pre >= 0 && snap > pre, "the snap must run after PreHologramPlacement");
  assert.ok(fallback > snap, "the fallback belongs to a declined snap");
  assert.ok(post > fallback, "PostHologramPlacement must close the envelope");
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
  const destinationSnap = actions.indexOf("SnapBeltEndpointWithAim(Belt, ToHit)");
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
