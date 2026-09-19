import assert from "node:assert/strict";
import test from "node:test";
import { orientedVolume, volumesOverlap } from "../lib/architect-geometry.mjs";

const box = (x, y, width, depth, yaw = 0, z = 0) =>
  orientedVolume({ x, y, z }, { x: width, y: depth, z: 400 }, yaw);

test("quarter-turn volumes include the negative side of their pivot", () => {
  assert.deepEqual(box(100, 200, 1600, 800, 90).corners, [
    { x: 100, y: 200 }, { x: 100, y: 1800 },
    { x: -700, y: 1800 }, { x: -700, y: 200 },
  ]);
});

test("oriented overlap catches collisions outside the unrotated rectangle", () => {
  assert.equal(volumesOverlap(box(0, 0, 1600, 1600, 90), box(-1600, 800, 800, 800)), true);
  assert.equal(volumesOverlap(box(0, 0, 1600, 1600, 180), box(800, 800, 800, 800)), false);
});

test("separating axes distinguish parallel diagonal halls even when their AABBs overlap", () => {
  const a = box(0, 0, 1000, 100, 45);
  const b = box(-100, 100, 1000, 100, 45);
  assert.equal(volumesOverlap(a, b), false);
  assert.equal(volumesOverlap(b, a), false);
  assert.equal(volumesOverlap(a, box(-20, 20, 1000, 100, 45)), true);
});

test("touching edges, stacked floors and separated elevations are not overlaps", () => {
  const a = box(0, 0, 800, 800);
  assert.equal(volumesOverlap(a, box(800, 0, 800, 800)), false);
  assert.equal(volumesOverlap(a, box(0, 0, 800, 800, 45, 400)), false);
  assert.equal(volumesOverlap(a, box(0, 0, 800, 800, 45, 399)), true);
});

test("invalid or overflowing geometry cannot become a usable volume", () => {
  for (const yaw of [null, undefined, NaN, Infinity]) {
    assert.equal(orientedVolume({ x: 0, y: 0, z: 0 }, { x: 800, y: 800, z: 400 }, yaw), null);
  }
  assert.equal(box(0, 0, 0, 800), null);
  assert.equal(box(0, 0, -800, 800), null);
  assert.equal(box(1e308, 0, 1e308, 800), null);
});
