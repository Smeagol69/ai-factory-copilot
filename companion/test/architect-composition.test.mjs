import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_ROLE_CENSUS,
  assessComposition,
  assessPromotedComposition,
  buildingNameFromRecipeClass,
  impliedPartsForElement,
  referenceRoleMix,
} from "../lib/architect-composition.mjs";
import { compileArchitectPromotion } from "../lib/architect-promotion.mjs";
import { validateMegabaseManifest } from "../lib/megabase.mjs";

test("the reference mix comes from designer blueprints, not the whole-site export", () => {
  const mix = referenceRoleMix();
  // The home base is a site, not a module; its proportions would drag the
  // production share toward zero for reasons that say nothing about one building.
  assert.equal(mix.source_designs, 7);
  assert.equal(mix.total_buildings, 890);
  assert.equal(mix.counts.production, 24);
  assert.equal(mix.counts.enclosure, 567);
  // The ratio the budget is built on: real designs place ~24 enclosure pieces
  // for every machine.
  assert.ok(mix.per_production_machine.enclosure > 23 && mix.per_production_machine.enclosure < 24);
  assert.equal(mix.per_production_machine.production, 1);
});

test("implied parts follow declared geometry and declared roles only", () => {
  const hall = impliedPartsForElement({
    size_cells: { x: 6, y: 6, z: 2 },
    requires_roles: ["foundation", "wall"],
  });
  assert.equal(hall.foundation, 6 * 6 * 2, "a deck per floor");
  assert.equal(hall.wall, 2 * (6 + 6) * 2, "a skin around the perimeter of each floor");
  // Not declared, so not silently credited.
  assert.equal(hall.window, 0);
  assert.equal(hall.sloped_roof, 0);
  assert.equal(hall.walkway, 0);

  // Degenerate footprints produce nothing rather than NaN.
  assert.deepEqual(impliedPartsForElement({ size_cells: { x: 0, y: 4, z: 1 } }), {
    foundation: 0,
    wall: 0,
    window: 0,
    sloped_roof: 0,
    support_column: 0,
  });
  assert.deepEqual(impliedPartsForElement({}), {
    foundation: 0,
    wall: 0,
    window: 0,
    sloped_roof: 0,
    support_column: 0,
  });
});

test("a hall with no circulation is reported short of access", () => {
  const assessment = assessComposition({
    elements: [
      {
        size_cells: { x: 6, y: 6, z: 6 },
        requires_roles: ["foundation", "wall", "window"],
        phase_machine_allocation: [{ machines: 4 }],
      },
    ],
  });

  assert.equal(assessment.planned_machines, 4);
  // The massing implies plenty of skin, so enclosure is not the gap.
  const enclosure = assessment.roles.find((role) => role.role === "enclosure");
  assert.equal(enclosure.shortfall, 0);
  // Circulation is: nothing declares a walkway or rail.
  const access = assessment.roles.find((role) => role.role === "access");
  assert.ok(access.required_for_planned_machines > 0);
  assert.equal(access.implied_by_declared_massing, 0);
  assert.ok(access.shortfall > 0);
  assert.ok(assessment.shortfall_roles.includes("access"));
  assert.equal(assessment.meets_reference_composition, false);
  assert.match(assessment.caveat, /not decoded buildings/);
});

test("signage is reported as inexpressible, not merely as zero", () => {
  // The manifest vocabulary has no signage role at all, which is a different
  // problem from a design that could label itself and did not. Real designs
  // place three signs per machine.
  assert.ok(!Object.values(SEMANTIC_ROLE_CENSUS).includes("signage"));
  const assessment = assessComposition({
    elements: [
      { size_cells: { x: 4, y: 4, z: 1 }, requires_roles: ["foundation"], phase_machine_allocation: [{ machines: 2 }] },
    ],
  });
  assert.ok(assessment.inexpressible_roles.includes("signage"));
  const signage = assessment.roles.find((role) => role.role === "signage");
  assert.equal(signage.expressible, false);
  assert.ok(signage.required_for_planned_machines > 0);
  // An inexpressible role must not be counted as a shortfall the design could fix.
  assert.ok(!assessment.shortfall_roles.includes("signage"));
});

test("no machines means no budget rather than a false pass", () => {
  const assessment = assessComposition({ elements: [{ size_cells: { x: 4, y: 4, z: 1 } }] });
  assert.equal(assessment.planned_machines, 0);
  assert.equal(assessment.meets_reference_composition, false);
  assert.match(assessment.guidance, /no budget to meet/);
});

test("a recipe class resolves to the building the catalog counted", () => {
  assert.equal(
    buildingNameFromRecipeClass(
      "/Game/FactoryGame/Buildable/Building/Wall/Recipe_Wall_Concrete_8x4.Recipe_Wall_Concrete_8x4_C",
    ),
    "Wall_Concrete_8x4",
  );
  assert.equal(buildingNameFromRecipeClass("Recipe_ConstructorMk1"), "ConstructorMk1");
  assert.equal(buildingNameFromRecipeClass(""), "");
  assert.equal(buildingNameFromRecipeClass(null), "");
});

test("promoted actions are graded against the decoded census, apples to apples", () => {
  const actions = [
    { recipe_class: "Recipe_ConstructorMk1" },
    { recipe_class: "Recipe_ConstructorMk1" },
    ...Array.from({ length: 20 }, () => ({ recipe_class: "Recipe_Wall_Concrete_8x4" })),
  ];
  const assessment = assessPromotedComposition(actions);

  assert.equal(assessment.planned_buildings, 22);
  assert.equal(assessment.planned_machines, 2);
  assert.equal(assessment.planned_by_role.enclosure, 20);
  // The headline: this plan is far more machine-dense than any real design.
  assert.ok(assessment.production_share > assessment.reference_production_share);
  assert.ok(assessment.shortfall_roles.includes("enclosure"));
  assert.equal(assessment.meets_reference_composition, false);
  assert.deepEqual(assessment.unclassified_buildings, []);
});

test("an unrecognised building is surfaced rather than absorbed", () => {
  const assessment = assessPromotedComposition([
    { recipe_class: "Recipe_ConstructorMk1" },
    { recipe_class: "Recipe_Xeno_Frobnicator_Mk9" },
  ]);
  assert.deepEqual(assessment.unclassified_buildings, ["Xeno_Frobnicator_Mk9"]);
  assert.equal(assessment.planned_by_role.unclassified, 1);
});

test("validation reports composition without ever failing a design for it", () => {
  // A thin build may be a deliberate choice, and refusing it here would
  // invalidate stored revisions. The advisory names the gap; issues stay clean.
  const manifest = {
    elements: [
      {
        size_cells: { x: 4, y: 4, z: 1 },
        requires_roles: ["foundation"],
        phase_machine_allocation: [{ machines: 8 }],
      },
    ],
  };
  const result = validateMegabaseManifest(manifest);
  assert.ok(result.composition_advisory, "the advisory is always present");
  assert.equal(result.composition_advisory.meets_reference_composition, false);
  assert.ok(result.composition_advisory.shortfall_roles.length > 0);
  assert.ok(result.composition_advisory.inexpressible_roles.includes("signage"));
  // Every issue raised is about something other than composition.
  for (const issue of result.issues) {
    assert.doesNotMatch(String(issue), /composition|enclosure|signage|access/);
  }
});

test("the promotion compiler still refuses a manifest it cannot promote", () => {
  // The budget is reporting only; it must not change whether promotion compiles.
  const refused = compileArchitectPromotion(null, null, {});
  assert.equal(refused.compiled, false);
  assert.ok(Array.isArray(refused.blockers) && refused.blockers.length > 0);
});
