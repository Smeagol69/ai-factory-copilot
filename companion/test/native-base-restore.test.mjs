import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBaseTransfer } from "../lib/base-transfer.mjs";
import { compileNativeBaseArchive } from "../../scripts/lib/native-base-archive.mjs";
import { validateAction, validatePlan } from "../lib/actions.mjs";
import { answerLocally } from "../lib/router.mjs";
import { buildGraph } from "../lib/graph.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

function fixture() {
  const id = "Persistent_Level:PersistentLevel.Build_Fixture_0";
  const transform = { translation: { x: 296518.1594721499, y: -147761.1640091523, z: 4484.938640674662 },
    rotation: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } };
  const classPath = "/Fixture/Build_Fixture.Build_Fixture_C";
  const object = { type: "SaveEntity", typePath: classPath, instanceName: id, rootObject: "Persistent_Level",
    needTransform: true, wasPlacedInLevel: false, parentEntityName: "", parentObject: { levelName: "", pathName: "" },
    components: [], transform, flags: 8, properties: {
      mSelf: { name: "mSelf", type: "ObjectProperty", propertyTagType: { name: "ObjectProperty", children: [] }, value: { levelName: "Persistent_Level", pathName: id } },
    }, specialProperties: { type: "EmptySpecialProperties" }, trailingData: [], saveCustomVersion: 60 };
  const row = { instance_name: id, level_key: "Persistent_Level", class_path: classPath, raw_record: object };
  const manifest = createBaseTransfer({ save_sha256: "a".repeat(64), map_name: "Persistent_Level", build_version: 502094 },
    [{ id, kind: "actor", class_path: classPath, transform }]);
  const state = { actors: [row], components: [], lightweight: [] };
  const save = { header: { saveVersion: 60, buildVersion: 502094 }, levels: { Persistent_Level: { objects: [object] } },
    compressionInfo: { packageFileTag: 2653586369, chunkHeaderVersion: 0x22222222, maxUncompressedChunkContentSize: 131072, compressionAlgorithm: 3 },
    objectVersionData: { saveObjectVersionDataVersion: 0, packageFileVersion: { ue4Version: 522, ue5Version: 1017 }, licenceVersion: 3,
      engineVersion: { major: 5, minor: 6, patch: 1, changelist: 502094, branch: "fixture" }, customVersionContainer: { versions: [] } } };
  return { manifest, state, save };
}

test("native actor archive roundtrips saved properties and carries exact doubles separately from float TOC", () => {
  const f = fixture(), before = structuredClone(f);
  const result = compileNativeBaseArchive(f.manifest, f.state, f.save);
  assert.ok(result.sbp.length > 0);
  assert.equal(result.runtime.actors[0].archive_location.x, Math.fround(f.manifest.pieces[0].transform.translation.x));
  assert.equal(result.runtime.actors[0].transform.translation.x, f.manifest.pieces[0].transform.translation.x);
  assert.match(result.runtime.actors[0].archive_name, /AIFactoryBase_aaaaaaaaaaaaaaaa_0$/);
  assert.deepEqual(result.runtime.required_assets, [f.manifest.pieces[0].class_path]);
  assert.equal(result.runtime.geometry_verified, false);
  assert.deepEqual(f, before);
});

test("native archive preserves byte properties after JSON preparation omits undefined enum metadata", () => {
  const f = fixture();
  f.state.actors[0].raw_record.properties.mColorSlot = {
    type: "ByteProperty", name: "mColorSlot",
    propertyTagType: { name: "ByteProperty", children: [] }, value: { value: 18 },
  };
  const before = structuredClone(f);
  // The archive compiler reparses and compares every saved property. The
  // parser adds value.type: undefined for a byte without an enum type.
  assert.ok(compileNativeBaseArchive(f.manifest, f.state, f.save).sbp.length > 0);
  assert.deepEqual(f, before);
});

test("native packaging refuses unsupported versions, incomplete state and ambiguous loader identity", () => {
  const f = fixture(); f.save.header.saveVersion = 59;
  assert.throws(() => compileNativeBaseArchive(f.manifest, f.state, f.save), /version/);
  f.save.header.saveVersion = 60; f.state.actors = [];
  assert.throws(() => compileNativeBaseArchive(f.manifest, f.state, f.save), /count/);
  const g = fixture(), second = structuredClone(g.state.actors[0]);
  second.instance_name += "2"; second.raw_record.instanceName = second.instance_name;
  g.state.actors.push(second);
  g.manifest = createBaseTransfer(g.manifest.source, [...g.manifest.pieces, { ...g.manifest.pieces[0], id: second.instance_name }]);
  assert.throws(() => compileNativeBaseArchive(g.manifest, g.state, g.save), /Ambiguous/);
});

test("Copilot restores a named base locally, stamps the revision and cannot accept model coordinates", () => {
  const graph = buildGraph(buildFactorySnapshot()), emitted = [];
  const reply = answerLocally("restore base chatgpt", graph, { actions: { emit: actions => emitted.push(...actions) } });
  assert.ok(reply);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "restore_base"); assert.equal(emitted[0].base_name, "chatgpt"); assert.equal(emitted[0].commit, true);
  assert.ok(emitted[0].expect_world_revision);
  assert.equal(validateAction(graph, { action: "restore_base", base_name: "../chatgpt" }).valid, false);
  assert.equal(validateAction(graph, { action: "restore_base", base_name: "chatgpt", location: { x: 1, y: 2, z: 3 } }).reason, "base_restore_uses_saved_transforms_only");
  assert.equal(validatePlan(graph, [emitted[0], { action: "teleport_player", target: { x: 1, y: 2, z: 3 }, commit: true }]).reason, "base_restore_must_be_a_standalone_commit");
  const check = [];
  answerLocally("check base chatgpt", graph, { actions: { emit: actions => check.push(...actions) } });
  assert.equal(check[0].commit, false);
});

test("native restore applies saved transforms, verifies lightweight customization and cleans failed imports", () => {
  const native = fs.readFileSync(new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBaseRestore.cpp", import.meta.url), "utf8");
  const actions = fs.readFileSync(new URL("../../Source/AIFactoryCopilot/Private/AIFactoryActions.cpp", import.meta.url), "utf8");
  assert.match(native, /LoadStoredBlueprint\(Descriptor, FTransform::Identity/);
  assert.match(native, /saved_base_transfer_no_material_charge/);
  assert.doesNotMatch(native, /GetNoBuildCost|base_restore_requires_no_build_cost_mode/);
  assert.match(native, /SetActorTransform\(Match->Exact/);
  assert.match(native, /FRuntimeBuildableInstanceData RuntimeData = Instance.Data/);
  assert.match(native, /Observed->TypeSpecificData.Identical\(Instance.Data.TypeSpecificData\)/);
  assert.match(native, /created_buildables_removed/);
  assert.match(native, /Before.Contains\(\*It\)/);
  assert.doesNotMatch(native, /PositionAndValidateActionHologram|SnapToGround|TeleportPlayer/);
  assert.match(actions, /if \(Result.bCommitted\) RecordActionUndo\(MoveTemp\(Step\)\)/);
});
