import test from "node:test";
import assert from "node:assert/strict";
import { createBaseTransfer, validateBaseTransfer, readExactBaseTransform, verifyBaseSpawn } from "../lib/base-transfer.mjs";

const transform = () => ({ translation: { x: 296518.1594721499, y: -147761.1640091523, z: 4484.938640674662 },
  rotation: { x: -0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 2, z: 1 } });
const source = { save_sha256: "a".repeat(64), map_name: "Persistent_Level", build_version: 502094 };
const piece = id => ({ id, kind: "lightweight", class_path: "/Test/Foundation_C", transform: transform() });
const capture = pieces => ({ scope: "created_by_this_restore", complete: true, map_name: source.map_name,
  pieces: pieces.map((p, i) => ({ ...p, runtime_id: `new:${i}` })) });

test("absolute base package survives JSON without losing original double values or negative zero", () => {
  const manifest = createBaseTransfer(source, [piece("one")]);
  const parsed = validateBaseTransfer(JSON.parse(JSON.stringify(manifest)));
  assert.deepEqual(readExactBaseTransform(parsed.pieces[0]), transform());
  assert.equal(parsed.native_restore_verified, false);
  assert.equal(verifyBaseSpawn(parsed, capture([piece("new")])).exact, true);
});

test("missing lightweight, snapped Z, float rounding and extra generated pieces fail exact readback", () => {
  const manifest = createBaseTransfer(source, [piece("one"), piece("two")]);
  assert.equal(verifyBaseSpawn(manifest, capture([piece("one")])).exact, false);
  for (const change of [p => { p.transform.translation.z += 1; },
    p => { p.transform.translation.x = Math.fround(p.transform.translation.x); },
    p => { p.transform.scale3d.y = 1; }]) {
    const pieces = [piece("a"), piece("b")]; change(pieces[1]);
    assert.equal(verifyBaseSpawn(manifest, capture(pieces)).exact, false);
  }
  assert.deepEqual(verifyBaseSpawn(manifest, capture([piece("a"), piece("b"), piece("c")])).unexpected, ["new:0"]);
});

test("coincident instances require separate newly-created runtime identities", () => {
  const manifest = createBaseTransfer(source, [piece("one"), piece("two")]);
  assert.equal(verifyBaseSpawn(manifest, capture([piece("a"), piece("b")])).matched, 2);
  const observed = capture([piece("a"), piece("b")]);
  observed.pieces[1].runtime_id = observed.pieces[0].runtime_id;
  assert.throws(() => verifyBaseSpawn(manifest, observed), /runtime identity/);
  for (const patch of [{ scope: "all_world" }, { complete: false }, { map_name: "OtherWorld" }]) {
    assert.throws(() => verifyBaseSpawn(manifest, { ...capture([]), ...patch }), /readback/);
  }
});

test("modified transform, identity, digest and malformed quaternion cannot become a restore package", () => {
  const fresh = () => createBaseTransfer(source, [piece("one")]);
  const changed = fresh(); changed.pieces[0].transform.translation.z++;
  assert.throws(() => validateBaseTransfer(changed), /disagree/);
  const id = fresh(); id.pieces[0].id = "replacement";
  assert.throws(() => validateBaseTransfer(id), /digest/);
  assert.throws(() => createBaseTransfer(source, [piece("a"), piece("a")]), /duplicate/);
  const bad = piece("a"); bad.transform.rotation.w = 2;
  assert.throws(() => createBaseTransfer(source, [bad]), /quaternion/);
});
