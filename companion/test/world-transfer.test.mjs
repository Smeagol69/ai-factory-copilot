import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { inspectParsedWorld } from "../../scripts/lib/world-transfer.mjs";
import { compilePlayerMegaprint, encodeMegaprint, selectPlayerBase } from "../../scripts/lib/player-base-transfer.mjs";

const BUILDING = "/Fixture/Build_Test.Build_Test_C";
const LIGHT = "/Fixture/Build_Floor.Build_Floor_C";
const ID = "Persistent_Level:PersistentLevel.Build_Test_1";
const transform = () => ({ translation: { x: 296518.1594721499, y: -147761.1640091523, z: 4484.938640674662 },
  rotation: { x: -0, y: 0, z: -0.42261826174069944, w: 0.9063077870366498 }, scale3d: { x: 1, y: 2, z: 1 } });
const entity = (id, type = BUILDING) => ({ type: "SaveEntity", typePath: type,
  instanceName: id, needTransform: true, wasPlacedInLevel: false, transform: transform(), properties: {},
  parentObject: { pathName: "" }, components: [], trailingData: [], specialProperties: { type: "EmptySpecialProperties" } });
const scim = (source, name = source.instanceName) => ({ className: source.typePath, pathName: name,
  transform: { translation: [source.transform.translation.x, source.transform.translation.y, source.transform.translation.z],
    rotation: [source.transform.rotation.x, source.transform.rotation.y, source.transform.rotation.z, source.transform.rotation.w],
    scale3d: [source.transform.scale3d.x, source.transform.scale3d.y, source.transform.scale3d.z] }, properties: [] });
function fixture() {
  const building = entity(ID);
  building.components.push({ pathName: ID + ".Power" });
  const component = { type: "SaveComponent", typePath: "/Script/FactoryGame.FGPowerConnectionComponent",
    instanceName: ID + ".Power", parentEntityName: ID, properties: {}, trailingData: [0, 0, 0, 0] };
  const mapActor = entity("MapNode", "/Fixture/ResourceNode");
  mapActor.wasPlacedInLevel = true; mapActor.needTransform = false;
  const player = entity("Player", "/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C");
  const subsystem = entity("LightweightSubsystem", "/Script/FactoryGame.FGLightweightBuildableSubsystem");
  subsystem.needTransform = false;
  subsystem.specialProperties = { type: "BuildableSubsystemSpecialProperties", currentLightweightVersion: 4,
    buildables: [{ typeReference: { pathName: LIGHT }, instances: [
      { transform: transform(), usedRecipe: { pathName: "/Fixture/Recipe" }, usedSwatchSlot: { pathName: "/Fixture/Swatch" } },
      { transform: transform(), usedRecipe: { pathName: "" }, usedSwatchSlot: { pathName: "" } },
    ] }] };
  const save = { header: { saveVersion: 60, buildVersion: 502094 }, levels: {
    Persistent_Level: { name: "Persistent_Level", objects: [building, component, mapActor, player, subsystem], collectables: [] },
  } };
  const snapshot = { content: { items: [{ building: { class_path: BUILDING } }] } };
  const nativeActor = scim(building);
  nativeActor.children = building.components;
  const light = scim({ typePath: LIGHT, transform: transform() }, "LB_floor_1");
  const state = { header: { ...save.header }, objects: { [ID]: nativeActor, [component.instanceName]: {
    className: component.typePath, pathName: component.instanceName, outerPathName: ID, properties: [],
  }, [light.pathName]: light } };
  return { save, snapshot, state, building, subsystem };
}

test("base selection excludes player, map actors and dismantled lightweight slots", () => {
  const { save, snapshot } = fixture();
  const result = selectPlayerBase(save, snapshot);
  assert.equal(result.actors.length, 1);
  assert.equal(result.lightweight.length, 1);
  assert.equal(result.deleted_lightweight.length, 1);
  const census = inspectParsedWorld(save);
  assert.deepEqual(census.records.find((record) => record.instance_name === "MapNode").transform, transform());
  assert.equal(census.records.find((record) => record.instance_name === "MapNode").apply_saved_transform, false);
});

test("Megaprint contains every selected actor, component and active instance without changing transforms", () => {
  const { save, snapshot, state } = fixture();
  const before = structuredClone({ save, snapshot, state });
  const result = compilePlayerMegaprint(save, snapshot, state);
  result.clipboard.note = "__aifactory_negative_zero__";
  assert.equal(result.report.counts.player_placed_pieces, 2);
  assert.equal(result.report.counts.components, 1);
  assert.equal(result.report.counts.excluded_deleted_lightweight_slots, 1);
  const bytes = encodeMegaprint(result.clipboard);
  const decoded = JSON.parse(inflateSync(bytes));
  assert.deepEqual(decoded, result.clipboard);
  assert.ok(Object.is(decoded.data[0].parent.transform.rotation[0], -0));
  assert.deepEqual({ save, snapshot, state }, before);
});

test("one missing piece or changed coordinate refuses export rather than producing a partial base", () => {
  for (const mutation of [
    (f) => { delete f.state.objects.LB_floor_1; },
    (f) => { f.state.objects[ID].transform.translation[0] += 0.001; },
    (f) => { delete f.state.objects[ID + ".Power"]; },
    (f) => { f.state.header.saveVersion = 59; },
  ]) {
    const f = fixture(); mutation(f);
    assert.throws(() => compilePlayerMegaprint(f.save, f.snapshot, f.state));
  }
});

test("coincident lightweight instances retain multiplicity and are not deduplicated", () => {
  const { save, snapshot, state, subsystem } = fixture();
  subsystem.specialProperties.buildables[0].instances.push(structuredClone(subsystem.specialProperties.buildables[0].instances[0]));
  state.objects.LB_floor_2 = { ...structuredClone(state.objects.LB_floor_1), pathName: "LB_floor_2" };
  const result = compilePlayerMegaprint(save, snapshot, state);
  assert.equal(result.report.counts.active_lightweight, 2);
  assert.equal(result.clipboard.data.length, 3);
});

test("unknown dynamic actors and ambiguous lightweight validity remain explicit failures", () => {
  const f = fixture();
  f.save.levels.Persistent_Level.objects.push(entity("Unknown", "/NewMod/Unknown"));
  assert.throws(() => selectPlayerBase(f.save, f.snapshot), /Unclassified/);
  f.save.levels.Persistent_Level.objects.pop();
  f.subsystem.specialProperties.buildables[0].instances[0].usedSwatchSlot.pathName = "";
  assert.throws(() => selectPlayerBase(f.save, f.snapshot), /Ambiguous/);
});

test("explicit N-gon assembly references retain generated recipe-less pieces", () => {
  const f = fixture();
  f.building.typePath = "/NgonFoundations/Buildables/Build_DodNFWhole4m.Build_DodNFWhole4m_C";
  f.snapshot.content.items[0].building.class_path = f.building.typePath;
  f.building.properties.DodNumToBuild4 = { values: [{ pathName: "NgonPiece" }] };
  const piece = entity("NgonPiece", "/NgonFoundations/Buildables/Build_DodNFPiece4m.Build_DodNFPiece4m_C");
  f.save.levels.Persistent_Level.objects.push(piece);
  assert.equal(selectPlayerBase(f.save, f.snapshot).actors.length, 2);
  f.save.levels.Persistent_Level.objects.pop();
  assert.throws(() => selectPlayerBase(f.save, f.snapshot), /Missing N-gon/);
});

test("whole power circuits are preserved and external circuit members refuse a partial copy", () => {
  const f = fixture();
  const circuit = { className: "/Script/FactoryGame.FGPowerCircuit", pathName: "Circuit_7", properties: [
    { name: "mComponents", value: { values: [{ pathName: ID + ".Power" }] } },
  ] };
  f.state.objects.Circuit_7 = circuit;
  const result = compilePlayerMegaprint(f.save, f.snapshot, f.state);
  assert.deepEqual(result.clipboard.powerCircuits.Circuit_7, circuit);
  circuit.properties[0].value.values.push({ pathName: "UnselectedMachine.Power" });
  assert.throws(() => compilePlayerMegaprint(f.save, f.snapshot, f.state), /outside selected base/);
});

test("external resource identities stay references and missing source objects are reported", () => {
  const f = fixture();
  f.state.objects[ID].properties = [{ name: "mExtractableResource", value: { pathName: "Node200" } },
    { name: "mLocker", value: { pathName: "MissingLocker" } }];
  f.state.objects.Node200 = { className: "/Fixture/ResourceNode", pathName: "Node200", properties: [] };
  const result = compilePlayerMegaprint(f.save, f.snapshot, f.state);
  assert.equal(result.clipboard.data.length, 2);
  assert.equal(result.report.external_references.find((ref) => ref.path_name === "Node200").source_record_present, true);
  assert.equal(result.report.external_references.find((ref) => ref.path_name === "MissingLocker").source_record_present, false);
  assert.equal(result.report.verification.in_game_spawn_verified, false);
});
