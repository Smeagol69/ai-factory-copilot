/**
 * The efficiency layer: what is hardcoded, what is derived, and why.
 *
 * The split matters and it is not arbitrary.
 *
 * DERIVED from the live snapshot, never hardcoded: every recipe ratio. A
 * snapshot carries `content.recipes` with `duration_seconds`, `ingredients` and
 * `products`, which is exactly enough to compute items/minute with no lookup
 * table at all. It is authoritative, version-exact, and covers all 51 of the
 * player's mods. A hardcoded ratio table could only ever be a stale copy of it.
 *
 * HARDCODED in data/efficiency.json: everything the game does not expose as
 * structured data. Belt throughput exists only as English prose in an item
 * description. The overclock power curve is an engine constant that appears
 * nowhere. Manifold-versus-balancer is community practice that no amount of
 * recipe data implies.
 *
 * MEASURED on demand: machine footprints. Every buildable in a snapshot carries
 * a real `bounds.extent`, so these come from the player's own world -- including
 * modded machines, which no table would cover.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(here, "..", "data", "efficiency.json");

let cached = null;

/** The hardcoded constants. Read once; the file does not change at runtime. */
export function efficiencyData() {
  if (cached === null) {
    cached = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  }
  return cached;
}

/**
 * Items per minute in and out of one machine running this recipe at 100%.
 *
 * `duration_seconds` is the cycle time, so a recipe producing 1 item in 2s runs
 * 30 cycles a minute. Everything else follows from that one number.
 */
export function recipeRates(recipe) {
  const duration = Number(recipe?.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  const cyclesPerMinute = 60 / duration;
  const rate = (entries) =>
    (entries ?? []).map((entry) => ({
      item_class: entry.item_class,
      item_name: entry.item_name,
      amount_per_cycle: entry.amount,
      per_minute: Number((entry.amount * cyclesPerMinute).toFixed(6)),
    }));

  return {
    recipe_name: recipe.name,
    recipe_class: recipe.class_path,
    duration_seconds: duration,
    cycles_per_minute: Number(cyclesPerMinute.toFixed(6)),
    produced_in: recipe.produced_in ?? [],
    inputs: rate(recipe.ingredients),
    outputs: rate(recipe.products),
  };
}

/**
 * How many machines to hit a target output rate, and how to clock the remainder.
 *
 * Returns whole machines at 100% plus at most one underclocked machine, rather
 * than rounding the count up. The power curve is superlinear -- see the
 * `power_exponent` note -- so a fractional machine underclocked always costs
 * less power and less material than one more machine at full rate.
 */
export function machinesFor(recipe, targetPerMinute, itemClass = null) {
  const rates = recipeRates(recipe);
  if (rates === null) return null;

  const output = itemClass
    ? rates.outputs.find((o) => o.item_class === itemClass)
    : rates.outputs[0];
  if (!output || output.per_minute <= 0) return null;

  const exact = targetPerMinute / output.per_minute;
  const whole = Math.floor(exact + 1e-9);
  const remainder = exact - whole;
  const { min_percent: minPercent } = efficiencyData().overclock;

  // A remainder too small to clock is not worth a machine; report it as
  // shortfall so the caller sees the gap rather than silently missing rate.
  const partialPercent = remainder > 1e-9 ? remainder * 100 : 0;
  const clockable = partialPercent >= minPercent;

  return {
    item: output.item_name,
    target_per_minute: targetPerMinute,
    per_machine_per_minute: output.per_minute,
    machines_exact: Number(exact.toFixed(6)),
    full_machines: whole,
    partial_machine_clock_percent: clockable ? Number(partialPercent.toFixed(4)) : 0,
    unmet_per_minute: clockable ? 0 : Number((remainder * output.per_minute).toFixed(6)),
    inputs_per_minute: rates.inputs.map((input) => ({
      item: input.item_name,
      item_class: input.item_class,
      per_minute: Number((input.per_minute * exact).toFixed(6)),
    })),
  };
}

/** Power draw at a given clock, on the game's superlinear curve. */
export function overclockPower(baseMegawatts, clockPercent) {
  const { power_exponent: exponent, min_percent: min, max_percent: max } =
    efficiencyData().overclock;
  const clamped = Math.min(max, Math.max(min, clockPercent));
  return {
    clock_percent: clamped,
    clamped: clamped !== clockPercent,
    power_mw: Number((baseMegawatts * (clamped / 100) ** exponent).toFixed(6)),
  };
}

/**
 * The smallest belt that carries this rate.
 *
 * `available` filters to tiers the player has unlocked, when the caller knows.
 * Returns the top tier plus a `saturated` flag when nothing is big enough --
 * a caller that needs two parallel belts has to be told, not handed a lie.
 */
export function beltFor(itemsPerMinute, { available = null, kind = "belts" } = {}) {
  const tiers = efficiencyData().transport[kind] ?? [];
  const usable = available
    ? tiers.filter((tier) => available.includes(tier.name))
    : tiers;
  if (usable.length === 0) return null;

  const fits = usable.find((tier) => tier.items_per_min >= itemsPerMinute);
  if (fits) {
    return { ...fits, saturated: false, belts_needed: 1, spare_per_min: fits.items_per_min - itemsPerMinute };
  }
  const top = usable[usable.length - 1];
  return {
    ...top,
    saturated: true,
    belts_needed: Math.ceil(itemsPerMinute / top.items_per_min),
    spare_per_min: 0,
  };
}

/**
 * Measure machine footprints from a snapshot instead of hardcoding them.
 *
 * `bounds.extent` is a half-extent in centimetres, so a full footprint is twice
 * that, and /100 for metres. Modded machines are covered for free, which no
 * hardcoded table manages.
 *
 * Note this only sees machines the snapshot can see. Until the snapshot reads
 * lightweight buildables, structural pieces will be absent from the result --
 * that is a property of the input, and `sample_count` is reported so a caller
 * can tell a measured value from a lonely one.
 */
export function measureFootprints(snapshot) {
  const byClass = new Map();
  for (const actor of snapshot?.actors ?? []) {
    const extent = actor?.bounds?.extent;
    if (!extent || actor.kind !== "buildable") continue;
    const name = String(actor.class_path).replace(/^.*\./, "");
    const entry = byClass.get(name) ?? { samples: [], class_path: actor.class_path };
    entry.samples.push([
      Math.abs(extent.x) * 2 / 100,
      Math.abs(extent.y) * 2 / 100,
      Math.abs(extent.z) * 2 / 100,
    ]);
    byClass.set(name, entry);
  }

  const out = {};
  for (const [name, entry] of byClass) {
    // Median, not mean: a machine clipped by terrain or mid-build-effect would
    // drag an average and there is no reason to let one bad sample define a size.
    const pick = (axis) => {
      const sorted = entry.samples.map((s) => s[axis]).sort((a, b) => a - b);
      return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
    };
    out[name] = {
      class_path: entry.class_path,
      width_m: pick(0),
      depth_m: pick(1),
      height_m: pick(2),
      sample_count: entry.samples.length,
    };
  }
  return out;
}

/**
 * Cross-check the hardcoded transport table against a snapshot's own item
 * descriptions.
 *
 * The game states throughput in prose. Hardcoding it is right -- parsing English
 * at runtime is not a dependency worth having -- but hardcoding it *without* a
 * check is how a table goes stale through a patch and quietly produces wrong
 * plans for months. This turns that into a failing test.
 */
export function crossCheckTransport(snapshot) {
  const stated = new Map();
  for (const item of snapshot?.content?.items ?? []) {
    const match = String(item.description ?? "").match(
      /up to\s+([\d,]+(?:\.\d+)?)\s*(?:resources|items)?\s*per minute/i,
    );
    if (match) stated.set(item.name, Number(match[1].replace(/,/g, "")));
  }

  const problems = [];
  const checked = [];
  const data = efficiencyData().transport;
  for (const kind of ["belts", "lifts"]) {
    for (const tier of data[kind] ?? []) {
      const found = stated.get(tier.name);
      if (found === undefined) continue;
      checked.push(tier.name);
      if (found !== tier.items_per_min) {
        problems.push(
          `${tier.name}: table says ${tier.items_per_min}/min, game says ${found}/min`,
        );
      }
    }
  }
  return { checked_count: checked.length, problems, ok: problems.length === 0 };
}
