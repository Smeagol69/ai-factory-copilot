import assert from "node:assert/strict";
import test from "node:test";
import { deriveSnapshotFacts } from "../lib/analysis.mjs";

test("derives exact registry-unit rates without selecting alternate recipes", () => {
  const facts = deriveSnapshotFacts({
    world_revision: 9,
    content: {
      recipes: [
        {
          class_path: "Recipe_Rotor",
          name: "Rotor",
          duration_seconds: 15,
          ingredients: [{ item_class: "IronRod", item_name: "Iron Rod", amount: 5 }],
          products: [{ item_class: "Rotor", item_name: "Rotor", amount: 1 }],
          produced_in: ["Constructor"],
        },
      ],
    },
    actors: [],
  });
  assert.equal(facts.world_revision, 9);
  assert.equal(facts.recipe_rates[0].cycles_per_minute_at_recipe_base_time, 4);
  assert.equal(facts.recipe_rates[0].ingredients[0].registry_units_per_minute, 20);
  assert.equal(facts.recipe_rates[0].products[0].registry_units_per_minute, 4);
});

test("uses live cycle time and reported production boost for a manufacturer", () => {
  const facts = deriveSnapshotFacts({
    content: {
      recipes: [
        {
          class_path: "Recipe_X",
          duration_seconds: 10,
          ingredients: [{ item_class: "A", amount: 2 }],
          products: [{ item_class: "B", amount: 3 }],
        },
      ],
    },
    actors: [
      {
        actor_id: "Machine_1",
        class_path: "Build_Machine",
        owner_mod: "FactoryGame",
        manufacturer: { recipe_class: "Recipe_X" },
        factory: {
          production_cycle_seconds: 5,
          current_production_boost: 2,
          is_producing: true,
        },
      },
    ],
  });
  const machine = facts.live_manufacturers[0];
  assert.equal(machine.cycles_per_minute, 12);
  assert.equal(machine.ingredients[0].registry_units_per_minute, 24);
  assert.equal(machine.base_products[0].registry_units_per_minute, 36);
  assert.equal(
    machine.products_after_reported_production_boost[0].registry_units_per_minute,
    72,
  );
});

test("derives exact player-relative spatial facts", () => {
  const facts = deriveSnapshotFacts({
    interaction_context: {
      player: { pawn_location: { x: 100, y: 200, z: 300 } },
      preferred_target: {
        available: true,
        actor_id: "Build_Target",
        hit_location: { x: 400, y: 200, z: 300 },
      },
    },
    actors: [
      {
        actor_id: "Build_Near",
        location: { x: 400, y: 600, z: 300 },
        kind: "buildable",
      },
    ],
  });
  assert.equal(facts.spatial_context.player_location_cm.x, 100);
  assert.equal(facts.spatial_context.preferred_target.actor_id, "Build_Target");
  assert.equal(facts.spatial_context.nearest_actors[0].distance_meters, 5);
});
