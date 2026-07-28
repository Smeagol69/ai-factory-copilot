/**
 * Solver tool definitions exposed to the model.
 *
 * The model is told to call these for anything numeric. Results are bounded so
 * a large factory cannot overflow the provider context, and every truncation is
 * reported inside the tool result so omitted rows stay explicitly unknown.
 *
 * Some tools change the world. They do not change it *here* — an action tool
 * validates a request and drops the resulting typed action into the request's
 * action sink, which the bridge returns to the mod. The mod re-validates and is
 * the only thing that can commit. Two independent checks, and the one that owns
 * the world has the last word.
 */

import { summarizePlan, validatePlan } from "./actions.mjs";
import { designFactoryLayout } from "./designer.mjs";
import {
  solveBottlenecks,
  solveBuildCost,
  solveItemBalance,
  solveMachineRates,
  solvePowerCircuits,
  solveProductionPlan,
  solveBlueprintLibrary,
  solveRecipeOptions,
  solveSiteSelection,
  solveTransportCapacity,
  solveUnlockStatus,
} from "./solvers.mjs";

const DEFAULT_TOOL_RESULT_CHARACTERS = 120_000;
const ARRAY_CAP_ATTEMPTS = [null, 200, 80, 30, 10, 3, 1];

const actorIdsSchema = {
  type: "array",
  items: { type: "string" },
  description: "Optional exact actor_id values from the snapshot. Omit to cover every captured machine.",
};

export const SOLVER_TOOLS = [
  {
    name: "get_machine_rates",
    description:
      "Exact per-minute input and output rates for captured machines, derived from each machine's live production cycle time, reported production boost, and its registered recipe. Also returns machines whose rate could not be derived and why. Use this instead of computing rates yourself.",
    parameters: {
      type: "object",
      properties: { actor_ids: actorIdsSchema },
      additionalProperties: false,
    },
    run: (graph, args) => solveMachineRates(graph, args),
  },
  {
    name: "get_item_balance",
    description:
      "Whole-snapshot production versus consumption per item in units per minute, with surplus/deficit status, the contributing actor ids, and the coverage warning for machines that could not be resolved. Use this to find what the factory is short of.",
    parameters: {
      type: "object",
      properties: {
        item_class: {
          type: "string",
          description: "Optional exact item class_path to restrict the balance to one item.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveItemBalance(graph, args),
  },
  {
    name: "find_recipes",
    description:
      "Recipes that produce or consume an item, with per-minute rates at base cycle time, the buildings they are produced in, owning mod, and how many machines in this world already use them. Use this before suggesting a recipe change.",
    parameters: {
      type: "object",
      properties: {
        item_class: { type: "string", description: "Exact item class_path to search for." },
        name_contains: { type: "string", description: "Case-insensitive substring of the recipe name or class path." },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveRecipeOptions(graph, args),
  },
  {
    name: "get_transport_capacity",
    description:
      "Conveyor and pipeline capacity against the supply reaching each segment and the demand behind it, including which endpoints were traced, the narrowest segment on each path, over-capacity and under-supply findings, and observed backup evidence. Pipeline head lift is not captured and is reported as unknown.",
    parameters: {
      type: "object",
      properties: {
        actor_ids: actorIdsSchema,
        only_problems: {
          type: "boolean",
          description: "When true, return only segments with a finding or observed backup. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) =>
      solveTransportCapacity(graph, { ...args, only_problems: args?.only_problems ?? true }),
  },
  {
    name: "get_power_circuits",
    description:
      "Per power circuit: production capacity, maximum consumption, headroom, fuse state, battery store and capacity, battery runtime at the current deficit, and the biggest consumers on the circuit.",
    parameters: {
      type: "object",
      properties: {
        circuit_id: { type: "number", description: "Optional exact circuit id to restrict the result to." },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solvePowerCircuits(graph, args),
  },
  {
    name: "diagnose_bottlenecks",
    description:
      "Root-cause analysis for stalled or underperforming machines. Classifies each cause as invalid, inefficient, or unknown, walks upstream through belts to name the machine that actually has to change, and returns the causal chain. Use this for any 'why is this not working' question.",
    parameters: {
      type: "object",
      properties: {
        actor_ids: actorIdsSchema,
        include_healthy: {
          type: "boolean",
          description: "When true, also return machines with no detected problem.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveBottlenecks(graph, args),
  },
  {
    name: "get_build_cost",
    description:
      "Construction cost for a building from its build recipe, multiplied by a count, compared against captured player inventories with the shortfall per ingredient. Storage containers are not included in held amounts.",
    parameters: {
      type: "object",
      properties: {
        recipe_class: { type: "string", description: "Exact build recipe class_path, when known." },
        class_path: {
          type: "string",
          description: "Buildable class_path; the recipe is taken from an existing actor of that class in the snapshot.",
        },
        count: { type: "number", description: "How many to build. Defaults to 1." },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveBuildCost(graph, args),
  },
  {
    name: "find_best_site",
    description:
      "Ranks places to build, scoring every candidate by the resource nodes within a radius and by measured ground: distinct resource types, purity-weighted node count, coverage of resources you require, terrain buildability, and distance cost. Terrain is real measurement, not a guess: downward line traces across each footprint give slope and elevation range, the game's own water volumes give water, and a lifted box test gives rock and cliff obstruction. Returns exact coordinates, the ranked runners-up, and the full score breakdown. Use this for any 'where should I put my HUB / base / factory' question instead of judging coordinates yourself. Sites outside the scanner's probe radius are reported as unmeasured rather than assumed flat.",
    parameters: {
      type: "object",
      properties: {
        radius_meters: {
          type: "number",
          description: "How far from a candidate a node still counts as usable. Defaults to 300.",
        },
        top: { type: "number", description: "How many ranked sites to return. Defaults to 5." },
        required_resources: {
          type: "array",
          items: { type: "string" },
          description:
            "Resource names or class substrings that must be present, e.g. [\"Iron Ore\",\"Copper Ore\",\"Limestone\"] for a starter HUB. Sites missing any are reported but scored down.",
        },
        include_deposits: {
          type: "boolean",
          description: "Include hand-mined Deposit nodes, which cannot host a miner. Defaults to false.",
        },
        center: {
          type: "object",
          description: "Score one specific location instead of searching, as {x, y, z} in centimetres.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveSiteSelection(graph, args),
  },
  {
    name: "plan_production",
    description:
      "Designs a production line for a target item and rate, against THIS base: exact machine counts per step, the recipe chosen at each step, per-machine and total power read off the player's own machines of that type, belt-level input rates, the raw inputs the line needs, and the build cost priced against what they are carrying. Anything the factory already over-produces is subtracted first, so the plan covers what is actually missing rather than an empty-world ideal. Use this for 'how do I make N per minute of X', 'what do I need to build for X', or any scale-up question. It is a bill of materials and machine count, not a physical layout.",
    parameters: {
      type: "object",
      properties: {
        item_class: { type: "string", description: "Exact item class_path to produce." },
        item_name: { type: "string", description: "Item name, if the class path is not known (e.g. \"Reinforced Iron Plate\")." },
        target_rate_per_minute: { type: "number", description: "Desired output per minute, in items (or cubic metres for fluids)." },
        recipe_class: { type: "string", description: "Force a specific recipe for the top-level item." },
        max_depth: { type: "number", description: "How many ingredient levels to expand. Defaults to 6." },
        use_existing_surplus: {
          type: "boolean",
          description: "Subtract what the factory already over-produces. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveProductionPlan(graph, args),
  },
  {
    name: "list_blueprints",
    description:
      "The player's saved blueprints: designer dimensions, exact build cost priced against what they are carrying, the game build each was authored on, and its description. Use this when they ask what blueprints they have, what one costs, whether they can afford it, or whether it still matches their game version. The per-building layout inside a blueprint is not decoded.",
    parameters: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Case-insensitive substring of the blueprint name." },
        limit: { type: "number", description: "Maximum blueprints to return. Defaults to 25." },
      },
      additionalProperties: false,
    },
    run: (graph, args, services) => solveBlueprintLibrary(graph, args, services ?? {}),
  },
  {
    name: "get_unlock_status",
    description:
      "Purchased schematics and the highest available tech tier. The schematic-to-recipe mapping is not captured, so this reports recipe unlock state as unknown rather than guessing it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (graph) => solveUnlockStatus(graph),
  },

  /* ---------------- world-changing tools ---------------- */

  {
    name: "design_factory_layout",
    description:
      "Designs a PLACEABLE factory: takes a target item and rate, works out the machines (as plan_production does), then positions every one of them on the ground at exact coordinates. The layout is fitted to THIS base — machine footprints are measured from the player's own machines, the grid is rotated onto the alignment their existing buildings share, and the origin is phase-locked to their foundation lines, so it reads as part of the base rather than dropped on it. Ground already occupied is detected from captured bounds and those slots are reported, not built through. Use this for 'build me X', 'design a factory for X', or any request for a layout rather than a shopping list. Requires an origin: get one from find_best_site or use the player's position. Set build=true ONLY when the player has clearly asked for it to actually be built; otherwise this previews and nothing is placed.",
    parameters: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Item to produce, e.g. \"Reinforced Iron Plate\"." },
        item_class: { type: "string", description: "Exact item class_path, if known." },
        target_rate_per_minute: { type: "number", description: "Desired output per minute." },
        origin: {
          type: "object",
          description: "Where to put the factory. Needs an explicit x, y and z in centimetres.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
        recipe_class: { type: "string", description: "Force a specific recipe for the top-level item." },
        use_existing_surplus: {
          type: "boolean",
          description: "Subtract what the factory already over-produces. Defaults to true.",
        },
        align_to_base: {
          type: "boolean",
          description: "Match the alignment of existing buildings. Defaults to true. Set false for world axes.",
        },
        aisle_cm: { type: "number", description: "Gap between machine rows for belts. Defaults to 800 (one foundation)." },
        machine_gap_cm: { type: "number", description: "Gap between machines in a row. Defaults to 100." },
        build: {
          type: "boolean",
          description:
            "Actually place the machines. Defaults to false, which previews the layout without changing anything. Only set true when the player asked for it to be built.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      const layout = designFactoryLayout(graph, args, services ?? {});
      if (!layout.designed) return layout;

      const build = args.build === true;
      const actions = layout.actions.map((action) => ({ ...action, commit: build }));
      const plan = validatePlan(graph, actions, { maxActions: 256 });
      if (plan.valid) {
        services?.actions?.emit?.(plan.actions);
      }
      return {
        ...layout,
        will_build: build,
        plan_validation: plan.valid ? { valid: true, steps: plan.step_count } : plan,
        next_step: build
          ? "The machines are being placed now. Anything already there is skipped and reported."
          : "Nothing was placed. Say \"build it\" to place these machines.",
      };
    },
  },
  {
    name: "perform_actions",
    description:
      "Executes world-changing actions the player asked for: place_building, place_blueprint, teleport_player, dismantle, undo_last. Pass the whole sequence at once — it runs in order and stops at the first failure, so a half-built layout is never left behind. Set commit=true on each action the player actually asked to happen; leave it false to preview. Use place_blueprint to stamp one of their saved blueprints into the world (the game's own loader places its contents, wiring and all). Use undo_last to reverse the previous action.",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Actions to run, in order.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["place_building", "place_blueprint", "teleport_player", "dismantle", "undo_last"],
              },
              commit: {
                type: "boolean",
                description: "True to actually do it, false to preview. Defaults to false.",
              },
              recipe_class: { type: "string", description: "place_building: the recipe that BUILDS the machine (e.g. Recipe_ConstructorMk1), not the one it runs." },
              blueprint_name: { type: "string", description: "place_blueprint: exact name from list_blueprints." },
              actor_id: { type: "string", description: "dismantle: the actor_id to remove." },
              location: {
                type: "object",
                description: "Where, in centimetres. place_building and place_blueprint need an explicit z.",
                properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
                additionalProperties: false,
              },
              target: {
                type: "object",
                description: "teleport_player: destination in centimetres. z is optional when snapping to ground.",
                properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
                additionalProperties: false,
              },
              yaw: { type: "number", description: "Rotation in degrees." },
              snap_to_ground: {
                type: "boolean",
                description: "teleport_player: resolve z by tracing to the ground. Defaults to true. Leave it on.",
              },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      const plan = summarizePlan(graph, validatePlan(graph, args.actions));
      if (plan.valid) {
        services?.actions?.emit?.(plan.actions);
      }
      return plan;
    },
  },
  {
    name: "highlight",
    description:
      "Draws tracer lines and bounding boxes in the world around things, visible through terrain. Use whenever the player asks to be SHOWN where something is — 'show me every Beryl Nut within 100 m', 'mark the impure iron nodes', 'highlight my stopped machines'. Filter by item name (pickups and nodes), class name, or pass exact actor_ids from a solver result. Resolution happens live against the world, so it is current even if the snapshot has aged. Name the overlay so it can be cleared or replaced later.",
    parameters: {
      type: "object",
      properties: {
        overlay: {
          type: "string",
          description: "A short name for this overlay, e.g. \"beryl\". Re-using a name replaces that overlay.",
        },
        item_name_contains: {
          type: "string",
          description: "Substring of the item a pickup or node holds, e.g. \"Beryl Nut\", \"Paleberry\", \"Iron Ore\".",
        },
        class_name_contains: { type: "string", description: "Substring of the actor's class name." },
        name_contains: { type: "string", description: "Substring of the actor's display name." },
        kind: {
          type: "string",
          enum: ["any", "item_pickup", "resource_node", "buildable"],
          description: "Restrict to one kind of thing. Defaults to any.",
        },
        actor_ids: {
          type: "array",
          items: { type: "string" },
          description: "Exact actor_ids to highlight. These ignore the radius, so use them to mark specific solver results.",
        },
        radius_m: { type: "number", description: "Search radius from the player in metres. Defaults to 100." },
        color: {
          type: "string",
          enum: ["green", "red", "blue", "yellow", "orange", "purple", "cyan", "white"],
          description: "Overlay colour. Defaults to green.",
        },
        max_results: { type: "number", description: "Cap on how many to draw. Defaults to 200." },
        lifetime_seconds: { type: "number", description: "Auto-clear after this long. Defaults to 0, meaning until cleared." },
        tracers: { type: "boolean", description: "Draw lines from the player to each target. Defaults to true." },
        boxes: { type: "boolean", description: "Draw a bounding box around each target. Defaults to true." },
        pillars: { type: "boolean", description: "Draw a vertical beam at each target, visible from far away. Defaults to true." },
      },
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      // Overlays draw only; they never change the world, so they always commit
      // and are not held behind the write-action gate.
      const action = { ...args, action: "highlight", commit: true };
      services?.actions?.emit?.([action]);
      return {
        queued: true,
        overlay: args.overlay ?? "overlay",
        note: "The mod resolves this against live actors and draws it. The count and the exact things found come back in the action report, so do not state a number here.",
        source: "drawn_in_world_by_the_mod",
      };
    },
  },
  {
    name: "clear_highlight",
    description:
      "Removes an overlay drawn by highlight. Pass the overlay name, or all=true to remove every overlay.",
    parameters: {
      type: "object",
      properties: {
        overlay: { type: "string", description: "Name of the overlay to remove." },
        all: { type: "boolean", description: "Remove every overlay this mod drew." },
      },
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      services?.actions?.emit?.([{ ...args, action: "clear_highlight", commit: true }]);
      return { queued: true, overlay: args.overlay ?? null, all: args.all === true };
    },
  },
];

const toolsByName = new Map(SOLVER_TOOLS.map((tool) => [tool.name, tool]));

/** Recursively caps every array so one huge factory cannot blow the context. */
function capArrays(value, limit, cappedPaths, path = "") {
  if (Array.isArray(value)) {
    const capped = limit === null ? value : value.slice(0, limit);
    if (capped.length < value.length) {
      cappedPaths.push(`${path || "root"}[${capped.length}/${value.length}]`);
    }
    return capped.map((entry, index) => capArrays(entry, limit, cappedPaths, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = capArrays(nested, limit, cappedPaths, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return value;
}

export function serializeToolResult(result, maximumCharacters = DEFAULT_TOOL_RESULT_CHARACTERS) {
  for (const limit of ARRAY_CAP_ATTEMPTS) {
    const cappedPaths = [];
    const capped = capArrays(result, limit, cappedPaths);
    if (cappedPaths.length > 0) {
      capped.tool_result_truncation = {
        array_item_limit: limit,
        truncated_paths: cappedPaths.slice(0, 40),
        truncated_path_count: cappedPaths.length,
        policy: "Rows beyond the limit are omitted and must be treated as unknown, not as absent.",
      };
    }
    const serialized = JSON.stringify(capped);
    if (serialized.length <= maximumCharacters) {
      return { serialized, truncated: cappedPaths.length > 0, array_item_limit: limit };
    }
  }

  const minimal = JSON.stringify({
    solver: result?.solver ?? "unknown",
    world_revision: result?.world_revision ?? null,
    error: "Solver result exceeded the tool result budget even fully truncated.",
    policy: "Ask a narrower question, for example a single actor_id or item_class.",
  });
  return { serialized: minimal, truncated: true, array_item_limit: 0 };
}

export function runSolverTool(graph, name, args, { maximumCharacters, services } = {}) {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      name,
      ...serializeToolResult({
        error: `Unknown solver tool "${name}".`,
        available_tools: SOLVER_TOOLS.map((entry) => entry.name),
      }),
    };
  }

  try {
    const parsed = args && typeof args === "object" ? args : {};
    return { name, ...serializeToolResult(tool.run(graph, parsed, services), maximumCharacters) };
  } catch (error) {
    return {
      name,
      ...serializeToolResult({
        solver: name,
        error: `Solver failed: ${error instanceof Error ? error.message : String(error)}`,
        policy: "Treat the requested values as unknown.",
      }),
    };
  }
}

/** Responses API function-tool shape (flat, not nested under `function`). */
export function openAIToolDefinitions() {
  return SOLVER_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

/**
 * Chat Completions tool shape, nested under `function` — this is what
 * OpenAI-compatible local servers (Ollama, LM Studio, llama.cpp) expect, and it
 * differs from the flat Responses API shape above.
 */
export function chatCompletionsToolDefinitions() {
  return SOLVER_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Messages API tool shape. */
export function anthropicToolDefinitions() {
  return SOLVER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export { DEFAULT_TOOL_RESULT_CHARACTERS };
