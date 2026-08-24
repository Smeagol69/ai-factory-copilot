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

test("a saved blueprint can be armed in the requesting player's native Build Gun", () => {
  const subsystem = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp", import.meta.url),
    "utf8",
  );
  const rcoHeader = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Public/AIFactoryBlueprintPreviewRCO.h", import.meta.url),
    "utf8",
  );
  const rco = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintPreviewRCO.cpp", import.meta.url),
    "utf8",
  );
  const gameInstanceModule = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryGameInstanceModule.cpp", import.meta.url),
    "utf8",
  );

  assert.match(rcoHeader, /UFUNCTION\(Client, Reliable\)\s*void ClientPreviewBlueprint/);
  assert.match(gameInstanceModule, /RemoteCallObjects\.Add\(UAIFactoryBlueprintPreviewRCO::StaticClass\(\)\)/);
  assert.match(rco, /GetOwnerPlayerCharacter\(\)/);
  assert.match(rco, /BuildGun->SetDesiredBlueprint\(BlueprintName\)/);
  assert.match(rco, /BuildGun->GotoBuildState\(BlueprintRecipe\)/);
  assert.match(rco, /BuildGun->IsBlueprintDescriptorActive\(Descriptor\)/);
  assert.doesNotMatch(rco, /Server_GotoBuildState|Server_SetDesiredBlueprint/);

  assert.match(subsystem, /DispatchClientBlueprintPreview\(/);
  assert.match(subsystem, /PreviewRCO->ClientPreviewBlueprint\(BlueprintName\)/);
  assert.match(subsystem, /client_preview_must_be_a_standalone_action/);
  assert.match(subsystem, /game_client_blueprint_preview_dispatched/);
  assert.match(subsystem, /TEXT\("world_mutated"\), false/);
  const dispatch = subsystem.indexOf("DispatchClientBlueprintPreview(");
  const normalExecute = subsystem.indexOf("AIFactoryActions::ExecutePlan(", dispatch);
  assert.ok(dispatch >= 0 && normalExecute > dispatch);
});

test("native Blueprint preview refreshes only when the player requests a native preview", () => {
  const subsystem = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp", import.meta.url),
    "utf8",
  );
  const rco = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintPreviewRCO.cpp", import.meta.url),
    "utf8",
  );
  const snapshot = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp", import.meta.url),
    "utf8",
  );

  const dispatchStart = subsystem.indexOf("FString DispatchClientBlueprintPreview(");
  const dispatchEnd = subsystem.indexOf("FString DescribeActionResults(", dispatchStart);
  const dispatch = subsystem.slice(dispatchStart, dispatchEnd);
  const clientStart = rco.indexOf("void UAIFactoryBlueprintPreviewRCO::ClientPreviewBlueprint_Implementation(");
  const client = rco.slice(clientStart);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  assert.ok(clientStart >= 0);

  for (const source of [dispatch, client]) {
    const refresh = source.indexOf("RefreshBlueprintsAndDescriptors()");
    const requirements = source.indexOf("RefreshBlueprintRecipeRequirements()", refresh);
    const lookup = source.indexOf("GetBlueprintDescriptorByNameString", requirements);
    assert.ok(
      refresh >= 0 && refresh < requirements && requirements < lookup,
      "refresh and recipe requirements must precede descriptor lookup",
    );
    assert.doesNotMatch(source, /ReadBlueprintFromDisc|WriteFileToDisk|CopyFile/);
  }

  assert.match(snapshot, /TSharedRef<FJsonObject> BlueprintLibraryJson\(UWorld\* World\)/);
  assert.match(snapshot, /AFGBlueprintSubsystem::GetBlueprintDescriptors\(Descriptors, World\)/);
  assert.match(snapshot, /SetArrayField\(TEXT\("registered_blueprint_names"\), RegisteredNames\)/);
  assert.match(snapshot, /Root->SetObjectField\(TEXT\("blueprint_library"\), BlueprintLibraryJson\(World\)\)/);
  const snapshotLibraryStart = snapshot.indexOf("TSharedRef<FJsonObject> BlueprintLibraryJson(");
  const snapshotLibraryEnd = snapshot.indexOf("FAIFactorySnapshotResult FAIFactorySnapshot::Build(", snapshotLibraryStart);
  const snapshotLibrary = snapshot.slice(snapshotLibraryStart, snapshotLibraryEnd);
  assert.ok(snapshotLibraryStart >= 0 && snapshotLibraryEnd > snapshotLibraryStart);
  assert.doesNotMatch(
    snapshotLibrary,
    /BlueprintSubsystem->RefreshBlueprintsAndDescriptors|BlueprintSubsystem->RefreshBlueprintRecipeRequirements/,
  );
  assert.match(snapshotLibrary, /SetBoolField\(TEXT\("refreshed_before_capture"\), false\)/);
  assert.match(snapshotLibrary, /SetBoolField\(TEXT\("complete"\), InvalidDescriptorCount == 0\)/);
  assert.doesNotMatch(snapshot, /WriteFileToDisk|ReadBlueprintFromDisc|CopyFile/);
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
  // The endpoints may now be repaired with SetConnection before the rollback --
  // a belt that constructed but snapped to the wrong port is worth joining
  // rather than dismantling. The gate moved to bEndpointsExact accordingly.
  const repair = belt.indexOf("bool bEndpointsExact = bExactEndpoints");
  const exactGate = belt.indexOf("if (!bEndpointsExact)");
  const charge = belt.indexOf("ChargeActionCost(Cost, Inventory)");
  const journal = belt.indexOf("RecordActionUndo(MoveTemp(Step))");
  assert.ok(finalStep >= 0 && finalStep < finalRevalidation && finalRevalidation < cost);
  assert.ok(cost < exactReadback && exactReadback < repair && repair < exactGate);
  assert.ok(exactGate < charge && charge < journal);

  // The repair must not weaken the check it precedes: it is gated on the game's
  // own CanConnectTo, it re-runs the same IsExactPair rather than assuming the
  // join took, and it refuses to steal a port another machine already holds.
  assert.match(belt, /BeltSide->CanConnectTo\(Wanted\)/);
  assert.match(belt, /return IsExactPair\(BeltSide, Wanted\);/);
  assert.match(belt, /Wanted->IsConnected\(\) && Wanted->GetConnection\(\) != BeltSide/);
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

test("native blueprint placement retains a valid lightweight-only proxy", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const blueprintStart = actions.indexOf("FAIFactoryActionResult PlaceBlueprint(");
  const blueprintEnd = actions.indexOf("FAIFactoryActionResult GiveItem(", blueprintStart);
  const blueprint = actions.slice(blueprintStart, blueprintEnd);

  assert.match(blueprint, /Proxy->GetLightweightClassAndIndices\(\)/);
  assert.match(blueprint, /Proxy->AreProxyBuildingsRegisteredAndValid\(\)/);
  assert.match(blueprint, /blueprint_proxy_lightweight_readback_not_ready/);
  assert.match(blueprint, /lightweight_buildings_placed/);
  assert.match(blueprint, /actor_buildings_placed/);

  const lightweightReadback = blueprint.indexOf(
    "Proxy->AreProxyBuildingsRegisteredAndValid()",
  );
  const successGate = blueprint.indexOf("const bool bHasPlacedLightweights");
  const cleanup = blueprint.indexOf("blueprint_proxy_lightweight_readback_not_ready");
  const charge = blueprint.indexOf("ChargeActionCost(Cost, Inventory)");
  assert.ok(
    lightweightReadback >= 0 &&
      lightweightReadback < successGate &&
      successGate < cleanup &&
      cleanup < charge,
    "a valid lightweight proxy must pass readback before cost charging; only an unready proxy is cleaned up",
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

test("native Blueprint placement auditing stays evidence-only and handles a miner aim fallback", () => {
  const audit = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintAudit.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const snapshot = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  // A resource node can be the game's usable hit while the camera trace sees
  // the Blueprint miner. The fallback is evidence-only: it must not replace
  // preferred_target for normal placement/action semantics.
  assert.match(audit, /AIFactoryBlueprintAuditFindProxy/);
  assert.match(audit, /camera_visibility_trace_fallback/);
  assert.match(snapshot, /Capture\(PreferredActor, CameraHit\.GetActor\(\)\)/);
  assert.match(actions, /SetObjectField\(\s*TEXT\("blueprint_instance_audit"\)/);

  assert.match(audit, /AreProxyBuildingsRegisteredAndValid\(\)/);
  assert.match(audit, /GetBlueprintProxy\(\)/);
  assert.match(audit, /GetExtractableResource\(\)/);
  assert.match(audit, /GetLightweightClassAndIndices\(\)/);
  assert.match(audit, /proxy_has_authority/);
  assert.match(audit, /extractable_resource_not_replicated_or_unbound/);

  // Resource Anchor evidence stays tied to public, exact identities. The
  // audit may describe a configured anchor, but it never recovers or repairs
  // the anchor's private persisted mapping.
  assert.match(audit, /GetConfiguration\(\)/);
  assert.match(audit, /GetRuntimeNode\(\)/);
  assert.match(audit, /GetResourcePurity\(\)/);
  assert.match(audit, /Extractor->GetExtractableResource\(\);/);
  assert.match(audit, /ExtractableResource\.GetObject\(\)/);
  assert.match(audit, /ExtractableResource\.GetInterface\(\) != nullptr/);
  assert.match(audit, /ResourceAnchor->GetRuntimeNode\(\) == RuntimeNode/);
  assert.match(audit, /RuntimeNode->GetOwner\(\) == ResourceAnchor/);
  assert.match(audit, /unknown_on_client/);
  assert.match(audit, /missing_on_authority/);
  assert.doesNotMatch(audit, /mBoundExtractors/);

  // This helper is a witness of Satisfactory's placement, never a repair or
  // a second placement system. Keep all world-write APIs out of the source.
  for (const forbidden of [
    /SetResourceNode/,
    /SetExtractableResource/,
    /SpawnActor/,
    /Construct\(/,
    /Dismantle/,
    /WriteFileToDisk/,
    /ReadBlueprintFromDisc/,
  ]) {
    assert.doesNotMatch(audit, forbidden);
  }
});

test("Blueprint Designer miner support keeps the native node and extractor contracts intact", () => {
  const anchorHeader = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Public/AIFactoryBlueprintResourceAnchor.h",
      import.meta.url,
    ),
    "utf8",
  );
  const anchor = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintResourceAnchor.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const hologram = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintResourceAnchorHologram.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const rco = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintResourceAnchorRCO.cpp",
      import.meta.url,
    ),
    "utf8",
  );
  const worldModule = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryGameWorldModule.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  // The node is deliberately transient: Blueprint roots carry configuration
  // and explicit extractor identities, then recreate the node in both a
  // Designer preview and a placed Blueprint world.  It must never become an
  // accidental serialised map node.
  assert.match(anchorHeader, /class .*AAIFactoryBlueprintAnchorNode.*AFGResourceNode/s);
  assert.match(anchorHeader, /ShouldSave_Implementation\(\) const override \{ return false; \}/);
  assert.match(anchorHeader, /TArray<TObjectPtr<AFGBuildableResourceExtractorBase>> mBoundExtractors/);
  assert.match(anchor, /Node->SetFlags\(RF_Transient\)/);
  assert.match(anchor, /PostSerializedFromBlueprint[\s\S]*ScheduleExactRebind\(\)/);
  const postDeserialize = anchor.slice(
    anchor.indexOf("void AAIFactoryBlueprintResourceAnchor::PostSerializedFromBlueprint"),
    anchor.indexOf("void AAIFactoryBlueprintResourceAnchor::PostLoadGame_Implementation"),
  );
  assert.doesNotMatch(postDeserialize, /DestroyRuntimeNode\(/);

  // Native miners retain their ordinary resource/occupancy checks.  The
  // extension is deliberately narrow, and a full native disconnect prevents
  // either of the extractors' SaveGame resource fields from keeping a
  // transient node alive in an archive.
  for (const miner of ["Build_MinerMk1_C", "Build_MinerMk2_C", "Build_MinerMk3_C"]) {
    assert.match(anchor, new RegExp(miner));
  }
  assert.match(anchor, /mBlacklistedDesignerBuildables\.RemoveAtSwap/);
  assert.match(anchor, /mCanBePlacedInBlueprintDesigner/);
  assert.match(anchor, /SynchronizeBoundExtractorsFromRuntimeNode\(\)/);
  assert.match(anchor, /TActorIterator<AFGBuildableResourceExtractorBase>/);
  assert.match(anchor, /Extractor->GetExtractableResource\(\)\.GetObject\(\) == mRuntimeNode/);
  assert.match(anchorHeader, /virtual void SetIsOccupied\(bool Occupied\) override/);
  assert.match(anchorHeader, /virtual bool CanBecomeOccupied\(\) const override \{ return true; \}/);
  assert.match(anchor, /AAIFactoryBlueprintAnchorNode::SetIsOccupied[\s\S]*ScheduleBoundExtractorSynchronization\(\)/);
  assert.match(anchor, /SetTimerForNextTick[\s\S]*CompleteBoundExtractorSynchronization/);
  assert.match(anchor, /DisconnectExtractableResource\(\)/);
  assert.match(anchor, /Extractor->GetResourceNode\(\) == nullptr/);
  assert.match(anchorHeader, /CanDismantle_Implementation\(\) const override/);
  assert.match(anchor, /return Super::CanDismantle_Implementation\(\) && !HasBoundExtractorOnRuntimeNode\(\)/);
  assert.match(anchor, /if \(!CanDismantle_Implementation\(\)\)/);
  assert.match(anchor, /could not fully detach extractor/);
  assert.match(anchor, /Extractor->GetExtractableResource\(\)\.GetObject\(\) != nullptr/);
  assert.match(anchor, /!mRuntimeNode->CanBecomeOccupied\(\)/);
  assert.match(anchor, /mRuntimeNode->IsOccupied\(\)/);
  assert.match(anchor, /left extractor .* unchanged because it or the anchor node was already occupied/);
  assert.match(anchor, /PreSaveGame_Implementation[\s\S]*TemporarilyDisconnectBoundExtractorsForSerialization/);
  assert.match(anchor, /PostSaveGame_Implementation[\s\S]*RestoreTemporarilyDisconnectedExtractors/);
  assert.match(anchor, /SetExtractableResource\(Resource\)/);
  assert.doesNotMatch(anchor, /mCanPlacePortableMiner\s*=\s*true/);
  assert.doesNotMatch(anchor, /SetInsideBlueprintDesigner/);

  // The anchor uses a real resource-node collision surface and a real Build
  // Gun hologram/RPC route, never a direct world spawn from the chat command.
  assert.match(anchor, /mBoxComponent = CreateDefaultSubobject<UBoxComponent>/);
  assert.match(hologram, /mCanBePlacedInBlueprintDesigner = true/);
  assert.match(hologram, /ConfigureAnchor\(mRequestedResource, mRequestedPurity/);
  assert.match(rco, /BuildGun->GotoBuildState\(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass\(\)\)/);
  assert.match(rco, /RecipeManager->IsRecipeAvailable\(UAIFactoryBlueprintResourceAnchorRecipe::StaticClass\(\)\)/);
  assert.match(rco, /mOnRecipeAvailable\.AddUniqueDynamic/);
  assert.match(rco, /SetTimerForNextTick/);
  assert.match(rco, /BlueprintAnchorRecipeReplicationRetryFrames/);
  assert.doesNotMatch(rco, /SpawnActor|Construct\(/);
  assert.match(worldModule, /EnableVanillaMinersInBlueprintDesigner\(GetWorld\(\)\)/);
  assert.doesNotMatch(anchor, /SUBSCRIBE_METHOD|UNSUBSCRIBE_METHOD|NativeHookManager/);
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

test("the requested Z is honoured only when the caller asks", () => {
  const actions = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp", import.meta.url),
    "utf8",
  );

  // Opt-in, and gated: a lone building on open ground must still settle onto
  // terrain, so the trace stays the default.
  assert.ok(actions.includes('Spec->TryGetBoolField(TEXT("exact_z"), bHonourRequestedZ)'));
  assert.ok(actions.includes("if (bHonourRequestedZ)"));
  assert.ok(actions.includes("requested_z_honoured"));

  // And the claim is checked against the placed transform, not asserted.
  assert.ok(actions.includes("requested_z_reached"));
  assert.ok(actions.includes("requested_z_drift_cm"));

  // The panel's one line says how well it landed, not only how many ran.
  // "It's placing everything wonky" was the report that found the discarded-Z
  // bug and nothing in the panel could have answered it.
  assert.ok(actions.includes("worst height drift"));
  assert.ok(actions.includes("placed through clearance"));
  assert.ok(actions.includes('TryGetNumberField(TEXT("requested_z_drift_cm"), DriftCm)'));
  // Reported above one centimetre only: below that it is the engine settling a
  // hologram, not a layout coming apart.
  assert.ok(actions.includes("WorstZDriftCm > 1.0"));

  // A belt that joins the wrong ports names the ports it did join. This
  // refusal has been reached live more than once with nothing in the reply to
  // act on.
  assert.ok(actions.includes("belt_connection_0_joined_to"));
  assert.ok(actions.includes("belt_connection_1_joined_to"));
  assert.ok(actions.includes("belt_connection_0_owner"));
  assert.ok(actions.includes('TEXT("requested_from")'));
  assert.ok(actions.includes('TEXT("requested_to")'));
  // Recorded before the branch that dismantles and returns, or a failure --
  // the only case anyone reads this for -- would carry none of it.
  const joins = actions.indexOf("belt_connection_0_joined_to");
  const refusal = actions.indexOf("constructed_belt_endpoints_did_not_match_requested_components");
  assert.ok(joins >= 0 && joins < refusal);

  // A snap reports what it snapped to, so FGCDMustSnapWall stops being a
  // refusal with no information attached to it.
  assert.ok(actions.includes("Cast<AFGBuildableHologram>(Hologram)"));
  assert.ok(actions.includes("Buildable->GetSnappedBuilding()"));
  assert.ok(actions.includes('TEXT("snapped_building")'));
  assert.ok(actions.includes('#include "Hologram/FGBuildableHologram.h"'));

  // The traced surface actor is kept -- only the height moves -- because the
  // hologram still needs a valid hit to accept.
  const guard = actions.indexOf("if (bHonourRequestedZ)");
  const lift = actions.indexOf("Hit.ImpactPoint.Z = WantedZ", guard);
  const instigator = actions.indexOf("SetConstructionInstigator", guard);
  assert.ok(guard >= 0 && lift > guard && instigator > lift);
});

test("a hologram that mounts at an offset is corrected by measurement, once", () => {
  const actions = fs.readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp", import.meta.url),
    "utf8",
  );

  // A Conveyor Merger came back +101 cm twice with snap_accepted false and
  // snapped_building "none". Nothing snapped it; it mounts a metre above
  // whatever surface it is handed, the way it sits on a foundation, so
  // replaying its captured world position made it add that offset again.
  //
  // The correction is measured, not tabulated: lower the hit by the drift that
  // was actually observed. A per-class offset table would be a guess that rots.
  assert.ok(actions.includes("requested_z_first_pass_drift_cm"));
  assert.ok(actions.includes("Hit.ImpactPoint.Z -= DriftCm;"));

  // Kept only if it helped, and undone if it did not -- a hologram that
  // ignores the hit must not be left worse off than before it was touched.
  assert.ok(actions.includes("requested_z_corrected"));
  assert.ok(actions.includes("requested_z_correction_rejected"));
  assert.ok(actions.includes("FMath::Abs(CorrectedDrift) < FMath::Abs(DriftCm)"));

  // One pass. Oscillating would be worse than reporting the residue honestly.
  assert.equal(actions.match(/Hit\.ImpactPoint\.Z -= DriftCm;/g).length, 1);
});
