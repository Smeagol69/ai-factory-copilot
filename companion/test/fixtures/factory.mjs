/**
 * A small but complete factory snapshot in the exact shape the mod emits.
 *
 * Chain: miner -> belt -> smelter -> belt -> constructor, plus an oil refinery
 * on a pipeline, a coal generator, and a player. Circuit 2 is healthy; circuit 1
 * is in deficit. The smelter is starved and the miner upstream of it is on
 * standby, so root-cause walking has something real to walk.
 */

const LEVEL = "/Game/FactoryMap.FactoryMap:PersistentLevel";

export const MINER = `${LEVEL}.Build_MinerMk1_C_1`;
export const BELT_ORE = `${LEVEL}.Build_ConveyorBeltMk1_C_1`;
export const SMELTER = `${LEVEL}.Build_SmelterMk1_C_1`;
export const BELT_INGOT = `${LEVEL}.Build_ConveyorBeltMk1_C_2`;
export const CONSTRUCTOR = `${LEVEL}.Build_ConstructorMk1_C_1`;
export const GENERATOR = `${LEVEL}.Build_GeneratorCoal_C_1`;
export const REFINERY = `${LEVEL}.Build_OilRefinery_C_1`;
export const PIPELINE = `${LEVEL}.Build_Pipeline_C_1`;
export const PLAYER = `${LEVEL}.Char_Player_C_1`;
export const ORE_NODE = `${LEVEL}.BP_ResourceNode_C_1`;

function factoryConnection(component, direction, peer, connected = true) {
  return {
    kind: "factory",
    component,
    direction,
    connected,
    connected_component: connected ? peer : "",
    location: { x: 0, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    inventory_access_index: 0,
  };
}

function pipeConnection(component, direction, peer, fluidClass, connected = true) {
  return {
    kind: "pipe",
    component,
    direction,
    connected,
    connected_component: connected ? peer : "",
    location: { x: 0, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    fluid_class: fluidClass,
  };
}

function powerConnection(component, circuit) {
  return { kind: "power", component, connected: true, circuit };
}

const CIRCUIT_DEFICIT = {
  circuit_id: 1,
  fuse_triggered: false,
  production_capacity_mw: 75,
  maximum_consumption_mw: 100,
  battery_store_mwh: 5,
  battery_capacity_mwh: 20,
  battery_input_mw: 0,
  battery_output_mw: 25,
};

const CIRCUIT_HEALTHY = {
  circuit_id: 2,
  fuse_triggered: false,
  production_capacity_mw: 100,
  maximum_consumption_mw: 50,
  battery_store_mwh: 0,
  battery_capacity_mwh: 0,
  battery_input_mw: 0,
  battery_output_mw: 0,
};

function factoryState(overrides = {}) {
  return {
    is_producing: true,
    production_status: "IS_PRODUCING",
    productivity: 1,
    production_progress: 0.5,
    production_cycle_seconds: 2,
    default_production_cycle_seconds: 2,
    current_potential: 1,
    pending_potential: 1,
    max_potential: 2.5,
    current_production_boost: 1,
    pending_production_boost: 1,
    producing_power_consumption_mw: 4,
    idle_power_consumption_mw: 0,
    ...overrides,
  };
}

export function buildFactorySnapshot(overrides = {}) {
  const snapshot = {
    schema: "aifactory.snapshot",
    schema_version: 1,
    data_policy: "authoritative_or_explicitly_unknown",
    world_revision: 41,
    generated_at_utc: "2026-07-27T00:00:00.000Z",
    units: { positions_and_extents: "unreal_centimeters" },
    world: { map: "FactoryMap", net_mode: "NM_Standalone", scan_radius_meters: -1 },
    interaction_context: {
      captured_at_utc: "2026-07-27T00:00:00.000Z",
      player: { pawn_available: true, pawn_id: PLAYER, pawn_location: { x: 0, y: 0, z: 0 } },
      preferred_target: { available: true, selected_from: "game_cached_interaction", actor_id: SMELTER },
    },
    mods: [{ reference: "AIFactoryCopilot", version: "0.3.0" }],
    progression: {
      highest_available_tech_tier: 5,
      purchased_schematics: [{ class_path: "Schematic_Tier1", name: "Base Building", owner_mod: "FactoryGame" }],
      onboarding: {
        available: true,
        tutorial_completed: false,
        current_step: {
          available: true,
          title: "Build the HUB",
          objectives: ["Select the HUB in the build menu and place it."],
        },
      },
      active_schematic: { available: false },
      game_phase: { available: true, current: { available: true, name: "Establishing Phase" } },
      todo_lists: { available: true, public: "", private: "" },
    },
    visible_ui: {
      available: true,
      source: "active local viewport's rendered Unreal UMG widget trees; no screenshot or OCR",
      certainty: "authoritative_at_capture_time",
      rendered_text_count: 2,
      captured_text_count: 2,
      truncated: false,
      rendered_text: [
        {
          text: "Objective:",
          widget_name: "ObjectiveLabel",
          widget_class: "/Script/UMG.TextBlock",
          user_widget_class: "/Game/FactoryGame/Interface/UI/InGame/Tutorial/WBP_Tutorial",
          owner_mod: "FactoryGame",
        },
        {
          text: "Build the HUB",
          widget_name: "ObjectiveText",
          widget_class: "/Script/UMG.TextBlock",
          user_widget_class: "/Game/FactoryGame/Interface/UI/InGame/Tutorial/WBP_Tutorial",
          owner_mod: "FactoryGame",
        },
      ],
    },
    completeness: { actor_limit_reached: false, actor_limit: 5000 },
    content: {
      availability_known: true,
      available_recipe_count: 5,
      unavailable_recipe_count: 0,
      items: [
        { class_path: "Desc_OreIron", name: "Iron Ore", form: "RF_SOLID", stack_size: 100 },
        { class_path: "Desc_IronIngot", name: "Iron Ingot", form: "RF_SOLID", stack_size: 100 },
        { class_path: "Desc_IronRod", name: "Iron Rod", form: "RF_SOLID", stack_size: 100 },
        { class_path: "Desc_IronPlate", name: "Iron Plate", form: "RF_SOLID", stack_size: 200 },
        { class_path: "Desc_LiquidOil", name: "Crude Oil", form: "RF_LIQUID", stack_size: 0 },
        { class_path: "Desc_Plastic", name: "Plastic", form: "RF_SOLID", stack_size: 200 },
      ],
      recipes: [
        {
          class_path: "Recipe_IngotIron",
          name: "Iron Ingot",
          owner_mod: "FactoryGame",
          available: true,
          duration_seconds: 2,
          ingredients: [{ item_class: "Desc_OreIron", item_name: "Iron Ore", amount: 1 }],
          products: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 1 }],
          produced_in: ["Build_SmelterMk1_C"],
        },
        {
          class_path: "Recipe_IronRod",
          name: "Iron Rod",
          owner_mod: "FactoryGame",
          available: true,
          duration_seconds: 4,
          ingredients: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 1 }],
          products: [{ item_class: "Desc_IronRod", item_name: "Iron Rod", amount: 1 }],
          produced_in: ["Build_ConstructorMk1_C"],
        },
        {
          class_path: "Recipe_Alternate_IronRod",
          name: "Alternate: Steel Rod",
          owner_mod: "FactoryGame",
          available: true,
          duration_seconds: 5,
          ingredients: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 1 }],
          products: [{ item_class: "Desc_IronRod", item_name: "Iron Rod", amount: 4 }],
          produced_in: ["Build_ConstructorMk1_C"],
        },
        {
          class_path: "Recipe_Plastic",
          name: "Plastic",
          owner_mod: "FactoryGame",
          available: true,
          duration_seconds: 6,
          ingredients: [{ item_class: "Desc_LiquidOil", item_name: "Crude Oil", amount: 3000 }],
          products: [{ item_class: "Desc_Plastic", item_name: "Plastic", amount: 2 }],
          produced_in: ["Build_OilRefinery_C"],
        },
        {
          class_path: "Recipe_SmelterMk1",
          name: "Smelter",
          owner_mod: "FactoryGame",
          available: true,
          duration_seconds: 1,
          ingredients: [
            { item_class: "Desc_IronRod", item_name: "Iron Rod", amount: 5 },
            { item_class: "Desc_IronPlate", item_name: "Iron Plate", amount: 5 },
          ],
          products: [{ item_class: "Desc_SmelterMk1", item_name: "Smelter", amount: 1 }],
          produced_in: ["BP_BuildGun_C"],
        },
      ],
    },
    actors: [
      {
        actor_id: MINER,
        name: "Build_MinerMk1_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/MinerMk1.Build_MinerMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 0, y: 0, z: 0 },
        built_with_recipe: "Recipe_MinerMk1",
        inside_blueprint_designer: false,
        connections: [
          factoryConnection(`${MINER}.OutputConnection0`, "FCD_OUTPUT", `${BELT_ORE}.ConnectionAny0`),
          powerConnection(`${MINER}.PowerConnection`, CIRCUIT_HEALTHY),
        ],
        inventories: [
          {
            component: `${MINER}.OutputInventory`,
            slots: 1,
            stacks: [{ item_class: "Desc_OreIron", item_name: "Iron Ore", amount: 50 }],
          },
        ],
        factory: factoryState({
          is_producing: false,
          production_status: "IS_STANDBY",
          production_cycle_seconds: 1,
          default_production_cycle_seconds: 1,
        }),
        extractor: {
          items_per_cycle: 1,
          items_per_cycle_converted: 1,
          extraction_per_minute: 60,
          extractable_resource_actor_id: ORE_NODE,
        },
        reflected_properties: [
          { name: "mItemsPerCycle", cpp_type: "int32", value: "1", source: "unreal_reflection", certainty: "authoritative" },
          { name: "mExtractCycleTime", cpp_type: "float", value: "1.0", source: "unreal_reflection", certainty: "authoritative" },
        ],
      },
      {
        actor_id: ORE_NODE,
        name: "BP_ResourceNode_C_1",
        class_path: "/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C",
        owner_mod: "FactoryGame",
        kind: "resource_node",
        location: { x: 0, y: 0, z: -100 },
        occupied: true,
        resource_class: "Desc_OreIron",
        resource_name: "Iron Ore",
        node_type: "RNT_Standard",
        purity: "RP_Normal",
        amount_type: "RA_Infinite",
        has_resources: true,
        inventories: [],
        connections: [],
      },
      {
        actor_id: BELT_ORE,
        name: "Build_ConveyorBeltMk1_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 400, y: 0, z: 0 },
        built_with_recipe: "Recipe_ConveyorBeltMk1",
        connections: [
          factoryConnection(`${BELT_ORE}.ConnectionAny0`, "FCD_INPUT", `${MINER}.OutputConnection0`),
          factoryConnection(`${BELT_ORE}.ConnectionAny1`, "FCD_OUTPUT", `${SMELTER}.InputConnection0`),
        ],
        inventories: [],
        transport: { kind: "conveyor", reported_speed: 120, item_spacing_cm: 120, reported_length: 800, available_space: 4, items_on_segment: 3 },
      },
      {
        actor_id: SMELTER,
        name: "Build_SmelterMk1_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/SmelterMk1.Build_SmelterMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 800, y: 0, z: 0 },
        built_with_recipe: "Recipe_SmelterMk1",
        connections: [
          factoryConnection(`${SMELTER}.InputConnection0`, "FCD_INPUT", `${BELT_ORE}.ConnectionAny1`),
          factoryConnection(`${SMELTER}.OutputConnection0`, "FCD_OUTPUT", `${BELT_INGOT}.ConnectionAny0`),
          powerConnection(`${SMELTER}.PowerConnection`, CIRCUIT_HEALTHY),
        ],
        inventories: [
          { component: `${SMELTER}.InputInventory`, slots: 1, stacks: [] },
          { component: `${SMELTER}.OutputInventory`, slots: 1, stacks: [] },
        ],
        factory: factoryState({ is_producing: false, production_status: "IS_STANDBY", productivity: 0 }),
        manufacturer: { recipe_class: "Recipe_IngotIron", recipe_name: "Iron Ingot", manufacturing_speed: 1 },
      },
      {
        actor_id: BELT_INGOT,
        name: "Build_ConveyorBeltMk1_C_2",
        class_path: "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 1200, y: 0, z: 0 },
        connections: [
          factoryConnection(`${BELT_INGOT}.ConnectionAny0`, "FCD_INPUT", `${SMELTER}.OutputConnection0`),
          factoryConnection(`${BELT_INGOT}.ConnectionAny1`, "FCD_OUTPUT", `${CONSTRUCTOR}.InputConnection0`),
        ],
        inventories: [],
        // Deliberately narrow: 40 / 2 = 20 items per minute against 30 supplied.
        transport: { kind: "conveyor", reported_speed: 40, item_spacing_cm: 120, reported_length: 600, available_space: 0, items_on_segment: 9 },
      },
      {
        actor_id: CONSTRUCTOR,
        name: "Build_ConstructorMk1_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/ConstructorMk1.Build_ConstructorMk1_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 1600, y: 0, z: 0 },
        built_with_recipe: "Recipe_ConstructorMk1",
        connections: [
          factoryConnection(`${CONSTRUCTOR}.InputConnection0`, "FCD_INPUT", `${BELT_INGOT}.ConnectionAny1`),
          factoryConnection(`${CONSTRUCTOR}.OutputConnection0`, "FCD_OUTPUT", "", false),
          powerConnection(`${CONSTRUCTOR}.PowerConnection`, CIRCUIT_DEFICIT),
        ],
        inventories: [
          {
            component: `${CONSTRUCTOR}.InputInventory`,
            slots: 1,
            stacks: [{ item_class: "Desc_IronIngot", item_name: "Iron Ingot", amount: 10 }],
          },
        ],
        factory: factoryState({ production_cycle_seconds: 4, default_production_cycle_seconds: 4 }),
        manufacturer: { recipe_class: "Recipe_IronRod", recipe_name: "Iron Rod", manufacturing_speed: 1 },
      },
      {
        actor_id: GENERATOR,
        name: "Build_GeneratorCoal_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/GeneratorCoal.Build_GeneratorCoal_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 2000, y: 0, z: 0 },
        connections: [powerConnection(`${GENERATOR}.PowerConnection`, CIRCUIT_DEFICIT)],
        inventories: [],
        factory: factoryState({ producing_power_consumption_mw: 0, idle_power_consumption_mw: 0 }),
      },
      {
        actor_id: REFINERY,
        name: "Build_OilRefinery_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/OilRefinery.Build_OilRefinery_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 2400, y: 0, z: 0 },
        connections: [
          pipeConnection(`${REFINERY}.PipeInput0`, "PCT_CONSUMER", `${PIPELINE}.PipeConnection1`, "Desc_LiquidOil"),
          powerConnection(`${REFINERY}.PowerConnection`, CIRCUIT_HEALTHY),
        ],
        inventories: [
          {
            component: `${REFINERY}.InputInventory`,
            slots: 2,
            stacks: [{ item_class: "Desc_LiquidOil", item_name: "Crude Oil", amount: 3000 }],
          },
        ],
        factory: factoryState({ production_cycle_seconds: 6, default_production_cycle_seconds: 6 }),
        manufacturer: { recipe_class: "Recipe_Plastic", recipe_name: "Plastic", manufacturing_speed: 1 },
      },
      {
        actor_id: PIPELINE,
        name: "Build_Pipeline_C_1",
        class_path: "/Game/FactoryGame/Buildable/Factory/Pipeline.Build_Pipeline_C",
        owner_mod: "FactoryGame",
        kind: "buildable",
        location: { x: 2800, y: 0, z: 0 },
        connections: [
          pipeConnection(`${PIPELINE}.PipeConnection1`, "PCT_PRODUCER", `${REFINERY}.PipeInput0`, "Desc_LiquidOil"),
        ],
        inventories: [],
        transport: {
          kind: "pipeline",
          reported_flow_limit: 5,
          reported_content: 8,
          reported_max_content: 10,
          reported_flow: 0.4,
          fluid_class: "Desc_LiquidOil",
        },
      },
      {
        actor_id: PLAYER,
        name: "Char_Player_C_1",
        class_path: "/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C",
        owner_mod: "FactoryGame",
        kind: "player",
        location: { x: 700, y: 0, z: 0 },
        connections: [],
        inventories: [],
        health_current: 100,
        health_max: 100,
        player_inventory: [
          { item_class: "Desc_IronRod", item_name: "Iron Rod", amount: 5 },
          { item_class: "Desc_IronPlate", item_name: "Iron Plate", amount: 20 },
        ],
      },
    ],
  };

  return { ...snapshot, ...overrides };
}
