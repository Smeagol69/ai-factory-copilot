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

import { DEFAULT_MAX_ACTIONS, summarizePlan, validatePlan } from "./actions.mjs";
import { designFactoryLayout } from "./designer.mjs";
import { baseBuildActions, planBaseBuild } from "./base-build.mjs";
import { planStructure, structureActions } from "./architecture.mjs";
import { compileMegabaseConcept, deriveMegabaseFloorHeight } from "./megabase.mjs";
import {
  planBeltedModule,
  solveBeltChain,
  solveBeltRoute,
  solveCompatibleBeltCandidates,
} from "./routing.mjs";
import {
  solveBottlenecks,
  solveBuildCost,
  solveFactorySummary,
  solveItemBalance,
  solveMachineRates,
  solvePowerCircuits,
  solveProductionPlan,
  solveBlueprintLibrary,
  solveRecipeOptions,
  solveActorLookup,
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
    name: "get_factory_summary",
    description:
      "Exact census of the actors in the current capture: counts by actor kind, buildable class, production status, transport kind, resource and owner mod, plus the scan radius and actor-limit caveat. Use this for 'what is in my factory', 'what have I built', or a factory overview. Counts are authoritative for the capture, never claimed as the whole map when scanning was limited.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (graph) => solveFactorySummary(graph),
  },
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
      "The rendered HUD text plus progression-manager onboarding state, active milestone and remaining cost, game phase, todo lists, purchased schematics, highest tech tier, and exact available/unavailable recipe counts. If the HUD and manager disagree, both authoritative observations are returned.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (graph) => solveUnlockStatus(graph),
  },

  {
    name: "locate",
    description:
      "Finds a specific thing in the world and returns its exact coordinates. Use this whenever a placement, teleport, or overlay needs a position and you only have a name — 'BP_ResourceNode12_91', 'the nearest iron node', 'my constructors'. Searches the complete snapshot, not the reduced view you were given, so something absent from your context is often still findable here. For resource nodes it also reports purity, whether the node is occupied, and whether a miner can actually be built on it — a Deposit cannot, which is the usual reason a placement fails.",
    parameters: {
      type: "object",
      properties: {
        actor_id: { type: "string", description: "Exact actor_id, or the trailing name portion of one." },
        name_contains: { type: "string", description: "Substring of the actor's name, e.g. \"ResourceNode12\"." },
        resource_name: { type: "string", description: "Resource held, e.g. \"Iron Ore\", \"Coal\"." },
        kind: {
          type: "string",
          enum: ["resource_node", "buildable", "item_pickup", "player", "vehicle"],
          description: "Restrict to one kind of actor.",
        },
        limit: { type: "number", description: "Maximum matches to return. Defaults to 10, nearest first." },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveActorLookup(graph, args),
  },

  {
    name: "find_belt_candidates",
    description:
      "Lists captured source/target machine pairs whose free conveyor output and input ports are proven compatible by the current recipe or extractor resource. Returns exact component paths, measured spans, alignment, compatible items, deterministic ordering, and explicit truncation. Use this to find or compare possible belt connections before choosing one. Unknown item compatibility is omitted rather than guessed. Maximum length, bend acceptance and clearance remain the game's hologram checks.",
    parameters: {
      type: "object",
      properties: {
        radius_m: {
          type: "number",
          description:
            "Optional radius around the captured player position, from above 0 through 5000 metres. Omit to inspect every captured buildable.",
        },
        limit: {
          type: "number",
          description: "Maximum candidates to return, from 1 through 100. Defaults to 25.",
        },
        compatibility: {
          type: "string",
          enum: ["proven", "not_proven_incompatible", "any"],
          description:
            "Defaults to proven. not_proven_incompatible also includes unknown pairs but refuses proven mismatches. any is for a read-only physical-port census and labels proven, incompatible, and unknown separately.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) => solveCompatibleBeltCandidates(graph, args),
  },
  {
    name: "plan_belt_route",
    description:
      "Works out the conveyor between two placed machines: which connector pair to use, where each end sits, how long the belt is, and whether it runs straight or has to bend. Reads the connector geometry the scanner captured, so it is measurement rather than estimation. Give actor_ids in flow order, or a whole chain to route several legs at once. It does not decide maximum belt length or whether the path is clear — both are the game's call, and the mod reports what was actually built.",
    parameters: {
      type: "object",
      properties: {
        from_actor_id: { type: "string", description: "The machine the items leave." },
        to_actor_id: { type: "string", description: "The machine the items arrive at." },
        actor_ids: {
          type: "array",
          items: { type: "string" },
          description: "A whole chain in flow order, e.g. [miner, smelter, constructor]. Use instead of from/to.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args) =>
      Array.isArray(args?.actor_ids) && args.actor_ids.length > 1
        ? solveBeltChain(graph, args)
        : solveBeltRoute(graph, args),
  },
  {
    name: "plan_belted_module",
    description:
      "Plans a compact belted module anchored on a resource node — a miner into a smelter into whatever follows, machines spaced by their measured footprints so buildings can be placed over them. Returns the machine placements and the belt legs to route afterwards. Deliberately two-phase: a belt joins connectors, and a connector does not exist until its machine is placed and the game has decided where it actually ended up, so belts are routed after placement rather than to a predicted position.",
    parameters: {
      type: "object",
      properties: {
        anchor_actor_id: { type: "string", description: "The resource node the module is built on." },
        chain: {
          type: "array",
          items: { type: "string" },
          description: "Buildable class paths in flow order, starting with the miner.",
        },
        spacing_cm: { type: "number", description: "Override the gap between machines. Defaults to their measured footprint." },
      },
      additionalProperties: false,
    },
    run: (graph, args) => planBeltedModule(graph, args),
  },

  {
    name: "plan_splitter_fan_out",
    description:
      "Plans one or more chained splitters and their belt legs when a machine must feed several consumers. Splitter capacity, connector geometry, and placement orientation are measured per instance from a captured splitter of the requested class; without that evidence the solver refuses instead of assuming vanilla topology. It proves the source recipe produces an item every consumer recipe accepts, resolves only free ports, and names incompatible or unknown consumers rather than dropping them. Use this for any 'split this between', 'feed both', or 'send some to' request. Positions are proposals; clearance, belt routing, and fit remain the game's decision.",
    parameters: {
      type: "object",
      properties: {
        from_actor_id: { type: "string", description: "The machine whose output is being split." },
        to_actor_ids: {
          type: "array",
          items: { type: "string" },
          description: "Two or more consumers to feed. One consumer needs a plain belt, not a splitter.",
        },
        splitter_class_path: {
          type: "string",
          description: "Exact class_path of the splitter topology to measure from captured in-world instances.",
        },
      },
      required: ["from_actor_id", "to_actor_ids", "splitter_class_path"],
      additionalProperties: false,
    },
    run: (graph, args) => planSplitterFanOut(graph, args),
  },

  {
    name: "design_base",
    description:
      "Designs a whole factory from a production goal and returns an ordered build plan: which buildings, how many, where each one goes, and the belt legs between them. Run plan_production first and pass its result. One row per production step, deepest dependency first, so belts run the short way and nothing crosses. Reports what it cannot place and why — a locked building is named, not silently skipped — and states plainly that power is not wired. Positions are a proposal; ground, clearance and cost are decided by the game when the plan runs. Use this for any 'design me a base', 'build me a factory for X', or 'lay this out' request.",
    parameters: {
      type: "object",
      properties: {
        production_plan: {
          type: "object",
          description: "The result of plan_production for the goal being built.",
        },
        anchor_cm: {
          type: "object",
          description: "Where to put the first row. Defaults to the player's position.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        machine_spacing_cm: { type: "number", description: "Gap between machines in a row. Defaults to 1500." },
        row_spacing_cm: { type: "number", description: "Gap between rows. Defaults to 1800." },
      },
      required: ["production_plan"],
      additionalProperties: false,
    },
    run: (graph, args) => {
      const plan = planBaseBuild(graph, args);
      // The actions travel with the plan so the caller can see exactly what
      // would run, without any of it committing until asked.
      return plan.planned
        ? { ...plan, actions_preview: baseBuildActions(plan, { commit: false }) }
        : plan;
    },
  },

  {
    name: "design_megabase_concept",
    description:
      "Creates a PREVIEW-ONLY architectural megabase manifest from this save's measured machines and an explicit site. Use this when the player wants an elevated campus, terraced megafactory, landmark tower, glazed halls, supports, or skybridges rather than a plain machine-row layout. It calls the production/layout solvers internally, derives vertical clearance from the tallest measured machine, and compiles integer design cells to exact world XYZ. It never emits actions and never claims construction will succeed. Semantic vanilla or modded parts resolve only when the selected recipe exists and is available in the captured catalog; everything else stays explicitly unresolved.",
    parameters: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "Exact display name of the target item." },
        target_rate_per_minute: { type: "number", description: "Desired output per minute." },
        origin: {
          type: "object",
          description: "Authoritative site anchor in centimetres, including explicit Z.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
        style: {
          type: "string",
          enum: [
            "elevated_industrial_campus",
            "terraced_megafactory",
            "curvilinear_future_campus",
          ],
          description: "Architectural grammar to compile. It changes massing, not game facts.",
        },
        recipe_class: { type: "string", description: "Optional captured production recipe for the target." },
        use_existing_surplus: {
          type: "boolean",
          description:
            "Subtract existing surplus only when true. Defaults to false because a megabase request normally asks for a new self-contained production program.",
        },
        align_to_base: { type: "boolean", description: "Match the captured base grid. Defaults to true." },
        creative_parameters: {
          type: "object",
          description: "Optional integer proportions. Unsupported fields are refused by the schema.",
          properties: {
            deck_floor: { type: "integer" },
            hall_floors: { type: "integer" },
            hall_gap_cells: { type: "integer" },
            service_margin_cells: { type: "integer" },
            terrace_step_cells: { type: "integer" },
            terrace_level_floors: { type: "integer" },
            curve_amplitude_cells: { type: "integer" },
            tower_width_cells: { type: "integer" },
            tower_depth_cells: { type: "integer" },
            tower_floors: { type: "integer" },
          },
          additionalProperties: false,
        },
        part_selections: {
          type: "object",
          description:
            "Optional recipe classes selected for semantic architecture roles. Each is independently checked against the captured available recipe catalog; a guessed class remains unresolved.",
          properties: {
            foundation: { type: "string" },
            support_column: { type: "string" },
            walkway: { type: "string" },
            rail: { type: "string" },
            wall: { type: "string" },
            window: { type: "string" },
            sloped_roof: { type: "string" },
            lighting: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["item_name", "target_rate_per_minute", "origin", "style"],
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      const layout = designFactoryLayout(graph, {
        item_name: args.item_name,
        target_rate_per_minute: args.target_rate_per_minute,
        origin: args.origin,
        recipe_class: args.recipe_class,
        use_existing_surplus: args.use_existing_surplus === true,
        align_to_base: args.align_to_base,
      }, services ?? {});
      if (!layout.designed) return layout;

      const vertical = deriveMegabaseFloorHeight(layout);
      if (!vertical.derived) {
        return {
          schema: "megabase.design/v1",
          compiled: false,
          status: "concept_refused",
          reason: vertical.reason,
          effect: vertical.effect ?? null,
          actions: [],
        };
      }
      const manifest = compileMegabaseConcept(graph, layout, {
        style: args.style,
        floor_height_cm: vertical.floor_height_cm,
        creative_parameters: args.creative_parameters,
        part_selections: args.part_selections,
      });
      return {
        ...manifest,
        vertical_module: vertical,
      };
    },
  },

  {
    name: "plan_structure",
    description:
      "Previews Claude's grid-derived structural shell: foundations, optional raised supports, perimeter walls with an entrance, and a roof using only available Build Gun recipes captured from this save. Use for a concrete platform/building shell measured in foundation cells. Returns exact piece transforms and commit:false action previews, but never submits them or claims hologram validity. For a complete production campus use design_megabase_concept instead.",
    parameters: {
      type: "object",
      properties: {
        origin_cm: {
          type: "object",
          description: "Optional exact world origin in centimetres. Defaults to the captured player position.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
        width_cells: { type: "integer", minimum: 1, maximum: 32 },
        depth_cells: { type: "integer", minimum: 1, maximum: 32 },
        height_cm: { type: "number", minimum: 0, maximum: 100000 },
        walls: { type: "boolean" },
        roof: { type: "boolean" },
        glass_roof: { type: "boolean" },
      },
      additionalProperties: false,
    },
    run: (graph, args) => {
      const plan = planStructure(graph, args);
      if (!plan.planned) return plan;
      const actionsPreview = structureActions(plan, { commit: false });
      return {
        ...plan,
        source: "captured_available_build_gun_recipes_and_descriptor_dimensions",
        certainty: "exact_grid_plan_pending_game_hologram_validation",
        actions_preview: actionsPreview,
        transaction_limit: {
          maximum_actions: DEFAULT_MAX_ACTIONS,
          proposed_actions: actionsPreview.length,
          requires_chunking: actionsPreview.length > DEFAULT_MAX_ACTIONS,
          effect:
            actionsPreview.length > DEFAULT_MAX_ACTIONS
              ? "This preview cannot be submitted as one action plan; bounded reversible chunking is required."
              : "The preview fits the bridge action-count limit but remains unsubmitted.",
        },
      };
    },
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
