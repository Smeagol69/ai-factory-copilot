import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILDABLE_ROLES,
  aggregateRoleCensus,
  architecturalVocabulary,
  buildReferenceCatalog,
  censusByRole,
  classifyBuildable,
  findReferenceDesigns,
  parseDeclaredIo,
  summarizeReference,
  summarizeWorldExport,
} from "../lib/blueprint-reference.mjs";
import { BLUEPRINT_REFERENCE_CATALOG } from "../lib/blueprint-reference-catalog.mjs";
import { solveReferenceDesigns } from "../lib/reference-designs.mjs";
import { SOLVER_TOOLS } from "../lib/tools.mjs";

test("classifier separates the parts that look alike", () => {
  // Ordering traps: all three of these contain a word that belongs to another
  // role, and getting any of them wrong silently skews the role census.
  assert.equal(classifyBuildable("ConveyorPoleWall"), "logistics");
  assert.equal(classifyBuildable("PowerPoleWall"), "power");
  assert.equal(classifyBuildable("Wall_Concrete_8x4_ConveyorHole_01"), "enclosure");
  assert.equal(classifyBuildable("QuarterPipeMiddle_Asphalt_8x1"), "enclosure");
  assert.equal(classifyBuildable("SteelWall_8x1"), "enclosure");
  assert.equal(classifyBuildable("ConstructorMk1"), "production");
  assert.equal(classifyBuildable("StandaloneWidgetSign_Small"), "signage");
  assert.equal(classifyBuildable("CatwalkStairs"), "access");
  assert.equal(classifyBuildable("LargeFan"), "ambience");
  assert.equal(classifyBuildable("BlueprintDesigner_MK2"), "utility");
});

test("an unfamiliar class is reported, never absorbed into a bucket", () => {
  assert.equal(classifyBuildable("Xeno_Frobnicator_Mk9"), "unclassified");
  const census = censusByRole([
    { class_name: "ConstructorMk1", count: 2 },
    { class_name: "Xeno_Frobnicator_Mk9", count: 3 },
  ]);
  assert.equal(census.counts.production, 2);
  assert.equal(census.counts.unclassified, 3);
  assert.deepEqual(census.unclassified_classes, ["Xeno_Frobnicator_Mk9"]);
  assert.equal(census.total_buildables, 5);
  assert.equal(census.share.production, 0.4);
});

test("declared io is parsed but stays labelled as an author claim", () => {
  const io = parseDeclaredIo("Input:  60  Iron Plate \r\n           120 Screw\r\nOutput: 10 R. Iron Plate");
  assert.deepEqual(
    io.inputs.map((entry) => [entry.amount_per_minute, entry.item_label]),
    [
      [60, "Iron Plate"],
      [120, "Screw"],
    ],
  );
  assert.deepEqual(
    io.outputs.map((entry) => [entry.amount_per_minute, entry.item_label]),
    [[10, "R. Iron Plate"]],
  );
  assert.equal(io.evidence, "author_supplied_description_text");
  assert.match(io.caveat, /not a decoded or simulated rate/);
});

test("summarizeReference refuses an inspection that failed", () => {
  assert.throws(
    () => summarizeReference({ available: false, reason: "blueprint_config_missing" }),
    /blueprint_config_missing/,
  );
});

test("summarizeReference carries decoded facts through unchanged", () => {
  const summary = summarizeReference(
    {
      available: true,
      blueprint_name: "example",
      header: {
        game_changelist: 424353,
        factory_save_custom_version: 52,
        designer_dimensions: { x: 6, y: 6, z: 6 },
        description: "Input: 120 Iron ore\nOutput: 120 Iron Ingot",
        build_cost: [{ item_name: "IronPlate", amount: 40 }],
      },
      pivot_bounds_cm: { span_cm: { x: 3200, y: 4000, z: 1150 } },
      buildable_classes: [
        { class_name: "Wall_Concrete_8x4", count: 30 },
        { class_name: "SmelterMk1", count: 4 },
      ],
      distinct_buildable_classes: 2,
      connection_topology: { reciprocal_connection_pair_count: 32 },
      power_wire_topology: { verified_power_wire_count: 5 },
    },
    { id: "example", kind: "production_module", author: "Somebody" },
  );

  assert.equal(summary.id, "example");
  assert.equal(summary.author, "Somebody");
  assert.deepEqual(summary.designer_dimensions, { x: 6, y: 6, z: 6 });
  assert.deepEqual(summary.occupied_span_cells, { x: 4, y: 5 });
  assert.equal(summary.role_census.counts.enclosure, 30);
  assert.equal(summary.role_census.counts.production, 4);
  assert.equal(summary.topology.reciprocal_conveyor_pairs, 32);
  assert.equal(summary.topology.verified_power_wires, 5);
  // Sorted by descending count, so the leading class is the most-used one.
  assert.equal(summary.buildable_classes[0].class_name, "Wall_Concrete_8x4");
});

test("world export excludes proxies and non-buildable actors from the census", () => {
  // The two origin-parked marker actors are the real trap: counting them stretches
  // the measured footprint by an order of magnitude.
  const summary = summarizeWorldExport(
    [
      { parent: { className: "/Game/X/Build_Foundation_Concrete_8x4.Build_Foundation_Concrete_8x4_C", transform: { translation: [800, 800, 0] } } },
      { parent: { className: "/Game/X/Build_Wall_Concrete_8x4.Build_Wall_Concrete_8x4_C", transform: { translation: [1600, 1600, 0] } } },
      { parent: { className: "/Script/FactoryGame.FGBlueprintProxy", transform: { translation: [0, 0, 0] } } },
      { parent: { className: "/Script/FactoryGame.FGDroneStationInfo", transform: { translation: [-900000, 900000, 0] } } },
    ],
    { id: "example-base", buildVersion: 493833, saveVersion: 60 },
  );

  assert.equal(summary.world_export.placed_buildable_count, 2);
  assert.equal(summary.world_export.blueprint_proxy_count, 1);
  assert.equal(summary.world_export.non_buildable_actor_count, 1);
  assert.equal(summary.role_census.total_buildables, 2);
  assert.deepEqual(summary.occupied_span_cm, { x: 800, y: 800, z: 0 });
  assert.deepEqual(summary.designer_dimensions, { x: null, y: null, z: null });
  assert.deepEqual(summary.build_cost, []);
});

test("vocabulary ranks by how many designs use a part, not raw count", () => {
  const vocabulary = architecturalVocabulary([
    { buildable_classes: [{ class_name: "Wall_Concrete_8x4", count: 400, role: "enclosure" }] },
    { buildable_classes: [{ class_name: "CatwalkStraight", count: 2, role: "access" }] },
    { buildable_classes: [{ class_name: "CatwalkStraight", count: 2, role: "access" }] },
  ]);
  assert.equal(vocabulary[0].class_name, "CatwalkStraight");
  assert.equal(vocabulary[0].design_frequency, 2);
  assert.equal(vocabulary[1].class_name, "Wall_Concrete_8x4");
  assert.equal(vocabulary[1].total_count, 400);
});

test("aggregate role census sums every role", () => {
  const aggregate = aggregateRoleCensus([
    { role_census: { counts: { production: 4, enclosure: 6 } } },
    { role_census: { counts: { production: 1, signage: 9 } } },
  ]);
  assert.equal(aggregate.total_buildables, 20);
  assert.equal(aggregate.counts.production, 5);
  assert.equal(aggregate.counts.enclosure, 6);
  assert.equal(aggregate.counts.signage, 9);
  assert.equal(aggregate.share.production, 0.25);
});

test("catalog query filters independently", () => {
  const catalog = buildReferenceCatalog([
    {
      id: "rods",
      kind: "production_module",
      designer_dimensions: { x: 6, y: 6, z: 6 },
      declared_io: { inputs: [{ item_label: "Iron Ingot" }], outputs: [{ item_label: "Iron Rod" }] },
      buildable_classes: [{ class_name: "ConstructorMk1", count: 4, role: "production" }],
      role_census: { counts: { production: 4 } },
    },
    {
      id: "wrap",
      kind: "architectural_wrap",
      designer_dimensions: { x: 8, y: 8, z: 8 },
      declared_io: { inputs: [], outputs: [] },
      buildable_classes: [{ class_name: "CatwalkStraight", count: 2, role: "access" }],
      role_census: { counts: { access: 2 } },
    },
  ]);

  assert.equal(findReferenceDesigns(catalog, {}).length, 2);
  assert.deepEqual(findReferenceDesigns(catalog, { produces: "rod" }).map((r) => r.id), ["rods"]);
  assert.deepEqual(findReferenceDesigns(catalog, { consumes: "ingot" }).map((r) => r.id), ["rods"]);
  assert.deepEqual(findReferenceDesigns(catalog, { kind: "architectural_wrap" }).map((r) => r.id), ["wrap"]);
  assert.deepEqual(findReferenceDesigns(catalog, { uses_class: "catwalk" }).map((r) => r.id), ["wrap"]);
  assert.deepEqual(findReferenceDesigns(catalog, { max_cells: 6 }).map((r) => r.id), ["rods"]);
  assert.equal(findReferenceDesigns(catalog, { produces: "plutonium" }).length, 0);
});

test("the shipped catalog is well formed and fully classified", () => {
  const catalog = BLUEPRINT_REFERENCE_CATALOG;
  assert.equal(catalog.catalog_version, "aifactory.blueprint-reference/v1");
  assert.equal(catalog.reference_count, catalog.references.length);
  assert.ok(catalog.reference_count >= 8);

  for (const reference of catalog.references) {
    assert.ok(reference.id, "every reference has an id");
    assert.ok(BUILDABLE_ROLES.includes(Object.keys(reference.role_census.counts)[0]));
    assert.deepEqual(
      reference.role_census.unclassified_classes,
      [],
      `${reference.id} has classes the role rules do not cover`,
    );
    const summed = Object.values(reference.role_census.counts).reduce((a, b) => a + b, 0);
    assert.equal(
      summed,
      reference.role_census.total_buildables,
      `${reference.id} role counts do not sum to its total`,
    );
  }

  // The measurement this library exists to make. If enclosure ever stops
  // dominating production here, the catalog was rebuilt from something else.
  const { counts, total_buildables } = catalog.role_census;
  assert.ok(counts.enclosure > counts.production * 20);
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    total_buildables,
  );
});

test("find_reference_designs is registered and answers from the shipped catalog", () => {
  const tool = SOLVER_TOOLS.find((entry) => entry.name === "find_reference_designs");
  assert.ok(tool, "tool is registered");
  assert.equal(tool.parameters.additionalProperties, false);

  const result = tool.run(null, { produces: "rod", limit: 3 }, {});
  assert.equal(result.available, true);
  assert.equal(result.matched_count, 1);
  assert.equal(result.references[0].id, "iron-rod-120");
  assert.match(result.references[0].declared_io.caveat, /author/i);
  assert.match(result.usage_note, /not facts about this save/);
  assert.ok(result.vocabulary.length > 0);
});

test("the solver bounds what it returns", () => {
  const wide = solveReferenceDesigns(null, { limit: 999, vocabulary_rows: 999 }, {});
  assert.ok(wide.references.length <= 20);
  assert.ok(wide.vocabulary.length <= 60);

  const none = solveReferenceDesigns(null, { include_vocabulary: false }, {});
  assert.deepEqual(none.vocabulary, []);
  assert.equal(none.vocabulary_rows_returned, 0);
  assert.ok(none.vocabulary_total_classes > 0);

  const capped = solveReferenceDesigns(null, { vocabulary_rows: 3 }, {});
  assert.equal(capped.vocabulary.length, 3);
});
