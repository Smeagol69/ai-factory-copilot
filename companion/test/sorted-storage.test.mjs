import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const routing = read("../lib/routing.mjs");
const actions = read("../lib/actions.mjs");
const exporter = read("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp");
const exporterHeader = read("../../Source/AIFactoryCopilot/Public/AIFactoryBlueprintExport.h");
const actionsCpp = read("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp");

test("a storage container is a legal belt destination", () => {
  // Before this, nothing could plan a belt into storage at all: the fan-out
  // solver dropped any consumer whose consumedItemClasses was empty, and a
  // container's is always empty because it has no recipe.
  assert.match(routing, /const isUnfilteredSink =\n\s*!node\?\.raw\?\.manufacturer && Number\(node\?\.inventory_slot_count \?\? 0\) > 0;/);
  assert.match(routing, /accepts: "any_solid_item"/);
  assert.match(routing, /accepted_because: "captured_storage_inventory_without_a_manufacturer"/);
});

test("a machine still waiting for a recipe is not mistaken for a sink", () => {
  // Both are recipe-less. Belting into an unconfigured Constructor would be
  // wrong - it is waiting to be told what to make, not accepting anything.
  // The captured manufacturer block is what separates them.
  assert.match(routing, /!node\?\.raw\?\.manufacturer/);
  assert.match(routing, /if \(!isUnfilteredSink\) \{/);
  assert.match(routing, /missing: \["target_current_recipe"\]/);
});

test("a splitter may exist in a generated blueprint only under its own role", () => {
  // The denylist stays for every other attachment; the exception is narrow and
  // named, matching how miner and resource_anchor already carve theirs.
  assert.match(exporter, /const bool bSplitterRole = Part\.Role == TEXT\("splitter"\);/);
  assert.match(
    exporter,
    /\(BuildableClass->IsChildOf\(AFGBuildableConveyorAttachment::StaticClass\(\)\) &&\n\s*!bSplitterRole\) \|\|/,
  );
  // Conveyors, pipes, pipe attachments and wires are all still denied outright.
  assert.match(exporter, /BuildableClass->IsChildOf\(AFGBuildableConveyorBase::StaticClass\(\)\) \|\|/);
  assert.match(exporter, /BuildableClass->IsChildOf\(AFGBuildableWire::StaticClass\(\)\) \|\|/);
});

test("an unconnected splitter is refused, which is why the exception is safe", () => {
  // The stated reason the denylist exists is an attachment that looks placed
  // and silently carries nothing.
  assert.match(exporter, /Defaults->GetComponents<UFGFactoryConnectionComponent>\(Connections\);/);
  assert.match(exporter, /generated_splitter_is_not_connected_to_anything/);
  assert.match(exporter, /generated_splitter_has_no_captured_factory_connections/);
  assert.match(exporter, /generated_splitters_require_v4/);
  // Links can never exceed the ports the captured class actually has.
  assert.match(exporter, /generated_splitter_has_more_links_than_ports/);
});

test("a bus blueprint may keep a free intake", () => {
  // Found by writing the planner: demanding every port be bound refuses the
  // very thing this was built for. A sorting bus has a deliberately free
  // input - that is where the player belts their own production in after
  // stamping it - so participation is the rule, not saturation.
  assert.doesNotMatch(exporter, /generated_splitter_ports_are_not_all_linked/);
  assert.match(exporter, /if \(BoundOutputs \+ BoundInputs == 0\)/);
});

test("a sorted lane must be belted somewhere", () => {
  // Declaring three sorted outputs and belting one would ship a bus that drops
  // two item types on the floor. Counted rather than name-matched, because
  // mOutputs is a runtime cache and any index-to-connector mapping read from
  // class defaults would be an assumption.
  assert.match(exporter, /TSet<int32> FilteredOutputs;/);
  assert.match(exporter, /generated_splitter_has_unrouted_sorted_outputs/);
  assert.match(exporter, /mOutputs` is a runtime cache|runtime cache built/);
});

test("sort rules are validated against the captured class, not a vanilla guess", () => {
  // A modded splitter with a different output count or rule cap goes through
  // the same code, because every limit is read from the class defaults.
  assert.match(exporter, /const int32 MaxRules = SplitterDefaults->GetMaxNumSortRules\(\);/);
  assert.match(exporter, /generated_sort_rules_exceed_captured_capacity/);
  assert.match(exporter, /EFactoryConnectionDirection::FCD_OUTPUT/);
  assert.match(exporter, /generated_sort_rule_output_index_is_not_on_this_splitter/);
  assert.match(exporter, /generated_sort_rule_item_class_not_found/);
});

test("every sort rule names an item, including the special ones", () => {
  // Corrected after reading the headers: the game expresses "Any Undefined",
  // "Overflow" and "None" as real UFGItemDescriptor subclasses
  // (UFGAnyUndefinedDescriptor, UFGOverflowDescriptor, UFGNoneDescriptor), so
  // they resolve through the ordinary lookup and need no special case. An empty
  // item class is NOT one of them - FSplitterSortRule's default constructor
  // uses a null ItemClass to mean *unset*, and serialising that would ship a
  // splitter with a lane that silently sorts nothing.
  assert.match(exporter, /generated_sort_rule_needs_an_item_class/);
  assert.match(actions, /generated_blueprint_sort_rule_needs_an_item_class/);
  // The single IsChildOf check covers specials and real items alike.
  assert.match(exporter, /Found->IsChildOf\(UFGItemDescriptor::StaticClass\(\)\)/);
});

test("applied sort rules are read back before anything is serialised", () => {
  // Same discipline as the production recipe above it: a setter returning is
  // not evidence. mSortRules is SaveGame, so what survives this readback is
  // exactly what lands in the .sbp.
  assert.match(exporter, /Splitter->SetSortRules\(Rules\);/);
  assert.match(exporter, /const TArray<FSplitterSortRule> Readback = Splitter->GetSortRules\(\);/);
  assert.match(exporter, /generated_sort_rule_readback_count_mismatch/);
  assert.match(exporter, /generated_sort_rule_readback_mismatch/);
});

test("the sort rule reaches the game through a declared contract", () => {
  assert.match(exporterHeader, /struct FAIFactoryGeneratedBlueprintSortRule/);
  assert.match(exporterHeader, /TArray<FAIFactoryGeneratedBlueprintSortRule> SortRules;/);
  // Parsed from the action JSON, refusing a malformed entry rather than
  // dropping it - a silently dropped rule is a lane that stops sorting.
  assert.match(actionsCpp, /TryGetArrayField\(TEXT\("sort_rules"\), SortRules\)/);
  assert.match(actionsCpp, /generated_sort_rule_is_not_an_object/);
  assert.match(actionsCpp, /generated_sort_rule_needs_an_output_index/);
});

test("the bridge proves what it can see and leaves the rest to the game", () => {
  assert.match(actions, /"splitter"\]\.includes\(role\)/);
  assert.match(actions, /generated_blueprint_sort_rules_need_the_splitter_role/);
  assert.match(actions, /generated_blueprint_sort_rule_item_is_not_in_the_catalog/);
  // Two rules on one output would be resolved silently by order, producing a
  // bus that sorts differently from the plan that was approved.
  assert.match(actions, /generated_blueprint_sort_rule_is_duplicated/);
  assert.match(actions, /findItemInCatalog\(graph, itemClass\)/);
});

test("an unfiltered splitter stays legal", () => {
  // An even split is a real thing to want; sort rules are optional and their
  // absence must not be an error.
  assert.match(exporter, /if \(Entry\.Source\.SortRules\.Num\(\) == 0\)\n\s*\{\n\s*continue;/);
  assert.match(actions, /\.\.\.\(sortRules\.length > 0 \? \{ sort_rules: sortRules \} : \{\}\)/);
});

test("a generated blueprint declares a box that contains its layout", () => {
  // Found while answering "is this going to create a blueprint?". The capture
  // path was fixed to declare an honest box; the generated path was not - it
  // took dimensions from whichever designer stood in the world, and nothing
  // bounds a generated layout to that box. A three-lane bus fits a Mk1
  // designer; five lanes does not.
  assert.match(exporter, /Designer->GetOffsetTransform\(BlueprintOrigin\);/);
  assert.match(
    exporter,
    /WriteSubsystem->WriteBlueprintToArchive\(\s*\n?\s*Record, BlueprintOrigin, Staging\.GetAll\(\), Dimensions\);/,
  );
  assert.match(exporter, /declared_dimension_x_cells/);
});

test("widening the generated box does not move the generated pivot", () => {
  // Generated parts are staged at RelativeTransform * designer transform, so
  // the designer's own offset transform is already the right frame. Passing it
  // explicitly changes the declared size and nothing else; recentring here
  // would shift every generated blueprint that currently places correctly.
  assert.match(exporter, /FTransform BlueprintOrigin;/);
  // No selection-centre recentring on this path - that belongs to captures.
  const generated = exporter.slice(exporter.indexOf("FAIFactoryActionResult GenerateLayout"));
  assert.doesNotMatch(generated, /ComputeCaptureFrame\(/);
});

test("the designer's dimensions remain the floor on the generated path too", () => {
  // A layout that already fits declares exactly what it declared before.
  assert.match(exporter, /FMath::Max\(Dimensions\.X, CellsFor\(Size\.X\)\)/);
  assert.match(exporter, /FMath::Max\(Dimensions\.Z, CellsFor\(Size\.Z\)\)/);
  // And the old path survives if the subsystem is unavailable.
  assert.match(exporter, /Designer->SaveBlueprint\(Record, Controller\);/);
});
