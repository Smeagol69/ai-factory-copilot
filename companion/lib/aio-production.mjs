/**
 * A multi-output factory is one material balance, not several independent
 * single-item plans. Reserve internal demand before promising external output.
 *
 * This first optimizer solves a deliberately explicit problem: maximize one
 * output basket's scale for a fixed acyclic, single-product recipe selection.
 * Each raw input gives a linear upper bound; their minimum is attainable in
 * the continuous steady-state model. It is NOT a global recipe/layout optimum.
 */
const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0;
const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
const stableCeil = n => Math.ceil(n - 1e-10 * Math.max(1, n));

export function planAioProduction(graph, args = {}) {
  const fail = (reason, extra = {}) => ({ solver: "aio_production", planned: false,
    source: "captured_recipe_catalog_and_explicit_supply_contract", certainty: "unknown", reason, ...extra });
  const { outputs, inputs, recipe_choices = [], belt_actor_id = null, maximize = true } = args;
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 24 ||
      !Array.isArray(inputs) || !inputs.length || inputs.length > 24 ||
      !Array.isArray(recipe_choices) || recipe_choices.length > 64 || typeof maximize !== "boolean") {
    return fail("give_1_to_24_outputs_and_inputs_and_at_most_64_recipe_choices");
  }
  if (graph.snapshot?.content?.availability_known !== true) return fail("current_recipe_availability_required");
  const resolve = row => {
    if (typeof row?.item_class === "string") return graph.itemsByClass.get(row.item_class) ?? null;
    if (typeof row?.item_name !== "string") return null;
    const matches = [...graph.itemsByClass.values()].filter(i => String(i.name).toLowerCase() === row.item_name.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  };
  const parseRows = (rows, field) => {
    const result = new Map();
    for (const row of rows) {
      const item = resolve(row);
      if (!item || !positive(row?.rate_per_minute)) throw { reason: "exact_item_and_positive_rate_required", field, row };
      if (!String(item.form ?? "").toUpperCase().includes("SOLID")) {
        throw { reason: "aio_initial_solver_requires_proven_solid_item_form", item_class: item.class_path };
      }
      if (result.has(item.class_path)) throw { reason: "duplicate_item_in_contract", field, item_class: item.class_path };
      result.set(item.class_path, row.rate_per_minute);
    }
    return result;
  };
  try {
    const desired = parseRows(outputs, "outputs"), budgets = parseRows(inputs, "inputs");
    if ([...desired.keys()].some(k => budgets.has(k))) return fail("input_resale_is_not_a_manufactured_output");
    const choices = new Map();
    for (const choice of recipe_choices) {
      const item = resolve(choice);
      if (!item || typeof choice.recipe_class !== "string" || choices.has(item.class_path)) return fail("invalid_or_duplicate_recipe_choice");
      choices.set(item.class_path, choice.recipe_class);
    }
    const selected = new Map(), visiting = new Set(), usedChoices = new Set();
    const depth = new Map();
    const select = (itemClass, level = 0) => {
      const previousDepth = depth.get(itemClass);
      depth.set(itemClass, Math.max(depth.get(itemClass) ?? 0, level));
      if (budgets.has(itemClass)) return;
      if (level > 32 || selected.size >= 128) throw { reason: "aio_dependency_budget_exceeded" };
      if (visiting.has(itemClass)) throw { reason: "cyclic_recipe_selection", item_class: itemClass };
      if (selected.has(itemClass) && previousDepth >= level) return;
      // Revisit a shared dependency at a deeper level to keep topological rows
      // correct; its recipe identity is selected only once.
      const item = graph.itemsByClass.get(itemClass);
      if (!item || !String(item.form ?? "").toUpperCase().includes("SOLID")) {
        throw { reason: "missing_or_non_solid_intermediate", item_class: itemClass };
      }
      let recipe = selected.get(itemClass);
      if (!recipe) {
        const all = [...graph.recipesByClass.values()].filter(r =>
          r.products?.some(p => p.item_class === itemClass) &&
          r.produced_in?.some(p => String(p).includes("/Build_")));
        if (choices.has(itemClass)) {
          recipe = all.find(r => r.class_path === choices.get(itemClass));
          usedChoices.add(itemClass);
        } else {
          const standard = all.filter(r => String(r.name ?? "").toLowerCase() === String(item.name).toLowerCase());
          const pool = standard.length ? standard : all.filter(r => r.available === true);
          if (pool.length !== 1) throw { reason: "choose_one_exact_production_recipe", item_class: itemClass,
            candidates: pool.map(r => ({ recipe_class: r.class_path, name: r.name, available: r.available ?? null })) };
          recipe = pool[0];
        }
        if (!recipe || recipe.available !== true) throw { reason: "selected_recipe_not_proven_available", item_class: itemClass,
          recipe_class: choices.get(itemClass) ?? recipe?.class_path ?? null };
        if (recipe.products.length !== 1 || !positive(recipe.products[0].amount) || !positive(recipe.duration_seconds) ||
            !Array.isArray(recipe.ingredients) || !recipe.ingredients.length ||
            recipe.ingredients.some(i => !positive(i.amount) || !i.item_class)) {
          throw { reason: "recipe_requires_single_product_positive_duration_and_ingredients", recipe_class: recipe.class_path };
        }
        selected.set(itemClass, recipe);
      }
      visiting.add(itemClass);
      for (const i of recipe.ingredients) select(i.item_class, level + 1);
      visiting.delete(itemClass);
    };
    for (const item of desired.keys()) select(item);
    if ([...choices.keys()].some(k => !usedChoices.has(k))) return fail("recipe_choice_not_used_by_this_factory");

    // Accumulate full-precision gross demand in consumer-before-producer order.
    const order = [...selected.keys()].sort((a, b) => depth.get(a) - depth.get(b));
    const gross = new Map(desired);
    for (const item of order) {
      const recipe = selected.get(item), cycles = gross.get(item) / recipe.products[0].amount;
      for (const ingredient of recipe.ingredients) add(gross, ingredient.item_class, cycles * ingredient.amount);
    }
    const bounds = [...budgets].filter(([item]) => (gross.get(item) ?? 0) > 0)
      .map(([item, supply]) => ({ item_class: item, ratio: supply / gross.get(item) }));
    if (!bounds.length) return fail("no_supplied_input_is_consumed");
    const maximumScale = Math.min(...bounds.map(b => b.ratio));
    const scale = maximize ? maximumScale : 1;
    if (!positive(scale) || [...gross.values()].some(n => !positive(n * scale))) return fail("nonfinite_material_balance");
    if (!maximize && maximumScale < 1 - 1e-9) return fail("insufficient_input_for_requested_outputs", { maximum_output_scale: maximumScale });

    let belt = null;
    if (belt_actor_id !== null) {
      const node = graph.nodes.get(belt_actor_id);
      if (node?.role !== "conveyor" || !positive(node.conveyor?.items_per_minute)) return fail("belt_actor_has_no_captured_capacity");
      belt = { actor_id: belt_actor_id, class_path: node.class_path, capacity_per_minute: node.conveyor.items_per_minute,
        source: "captured_conveyor_capacity_from_graph" };
    }
    const row = (item, rate) => ({ item_class: item, item_name: graph.itemsByClass.get(item)?.name ?? null,
      rate_per_minute: rate, ...(belt ? { minimum_parallel_belts: stableCeil(rate / belt.capacity_per_minute) } : {}) });
    const balances = [...gross].map(([item, amount]) => {
      const grossRate = amount * scale, external = (desired.get(item) ?? 0) * scale;
      return { ...row(item, grossRate), supplied_externally: budgets.has(item),
        internal_consumption_per_minute: grossRate - external, net_output_per_minute: external,
        residual_per_minute: 0 };
    });
    const steps = [...order].reverse().map((item, index) => {
      const r = selected.get(item), perMachine = 60 / r.duration_seconds * r.products[0].amount;
      const output = gross.get(item) * scale, exact = output / perMachine, machines = stableCeil(exact);
      const cycles = output / r.products[0].amount;
      return { step: index + 1, depth: depth.get(item), recipe_class: r.class_path, recipe_name: r.name,
        produced_in: r.produced_in.filter(p => String(p).includes("/Build_")),
        machines_required: machines, machines_exact: exact, required_clock_percent_each: exact / machines * 100,
        per_machine_display_units_per_minute: perMachine,
        produces: { item_class: item, item_name: graph.itemsByClass.get(item)?.name,
          display_units_per_minute: output },
        inputs_required: r.ingredients.map(i => ({ ...row(i.item_class, i.amount * cycles),
          display_units_per_minute: i.amount * cycles })),
      };
    });
    if (steps.some(s => !Number.isSafeInteger(s.machines_required) || s.machines_required < 1) ||
        steps.reduce((n, s) => n + s.machines_required, 0) > 4096) return fail("aio_machine_budget_exceeded");
    const flows = [];
    for (const step of steps) for (const input of step.inputs_required) flows.push({ ...row(input.item_class, input.rate_per_minute),
      from_recipe_class: selected.get(input.item_class)?.class_path ?? null, to_recipe_class: step.recipe_class,
      destination: "internal_production_reserved_before_storage" });
    for (const [item, rate] of desired) flows.push({ ...row(item, rate * scale),
      from_recipe_class: selected.get(item).class_path, to_recipe_class: null, destination: "finished_output" });
    return { solver: "aio_production", planned: true, world_revision: graph.world_revision,
      source: "captured_recipes_and_explicit_delivered_input_budget", certainty: "deterministic_steady_state_balance",
      objective: "maximize_common_scale_of_net_output_basket_for_fixed_recipes",
      optimality_scope: "exact_for_this_recipe_selection_and_output_ratio_only_not_global_recipe_or_spatial_optimality",
      output_scale: scale, maximum_output_scale: maximumScale,
      limiting_inputs: bounds.filter(b => Math.abs(b.ratio - maximumScale) <= 1e-9 * maximumScale).map(b => b.item_class),
      outputs: [...desired].map(([item, rate]) => row(item, rate * scale)),
      inputs: [...budgets].map(([item, rate]) => ({ ...row(item, (gross.get(item) ?? 0) * scale),
        budget_per_minute: rate, unused_per_minute: Math.max(0, rate - (gross.get(item) ?? 0) * scale),
        supply_evidence: "caller_specified_delivered_budget_not_live_route_verification" })),
      steps, balances, transport_flows: flows, belt,
      totals: { machines: steps.reduce((n, s) => n + s.machines_required, 0), power_mw: null },
      output_handling: "Reserve each internal branch at its calculated rate; send only net output to storage. Continuous operation needs consumers or an overflow sink for every finished output, with sink eligibility and capacity verified. Full storage alone will eventually stop production.",
      build_ready: false,
      blockers: ["physical_belt_splitter_merger_routing_not_compiled", "machine_clock_application_and_native_readback_required",
        "overflow_sink_item_eligibility_capacity_and_routing_not_verified", "power_and_compact_layout_not_verified",
        ...(!belt ? ["no_captured_belt_capacity_selected"] : [])],
      caveats: ["Minimum machine count is per selected recipe at a maximum 100% clock; required underclock settings still need native validation.",
        "Parallel belt counts are aggregate lower bounds, not proof of individual port or junction capacity.",
        "Startup fill time, splitter behavior and finite buffers are not simulated. No guarantee of zero transient idle time.",
        "Uses no current-factory surplus and assumes no production amplification. No file or world action was emitted."],
    };
  } catch (error) {
    if (error?.reason) return fail(error.reason, Object.fromEntries(Object.entries(error).filter(([k]) => k !== "reason")));
    throw error;
  }
}
