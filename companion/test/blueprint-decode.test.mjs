import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkDeclaredThroughput,
  decodeWorldExport,
  isYawOnly,
  summarizeMachines,
  yawDegreesFromQuaternion,
} from "../lib/blueprint-decode.mjs";
import { renderBlueprintSheet, renderPlanViews } from "../lib/blueprint-sheet.mjs";

const DECODED_DIR = fileURLToPath(new URL("../../reference/blueprints/decoded/", import.meta.url));

function loadDecode(id) {
  return JSON.parse(fs.readFileSync(path.join(DECODED_DIR, `${id}.json`), "utf8"));
}

test("yaw comes out of a saved quaternion in degrees", () => {
  assert.equal(yawDegreesFromQuaternion({ x: 0, y: 0, z: 0, w: 1 }), 0);
  // The quaternion the game actually saves for a half turn.
  assert.equal(yawDegreesFromQuaternion({ x: 0, y: 0, z: 1, w: -4.07e-9 }), 180);
  assert.equal(yawDegreesFromQuaternion({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }), 90);
  // Normalised into [0, 360), never negative.
  assert.equal(yawDegreesFromQuaternion({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 }), 270);
});

test("a tilted quaternion is reported rather than flattened to yaw", () => {
  assert.equal(isYawOnly({ x: 0, y: 0, z: 1, w: 0 }), true);
  assert.equal(isYawOnly({ x: 0.3, y: 0, z: 0.5, w: 0.8 }), false);
});

test("machines group by class, recipe and clock together", () => {
  const groups = summarizeMachines([
    { role: "production", class_name: "ConstructorMk1", recipe: "Recipe_Screw", clock_percent: 75 },
    { role: "production", class_name: "ConstructorMk1", recipe: "Recipe_Screw", clock_percent: 75 },
    { role: "production", class_name: "ConstructorMk1", recipe: "Recipe_Screw", clock_percent: 100 },
    { role: "enclosure", class_name: "Wall_Concrete_8x4", recipe: null, clock_percent: null },
  ]);
  assert.equal(groups.length, 2, "a different clock is a different group");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].clock_percent, 75);
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].clock_percent, 100);
});

test("the throughput check divides the author's claim by machines and clock", () => {
  const check = checkDeclaredThroughput({ outputs: [{ amount_per_minute: 120, item_label: "Screw" }] }, [
    { class_name: "ConstructorMk1", recipe: "Recipe_Screw", clock_percent: 75, count: 4 },
  ]);
  assert.equal(check.status, "derived");
  assert.equal(check.implied_rate_per_machine_at_full_clock, 40);
  assert.match(check.caveat, /not a recipe rate/);
});

test("the throughput check refuses cases it cannot resolve", () => {
  assert.equal(checkDeclaredThroughput({ outputs: [] }, []).status, "not_attempted");
  const twoGroups = checkDeclaredThroughput({ outputs: [{ amount_per_minute: 1, item_label: "X" }] }, [
    { class_name: "A", recipe: "R1", clock_percent: 100, count: 1 },
    { class_name: "B", recipe: "R2", clock_percent: 100, count: 1 },
  ]);
  assert.equal(twoGroups.status, "not_attempted");
  const noClock = checkDeclaredThroughput({ outputs: [{ amount_per_minute: 1, item_label: "X" }] }, [
    { class_name: "A", recipe: "R1", clock_percent: null, count: 1 },
  ]);
  assert.equal(noClock.status, "not_attempted");
});

test("a world export rebases onto its own corner and keeps proxies out", () => {
  const decode = decodeWorldExport("example", {
    saveVersion: 60,
    buildVersion: 493833,
    data: [
      { parent: { className: "/Game/X/Build_Wall_Concrete_8x4.Build_Wall_Concrete_8x4_C", transform: { translation: [-100000, 50000, 400], rotation: [0, 0, 1, 0], scale3d: [1, 1, 1] } } },
      { parent: { className: "/Game/X/Build_Foundation_Concrete_8x1.Build_Foundation_Concrete_8x1_C", transform: { translation: [-99200, 50800, 0], rotation: [0, 0, 0, 1], scale3d: [1, 1, 1] } } },
      { parent: { className: "/Script/FactoryGame.FGBlueprintProxy", transform: { translation: [0, 0, 0] } } },
      { parent: { className: "/Script/FactoryGame.FGDroneStationInfo", transform: { translation: [0, 0, 0] } } },
    ],
  });

  assert.equal(decode.available, true);
  assert.equal(decode.totals.buildings, 2);
  assert.equal(decode.totals.blueprint_proxy_count, 1);
  assert.equal(decode.totals.non_buildable_actor_count, 1);
  // Rebased so the minimum corner is the origin, and the offset is kept.
  assert.deepEqual(decode.world_origin_cm, { x: -100000, y: 50000, z: 0 });
  const foundation = decode.buildings.find((b) => b.class_name === "Foundation_Concrete_8x1");
  assert.deepEqual(foundation.position_cm, { x: 800, y: 800, z: 0 });
  assert.deepEqual(foundation.grid_cells, { x: 1, y: 1 });
  const wall = decode.buildings.find((b) => b.class_name === "Wall_Concrete_8x4");
  assert.equal(wall.yaw_degrees, 180, "array-shaped rotations decode the same as object-shaped ones");
  assert.equal(decode.connection_topology.status, "not_available");
});

test("the plan view projects real cells and respects role priority", () => {
  const plan = renderPlanViews([
    // Same cell: a machine under a wall must read as the machine.
    { grid_cells: { x: 0, y: 0 }, height_m: 0, role: "enclosure" },
    { grid_cells: { x: 0.5, y: 0.5 }, height_m: 0, role: "production" },
    { grid_cells: { x: 1, y: 0 }, height_m: 0, role: "logistics" },
    { grid_cells: { x: 0, y: 1 }, height_m: 5, role: "power" },
  ]);
  assert.equal(plan.available, true);
  assert.equal(plan.width_cells, 2);
  assert.equal(plan.height_cells, 2);
  assert.equal(plan.levels_total, 2);
  const ground = plan.maps.find((map) => map.level === 0);
  assert.equal(ground.rows[0], "M=");
  const upper = plan.maps.find((map) => map.level === 1);
  assert.equal(upper.rows[1][0], "+");
});

test("the plan view refuses to draw a footprint it would have to truncate", () => {
  const wide = renderPlanViews(
    [
      { grid_cells: { x: 0, y: 0 }, height_m: 0, role: "enclosure" },
      { grid_cells: { x: 500, y: 0 }, height_m: 0, role: "enclosure" },
    ],
    { maxCells: 80 },
  );
  assert.equal(wide.available, false);
  assert.match(wide.reason, /larger than the 80-cell map limit/);
});

test("an undecodable blueprint renders a sheet that says so", () => {
  const sheet = renderBlueprintSheet({ available: false, name: "broken", reason: "blueprint_config_missing" });
  assert.match(sheet, /# broken/);
  assert.match(sheet, /blueprint_config_missing/);
});

test("the committed screw decode proves the clock explains the author's claim", () => {
  const decode = loadDecode("screw-120");
  assert.equal(decode.available, true);
  assert.deepEqual(decode.machine_groups, [
    { class_name: "ConstructorMk1", recipe: "Recipe_Screw", clock_percent: 75, count: 4 },
  ]);
  assert.equal(decode.throughput_check.status, "derived");
  assert.equal(decode.throughput_check.implied_rate_per_machine_at_full_clock, 40);
  assert.equal(decode.totals.buildings, 107);
  assert.equal(decode.connection_topology.reciprocal_connection_pair_count, 27);
});

test("every committed decode is complete and positioned", () => {
  const files = fs.readdirSync(DECODED_DIR).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 8, "decodes are committed for the whole library");

  for (const file of files) {
    const decode = JSON.parse(fs.readFileSync(path.join(DECODED_DIR, file), "utf8"));
    assert.equal(decode.available, true, `${file} decoded`);
    assert.ok(decode.buildings.length > 0, `${file} has buildings`);
    assert.ok(decode.class_paths, `${file} carries a class path index`);

    for (const building of decode.buildings) {
      assert.ok(building.class_name, `${file} building ${building.index} has a class`);
      assert.ok(building.grid_cells, `${file} building ${building.index} is positioned`);
      assert.ok(
        building.yaw_degrees >= 0 && building.yaw_degrees < 360,
        `${file} building ${building.index} yaw is normalised`,
      );
      assert.ok(decode.class_paths[building.class_name], `${file} class path resolves`);
    }

    // A world-export decode may cap its committed list; a designer blueprint
    // never may, because that is the artifact we would rebuild from.
    if (decode.source === "decoded_from_saved_native_blueprint") {
      assert.equal(decode.buildings.length, decode.totals.buildings, `${file} is untruncated`);
      assert.ok(decode.header.designer_dimensions.x > 0, `${file} has an envelope`);
    }
  }
});

test("every committed sheet carries the plan view", () => {
  const sheets = fs.readdirSync(DECODED_DIR).filter((file) => file.endsWith(".md"));
  assert.ok(sheets.length >= 8);
  for (const file of sheets) {
    const text = fs.readFileSync(path.join(DECODED_DIR, file), "utf8");
    assert.match(text, /## Plan view/, `${file} has a plan view section`);
    assert.match(text, /## Machines/, `${file} has a machine section`);
    assert.match(text, /## Every building/, `${file} lists buildings`);
  }
});
