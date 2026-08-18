/**
 * The library page's one job is handing over phrases that work.
 *
 * Every button on it copies a sentence the player then says to the copilot. A
 * button that copies something the router cannot parse is worse than no button:
 * it looks like a feature and does nothing. So the contract pinned here is the
 * round trip — page produces phrase, router parses phrase, and the parse says
 * what the button promised.
 *
 * The page had no tests at all before this.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildLibraryModel, renderLibraryPage } from "../lib/library-page.mjs";
import {
  parseDesignListRequest,
  parseDesignPlaceRequest,
  parseDesignSaveRequest,
} from "../lib/router.mjs";

const design = (name, buildings) => ({
  schema: "aifactory.design/v1",
  name,
  selected_by: "dismantle_selection",
  building_count: buildings.length,
  buildings,
});

const piece = (className, extra = {}) => ({
  recipe_class: `/G/Recipe_${className}_C`,
  class_path: `/G/Build_${className}_C`,
  offset_cm: { x: 0, y: 0, z: 0 },
  yaw: 0,
  ...extra,
});

const DESIGNS = [
  design("copper mk1", [piece("MinerMk1"), piece("SmelterMk1", { offset_cm: { x: 1_200, y: 0, z: 0 } })]),
  design("wall of storage", [piece("StorageContainerMk1"), piece("ConveyorBeltMk1"), piece("PowerLine")]),
];

test("every phrase the page offers parses back to what the button promised", () => {
  const model = buildLibraryModel({ designs: DESIGNS, blueprints: [] });

  for (const item of model.designs) {
    for (const say of item.says) {
      const parsed = parseDesignPlaceRequest(say);
      assert.ok(parsed, `the page offers "${say}" and the router does not parse it`);
      assert.equal(parsed.rotation_degrees, 0);
    }

    // The turn buttons append to the first phrase, so that is the one that has
    // to survive having an angle stuck on the end of it.
    for (const degrees of [90, 180, 270]) {
      const say = `${item.says[0]} rotated ${degrees}`;
      const parsed = parseDesignPlaceRequest(say);
      assert.ok(parsed, `dead turn button: "${say}"`);
      assert.equal(parsed.rotation_degrees, degrees);
    }
  }
});

test("a design with a miner is offered for a node first", () => {
  const [copper, storage] = buildLibraryModel({ designs: DESIGNS, blueprints: [] }).designs;
  // Alphabetical, so "copper mk1" then "wall of storage".
  assert.match(copper.says[0], /on this node/);
  assert.match(storage.says[0], /here/);
  assert.equal(storage.says.length, 1);
});

test("the count is what will be placed, not what was saved", () => {
  const [, storage] = buildLibraryModel({ designs: DESIGNS, blueprints: [] }).designs;

  // Three things were saved; the belt and the power line join two ends each and
  // are not replayed, so promising three would be promising wrong.
  assert.equal(storage.count, 1);
  assert.equal(storage.links, 2);
  assert.match(storage.contents, /Storage/);
  assert.ok(!/ConveyorBelt|PowerLine/.test(storage.contents));
});

test("every phrase the README teaches is one the router understands", () => {
  // Same principle as the dead-button test above, applied to the docs. A
  // phrase in the README that no parser accepts is a promise the copilot does
  // not keep, and it is exactly the kind of thing that rots silently as the
  // patterns change.
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Saving and replaying a layout"));
  assert.ok(section.length > 0, "the README should still document saving a layout");

  const block = section.slice(section.indexOf("```text") + 7, section.indexOf("```", section.indexOf("```text") + 7));
  const phrases = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(phrases.length >= 4, `expected the taught phrases, got ${phrases.length}`);

  const parsers = [
    parseDesignSaveRequest,
    parseDesignPlaceRequest,
    parseDesignListRequest,
  ];
  for (const phrase of phrases) {
    assert.ok(
      parsers.some((parse) => parse(phrase) !== null),
      `the README teaches "${phrase}" and no parser accepts it`,
    );
  }

  // And the ones named in prose rather than in the block.
  for (const [phrase, degrees] of [["turned right", 90], ["half turn", 180]]) {
    assert.ok(section.includes(phrase), `the README should still mention "${phrase}"`);
    assert.equal(parseDesignPlaceRequest(`place mk1 copper here ${phrase}`).rotation_degrees, degrees);
  }
});

test("the page renders, escapes, and its client script compiles", () => {
  const awkward = design('a "quoted" <name> & co', [piece("SmelterMk1")]);
  const html = renderLibraryPage(buildLibraryModel({ designs: [awkward], blueprints: [] }));

  // Compiles rather than runs: it touches document and fetch, which do not
  // exist here, but a syntax error in it would break the page silently.
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));

  // No design data is in the shell at all — the client fetches /library.json
  // and builds the cards — so a design called anything at all cannot reach the
  // markup unescaped. This is the property worth pinning, because it is what
  // makes the client's esc() the only place escaping has to be right.
  assert.ok(!html.includes("quoted"), "the shell must not carry design names");
  assert.ok(html.includes("/library.json"));
  assert.ok(html.includes("esc(item.name)"), "cards must escape the name they render");
  assert.ok(html.includes("turns"), "the turn buttons should be in the client");
});
