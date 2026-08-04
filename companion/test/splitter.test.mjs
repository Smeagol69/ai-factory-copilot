/**
 * Splitting one proven item flow across several compatible machines.
 *
 * Every fact used here has to come from the snapshot: source/consumer recipes,
 * free ports, one real splitter's per-instance connector topology, and captured
 * coordinates. Missing evidence refuses the plan instead of becoming a vanilla
 * three-output assumption or a spatial constant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { planSplitterFanOut } from "../lib/routing.mjs";

const SPLITTER_CLASS =
  "/Game/FactoryGame/Buildable/Factory/Splitter/Build_ConveyorAttachmentSplitter.Build_ConveyorAttachmentSplitter_C";

const connection = (overrides) => ({
  kind: "factory",
  connected: false,
  connected_component: "",
  normal: { x: 1, y: 0, z: 0 },
  ...overrides,
});

const machine = (name, x, y, extra = {}) => ({
  actor_id: name,
  name,
  kind: "buildable",
  location: { x, y, z: 0 },
  rotation: { pitch: 0, yaw: 0, roll: 0 },
  ...extra,
});

function splitter(number, outputCount = 3) {
  const y = 9_000 + number * 1_000;
  return {
    ...machine(`Build_Splitter_C_${number}`, 9_000, y),
    class_path: SPLITTER_CLASS,
    connections: [
      connection({
        component: `Splitter${number}.Input0`,
        direction: "FCD_INPUT",
        location: { x: 8_900, y, z: 100 },
        normal: { x: -1, y: 0, z: 0 },
      }),
      ...Array.from({ length: outputCount }, (_, index) =>
        connection({
          component: `Splitter${number}.Output${index}`,
          direction: "FCD_OUTPUT",
          location: { x: 9_100, y: y + (index - (outputCount - 1) / 2) * 100, z: 100 },
          normal: { x: 1, y: 0, z: 0 },
        }),
      ),
    ],
  };
}

function consumer(number, { item = "Desc_IronIngot", connected = false, recipe = true } = {}) {
  const recipeClass = item === "Desc_IronIngot" ? "Recipe_IronRod" : "Recipe_CopperSheet";
  const y = (number % 2 === 1 ? -1 : 1) * Math.ceil(number / 2) * 500;
  return machine(`Build_Consumer_C_${number}`, 3_000, y, {
    connections: [
      connection({
        component: `Consumer${number}.Input0`,
        direction: "FCD_INPUT",
        location: { x: 3_000, y, z: 100 },
        normal: { x: -1, y: 0, z: 0 },
        connected,
        connected_component: connected ? "Other.Output0" : "",
      }),
    ],
    ...(recipe ? { manufacturer: { recipe_class: recipeClass } } : {}),
  });
}

function snapshot({ splitterOutputCounts = [3], consumers = [consumer(1), consumer(2)] } = {}) {
  return {
    world_revision: 11,
    content: {
      items: [
        { class_path: "Desc_IronIngot", name: "Iron Ingot" },
        { class_path: "Desc_IronRod", name: "Iron Rod" },
        { class_path: "Desc_CopperIngot", name: "Copper Ingot" },
        { class_path: "Desc_CopperSheet", name: "Copper Sheet" },
      ],
      recipes: [
        {
          class_path: "Recipe_IronIngot",
          ingredients: [{ item_class: "Desc_OreIron" }],
          products: [{ item_class: "Desc_IronIngot" }],
        },
        {
          class_path: "Recipe_IronRod",
          ingredients: [{ item_class: "Desc_IronIngot" }],
          products: [{ item_class: "Desc_IronRod" }],
        },
        {
          class_path: "Recipe_CopperSheet",
          ingredients: [{ item_class: "Desc_CopperIngot" }],
          products: [{ item_class: "Desc_CopperSheet" }],
        },
      ],
    },
    actors: [
      machine("Build_Source_C_1", 0, 0, {
        manufacturer: { recipe_class: "Recipe_IronIngot" },
        connections: [
          connection({
            component: "Source.Output0",
            direction: "FCD_OUTPUT",
            location: { x: 500, y: 0, z: 100 },
          }),
        ],
      }),
      ...consumers,
      ...splitterOutputCounts.map((count, index) => splitter(index + 1, count)),
    ],
  };
}

const request = (consumerIds = ["Build_Consumer_C_1", "Build_Consumer_C_2"]) => ({
  from_actor_id: "Build_Source_C_1",
  to_actor_ids: consumerIds,
  splitter_class_path: SPLITTER_CLASS,
});

test("derives one splitter position from captured endpoints and connector offsets", () => {
  const plan = planSplitterFanOut(buildGraph(snapshot()), request());

  assert.equal(plan.planned, true, JSON.stringify(plan));
  assert.equal(plan.splitters_needed, 1);
  assert.equal(plan.splitter.outputs_available, 3);
  assert.equal(plan.splitter.outputs_source, "measured_per_instance_from_your_own_splitter");
  assert.equal(plan.legs.length, 2);
  assert.equal(plan.feed.from_connector, "Source.Output0");
  // Source output x=500, target centroid x=3000, so the proposed input is the
  // midpoint x=1750. The measured input offset is -100, giving actor x=1850.
  assert.equal(plan.splitter.input_world_cm.x, 1_750);
  assert.equal(plan.splitter.location_cm.x, 1_850);
  assert.match(plan.certainty, /captured_geometry_and_recipe_compatibility/);
});

test("refuses capacity and placement when no splitter example was captured", () => {
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ splitterOutputCounts: [] })),
    request(),
  );

  assert.equal(plan.planned, false);
  assert.match(plan.reason, /connectors are unknown/);
  assert.deepEqual(plan.missing, ["captured_splitter_connector_topology"]);
  assert.equal(plan.splitter, undefined);
});

test("counts outputs per instance instead of pooling every owned splitter", () => {
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ splitterOutputCounts: [3, 3] })),
    request(),
  );

  assert.equal(plan.planned, true);
  assert.equal(plan.splitter.outputs_available, 3);
  assert.equal(plan.splitter.measured_from, 2);
});

test("refuses inconsistent connector counts for one class", () => {
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ splitterOutputCounts: [3, 4] })),
    request(),
  );

  assert.equal(plan.planned, false);
  assert.match(plan.reason, /disagree/);
  assert.deepEqual(plan.observed_output_counts, [3, 4]);
});

test("proves every consumer accepts the source item and names incompatibility", () => {
  const consumers = [consumer(1), consumer(2), consumer(3, { item: "Desc_CopperIngot" })];
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ consumers })),
    request(consumers.map((entry) => entry.actor_id)),
  );

  assert.equal(plan.planned, true);
  assert.equal(plan.legs.length, 2);
  assert.ok(plan.legs.every((leg) => leg.compatible_items.includes("Iron Ingot")));
  assert.equal(plan.unusable.length, 1);
  assert.match(plan.unusable[0].reason, /cannot accept every item/);
});

test("a regular splitter refuses a mixed source belt unless consumers accept every coproduct", () => {
  const mixed = snapshot();
  mixed.content.recipes.find((recipe) => recipe.class_path === "Recipe_IronIngot").products.push({
    item_class: "Desc_CopperIngot",
  });
  const plan = planSplitterFanOut(buildGraph(mixed), request());

  assert.equal(plan.planned, false);
  assert.match(plan.reason, /fewer than two recipe-compatible consumers/);
  assert.equal(plan.unusable.length, 2);
  assert.ok(plan.unusable.every((entry) => /every item/.test(entry.reason)));
  assert.ok(
    plan.unusable.every((entry) => entry.incompatible_source_item_classes.includes("Desc_CopperIngot")),
  );
});

test("unknown source or consumer recipe evidence stays unknown", () => {
  const noSourceRecipe = snapshot();
  delete noSourceRecipe.actors[0].manufacturer;
  const sourcePlan = planSplitterFanOut(buildGraph(noSourceRecipe), request());
  assert.equal(sourcePlan.planned, false);
  assert.deepEqual(sourcePlan.missing, ["source_current_recipe_or_resource"]);

  const consumers = [consumer(1), consumer(2), consumer(3, { recipe: false })];
  const targetPlan = planSplitterFanOut(
    buildGraph(snapshot({ consumers })),
    request(consumers.map((entry) => entry.actor_id)),
  );
  assert.equal(targetPlan.planned, true);
  assert.equal(targetPlan.unusable.length, 1);
  assert.deepEqual(targetPlan.unusable[0].missing, ["target_current_recipe"]);
});

test("a consumer that cannot take a belt is named, not silently dropped", () => {
  const consumers = [consumer(1), consumer(2), consumer(3, { connected: true })];
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ consumers })),
    request(consumers.map((entry) => entry.actor_id)),
  );

  assert.equal(plan.planned, true);
  assert.equal(plan.legs.length, 2);
  assert.equal(plan.unusable.length, 1);
  assert.match(plan.unusable[0].reason, /already connected/);
});

test("six consumers produce a real three-splitter chain with valid output slots", () => {
  const consumers = Array.from({ length: 6 }, (_, index) => consumer(index + 1));
  const plan = planSplitterFanOut(
    buildGraph(snapshot({ consumers })),
    request(consumers.map((entry) => entry.actor_id)),
  );

  assert.equal(plan.planned, true);
  assert.equal(plan.splitters_needed, 3);
  assert.equal(plan.splitters.length, 3);
  assert.equal(plan.chain_legs.length, 2);
  assert.equal(plan.legs.length, 6);
  assert.ok(plan.legs.every((leg) => leg.from_splitter_output >= 1 && leg.from_splitter_output <= 3));
  assert.equal(new Set(plan.legs.map((leg) => leg.to_actor_id)).size, 6);
  assert.deepEqual(plan.chain_legs.map((leg) => leg.to_splitter), [2, 3]);
});

test("duplicates cannot consume the same input twice", () => {
  const plan = planSplitterFanOut(
    buildGraph(snapshot()),
    request(["Build_Consumer_C_1", "Build_Consumer_C_2", "Build_Consumer_C_2"]),
  );
  assert.equal(plan.planned, true);
  assert.equal(plan.legs.length, 2);
  assert.ok(plan.unusable.some((entry) => /duplicate/.test(entry.reason)));
});

test("refuses cases where a splitter is the wrong or unresolved answer", () => {
  const graph = buildGraph(snapshot());
  assert.match(planSplitterFanOut(graph, {}).reason, /splitter_class_path|from_actor_id/);
  assert.match(
    planSplitterFanOut(graph, {
      from_actor_id: "Build_Source_C_1",
      to_actor_ids: ["Build_Consumer_C_1"],
      splitter_class_path: SPLITTER_CLASS,
    }).reason,
    /one consumer needs a belt, not a splitter/,
  );
  assert.match(planSplitterFanOut(graph, request(["nope", "also-nope"])).reason, /fewer than two/);
});

test("never claims the proposed transforms will fit", () => {
  const plan = planSplitterFanOut(buildGraph(snapshot()), request());
  assert.match(plan.unverified, /holograms/);
  assert.match(plan.unverified, /after the splitters exist/);
});
