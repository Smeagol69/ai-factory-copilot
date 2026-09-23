/**
 * The reference census, turned into a budget the Architect has to answer for.
 *
 * `blueprint-reference.mjs` measured what finished builds are actually made of:
 * across seven human-authored designer blueprints, production machines were 24
 * of 890 placed buildings - 2.7% - while enclosure was 63.7%. That number
 * explained why generated output reads as boxes, and then sat in the catalog
 * doing nothing. This is what consumes it.
 *
 * The check is deliberately one-directional. It asks "for the machines this
 * design plans, does its massing imply enough structure to be a building rather
 * than a machine yard" - and reports the shortfall per role. It does not cap
 * anything: a design may exceed the reference happily, and often should.
 *
 * Everything here is an *estimate derived from declared geometry*, and is
 * labelled that way in the output. A hall's wall count is inferred from its
 * perimeter and floor count, not decoded from a placed building. That
 * distinction matters in this codebase: the catalog's own numbers are decoded
 * facts, these are not, and the two must never be reported in the same voice.
 */

import { BLUEPRINT_REFERENCE_CATALOG } from "./blueprint-reference-catalog.mjs";
import { classifyBuildable } from "./blueprint-reference.mjs";

/**
 * How a manifest's semantic roles map onto the census roles the references were
 * measured in. `megabase.mjs` names parts by building function; the catalog
 * names them by what they do in a finished build.
 */
export const SEMANTIC_ROLE_CENSUS = Object.freeze({
  foundation: "enclosure",
  wall: "enclosure",
  window: "enclosure",
  sloped_roof: "enclosure",
  support_column: "enclosure",
  walkway: "access",
  rail: "access",
  lighting: "ambience",
  sign: "signage",
});

/**
 * The reference mix, taken from designer blueprints only.
 *
 * The finished home base is excluded on purpose: it is a whole-site export
 * whose proportions describe a base, not a module, and including it would drag
 * the production share toward zero for reasons that say nothing about how a
 * single building should be composed.
 */
export function referenceRoleMix(catalog = BLUEPRINT_REFERENCE_CATALOG) {
  const designs = (catalog?.references ?? []).filter(
    (reference) => reference.kind !== "base_build",
  );
  const counts = {};
  let total = 0;
  for (const reference of designs) {
    for (const [role, value] of Object.entries(reference?.role_census?.counts ?? {})) {
      const count = Number(value);
      if (!Number.isFinite(count) || count <= 0) continue;
      counts[role] = (counts[role] ?? 0) + count;
      total += count;
    }
  }
  const perProduction = {};
  const production = counts.production ?? 0;
  for (const [role, count] of Object.entries(counts)) {
    perProduction[role] = production > 0 ? count / production : null;
  }
  return {
    source_designs: designs.length,
    total_buildings: total,
    counts,
    /** Parts of each role that real designs place per production machine. */
    per_production_machine: perProduction,
    evidence: "decoded_from_designer_blueprints_in_the_reference_catalog",
    excluded: "base_build references, whose site-wide proportions are not a module's",
  };
}

function whole(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Parts a single element's declared massing implies.
 *
 * A box `x` by `y` cells and `z` floors needs a deck per floor, a skin around
 * its perimeter on every floor, a column at each corner, and a roof. That is
 * arithmetic on the manifest's own `size_cells`, not a decoded building - the
 * caller must present it as an estimate.
 */
export function impliedPartsForElement(element) {
  const size = element?.size_cells ?? {};
  const x = whole(size.x);
  const y = whole(size.y);
  const z = Math.max(whole(size.z), 1);
  if (x === 0 || y === 0) {
    return { foundation: 0, wall: 0, window: 0, sloped_roof: 0, support_column: 0 };
  }

  const deck = x * y;
  const perimeter = 2 * (x + y);
  const roles = new Set([
    ...(element?.requires_roles ?? []),
    ...(element?.optional_roles ?? []),
  ]);

  // Only count what the element actually claims to use. An element that never
  // declares a wall is not silently credited with one.
  return {
    foundation: roles.has("foundation") ? deck * z : 0,
    wall: roles.has("wall") ? perimeter * z : 0,
    // A glazed face is part of the skin, not extra to it: windows displace
    // wall rather than adding area, so they are counted from the same
    // perimeter and the wall estimate is not also reduced. The pair is an
    // upper bound on skin, which is the honest direction for a budget.
    window: roles.has("window") ? perimeter : 0,
    sloped_roof: roles.has("sloped_roof") ? deck : 0,
    support_column: roles.has("support_column") ? 4 * z : 0,
    walkway: roles.has("walkway") ? perimeter : 0,
    rail: roles.has("rail") ? perimeter : 0,
    lighting: roles.has("lighting") ? Math.max(Math.round(deck / 4), 1) : 0,
    // Signage is the one role that does not scale with area: a sign labels
    // what is inside, so it tracks the machines in this element rather than
    // its footprint. One per machine is the floor - the references place
    // roughly three - so declaring the role clears "cannot label itself at
    // all" while the ratio still shows how much more a real build signs.
    sign: roles.has("sign") ? Math.max(elementMachines(element), 1) : 0,
  };
}

/** Machines this one element plans, across every phase it allocates. */
function elementMachines(element) {
  const allocation = element?.phase_machine_allocation;
  let planned = 0;
  if (Array.isArray(allocation)) {
    for (const entry of allocation) planned += whole(entry?.machines ?? entry?.count);
  } else if (allocation && typeof allocation === "object") {
    for (const value of Object.values(allocation)) planned += whole(value);
  }
  return planned;
}

function machineCount(manifest) {
  let planned = 0;
  for (const element of manifest?.elements ?? []) {
    const allocation = element?.phase_machine_allocation;
    if (Array.isArray(allocation)) {
      for (const entry of allocation) planned += whole(entry?.machines ?? entry?.count);
    } else if (allocation && typeof allocation === "object") {
      for (const value of Object.values(allocation)) planned += whole(value);
    }
  }
  if (planned > 0) return planned;
  // Fall back to the program's own machine total when elements carry no
  // per-phase allocation.
  return whole(manifest?.program?.total_machines ?? manifest?.program?.machines);
}

/**
 * Required-versus-implied composition for a compiled manifest.
 *
 * Shortfalls are named, never silently rounded away, and a role the manifest
 * cannot express at all is reported as its own kind of finding rather than as
 * a count of zero - those are different problems with different fixes.
 */
export function assessComposition(manifest, catalog = BLUEPRINT_REFERENCE_CATALOG) {
  const reference = referenceRoleMix(catalog);
  const machines = machineCount(manifest);

  const impliedBySemanticRole = {};
  for (const element of manifest?.elements ?? []) {
    for (const [role, count] of Object.entries(impliedPartsForElement(element))) {
      impliedBySemanticRole[role] = (impliedBySemanticRole[role] ?? 0) + count;
    }
  }

  const impliedByCensusRole = {};
  for (const [semanticRole, count] of Object.entries(impliedBySemanticRole)) {
    const censusRole = SEMANTIC_ROLE_CENSUS[semanticRole];
    if (!censusRole) continue;
    impliedByCensusRole[censusRole] = (impliedByCensusRole[censusRole] ?? 0) + count;
  }

  // Roles the references place but this manifest has no vocabulary for at all.
  const expressible = new Set(Object.values(SEMANTIC_ROLE_CENSUS));
  const inexpressible = Object.keys(reference.per_production_machine).filter(
    (role) => role !== "production" && role !== "logistics" && role !== "power" &&
      !expressible.has(role),
  );

  const roles = [];
  for (const [role, ratio] of Object.entries(reference.per_production_machine)) {
    if (role === "production") continue;
    // Logistics and power are planned by the routing and power lanes from real
    // connection evidence, not massed here, so this budget does not grade them.
    if (role === "logistics" || role === "power") continue;
    const required = ratio === null ? null : Math.round(ratio * machines);
    const implied = impliedByCensusRole[role] ?? 0;
    roles.push({
      role,
      reference_per_machine: ratio === null ? null : Math.round(ratio * 100) / 100,
      required_for_planned_machines: required,
      implied_by_declared_massing: implied,
      shortfall: required === null ? null : Math.max(required - implied, 0),
      expressible: expressible.has(role),
    });
  }
  roles.sort((a, b) => (b.shortfall ?? 0) - (a.shortfall ?? 0));

  const shortRoles = roles.filter((entry) => entry.expressible && (entry.shortfall ?? 0) > 0);
  return {
    planned_machines: machines,
    reference_mix: reference,
    roles,
    meets_reference_composition: shortRoles.length === 0 && machines > 0,
    shortfall_roles: shortRoles.map((entry) => entry.role),
    inexpressible_roles: inexpressible,
    evidence: "estimated_from_declared_element_geometry_against_decoded_reference_census",
    caveat:
      "Implied counts are arithmetic on each element's declared size_cells and requires_roles, not decoded buildings. They size a budget; they do not prove what a build will contain. The reference ratios themselves are decoded from saved blueprints.",
    guidance:
      machines === 0
        ? "No machines are planned, so there is no production to compose around and no budget to meet."
        : shortRoles.length === 0
          ? "The declared massing already implies reference-scale structure for the machines planned."
          : `Increase massing or declared roles for: ${shortRoles.map((entry) => entry.role).join(", ")}. Real designs place these at the ratios above for every production machine.`,
  };
}

/**
 * The building a Build Gun recipe produces, as a class name the reference
 * classifier understands. `Recipe_Wall_Concrete_8x4` describes the same thing
 * the catalog counted as `Wall_Concrete_8x4`.
 */
export function buildingNameFromRecipeClass(recipeClass) {
  const value = String(recipeClass ?? "");
  if (!value) return "";
  const asset = value.slice(value.lastIndexOf("/") + 1).split(".")[0];
  return asset.startsWith("Recipe_") ? asset.slice("Recipe_".length) : asset;
}

/**
 * The same budget, graded against what promotion will actually build.
 *
 * `assessComposition` grades declared *intent* - a hall's volume implies a lot
 * of skin whether or not the adapters ever emit it. This grades the promoted
 * action list instead, classifying each action by the building its recipe
 * produces through the very classifier the reference catalog was counted with.
 * That makes it apples-to-apples: planned buildings against decoded buildings,
 * no geometry estimate in between. When the two assessments disagree, this one
 * is the truth about what gets built.
 */
export function assessPromotedComposition(actions, catalog = BLUEPRINT_REFERENCE_CATALOG, { graph = null, topologyRoles = new Map() } = {}) {
  const reference = referenceRoleMix(catalog);
  const counts = {};
  const unclassified = new Set();
  const unresolvedRecipes = new Set();
  let planned = 0;

  for (const action of actions ?? []) {
    const recipeClass = String(action?.recipe_class ?? "");
    let name;
    if (graph) {
      // Mod recipes do not have to share a name with the building they create.
      // Use the captured recipe -> item descriptor -> building class relation,
      // and keep missing/ambiguous evidence unknown instead of guessing.
      const recipe = graph.recipesByClass?.get(recipeClass) ??
        graph.snapshot?.content?.recipes?.find((entry) => entry.class_path === recipeClass);
      const classes = new Set();
      for (const product of recipe?.products ?? []) {
        const item = graph.itemsByClass?.get(product.item_class) ??
          graph.snapshot?.content?.items?.find((entry) => entry.class_path === product.item_class);
        if (item?.building?.class_path) classes.add(item.building.class_path);
      }
      if (classes.size === 1) {
        const classPath = [...classes][0];
        name = classPath.slice(Math.max(classPath.lastIndexOf("/"), classPath.lastIndexOf(".")) + 1)
          .replace(/^Build_/, "").replace(/_C$/, "");
      } else {
        unresolvedRecipes.add(recipeClass || "missing_recipe_class");
        name = "";
      }
    } else {
      name = buildingNameFromRecipeClass(recipeClass);
    }
    planned += 1;
    // The native spline collection establishes its role even for modded class
    // names. These roles are supplied by the compiled-payload adapter only.
    const role = topologyRoles.get(action) ?? classifyBuildable(name);
    counts[role] = (counts[role] ?? 0) + 1;
    if (role === "unclassified") unclassified.add(name || recipeClass || "missing_recipe_class");
  }

  const machines = counts.production ?? 0;
  const roles = [];
  for (const [role, ratio] of Object.entries(reference.per_production_machine)) {
    if (role === "production" || ratio === null) continue;
    const required = Math.round(ratio * machines);
    const actual = counts[role] ?? 0;
    roles.push({
      role,
      reference_per_machine: Math.round(ratio * 100) / 100,
      required_for_planned_machines: required,
      planned_by_promotion: actual,
      shortfall: Math.max(required - actual, 0),
    });
  }
  roles.sort((a, b) => b.shortfall - a.shortfall);
  const shortRoles = roles.filter((entry) => entry.shortfall > 0);

  return {
    planned_buildings: planned,
    planned_machines: machines,
    planned_by_role: counts,
    unclassified_buildings: [...unclassified].sort(),
    unresolved_recipe_classes: [...unresolvedRecipes].sort(),
    classification_complete: unclassified.size === 0 && unresolvedRecipes.size === 0,
    roles,
    meets_reference_composition: machines > 0 && shortRoles.length === 0 && unclassified.size === 0 && unresolvedRecipes.size === 0,
    shortfall_roles: shortRoles.map((entry) => entry.role),
    production_share:
      planned > 0 ? Math.round((machines / planned) * 10000) / 10000 : null,
    reference_production_share:
      reference.total_buildings > 0
        ? Math.round(((reference.counts.production ?? 0) / reference.total_buildings) * 10000) / 10000
        : null,
    evidence: graph
      ? "classified_from_captured_recipe_buildable_classes_against_decoded_reference_census"
      : "classified_from_promoted_action_recipe_classes_against_decoded_reference_census",
    caveat:
      "Counts planned records; roles use the reference library's class-name classifier. Unclassified records may include production machines, so their presence makes the production denominator incomplete. These advisory reference ratios are not construction requirements. Terrain, clearance, cost and Build Gun validity remain the game's to decide.",
  };
}

/** Count the final native payload, including spline records outside actions. */
export function assessGeneratedBlueprintComposition(compiled, graph, catalog = BLUEPRINT_REFERENCE_CATALOG) {
  const sections = ["buildables", "conveyors", "power_wires", "pipelines"];
  const entries = sections.flatMap((section) => compiled?.[section] ?? []);
  const topologyRoles = new Map([
    ...(compiled?.conveyors ?? []).map((entry) => [entry, "logistics"]),
    ...(compiled?.power_wires ?? []).map((entry) => [entry, "power"]),
    ...(compiled?.pipelines ?? []).map((entry) => [entry, "logistics"]),
  ]);
  return {
    ...assessPromotedComposition(entries, catalog, { graph, topologyRoles }),
    native_record_counts: Object.fromEntries(sections.map((section) => [section, compiled?.[section]?.length ?? 0])),
  };
}
