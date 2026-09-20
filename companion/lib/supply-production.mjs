/**
 * Sizing a factory from the miners that already exist.
 *
 * Every production planner here runs forwards from a goal: "make 60 wire per
 * minute", work out the chain, size the machines. That is the right shape when
 * you know what you want. It is the wrong shape for the far more common
 * situation of standing in front of four miners and asking what to build.
 *
 * This runs the other way. It censuses what the world is actually extracting,
 * then asks how many machines that supply supports for a chosen product.
 *
 * Nothing here is a second solver. The ore rate comes from `solveMachineRates`,
 * which reads each extractor's own per-minute accessor and falls back to yield
 * times live cycle time; the ratio comes from probing `solveProductionPlan` at
 * one unit per minute with `stop_at_item_classes` set to the ore, exactly the
 * technique `resource-factory.mjs` already uses. Both are existing, tested
 * paths - this is arithmetic between them, and the arithmetic is the part that
 * was missing.
 *
 * Two deliberate choices about honesty:
 *
 *   - **Machines round down.** Supply that buys 3.7 Smelters buys three, and
 *     the leftover ore is reported rather than rounded into a fourth machine
 *     that would starve. A player who wants the fourth can add a miner.
 *   - **Belt capacity clamps each miner.** A Mk.3 miner on a pure node can
 *     out-produce the belt leaving it, and planning against the mining rate
 *     rather than the deliverable rate overstates the factory. The clamp is
 *     reported alongside the raw rate so the loss is visible, not silent.
 */

import { findBestAvailableBelt } from "./base-build.mjs";
import { solveMachineRates, solveProductionPlan } from "./solvers.mjs";

/**
 * The slowest belt of the chosen tier actually observed in this world.
 *
 * Measured rather than looked up, matching `resource-factory.mjs`: a belt's
 * items-per-minute comes from the captured instance's own conveyor data, so a
 * modded or retuned belt sizes correctly. No captured belt means no clamp, and
 * that is reported rather than filled in with a vanilla number.
 */
function observedBeltCapacity(graph, belt) {
  const tier = Number(belt?.tier);
  const matches = [...(graph?.nodes?.values?.() ?? [])]
    .filter((node) => node.role === "conveyor")
    .filter((node) =>
      Number.isFinite(tier)
        ? new RegExp(`conveyorbeltmk${tier}`, "i").test(String(node.class_path ?? node.name ?? ""))
        : true,
    )
    .filter((node) => !belt?.owner_mod || !node.owner_mod || node.owner_mod === belt.owner_mod)
    .map((node) => Number(node.conveyor?.items_per_minute))
    .filter((rate) => Number.isFinite(rate) && rate > 0);
  if (matches.length === 0) return null;
  // Slowest observed: overbuilding is worse than leaving headroom.
  return Math.min(...matches);
}

function refuse(reason, extra = {}) {
  return { solver: "supply_production", planned: false, reason, ...extra };
}

const sameItem = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

/**
 * What the world extracts, per item, per minute.
 *
 * Each extractor is clamped to the belt that can carry its output, because a
 * rate that cannot leave the miner is not supply.
 */
export function censusExtractedSupply(graph, { belt_tier: beltTier = null } = {}) {
  const rates = solveMachineRates(graph);
  const belt = findBestAvailableBelt(graph, { tier: beltTier });
  const beltLimit = observedBeltCapacity(graph, belt);
  const hasBeltLimit = Number.isFinite(beltLimit) && beltLimit > 0;

  const byItem = new Map();
  // Extractors the rate solver itself could not resolve never appear in
  // `machines`, so carrying its own unresolved list forward is the only way
  // they are not silently absent from the supply picture.
  const unresolved = (rates.unresolved_machines ?? [])
    .filter((entry) => entry?.raw?.extractor || /extractor/i.test(String(entry?.reason ?? "")))
    .map((entry) => ({
      actor_id: entry.actor_id ?? null,
      reason: entry.reason ?? "rate_solver_could_not_resolve_this_machine",
    }));

  for (const machine of rates.machines ?? []) {
    const extracted = machine.extracted_item_classes ?? [];
    if (extracted.length === 0) continue;
    if (extracted.length > 1) {
      // One extractor reporting several items has no single supply figure to
      // attribute; saying so beats dividing it arbitrarily.
      unresolved.push({
        actor_id: machine.actor_id,
        reason: "extractor_reports_more_than_one_extracted_item",
        item_classes: extracted,
      });
      continue;
    }
    const itemClass = extracted[0];
    const output = (machine.theoretical_outputs ?? []).find((entry) =>
      sameItem(entry.item_class, itemClass),
    );
    const mined = Number(output?.display_units_per_minute);
    if (!Number.isFinite(mined) || mined <= 0) {
      unresolved.push({
        actor_id: machine.actor_id,
        reason: "extractor_rate_could_not_be_resolved",
        item_class: itemClass,
      });
      continue;
    }
    const delivered = hasBeltLimit ? Math.min(mined, beltLimit) : mined;
    const entry = byItem.get(itemClass) ?? {
      item_class: itemClass,
      item_name: output?.item_name ?? graph.itemsByClass?.get(itemClass)?.name ?? null,
      extractors: 0,
      mined_per_minute: 0,
      deliverable_per_minute: 0,
      clamped_by_belt: false,
    };
    entry.extractors += 1;
    entry.mined_per_minute += mined;
    entry.deliverable_per_minute += delivered;
    if (delivered < mined) entry.clamped_by_belt = true;
    byItem.set(itemClass, entry);
  }

  for (const entry of byItem.values()) {
    entry.mined_per_minute = Math.round(entry.mined_per_minute * 100) / 100;
    entry.deliverable_per_minute = Math.round(entry.deliverable_per_minute * 100) / 100;
  }

  return {
    supply: [...byItem.values()].sort((a, b) => b.deliverable_per_minute - a.deliverable_per_minute),
    unresolved,
    belt: belt ? { tier: belt.tier, items_per_minute: hasBeltLimit ? beltLimit : null } : null,
    // A missing belt capacity is reported rather than assumed: without it the
    // rates are mining rates, which overstate what a factory can be fed.
    belt_clamp_applied: hasBeltLimit,
  };
}

/**
 * How much ore one unit per minute of a product costs.
 *
 * Probing the existing planner rather than walking the recipe tree here: it
 * already handles alternates, byproducts and multi-step chains, and
 * `stop_at_item_classes` makes it stop at the ore instead of recursing into
 * how the ore itself might be manufactured.
 */
function oreCostPerUnit(graph, { productClass, oreClass, recipeClass = null }) {
  // The probe runs a full production plan, which reaches into power, layout
  // and recipe resolution. Any one of those throwing is a bug elsewhere, but
  // it must surface here as a refusal naming the ore rather than taking the
  // whole request down.
  let plan;
  try {
    plan = probePlan(graph, { productClass, oreClass, recipeClass });
  } catch (error) {
    return {
      resolved: false,
      reason: `production_plan_threw:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return interpretProbe(plan, oreClass);
}

function probePlan(graph, { productClass, oreClass, recipeClass }) {
  return solveProductionPlan(graph, {
    item_class: productClass,
    target_rate_per_minute: 1,
    ...(recipeClass ? { recipe_class: recipeClass } : {}),
    use_existing_surplus: false,
    prefer_standard_recipes: true,
    stop_at_item_classes: [oreClass],
  });
}

function interpretProbe(plan, oreClass) {
  if (!plan.planned) {
    return { resolved: false, reason: plan.reason ?? "production_plan_refused", plan };
  }
  if (plan.unresolved?.length) {
    return { resolved: false, reason: "production_plan_has_unresolved_steps", plan };
  }
  const matching = (plan.raw_inputs_required ?? []).find((raw) =>
    sameItem(raw.item_class, oreClass),
  );
  const perUnit = Number(matching?.display_units_per_minute);
  if (!Number.isFinite(perUnit) || perUnit <= 0) {
    return { resolved: false, reason: "chain_does_not_reduce_to_the_available_ore", plan };
  }
  const otherRaw = (plan.raw_inputs_required ?? []).filter(
    (raw) => !sameItem(raw.item_class, oreClass),
  );
  return { resolved: true, ore_per_unit: perUnit, other_raw: otherRaw, plan };
}

/**
 * Size a factory for one product against the ore already being mined.
 */
export function planSupplyDrivenProduction(graph, args = {}) {
  const {
    item_name: itemName = null,
    item_class: requestedItemClass = null,
    ore_class: requestedOre = null,
    recipe_class: recipeClass = null,
    belt_tier: beltTier = null,
  } = args;

  const census = censusExtractedSupply(graph, { belt_tier: beltTier });
  if (census.supply.length === 0) {
    return refuse("nothing in this world is extracting anything, so there is no supply to size against", {
      missing: ["captured_extractors"],
      unresolved: census.unresolved,
    });
  }

  // Resolve the product the player asked for.
  let productClass = requestedItemClass;
  if (!productClass && itemName) {
    const wanted = String(itemName).trim().toLowerCase();
    for (const [classPath, item] of graph.itemsByClass ?? new Map()) {
      if (String(item?.name ?? "").trim().toLowerCase() === wanted) {
        productClass = classPath;
        break;
      }
    }
  }
  if (!productClass) {
    return refuse("name the product to build, by item_name or item_class", {
      missing: ["item_name"],
      available_supply: census.supply.map((entry) => entry.item_name ?? entry.item_class),
    });
  }

  // Which ore feeds it? An explicit choice wins; otherwise try each supply in
  // turn and keep the first whose chain actually reduces to it.
  const candidates = requestedOre
    ? census.supply.filter((entry) => sameItem(entry.item_class, requestedOre))
    : census.supply;
  if (candidates.length === 0) {
    return refuse("that ore is not being extracted in this world", {
      ore_class: requestedOre,
      available_supply: census.supply.map((entry) => entry.item_class),
    });
  }

  const attempts = [];
  for (const entry of candidates) {
    const cost = oreCostPerUnit(graph, {
      productClass,
      oreClass: entry.item_class,
      recipeClass,
    });
    if (!cost.resolved) {
      attempts.push({ ore: entry.item_class, reason: cost.reason });
      continue;
    }

    const supported = entry.deliverable_per_minute / cost.ore_per_unit;
    // Round down. A fractional machine is a machine that starves.
    const machines = Math.floor(supported);
    if (machines < 1) {
      attempts.push({
        ore: entry.item_class,
        reason: "supply_supports_less_than_one_machine",
        supported_rate_per_minute: Math.round(supported * 100) / 100,
      });
      continue;
    }

    const oreUsed = Math.round(machines * cost.ore_per_unit * 100) / 100;
    const leftover = Math.round((entry.deliverable_per_minute - oreUsed) * 100) / 100;

    // Re-plan at the whole-machine rate so the returned chain is the real one,
    // with its own machine counts per step rather than a scaled estimate.
    const chain = solveProductionPlan(graph, {
      item_class: productClass,
      target_rate_per_minute: machines,
      ...(recipeClass ? { recipe_class: recipeClass } : {}),
      use_existing_surplus: false,
      prefer_standard_recipes: true,
      stop_at_item_classes: [entry.item_class],
    });

    return {
      solver: "supply_production",
      planned: true,
      product: {
        item_class: productClass,
        item_name: graph.itemsByClass?.get(productClass)?.name ?? null,
        output_per_minute: machines,
      },
      fed_by: {
        item_class: entry.item_class,
        item_name: entry.item_name,
        extractors: entry.extractors,
        mined_per_minute: entry.mined_per_minute,
        deliverable_per_minute: entry.deliverable_per_minute,
        clamped_by_belt: entry.clamped_by_belt,
      },
      ore_per_unit: Math.round(cost.ore_per_unit * 1000) / 1000,
      ore_consumed_per_minute: oreUsed,
      ore_left_over_per_minute: leftover,
      // Rounding down is visible, not silent: this is what the spare ore buys.
      unused_capacity_note:
        leftover > 0
          ? `${leftover}/min of ${entry.item_name ?? entry.item_class} is spare - not enough for another whole unit of output.`
          : "supply is fully committed.",
      chain,
      other_raw_inputs: cost.other_raw,
      supply_census: census.supply,
      belt: census.belt,
      unresolved_extractors: census.unresolved,
      caveats: [
        "machine counts come from the production planner's own chain, not from this arithmetic",
        "belt capacity clamps each extractor; the unclamped mining rate is reported beside it",
        "nothing is placed - this sizes a factory, it does not lay one out",
      ],
    };
  }

  return refuse("no extracted ore feeds that product through a resolvable chain", {
    product_class: productClass,
    attempts,
    available_supply: census.supply.map((entry) => entry.item_name ?? entry.item_class),
  });
}
