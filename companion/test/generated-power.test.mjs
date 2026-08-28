import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { planGeneratedBlueprintPower } from "../lib/generated-power.mjs";
import { compileGeneratedBlueprint, generatedBlueprintAction } from "../lib/generated-blueprints.mjs";
import { validateAction } from "../lib/actions.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const BUILD_GUN = "/Game/FactoryGame/Equipment/BuildGun/BP_BuildGun.BP_BuildGun_C";
const POWER_CIRCUIT = "/Script/FactoryGame.FGPowerCircuit";

function connector(name, maxLinks) {
  return {
    component_name: name,
    component_class_path: "/Script/FactoryGame.FGPowerConnectionComponent",
    hidden: false,
    max_links: maxLinks,
    circuit_type_class_path: POWER_CIRCUIT,
    native_default_location_cm: { x: 0, y: 0, z: 200 },
  };
}

function addPowerCatalog(snapshot, { machineCapacity = 2, poleCapacity = 4 } = {}) {
  snapshot.content.items.push(
    {
      class_path: "Desc_SmelterMk1",
      name: "Smelter",
      available: true,
      building: {
        class_path: "Build_SmelterMk1_C",
        power_consumption_mw: 4,
        native_circuit_connections: [connector("PowerConnection", machineCapacity)],
        visible_circuit_connection_count: 1,
        visible_circuit_link_capacity: machineCapacity,
      },
    },
    {
      class_path: "Desc_PowerLine",
      name: "Power Line",
      available: true,
      building: {
        class_path: "Build_PowerLine_C",
        native_topology_kind: "power_wire",
        wire_max_length_cm: 10_000,
        native_circuit_connections: [],
        visible_circuit_connection_count: 0,
        visible_circuit_link_capacity: 0,
      },
    },
    {
      class_path: "Desc_PowerPoleMk1",
      name: "Power Pole Mk.1",
      available: true,
      building: {
        class_path: "Build_PowerPoleMk1_C",
        native_topology_kind: "power_pole",
        power_pole_type: "PPT_POLE",
        native_circuit_connections: [connector("PowerConnection", poleCapacity)],
        visible_circuit_connection_count: 1,
        visible_circuit_link_capacity: poleCapacity,
      },
    },
  );
  snapshot.content.recipes.push(
    {
      class_path: "Recipe_PowerLine",
      name: "Power Line",
      owner_mod: "FactoryGame",
      available: true,
      products: [{ item_class: "Desc_PowerLine", item_name: "Power Line", amount: 1 }],
      ingredients: [],
      produced_in: [BUILD_GUN],
    },
    {
      class_path: "Recipe_PowerPoleMk1",
      name: "Power Pole Mk.1",
      owner_mod: "FactoryGame",
      available: true,
      products: [{ item_class: "Desc_PowerPoleMk1", item_name: "Power Pole Mk.1", amount: 1 }],
      ingredients: [],
      produced_in: [BUILD_GUN],
    },
  );
  snapshot.content.available_recipe_count += 2;
  return snapshot;
}

function machine(step, { x = step * 1_000, y = 0, z = 800, commit = true } = {}) {
  return {
    action: "place_building",
    recipe_class: "Recipe_SmelterMk1",
    production_recipe_class: "Recipe_IngotIron",
    location: { x, y, z },
    exact_z: true,
    yaw: 0,
    generated_role: "machine",
    commit,
  };
}

test("one generated machine reserves its native connector without inventing an internal wire", () => {
  const graph = buildGraph(addPowerCatalog(buildFactorySnapshot(), { machineCapacity: 1 }));
  const result = planGeneratedBlueprintPower(graph, [machine(1)]);
  assert.equal(result.planned, true, JSON.stringify(result));
  assert.equal(result.mode, "single_external_machine_endpoint");
  assert.equal(result.poles, 0);
  assert.equal(result.wires, 0);
  assert.equal(result.external_connection.step, 1);
  assert.deepEqual(result.power_connections, []);
});

test("captured daisy-chain capacity produces exact physical machine wire edges", () => {
  const graph = buildGraph(addPowerCatalog(buildFactorySnapshot(), { machineCapacity: 2 }));
  const actions = [machine(1), machine(2)];
  const result = planGeneratedBlueprintPower(graph, actions);
  assert.equal(result.planned, true, JSON.stringify(result));
  assert.equal(result.mode, "native_machine_daisy_chain");
  assert.equal(result.poles, 0);
  assert.equal(result.wires, 1);
  assert.deepEqual(result.power_connections, [{
    recipe_class: "Recipe_PowerLine",
    from_step: 1,
    to_step: 2,
    from_connector_name: "PowerConnection",
    to_connector_name: "PowerConnection",
  }]);
  assert.equal(result.external_connection.step, 1);
});

test("single-link machines receive a minimal capacity-safe pole trunk with one external link reserved", () => {
  const graph = buildGraph(addPowerCatalog(buildFactorySnapshot(), {
    machineCapacity: 1,
    poleCapacity: 4,
  }));
  const actions = [
    machine(1, { x: 1_000 }),
    machine(2, { x: 2_000 }),
    machine(3, { x: 3_000 }),
    machine(4, { x: 4_000 }),
    { action: "place_belt", recipe_class: "Recipe_ConveyorBeltMk1", from_step: 1, to_step: 2, commit: true },
  ];
  const result = planGeneratedBlueprintPower(graph, actions, {
    shell_footprint: { origin_cm: { x: 0, y: -1_000, z: 0 } },
  });
  assert.equal(result.planned, true, JSON.stringify(result));
  assert.equal(result.mode, "captured_capacity_power_pole_trunk");
  assert.equal(result.poles, 2);
  assert.equal(result.wires, 5);
  assert.equal(result.external_connection.step, 5);
  assert.equal(result.actions[4].recipe_class, "Recipe_PowerPoleMk1");
  assert.equal(result.actions[5].recipe_class, "Recipe_PowerPoleMk1");
  assert.equal(result.actions[6].action, "place_belt");

  const degrees = new Map();
  for (const edge of result.power_connections) {
    degrees.set(edge.from_step, (degrees.get(edge.from_step) ?? 0) + 1);
    degrees.set(edge.to_step, (degrees.get(edge.to_step) ?? 0) + 1);
  }
  assert.equal(degrees.get(5), 3, "first pole keeps its fourth link free for the external grid");
  assert.equal(degrees.get(6), 3);
  assert.deepEqual(
    result.actions.slice(4, 6).map((action) => action.location.y),
    [-1_800, -1_800],
  );
});

test("missing native connector metadata remains unknown and emits no partial topology", () => {
  const snapshot = addPowerCatalog(buildFactorySnapshot());
  snapshot.content.items = snapshot.content.items.filter((item) => item.class_path !== "Desc_SmelterMk1");
  const result = planGeneratedBlueprintPower(buildGraph(snapshot), [machine(1), machine(2)]);
  assert.equal(result.planned, false);
  assert.equal(result.reason, "generated_machine_power_capability_is_not_authoritative");
  assert.deepEqual(result.unavailable.map((entry) => entry.step), [1, 2]);
});

test("obvious overlength power edges are refused before native staging", () => {
  const graph = buildGraph(addPowerCatalog(buildFactorySnapshot(), { machineCapacity: 2 }));
  const result = planGeneratedBlueprintPower(graph, [
    machine(1, { x: 0 }),
    machine(2, { x: 30_000 }),
  ]);
  assert.equal(result.planned, false);
  assert.equal(result.reason, "generated_machine_drop_exceeds_captured_wire_length");
  assert.equal(result.direct_chain_reason, "machine_chain_exceeds_captured_wire_length");
});

test("generated action validation rejects links beyond captured endpoint capacity", () => {
  const graph = buildGraph(addPowerCatalog(buildFactorySnapshot(), { machineCapacity: 1 }));
  const compiled = compileGeneratedBlueprint({
    blueprint_name: "Overloaded native connector",
    actions: [machine(1), machine(2), machine(3)],
    power_connections: [
      { recipe_class: "Recipe_PowerLine", from_step: 1, to_step: 2 },
      { recipe_class: "Recipe_PowerLine", from_step: 1, to_step: 3 },
    ],
  });
  assert.equal(compiled.compiled, true, JSON.stringify(compiled));
  const result = validateAction(graph, generatedBlueprintAction(compiled, { commit: true }));
  assert.equal(result.valid, false);
  assert.equal(result.reason, "generated_power_endpoint_exceeds_captured_native_capacity");
  assert.equal(result.part_id, "part-0001");
  assert.equal(result.requested_links, 2);
  assert.equal(result.captured_max_links, 1);
});

test("snapshot and generator source pin native capacity and physical wire-length readback", () => {
  const snapshotSource = readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactorySnapshot.cpp", import.meta.url),
    "utf8",
  );
  const exportSource = readFileSync(
    new URL("../../Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp", import.meta.url),
    "utf8",
  );
  assert.match(snapshotSource, /native_circuit_connections/);
  assert.match(snapshotSource, /GetMaxNumConnections\(\)/);
  assert.match(snapshotSource, /GetPowerPoleType\(\)/);
  assert.match(snapshotSource, /wire_max_length_cm/);
  assert.match(snapshotSource, /UFGBuildingDescriptor::GetPowerConsumption/);
  assert.match(exportSource, /generated_power_wire_exceeds_native_length/);
  assert.match(exportSource, /WireDefault->mMaxLength/);
  assert.match(exportSource, /From->GetComponentLocation\(\)/);
  assert.match(exportSource, /To->GetComponentLocation\(\)/);
});
