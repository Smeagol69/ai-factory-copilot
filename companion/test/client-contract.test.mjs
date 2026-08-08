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

test("the game defers step-referenced belt preflight until its actors exist", () => {
  const actions = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(actions, /bDeferredStepReferences/);
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
