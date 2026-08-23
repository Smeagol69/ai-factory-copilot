/**
 * Will this blueprint fit *here*?
 *
 * This is the one question a player asks before every placement and that nothing
 * could answer until now. It needs two things that arrived from opposite
 * directions and only recently:
 *
 *   the blueprint's real footprint   — Codex's structural parser, which decodes
 *                                      every saved entity transform
 *   the ground it would land on      — the terrain scan, a probed grid carrying
 *                                      height, slope and a water flag
 *
 * Neither half answers it alone. A blueprint knows its own size and nothing
 * about the world; a terrain scan knows the world and nothing about what you
 * intend to put on it. Crossed, they answer it exactly.
 *
 * What this deliberately does NOT claim: that the game will accept the
 * placement. Clearance against existing buildings, foundation snapping and
 * hologram validity are the build gun's business and are not modelled here. This
 * answers "is the ground suitable", which is the question that actually stops
 * people, and says so rather than implying more.
 */

/** Pivot bounds are a point cloud of origins, not extents. See the caveat below. */
function footprintFromBounds(bounds) {
  if (!bounds?.span_cm) return null;
  return {
    width_m: bounds.span_cm.x / 100,
    depth_m: bounds.span_cm.y / 100,
    height_m: bounds.span_cm.z / 100,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Assess a site for a blueprint.
 *
 * @param inspection  output of inspectBlueprintStructure
 * @param scan        parsed Terrain/latest.json
 * @param origin      {x,y} in cm; defaults to the scan centre
 * @param rotationDeg 0/90/180/270 — a quarter turn swaps width and depth
 */
export function assessBlueprintSite(inspection, scan, { origin = null, rotationDeg = 0 } = {}) {
  if (!inspection?.available) {
    return { ok: false, reason: "blueprint_not_readable" };
  }
  const footprint = footprintFromBounds(inspection.pivot_bounds_cm);
  if (footprint === null) {
    return { ok: false, reason: "blueprint_has_no_decoded_transforms" };
  }
  const samples = (scan?.samples ?? []).filter((s) => s.hit !== false && Number.isFinite(s.z));
  if (samples.length === 0) {
    return { ok: false, reason: "no_terrain_scan" };
  }

  const centre = origin ?? scan.center;
  // A quarter turn swaps the axes. Anything else is refused rather than
  // approximated: the game snaps blueprints to 90-degree steps, so a 37-degree
  // answer would be about a placement that cannot be made.
  const quarterTurns = Math.round(((rotationDeg % 360) + 360) % 360 / 90);
  if (Math.abs(quarterTurns * 90 - (((rotationDeg % 360) + 360) % 360)) > 0.01) {
    return { ok: false, reason: "rotation_must_be_a_quarter_turn" };
  }
  const swap = quarterTurns % 2 === 1;
  const halfX = ((swap ? footprint.depth_m : footprint.width_m) * 100) / 2;
  const halfY = ((swap ? footprint.width_m : footprint.depth_m) * 100) / 2;

  const under = samples.filter(
    (s) => Math.abs(s.x - centre.x) <= halfX && Math.abs(s.y - centre.y) <= halfY,
  );
  if (under.length === 0) {
    return {
      ok: false,
      reason: "footprint_outside_the_scan",
      note: "Re-run the terrain scan standing where the blueprint would go, or widen its radius.",
    };
  }

  const heights = under.map((s) => s.z);
  const minZ = Math.min(...heights);
  const maxZ = Math.max(...heights);
  const medianZ = median(heights);
  const water = under.filter((s) => s.water === true);
  const steep = under.filter((s) => (s.slope_deg ?? 0) >= 15);

  // A foundation is 8 m square; the levelling estimate counts how many it takes
  // to cover the footprint, not how many the game would actually snap.
  const foundationsAcross = Math.ceil((halfX * 2) / 800);
  const foundationsDeep = Math.ceil((halfY * 2) / 800);

  return {
    ok: true,
    blueprint: inspection.blueprint_name,
    footprint_m: {
      width: Number((swap ? footprint.depth_m : footprint.width_m).toFixed(1)),
      depth: Number((swap ? footprint.width_m : footprint.depth_m).toFixed(1)),
      height: Number(footprint.height_m.toFixed(1)),
    },
    rotation_deg: quarterTurns * 90,
    centre_cm: { x: centre.x, y: centre.y },
    ground: {
      probes: under.length,
      min_m: Number((minZ / 100).toFixed(1)),
      max_m: Number((maxZ / 100).toFixed(1)),
      median_m: Number((medianZ / 100).toFixed(1)),
      relief_m: Number(((maxZ - minZ) / 100).toFixed(1)),
    },
    water: {
      probes: water.length,
      fraction: Number((water.length / under.length).toFixed(3)),
    },
    steep: {
      probes: steep.length,
      fraction: Number((steep.length / under.length).toFixed(3)),
    },
    levelling: {
      deck_height_m: Number((maxZ / 100).toFixed(1)),
      fill_above_median_m: Number(((maxZ - medianZ) / 100).toFixed(1)),
      foundations_8m: foundationsAcross * foundationsDeep,
      foundations_grid: `${foundationsAcross} x ${foundationsDeep}`,
    },
    footprint_caveat:
      "Footprint is the span of saved buildable pivots, not collision extents. A blueprint whose " +
      "outermost pieces are walls reads slightly smaller than it builds.",
    not_checked:
      "Clearance against existing buildings, foundation snapping and hologram validity are the " +
      "build gun's business and are not modelled here. This answers whether the ground suits it.",
  };
}

/**
 * A verdict, and the reason for it.
 *
 * Thresholds are deliberately stated in the output rather than hidden: a player
 * who disagrees with "5 m of relief is a lot" can see that is the line being
 * drawn, instead of arguing with a word.
 */
export function judgeSite(site) {
  if (!site?.ok) return { verdict: "unknown", lines: [] };

  const problems = [];
  const notes = [];

  if (site.water.fraction >= 0.5) {
    problems.push(
      `more than half the footprint is over water (${Math.round(site.water.fraction * 100)}%)`,
    );
  } else if (site.water.fraction > 0) {
    notes.push(
      `${Math.round(site.water.fraction * 100)}% of it sits over water — buildable on foundations, ` +
        `but the pillars have to reach the bed`,
    );
  }

  if (site.ground.relief_m >= 8) {
    problems.push(`the ground rises and falls ${site.ground.relief_m} m across it`);
  } else if (site.ground.relief_m >= 3) {
    notes.push(`${site.ground.relief_m} m of relief — one foundation layer absorbs this`);
  }

  if (site.steep.fraction >= 0.3) {
    problems.push(
      `${Math.round(site.steep.fraction * 100)}% of it is steeper than 15 degrees`,
    );
  }

  const verdict = problems.length === 0 ? (notes.length === 0 ? "flat" : "workable") : "difficult";
  return { verdict, problems, notes };
}

/** Human-readable, for the in-game panel. */
export function formatSiteAssessment(site, judgement) {
  if (!site?.ok) {
    const reasons = {
      blueprint_not_readable: "That blueprint could not be decoded.",
      blueprint_has_no_decoded_transforms:
        "That blueprint decoded, but none of its pieces carry a usable transform, so it has no measurable footprint.",
      no_terrain_scan: "There is no terrain scan yet. Run `/ai terrain` where you want to build.",
      footprint_outside_the_scan:
        "The footprint reaches past the scanned area. Re-run `/ai terrain` standing where it would go, or with a larger radius.",
      rotation_must_be_a_quarter_turn:
        "Blueprints snap to quarter turns, so only 0, 90, 180 and 270 are meaningful.",
    };
    return reasons[site?.reason] ?? "That site could not be assessed.";
  }

  const out = [
    `**${site.blueprint}** is ${site.footprint_m.width} x ${site.footprint_m.depth} m` +
      `${site.rotation_deg ? ` at ${site.rotation_deg}°` : ""}.`,
    "",
    `Ground under it: **${site.ground.relief_m} m** of relief ` +
      `(${site.ground.min_m}–${site.ground.max_m} m), from ${site.ground.probes} probes.`,
  ];

  if (judgement.verdict === "flat") {
    out.push("", "**This site is flat enough to build on as-is.**");
  } else if (judgement.verdict === "workable") {
    out.push("", `**Workable.** ${judgement.notes.join("; ")}.`);
  } else {
    out.push("", `**Difficult here** — ${judgement.problems.join(", ")}.`);
    if (judgement.notes.length > 0) out.push(judgement.notes.join("; ") + ".");
  }

  out.push(
    "",
    `To level it: a deck at **${site.levelling.deck_height_m} m** clears the high point, ` +
      `about **${site.levelling.foundations_8m}** foundations (${site.levelling.foundations_grid} of 8 m), ` +
      `filling up to ${site.levelling.fill_above_median_m} m above the middle.`,
    "",
    `_${site.not_checked}_`,
  );
  return out.join("\n");
}
