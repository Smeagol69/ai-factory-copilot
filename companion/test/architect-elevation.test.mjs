import assert from "node:assert/strict";
import test from "node:test";
import { resolveArchitectElevation } from "../lib/architect-elevation.mjs";

test("elevation refuses malformed offsets, missing XYZ and arithmetic overflow", () => {
  const origin = { x: 10, y: 20, z: 30 };
  for (const offset of [null, "-2000", false, NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(resolveArchitectElevation({ origin, elevation_offset_cm: offset }).resolved, false);
  }
  for (const invalid of [{ x: 10, y: 20 }, { x: null, y: 20, z: 30 }]) {
    assert.equal(resolveArchitectElevation({ origin: invalid, elevation_offset_cm: -2000 }).resolved, false);
  }
  assert.equal(resolveArchitectElevation({ origin: { x: 0, y: 0, z: Number.MAX_VALUE },
    elevation_offset_cm: Number.MAX_VALUE }).reason, "elevation_offset_produces_nonfinite_height");
  const request = { origin, elevation_offset_cm: -2000.5 };
  assert.deepEqual(resolveArchitectElevation(request).origin, { x: 10, y: 20, z: -1970.5 });
  assert.deepEqual(origin, { x: 10, y: 20, z: 30 });
  assert.equal(resolveArchitectElevation({ origin }).origin, origin);
});
