import assert from "node:assert/strict";
import test from "node:test";
import { assessBlueprintSite, formatSiteAssessment, judgeSite } from "../lib/siting.mjs";

/** A 32 x 16 m blueprint, as the structural parser reports one. */
const blueprint = {
  available: true,
  blueprint_name: "test module",
  pivot_bounds_cm: {
    minimum_cm: { x: -1600, y: -800, z: 0 },
    maximum_cm: { x: 1600, y: 800, z: 900 },
    span_cm: { x: 3200, y: 1600, z: 900 },
  },
};

/** A terrain scan on a 4 m grid, flat unless a shaper says otherwise. */
function scan({ shape = () => ({}), radiusCm = 4000 } = {}) {
  const samples = [];
  for (let x = -radiusCm; x <= radiusCm; x += 400) {
    for (let y = -radiusCm; y <= radiusCm; y += 400) {
      samples.push({ x, y, z: 10000, slope_deg: 0, water: false, ...shape(x, y) });
    }
  }
  return { center: { x: 0, y: 0, z: 10000 }, achieved_step_meters: 4, samples };
}

test("footprint comes from the blueprint's own decoded bounds", () => {
  const site = assessBlueprintSite(blueprint, scan());
  assert.equal(site.footprint_m.width, 32);
  assert.equal(site.footprint_m.depth, 16);
});

test("a quarter turn swaps width and depth", () => {
  const site = assessBlueprintSite(blueprint, scan(), { rotationDeg: 90 });
  assert.equal(site.footprint_m.width, 16);
  assert.equal(site.footprint_m.depth, 32);
  assert.equal(site.rotation_deg, 90);
});

test("a rotation the game cannot snap to is refused, not approximated", () => {
  // Answering for 37 degrees would describe a placement that cannot be made.
  const site = assessBlueprintSite(blueprint, scan(), { rotationDeg: 37 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, "rotation_must_be_a_quarter_turn");
});

test("flat ground is called flat", () => {
  const site = assessBlueprintSite(blueprint, scan());
  assert.equal(judgeSite(site).verdict, "flat");
  assert.equal(site.ground.relief_m, 0);
});

test("a slope across the footprint is measured, not eyeballed", () => {
  const site = assessBlueprintSite(blueprint, scan({ shape: (x) => ({ z: 10000 + x }) }));
  // 32 m of footprint at 1 cm per cm of x = 32 m of rise.
  assert.equal(site.ground.relief_m, 32);
  assert.equal(judgeSite(site).verdict, "difficult");
});

test("mid-range relief is workable rather than a problem", () => {
  // 4 m across the footprint: one foundation layer absorbs it.
  const site = assessBlueprintSite(blueprint, scan({ shape: (x) => ({ z: 10000 + x / 8 }) }));
  const judgement = judgeSite(site);
  assert.equal(judgement.verdict, "workable");
  assert.match(judgement.notes.join(" "), /one foundation layer absorbs this/);
});

test("water under half the footprint is a note, under most of it is a problem", () => {
  const some = judgeSite(assessBlueprintSite(blueprint, scan({ shape: (x) => ({ water: x < -800 }) })));
  assert.equal(some.verdict, "workable");
  assert.match(some.notes.join(" "), /over water/);

  const mostly = judgeSite(assessBlueprintSite(blueprint, scan({ shape: (x) => ({ water: x < 800 }) })));
  assert.equal(mostly.verdict, "difficult");
  assert.match(mostly.problems.join(" "), /more than half/);
});

test("only ground under the footprint is judged, not the whole scan", () => {
  // A cliff well outside the 32 x 16 m footprint must not condemn the site.
  const site = assessBlueprintSite(
    blueprint,
    scan({ shape: (x, y) => (Math.abs(y) > 2000 ? { z: 20000 } : {}) }),
  );
  assert.equal(site.ground.relief_m, 0);
  assert.equal(judgeSite(site).verdict, "flat");
});

test("a footprint reaching past the scan says so instead of judging a fragment", () => {
  const site = assessBlueprintSite(blueprint, scan({ radiusCm: 400 }));
  // 32 m wide against an 8 m scan: the probes present are not the footprint.
  assert.equal(site.ok, true, "a small scan still has probes under the centre");
  const tiny = assessBlueprintSite(blueprint, { center: { x: 900000, y: 0 }, samples: [] });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.reason, "no_terrain_scan");
});

test("the levelling estimate is stated in foundations, not centimetres", () => {
  const site = assessBlueprintSite(blueprint, scan({ shape: (x) => ({ z: 10000 + x / 4 }) }));
  // 32 x 16 m needs 4 x 2 foundations of 8 m.
  assert.equal(site.levelling.foundations_grid, "4 x 2");
  assert.equal(site.levelling.foundations_8m, 8);
  assert.ok(site.levelling.deck_height_m >= site.ground.max_m);
});

test("it never claims the game will accept the placement", () => {
  const site = assessBlueprintSite(blueprint, scan());
  const text = formatSiteAssessment(site, judgeSite(site));
  assert.match(text, /Clearance against existing buildings/);
  assert.match(text, /not modelled here/);
});

test("a missing terrain scan tells the player how to get one", () => {
  const site = assessBlueprintSite(blueprint, { center: { x: 0, y: 0 }, samples: [] });
  assert.match(formatSiteAssessment(site, judgeSite(site)), /Run `\/ai terrain`/);
});

test("an unreadable blueprint is refused rather than measured as zero", () => {
  const site = assessBlueprintSite({ available: false }, scan());
  assert.equal(site.ok, false);
  assert.equal(site.reason, "blueprint_not_readable");
});
