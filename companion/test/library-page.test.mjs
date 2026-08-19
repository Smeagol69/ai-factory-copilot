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
  parseBlueprintPlaceRequest,
  parseDesignListRequest,
  parseDesignPlaceRequest,
  parseDesignRenameRequest,
  parseDesignRetireRequest,
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

test("a blueprint's phrases and turn buttons parse too", () => {
  const model = buildLibraryModel({
    designs: [],
    // The name in the noticeboard's warning: a real file with a version number
    // in it, which is why the blueprint route has no keyword blocklist.
    blueprints: [{ name: "Coal power plant 2700MW v1.1", build_cost: [{ amount: 4, item_name: "Concrete" }] }],
  });

  const [blueprint] = model.blueprints;
  assert.equal(parseBlueprintPlaceRequest(blueprint.says[0]).name, "Coal power plant 2700MW v1.1");
  assert.equal(parseBlueprintPlaceRequest(blueprint.says[0]).rotation_degrees, 0);

  for (const degrees of [90, 180, 270]) {
    const parsed = parseBlueprintPlaceRequest(`${blueprint.says[0]} rotated ${degrees}`);
    assert.equal(parsed.rotation_degrees, degrees);
    // The version number must survive the turn being stripped off the end.
    assert.equal(parsed.name, "Coal power plant 2700MW v1.1");
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
    parseDesignRenameRequest,
    parseDesignRetireRequest,
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

test("the thumbnail keeps the design's proportions and centres it", () => {
  const at = (x, y, className = "SmelterMk1") =>
    piece(className, { offset_cm: { x, y, z: 0 } });

  // A row of four, twice as long as it is deep. It must read as a row.
  const row = buildLibraryModel({
    designs: [design("a row", [at(0, 0), at(1_000, 0), at(2_000, 0), at(3_000, 0)])],
    blueprints: [],
  }).designs[0].plan;

  const xs = row.map(([x]) => x);
  const ys = row.map(([, y]) => y);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 1);
  // Centred on the short axis rather than pinned to an edge, which is how the
  // four-smelter design first came out.
  assert.ok(ys.every((y) => Math.abs(y - 0.5) < 0.001), `row should sit centred, got ${ys}`);

  // Proportions survive: a design twice as wide as deep uses half the height.
  const oblong = buildLibraryModel({
    designs: [design("oblong", [at(0, 0), at(2_000, 1_000)])],
    blueprints: [],
  }).designs[0].plan;
  assert.equal(oblong[1][0] - oblong[0][0], 1);
  assert.equal(oblong[1][1] - oblong[0][1], 0.5);

  // Kinds are what the colours key off, and the extractor is the one that
  // matters -- it is what a design gets aimed at.
  const mixed = buildLibraryModel({
    designs: [design("mixed", [at(0, 0, "MinerMk1"), at(500, 0), at(0, 500, "Foundation_8x4_01")])],
    blueprints: [],
  }).designs[0].plan;
  assert.deepEqual(mixed.map(([, , kind]) => kind), [2, 1, 0]);

  // A single building has no extent at all; dividing by that would be NaN.
  const alone = buildLibraryModel({
    designs: [design("alone", [at(0, 0)])],
    blueprints: [],
  }).designs[0].plan;
  assert.ok(alone.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), "one building must still draw");
});

test("blueprint outlines are sized against each other, not each against its own box", () => {
  // Designer volumes in the owner's library are all square -- 4x4, 5x5, 6x6,
  // 12x12 -- so an outline normalised to fill its own box would say nothing
  // the size tag does not. Relative scale is the whole point of drawing it.
  const model = buildLibraryModel({
    designs: [],
    blueprints: [
      { name: "small", designer_dimensions: { x: 4, y: 4 } },
      { name: "large", designer_dimensions: { x: 12, y: 12 } },
    ],
  });

  const [small, large] = model.blueprints;
  assert.equal(large.outline.scale, 1);
  assert.ok(Math.abs(small.outline.scale - 1 / 3) < 0.001);

  // A library of one size still draws it full, rather than dividing by nothing.
  const alone = buildLibraryModel({
    designs: [],
    blueprints: [{ name: "only", designer_dimensions: { x: 4, y: 4 } }],
  }).blueprints[0];
  assert.equal(alone.outline.scale, 1);

  // A blueprint the game reported no dimensions for gets no outline invented
  // for it.
  const unknown = buildLibraryModel({ designs: [], blueprints: [{ name: "no size" }] }).blueprints[0];
  assert.equal(unknown.outline, null);
  assert.equal(unknown.footprint, null);
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
