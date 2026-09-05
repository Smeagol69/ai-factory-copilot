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
import { compositionActions, planComposition, stageComposition } from "./composition.mjs";
import { planStructure, planTower, structureActions } from "./architecture.mjs";
import { compileMegabaseConcept, deriveMegabaseFloorHeight } from "./megabase.mjs";
import { compileArchitectPreview } from "./architect-preview.mjs";
import { solveReferenceDesigns } from "./reference-designs.mjs";
import { compileArchitectPromotion } from "./architect-promotion.mjs";
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
  solveBlueprintPlacementAudit,
  solveBlueprintComparison,
  solveBlueprintLayout,
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

function architectDesignRequest(args = {}) {
  return {
    item_name: args.item_name,
    target_rate_per_minute: args.target_rate_per_minute,
    origin: args.origin,
    style: args.style,
    design_family_id: args.design_family_id,
    match_design_family_fingerprint: args.match_design_family_fingerprint,
    commissioning_phases: args.commissioning_phases,
    recipe_class: args.recipe_class,
    use_existing_surplus: args.use_existing_surplus === true,
    align_to_base: args.align_to_base,
    creative_parameters: args.creative_parameters,
    part_selections: args.part_selections,
  };
}

function compileArchitectDesignRequest(graph, request, services = {}) {
  const layout = designFactoryLayout(graph, {
    item_name: request.item_name,
    target_rate_per_minute: request.target_rate_per_minute,
    origin: request.origin,
    recipe_class: request.recipe_class,
    use_existing_surplus: request.use_existing_surplus === true,
    align_to_base: request.align_to_base,
  }, services);
  if (!layout.designed) return { compiled: false, result: layout };

  const vertical = deriveMegabaseFloorHeight(layout);
  if (!vertical.derived) {
    return {
      compiled: false,
      result: {
        schema: "megabase.design/v1",
        compiled: false,
        status: "concept_refused",
        reason: vertical.reason,
        effect: vertical.effect ?? null,
        actions: [],
      },
    };
  }
  const manifest = compileMegabaseConcept(graph, layout, {
    style: request.style,
    design_family_id: request.design_family_id,
    match_design_family_fingerprint: request.match_design_family_fingerprint,
    commissioning_phases: request.commissioning_phases,
    floor_height_cm: vertical.floor_height_cm,
    creative_parameters: request.creative_parameters,
    part_selections: request.part_selections,
  });
  return {
    compiled: manifest.compiled === true,
    result: { ...manifest, vertical_module: vertical },
    manifest,
    vertical,
  };
}

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
      "The player's saved blueprints: designer dimensions, exact build cost priced against what they are carrying, exact header recipe references, the game build each was authored on, and its description. Duplicate names include a safe blueprint_reference that disambiguates one saved library entry without accepting a filesystem path. Use this when they ask what blueprints they have, what one costs, whether they can afford it, or whether it still matches their game version. Call inspect_blueprint_layout for actual saved positions or exact building counts in one blueprint.",
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
    name: "inspect_blueprint_layout",
    description:
      "Read one exact saved native blueprint through a pinned, read-only Satisfactory serializer. Returns decoded native Build_* entity counts and classes, bounded individual transforms in centimetres, pivot bounds, build recipe evidence, costs priced against current player inventories, bounded exact reciprocal conveyor/pipe component links, bounded exact physical native power-wire endpoint pairs, bounded native railroad-track spline records (saved points, tangents, local bounds, Blueprint-relative transformed endpoints, chord-length lower bounds, and mTrackGraphID metadata), and bounded native hypertube records (exact FGPipeConnectionComponentHyper links, PipeHyper spline points/tangents, transformed endpoints, and saved passthrough-reference observations) inside the Blueprint. Saved mHiddenConnections logical circuit relationships are deliberately excluded. It names the naming-convention caveat for nonstandard modded classes and names unresolved, one-way, malformed, or unsupported records instead of assuming a route. Use this before reasoning from a blueprint's visual style, extracting a reusable layout, checking internal belt/pipe/power/rail/hypertube reference topology, or comparing it to a proposed factory. It does not infer item/fluid direction or rate, hypertube traversal direction/speed, rail joins, electricity direction/load/capacity, terrain excavation or clearance, underground fit, Build Gun hologram validity, signals, cross-blueprint joins, or external hookups at a new location.",
    parameters: {
      type: "object",
      properties: {
        blueprint_name: {
          type: "string",
          description: "Exact blueprint name, or the blueprint_reference returned by list_blueprints when names are duplicated. The bridge compares a reference only to its already-discovered library entries; it never resolves a filesystem path.",
        },
        maximum_buildables: {
          type: "number",
          description: "Maximum individual transformed buildables to return, from 1 through 200. Defaults to 80; aggregate counts still cover every decoded buildable.",
        },
        maximum_connections: {
          type: "number",
          description: "Maximum individual reciprocal conveyor/pipe connection pairs to return, from 1 through 200. Defaults to 80; aggregate reciprocal, unresolved, and nonreciprocal reference counts still cover every decoded component.",
        },
        maximum_power_wires: {
          type: "number",
          description: "Maximum individual exact native power-wire endpoint pairs to return, from 1 through 200. Defaults to 80; aggregate saved mWires, verified, malformed, unresolved, and incomplete-edge counts still cover every decoded power record.",
        },
        maximum_rail_tracks: {
          type: "number",
          description: "Maximum individual native railroad-track spline records to return, from 1 through 80. Defaults to 40; aggregate track counts still cover every exact saved rail entity.",
        },
        maximum_rail_spline_points: {
          type: "number",
          description: "Maximum saved spline points returned per native railroad track, from 1 through 1000. Defaults to 200; aggregate point counts still cover every decoded point.",
        },
        maximum_hypertube_connections: {
          type: "number",
          description: "Maximum individual reciprocal native hypertube connection pairs to return, from 1 through 200. Defaults to 80; aggregate reference counts still cover every exact Hyper connection component.",
        },
        maximum_hypertube_pipes: {
          type: "number",
          description: "Maximum native PipeHyper spline records to return, from 1 through 80. Defaults to 40; aggregate pipe counts still cover every exact PipeHyper entity.",
        },
        maximum_hypertube_spline_points: {
          type: "number",
          description: "Maximum saved spline points returned per native PipeHyper, from 1 through 1000. Defaults to 200; aggregate point counts still cover every decoded point.",
        },
      },
      required: ["blueprint_name"],
      additionalProperties: false,
    },
    run: (graph, args, services) => solveBlueprintLayout(graph, args, services ?? {}),
  },
  {
    name: "compare_blueprint_layouts",
    description:
      "Compare two exact saved native blueprints through the pinned read-only Satisfactory serializer. Returns side-by-side header/version and designer dimensions, decoded object/entity/component/buildable totals, saved pivot spans, exact buildable-class count differences, recipe-reference differences, build-cost differences, and aggregate decoded conveyor/pipe, physical power-wire, railroad, and hypertube topology deltas. Use this to study how supplied references differ from a proposed design before planning a new Blueprint. It preserves missing, malformed, and truncated evidence as unknown and never infers visual theme, snap compatibility, terrain or collision fit, cross-blueprint joins, item/fluid/power flow, or destination Build Gun validity.",
    parameters: {
      type: "object",
      properties: {
        left_blueprint_name: {
          type: "string",
          description: "Exact first blueprint name, or its blueprint_reference from list_blueprints.",
        },
        right_blueprint_name: {
          type: "string",
          description: "Exact second blueprint name, or its blueprint_reference from list_blueprints.",
        },
        maximum_class_differences: {
          type: "number",
          description: "Maximum changed buildable classes to return, from 1 through 200. Defaults to 100.",
        },
        maximum_recipe_differences: {
          type: "number",
          description: "Maximum changed recipe references to return, from 1 through 200. Defaults to 100.",
        },
        maximum_cost_differences: {
          type: "number",
          description: "Maximum changed cost items to return, from 1 through 200. Defaults to 100.",
        },
      },
      required: ["left_blueprint_name", "right_blueprint_name"],
      additionalProperties: false,
    },
    run: (graph, args, services) => solveBlueprintComparison(graph, args, services ?? {}),
  },
  {
    name: "find_reference_designs",
    description:
      "A shipped library of human-authored blueprints, measured. Returns matching reference designs with their designer envelope, occupied span, decoded buildable-class counts grouped into roles (production, logistics, power, enclosure, access, signage, ambience, utility), reciprocal conveyor-pair counts, exact build cost, and the author's declared inputs and outputs, plus the library-wide role census and the architectural vocabulary ranked by how many separate designs use each part. Use this before designing anything the player wants to look built rather than assembled: it is the evidence for how much structure, walkway, and signage a finished design actually carries relative to its machines. It describes other people's builds, not this save. It proves nothing about the current world, terrain fit, hologram validity, unlocks, or achievable rates, and the declared inputs and outputs are author claims parsed from description text rather than decoded or simulated throughput.",
    parameters: {
      type: "object",
      properties: {
        produces: {
          type: "string",
          description: "Case-insensitive substring of an author-declared output item, for example 'rod' or 'Reinforced'.",
        },
        consumes: {
          type: "string",
          description: "Case-insensitive substring of an author-declared input item.",
        },
        kind: {
          type: "string",
          description: "Restrict to one reference kind: production_module, architectural_wrap, or base_build.",
        },
        uses_class: {
          type: "string",
          description: "Case-insensitive substring of a buildable class name, for example 'Catwalk' or 'Tris'. Use this to find designs that demonstrate a specific part.",
        },
        max_cells: {
          type: "number",
          description: "Only designer blueprints whose x and y designer dimensions are both at most this many 8 m cells.",
        },
        limit: { type: "number", description: "Maximum references to return, from 1 through 20. Defaults to 5." },
        include_vocabulary: {
          type: "boolean",
          description: "Include the library-wide part vocabulary. Defaults to true.",
        },
        vocabulary_rows: {
          type: "number",
          description: "Maximum vocabulary rows to return, from 1 through 60. Defaults to 25.",
        },
      },
      additionalProperties: false,
    },
    run: (graph, args, services) => solveReferenceDesigns(graph, args ?? {}, services ?? {}),
  },
  {
    name: "audit_blueprint_placement",
    description:
      "Audits the placed native Blueprint runtime instance the player is currently aiming at, not a saved .sbp file. Returns the proxy's replication/readiness state, complete actor/lightweight member counts only after replication is ready, exact resource-extractor bindings when the game captured them, and for AI Factory Blueprint Resource Anchors the saved resource/purity plus exact runtime-node and miner-binding evidence. A client-null transient Anchor node is unknown on that client, never proof of a lost node or unbound miner. A replication-pending result is a wait state, never proof of zero miners or an unbound miner. This is read-only and emits no actions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: (graph) => solveBlueprintPlacementAudit(graph),
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
      "Creates a PREVIEW-ONLY architectural megabase manifest from this save's measured machines and an explicit site. Use this when the player wants AI Architect Mode: an elevated campus, terraced megafactory, landmark tower, glazed halls, supports, skybridges, a repeatable visual theme, or independently commissionable build phases rather than a plain machine-row layout. It calls the production/layout solvers internally, derives vertical clearance from the tallest measured machine, and compiles integer design cells to exact world XYZ. Set preview_in_world=true when the player wants to see the resulting whole-campus wireframe in the game; that emitted action draws only and never constructs, spends, or claims hologram validity. Set architect_session_name to preserve the exact manifest as an immutable, content-addressed revision; use parent_revision_id for a requested change rather than silently replacing the prior option. Semantic vanilla or modded parts resolve only when the selected recipe exists and is available in the captured catalog; everything else stays explicitly unresolved.",
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
        design_family_id: {
          type: "string",
          maxLength: 80,
          description:
            "Stable human-readable identity shared by buildings that must use the same style parameters and exact captured role recipes. Defaults to the style grammar.",
        },
        match_design_family_fingerprint: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
          description:
            "Optional fingerprint from an earlier manifest. The preview is refused if its style parameters or exact captured role recipes differ, preventing a reused family name from silently changing theme.",
        },
        commissioning_phases: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description:
            "Requested number of independently operable build phases. Machine totals are split deterministically, but phase rates, floors/wings, logistics, and power isolation remain explicit construction blockers until their dedicated solvers run.",
        },
        recipe_class: { type: "string", description: "Optional captured production recipe for the target." },
        use_existing_surplus: {
          type: "boolean",
          description:
            "Subtract existing surplus only when true. Defaults to false because a megabase request normally asks for a new self-contained production program.",
        },
        align_to_base: { type: "boolean", description: "Match the captured base grid. Defaults to true." },
        preview_in_world: {
          type: "boolean",
          description:
            "Draw the compiled semantic campus as a Shipping-safe in-world wireframe. This is a non-mutating architectural preview, not a native Blueprint hologram or placement guarantee.",
        },
        preview_lifetime_seconds: {
          type: "number",
          minimum: 0,
          maximum: 3600,
          description:
            "How long the Architect overlay remains. Zero means until explicitly cleared. Used only when preview_in_world is true.",
        },
        architect_session_name: {
          type: "string",
          maxLength: 80,
          description:
            "Optional stable name for a save/session-scoped Architect project. When present, the exact compiled manifest and design request are stored as a new immutable revision.",
        },
        architect_revision_label: {
          type: "string",
          maxLength: 80,
          description: "Optional visible option/revision label, such as 'Option B — compact tower'.",
        },
        architect_parent_revision_id: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
          description:
            "Exact stored parent revision when this concept changes an earlier option. It must belong to the same Architect session.",
        },
        architect_select_revision: {
          type: "boolean",
          description:
            "Select this newly compiled revision for later promotion. Selection changes only Architect metadata; it does not generate, place, or delete a Blueprint.",
        },
        architect_brief: {
          type: "object",
          description:
            "Human creative brief stored beside exact solver provenance. It may describe intent but cannot override manifest game facts.",
          properties: {
            goal: { type: "string", maxLength: 512 },
            creative_direction: { type: "string", maxLength: 1000 },
            constraints: {
              type: "array",
              maxItems: 32,
              items: { type: "string", maxLength: 256 },
            },
          },
          additionalProperties: false,
        },
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
      const designRequest = architectDesignRequest(args);
      const compiled = compileArchitectDesignRequest(graph, designRequest, services ?? {});
      if (!compiled.compiled) return compiled.result;
      const { manifest, vertical } = compiled;
      let architectRevision = null;
      if (args.architect_session_name) {
        const store = services?.architect;
        architectRevision = store?.saveRevision
          ? store.saveRevision({
              session_name: args.architect_session_name,
              label: args.architect_revision_label,
              parent_revision_id: args.architect_parent_revision_id,
              brief: {
                goal:
                  args.architect_brief?.goal ??
                  `${args.target_rate_per_minute} ${args.item_name}/min at the exact requested site`,
                creative_direction: args.architect_brief?.creative_direction ?? null,
                constraints: args.architect_brief?.constraints ?? [],
              },
              manifest,
              design_request: designRequest,
              select: args.architect_select_revision === true,
            })
          : {
              ok: false,
              reason: "architect_revision_store_is_not_available_for_this_request",
              effect: "the_manifest_was_compiled_but_not_persisted",
            };
      }
      if (args.preview_in_world === true && manifest.compiled === true) {
        const preview = compileArchitectPreview(manifest, {
          lifetime_seconds: args.preview_lifetime_seconds,
        });
        if (!preview.compiled) {
          return {
            ...manifest,
            vertical_module: vertical,
            ...(architectRevision ? { architect_revision: architectRevision } : {}),
            architect_preview: preview,
          };
        }
        services?.actions?.emit?.([preview.action]);
        return {
          ...manifest,
          vertical_module: vertical,
          ...(architectRevision ? { architect_revision: architectRevision } : {}),
          architect_preview: {
            compiled: true,
            schema: preview.schema,
            manifest_fingerprint: preview.manifest_fingerprint,
            element_count: preview.element_count,
            overlay: preview.action.overlay,
            status: "draw_action_emitted_pending_game_readback",
            construction: false,
          },
        };
      }
      return {
        ...manifest,
        vertical_module: vertical,
        ...(architectRevision ? { architect_revision: architectRevision } : {}),
      };
    },
  },

  {
    name: "manage_architect_revisions",
    description:
      "Manages save/session-scoped AI Architect revisions. Use list/get to inspect immutable options, compare for exact geometry/production/topology/style/blocker deltas, preview to redraw one stored option, select or rollback to choose it, promotion_status to recompile the exact selected revision and list every missing native-placement or topology adapter, promote_selected only after the player explicitly asks to write the proven layout through the existing native Designer/serializer, and delete_draft to remove an unselected leaf draft. Promotion never guesses or drops a semantic element or material flow: every producer output and consumer input is exactly balanced across internal edges plus explicit external-I/O obligations before it may emit one standalone generate_native_blueprint action. Direct equal-count solid dependencies with exact rates, captured endpoints, and observed unlocked belt capacity compile through generated-Blueprint v2. Direct equal-count liquid/gas dependencies additionally require unambiguous recipe-fluid identity, captured native pipe ports, and an unlocked pipe with sufficient captured flow and hologram length, then compile through v3; pumps, head lift, junctions, bends, and external fluid I/O remain blockers. Powered production machines also require captured circuit connector identity/capacity/position, compatible circuit types, and an unlocked wire with captured maximum length; they receive either a capacity-safe daisy chain or captured compatible pole trunk with one external-grid link reserved. Partial internal+external feeds require a merger/junction; split/merge, lift, generation/external feeds, and all external-material-I/O routing remain exact blockers. Native generation still does not place a factory; after verified game readback, use preview_blueprint to arm the saved descriptor in the player's Build Gun.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "get", "compare", "preview", "select", "rollback", "promotion_status", "promote_selected", "delete_draft"],
        },
        session_name: { type: "string", maxLength: 80 },
        revision_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        left_revision_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        right_revision_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        preview_lifetime_seconds: {
          type: "number",
          minimum: 0,
          maximum: 3600,
          description: "For preview only. Zero keeps the draw-only overlay until it is cleared.",
        },
        blueprint_name: {
          type: "string",
          maxLength: 240,
          description: "promotion_status/promote_selected: exact native Blueprint name. A deterministic revision-derived name is used when omitted.",
        },
        blueprint_description: {
          type: "string",
          maxLength: 1000,
          description: "promote_selected: optional native Blueprint description; revision and manifest provenance are retained when omitted.",
        },
        commit: {
          type: "boolean",
          description: "promote_selected only: must be true after an explicit player request. promotion_status never emits an action.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      const store = services?.architect;
      if (!store) {
        return {
          ok: false,
          reason: "architect_revision_store_is_not_available_for_this_request",
        };
      }
      if (args.operation === "list") {
        return store.list({ session_name: args.session_name });
      }
      if (args.operation === "get") {
        return store.getRevision({
          session_name: args.session_name,
          revision_id: args.revision_id,
        });
      }
      if (args.operation === "compare") {
        return store.compare({
          session_name: args.session_name,
          left_revision_id: args.left_revision_id,
          right_revision_id: args.right_revision_id,
        });
      }
      if (args.operation === "delete_draft") {
        return store.deleteDraft({
          session_name: args.session_name,
          revision_id: args.revision_id,
        });
      }
      if (["preview", "select", "rollback", "promotion_status", "promote_selected"].includes(args.operation)) {
        const stored = store.getRevision({
          session_name: args.session_name,
          revision_id: args.revision_id,
        });
        if (!stored.ok) return stored;
        if (!stored.revision?.design_request) {
          return {
            ok: false,
            reason: "architect_revision_has_no_recompilable_design_request",
            effect: "create_a_new_revision_from_current_game_evidence",
          };
        }
        const recompiled = compileArchitectDesignRequest(
          graph,
          stored.revision.design_request,
          services ?? {},
        );
        if (!recompiled.compiled) {
          return {
            ok: false,
            reason: "architect_revision_could_not_recompile_against_current_snapshot",
            current_result: recompiled.result,
            effect: "create_a_new_revision_from_current_game_evidence",
          };
        }
        if (args.operation === "preview") {
          const verified = store.verifyRevision({
            session_name: args.session_name,
            revision_id: args.revision_id,
            recompiled_manifest: recompiled.manifest,
          });
          if (!verified.ok) return verified;
          const preview = compileArchitectPreview(recompiled.manifest, {
            lifetime_seconds: args.preview_lifetime_seconds,
          });
          if (!preview.compiled) return preview;
          services?.actions?.emit?.([preview.action]);
          return {
            ok: true,
            operation: "preview",
            revision: verified.revision,
            evidence: verified.evidence,
            architect_preview: {
              schema: preview.schema,
              manifest_fingerprint: preview.manifest_fingerprint,
              element_count: preview.element_count,
              overlay: preview.action.overlay,
              status: "draw_action_emitted_pending_game_readback",
              construction: false,
              selection_changed: false,
            },
          };
        }
        if (["promotion_status", "promote_selected"].includes(args.operation)) {
          const verified = store.verifyRevision({
            session_name: args.session_name,
            revision_id: args.revision_id,
            recompiled_manifest: recompiled.manifest,
          });
          if (!verified.ok) return verified;
          const selectedRevisionId = stored.architect_session?.selected_revision_id ?? null;
          const defaultName = `AI Architect ${stored.revision.label ?? "Revision"} ${String(args.revision_id).slice(7, 15)}`;
          const promotion = compileArchitectPromotion(graph, recompiled.manifest, {
            revision_id: args.revision_id,
            selected_revision_id: selectedRevisionId,
            blueprint_name: args.blueprint_name ?? defaultName,
            description: args.blueprint_description,
            commit: args.operation === "promote_selected" && args.commit === true,
          });
          const { action, ...status } = promotion;
          if (args.operation === "promotion_status") {
            return {
              ok: true,
              operation: "promotion_status",
              revision: verified.revision,
              evidence: verified.evidence,
              promotion: status,
              action_emitted: false,
            };
          }
          if (args.commit !== true) {
            return {
              ok: false,
              reason: "architect_native_promotion_requires_explicit_commit_true",
              revision: verified.revision,
              promotion: status,
              action_emitted: false,
            };
          }
          if (!promotion.ready_for_native_generation || !action) {
            return {
              ok: false,
              reason: "architect_revision_is_not_ready_for_native_generation",
              revision: verified.revision,
              promotion: status,
              action_emitted: false,
            };
          }
          services?.actions?.emit?.([action]);
          return {
            ok: true,
            operation: "promote_selected",
            revision: verified.revision,
            evidence: verified.evidence,
            promotion: status,
            action_emitted: true,
            status: "native_generation_action_emitted_pending_game_readback",
            next_step_after_verified_game_readback:
              `preview blueprint ${promotion.native_blueprint.blueprint_name}`,
          };
        }
        return store.selectRevision({
          session_name: args.session_name,
          revision_id: args.revision_id,
          recompiled_manifest: recompiled.manifest,
          operation: args.operation,
        });
      }
      return { ok: false, reason: "unsupported_architect_revision_operation" };
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

  {
    name: "design_composition",
    description:
      "Builds an architectural composition you design. This is where you make the creative decisions the solvers cannot: how many blocks a factory is, their proportions, which one is tall, where the wings sit, what connects to what. You describe the building; this places it exactly. Positions are in whole GRID CELLS relative to the composition origin, never world coordinates — a block at grid_x 8 sits eight cells east of origin. Blocks overlapping on the same level are refused with both names, because two blocks in the same cells leave a half-built mess. Blocks at different raised_cells MAY overlap: that is a cantilever, and it is how the reference megabases get their overhangs. Mark at least one block houses_production or the result is an empty shell.",
    parameters: {
      type: "object",
      properties: {
        composition: {
          type: "object",
          description: "The building you are designing.",
          properties: {
            blocks: {
              type: "array",
              description: "1-12 rectangular volumes on the grid.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Unique; bridges refer to it." },
                  role: { type: "string", description: "Free text for your own intent." },
                  grid_x: { type: "number", description: "Whole cells east of origin; may be negative." },
                  grid_y: { type: "number", description: "Whole cells north of origin; may be negative." },
                  width_cells: { type: "number", description: "1 to 32." },
                  depth_cells: { type: "number", description: "1 to 32." },
                  levels: { type: "number", description: "Storeys, 1 to 12." },
                  inset_cells: { type: "number", description: "Cells each tier steps in, 0 to 4. 1 gives a stepped silhouette." },
                  raised_cells: { type: "number", description: "Cells of clear air beneath, 0 to 20. Non-zero puts it on pillars." },
                  glass_roof: { type: "boolean", description: "Glass rather than solid, where unlocked." },
                  houses_production: { type: "boolean", description: "Whether the machines go in this block." },
                },
                required: ["name", "grid_x", "grid_y", "width_cells", "depth_cells"],
                additionalProperties: false,
              },
            },
            bridges: {
              type: "array",
              description: "Walkways joining two blocks at a shared level.",
              items: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                  level: { type: "number" },
                },
                required: ["from", "to"],
                additionalProperties: false,
              },
            },
          },
          required: ["blocks"],
          additionalProperties: false,
        },
        origin_cm: {
          type: "object",
          description: "Where cell 0,0 sits. Defaults to the player's position.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        stage_index: {
          type: "number",
          description:
            "For a composition too large to place in one go. Call once without this to get the stage list, then again with 1, 2, 3... to get each stage's actions. The same composition always splits the same way, so the stages are stable between calls. Undo reverses the most recent stage, not the whole build.",
        },
        build: {
          type: "boolean",
          description:
            "Actually place it. Set true ONLY when the player has clearly asked for the building to go up; otherwise this previews and nothing is placed. For a composition that needs staging, this places the one stage named by stage_index.",
        },
      },
      required: ["composition"],
      additionalProperties: false,
    },
    run: (graph, args, services) => {
      const plan = planComposition(graph, {
        ...args,
        plan_structure: planStructure,
        plan_tower: planTower,
      });
      if (!plan.planned) return plan;

      // Designing without being able to build was the gap that made this whole
      // layer a demo: it returned a perfect plan and placed nothing, which is
      // the same silence the player already complained about.
      const build = args.build === true;
      const commitAndEmit = (proposals) => {
        const actions = proposals.map((action) => ({ ...action, commit: build }));
        const validated = validatePlan(graph, actions);
        if (validated.valid && build) services?.actions?.emit?.(validated.actions);
        return { actions, validated };
      };

      const actions = compositionActions(plan, { commit: false });
      if (actions.length <= DEFAULT_MAX_ACTIONS) {
        const { actions: ready, validated } = commitAndEmit(actions);
        return {
          ...plan,
          will_build: build,
          actions_preview: ready,
          plan_validation: validated.valid ? { valid: true, steps: validated.step_count } : validated,
          next_step: build
            ? 'Placing it now. Say "undo" to reverse the whole composition.'
            : 'Nothing was placed. Say "build it" to put this up.',
        };
      }

      // Too big for one transaction. Report the stages rather than the raw
      // count: "764 exceeds 512" tells the player their design is wrong, when
      // it is only too large to place at once. A four-block design of ordinary
      // size lands here, so this is the normal path for anything ambitious.
      const staged = stageComposition(plan, { maxActions: DEFAULT_MAX_ACTIONS });
      const wanted = Number(args?.stage_index);
      const stage = Number.isInteger(wanted)
        ? staged.stages.find((entry) => entry.index === wanted)
        : null;

      const summary = {
        ...plan,
        exceeds_single_transaction: true,
        will_build: build,
        total_actions: staged.total_actions,
        max_actions_per_transaction: DEFAULT_MAX_ACTIONS,
        stage_count: staged.stage_count,
        stages: staged.stages.map(({ actions: _actions, ...rest }) => rest),
        undo_note: staged.undo_note,
      };

      if (!stage) {
        return {
          ...summary,
          actions_preview: [],
          // Refusing to build the whole thing is deliberate. Silently placing
          // stage 1 when the player asked for the building would look like the
          // build failed halfway.
          next_step:
            `This is ${staged.total_actions} pieces and the game places at most ` +
            `${DEFAULT_MAX_ACTIONS} at once, so it goes up in ${staged.stage_count} ` +
            `stages. Call this again with the same composition and stage_index 1, ` +
            `then 2, through ${staged.stage_count}. ${staged.undo_note}`,
        };
      }

      const { actions: ready, validated } = commitAndEmit(stage.actions);
      return {
        ...summary,
        selected_stage: stage.index,
        selected_stage_name: stage.name,
        actions_preview: ready,
        plan_validation: validated.valid ? { valid: true, steps: validated.step_count } : validated,
        next_step: build
          ? stage.index < staged.stage_count
            ? `Placing stage ${stage.index} of ${staged.stage_count} (${stage.name}). ` +
              `Ask for stage ${stage.index + 1} when it is up.`
            : `Placing the last stage (${stage.name}). The composition is complete.`
          : `Nothing was placed. Say "build it" to put up stage ${stage.index}.`,
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
      "Executes world-changing actions the player asked for: place_building, place_blueprint, generate_native_blueprint, export_native_blueprint, teleport_player, dismantle, undo_last, waypoint, clear_waypoints, give_item. Pass the whole sequence at once — it runs in order and stops at the first failure, so a half-built layout is never left behind. Set commit=true on each action the player actually asked to happen; leave it false to preview. Use place_blueprint to stamp one of their saved blueprints into the world (the game's own loader places its contents, wiring and all). generate_native_blueprint writes a solver-computed Blueprint-relative layout through the game's real Designer and must be the only committed write. v1 preserves the fail-closed standalone-buildable contract. v2 additionally accepts explicit straight conveyor links and physical power wires; v3 adds explicit straight native pipelines; v4 adds one-to-one explicitly configured solid-resource Anchors with captured vanilla Miner Mk.1-Mk.3 actors. The game reconstructs the saved archive in its isolated Blueprint world and requires exact native topology and Anchor/miner configuration readback before success. A v4 resource pair does not prove destination-node or terrain alignment. Fluids/oil/gas/fracking extractors, portable/modded miners, pumps, head lift, junction manifolds, conveyor lifts/poles and host-dependent attachments remain unsupported. export_native_blueprint only packages the exact actors currently marked in the game's dismantle tool; never fabricate a region or actor list. Never say an .sbp was written until the game reports readback. Use preview_blueprint to arm one saved blueprint in the requesting player's own Build Gun without placing it: client-only, no cost, and it must be the only action in the request. Use undo_last to reverse the previous action. Use waypoint to drop a marker on the player's MAP and COMPASS — it is the game's own marker system, so it appears on the navigation bar with a live distance readout, and it is NOT the highlight overlay. Use clear_waypoints to remove them.",
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
                enum: ["place_building", "place_blueprint", "preview_blueprint", "generate_native_blueprint", "export_native_blueprint", "teleport_player", "dismantle", "undo_last", "waypoint", "clear_waypoints", "give_item"],
              },
              commit: {
                type: "boolean",
                description: "True to actually do it, false to preview. Defaults to false.",
              },
              recipe_class: { type: "string", description: "place_building: the recipe that BUILDS the machine (e.g. Recipe_ConstructorMk1), not the one it runs." },
              blueprint_name: { type: "string", description: "place_blueprint or preview_blueprint: exact saved-blueprint name from list_blueprints. generate_native_blueprint: the name of the new native Blueprint file. preview_blueprint must be the only action and only arms the requesting player's native Build Gun." },
              description: { type: "string", description: "generate_native_blueprint: description stored in the native Blueprint record." },
              layout_schema: {
                type: "string",
                enum: ["aifactory.generated-blueprint/v1", "aifactory.generated-blueprint/v2", "aifactory.generated-blueprint/v3", "aifactory.generated-blueprint/v4"],
                description: "generate_native_blueprint: exact generated-layout contract version.",
              },
              buildables: {
                type: "array",
                description: "generate_native_blueprint: complete Blueprint-relative layout. Every recipe is rechecked against current game unlocks and each native staged actor is bounds-checked before serialization.",
                items: {
                  type: "object",
                  properties: {
                    part_id: { type: "string" },
                    role: { type: "string", enum: ["floor", "pillar", "wall", "roof", "ramp", "machine", "standalone", "resource_anchor", "miner"] },
                    recipe_class: { type: "string", description: "Exact unlocked Build Gun recipe class." },
                    production_recipe_class: { type: "string", description: "Optional exact unlocked recipe to configure on a compatible manufacturer." },
                    resource_class: { type: "string", description: "v4 resource_anchor only: exact captured solid-resource descriptor class." },
                    resource_purity: { type: "string", enum: ["RP_Inpure", "RP_Normal", "RP_Pure"], description: "v4 resource_anchor only: exact native purity enum (including the engine's RP_Inpure spelling)." },
                    resource_anchor_part_id: { type: "string", description: "v4 miner only: part_id of the one resource_anchor this exact Miner must remain bound to after native save/load." },
                    relative_location: {
                      type: "object",
                      properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
                      required: ["x", "y", "z"],
                      additionalProperties: false,
                    },
                    yaw: { type: "number" },
                  },
                  required: ["part_id", "recipe_class", "relative_location", "yaw"],
                  additionalProperties: false,
                },
              },
              conveyors: {
                type: "array",
                description: "generate_native_blueprint v2: explicit directed straight belts between generated part ids. Omit connector names only when each endpoint has exactly one free compatible port; ambiguity is refused.",
                items: {
                  type: "object",
                  properties: {
                    link_id: { type: "string" },
                    recipe_class: { type: "string", description: "Exact unlocked conveyor-belt Build Gun recipe." },
                    from_part_id: { type: "string" },
                    to_part_id: { type: "string" },
                    from_connector_name: { type: "string" },
                    to_connector_name: { type: "string" },
                  },
                  required: ["link_id", "recipe_class", "from_part_id", "to_part_id"],
                  additionalProperties: false,
                },
              },
              power_wires: {
                type: "array",
                description: "generate_native_blueprint v2: explicit physical circuit wires between generated part ids. Include power poles as ordinary buildables when machine connectors cannot legally fan out.",
                items: {
                  type: "object",
                  properties: {
                    link_id: { type: "string" },
                    recipe_class: { type: "string", description: "Exact unlocked Power Line Build Gun recipe." },
                    from_part_id: { type: "string" },
                    to_part_id: { type: "string" },
                    from_connector_name: { type: "string" },
                    to_connector_name: { type: "string" },
                  },
                  required: ["link_id", "recipe_class", "from_part_id", "to_part_id"],
                  additionalProperties: false,
                },
              },
              pipelines: {
                type: "array",
                description: "generate_native_blueprint v3/v4: explicit directed straight native fluid pipelines between exact generated pipe ports. This does not infer pumps, head lift, fluid rate, or junction routing.",
                items: {
                  type: "object",
                  properties: {
                    link_id: { type: "string" },
                    recipe_class: { type: "string", description: "Exact unlocked Pipeline Build Gun recipe." },
                    from_part_id: { type: "string" },
                    to_part_id: { type: "string" },
                    from_connector_name: { type: "string" },
                    to_connector_name: { type: "string" },
                  },
                  required: ["link_id", "recipe_class", "from_part_id", "to_part_id"],
                  additionalProperties: false,
                },
              },
              selection_source: {
                type: "string",
                enum: ["dismantle_selection", "box_selection"],
                description: "export_native_blueprint: dismantle_selection for the game's own multi-select, or box_selection for a region the player sized and previewed. Never invent either; box_selection is refused unless the ids match a preview the player was shown.",
              },
              selected_actor_ids: {
                type: "array",
                items: { type: "string" },
                description: "export_native_blueprint: every actor_id currently marked in the captured dismantle selection, exactly once. The bridge rejects a subset, addition, radius, or invented id.",
              },
              actor_id: { type: "string", description: "dismantle: the actor_id to remove." },
              name: { type: "string", description: "waypoint: the label shown on the map and compass." },
              item_class: { type: "string", description: "give_item: exact item class_path or display name." },
              amount: { type: "number", description: "give_item: how many." },
              location: {
                type: "object",
                description: "Where, in centimetres. place_building and place_blueprint need an explicit z; waypoint uses it as the marker position.",
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
