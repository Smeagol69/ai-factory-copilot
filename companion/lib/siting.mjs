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
 * Return the spacing the scan itself says it used, in centimetres.
 *
 * `ScanToFile` records this after choosing tiles, so it is stronger evidence
 * than inferring a pitch from whichever subset of probes happened to hit
 * terrain. Older fixtures can omit it; then infer the smallest axis delta.
 */
function scanStepCm(scan, samples) {
  const reported = Number(scan?.achieved_step_meters);
  if (Number.isFinite(reported) && reported > 0) return reported * 100;

  const deltas = [];
  for (const axis of ["x", "y"]) {
    const values = [...new Set(samples.map((sample) => sample[axis]))].sort((a, b) => a - b);
    for (let index = 1; index < values.length; index += 1) {
      const delta = values[index] - values[index - 1];
      if (delta > 0.001) deltas.push(delta);
    }
  }
  return deltas.length > 0 ? Math.min(...deltas) : null;
}

function finiteXY(sample) {
  return Number.isFinite(sample?.x) && Number.isFinite(sample?.y);
}

/**
 * Prove that every terrain-grid cell touching the requested footprint exists
 * and has ground. A non-empty central intersection is not coverage: a tiny
 * scan can look flat while leaving a blueprint's edges unmeasured.
 */
function footprintCoverage(scan, centre, halfX, halfY) {
  const samples = (scan?.samples ?? []).filter(finiteXY);
  if (samples.length === 0) return { ok: false, reason: "no_terrain_scan" };
  if (scan?.truncated === true) {
    return { ok: false, reason: "terrain_scan_truncated", recorded_probes: samples.length };
  }

  const stepCm = scanStepCm(scan, samples);
  if (!Number.isFinite(stepCm) || stepCm <= 0) {
    return { ok: false, reason: "terrain_scan_spacing_unknown" };
  }

  // The scanner's first tile starts at centre - radius. Use that explicit
  // origin whenever it exists; otherwise a fixture's measured lower bound is
  // the only honest lattice origin available.
  const radiusCm = Number(scan?.radius_meters) * 100;
  const scanCentre = finiteXY(scan?.center) ? scan.center : centre;
  const originX = Number.isFinite(radiusCm) ? scanCentre.x - radiusCm : Math.min(...samples.map((s) => s.x));
  const originY = Number.isFinite(radiusCm) ? scanCentre.y - radiusCm : Math.min(...samples.map((s) => s.y));
  const tolerance = Math.max(0.01, stepCm * 0.001);
  const halfStep = stepCm / 2;
  const minX = centre.x - halfX;
  const maxX = centre.x + halfX;
  const minY = centre.y - halfY;
  const maxY = centre.y + halfY;
  // A grid point represents the half-step cell around it. Include every cell
  // that even touches the footprint so an unmeasured edge cannot become a
  // "flat" verdict.
  const firstX = Math.ceil((minX - halfStep - originX - tolerance) / stepCm);
  const lastX = Math.floor((maxX + halfStep - originX + tolerance) / stepCm);
  const firstY = Math.ceil((minY - halfStep - originY - tolerance) / stepCm);
  const lastY = Math.floor((maxY + halfStep - originY + tolerance) / stepCm);
  const width = Math.max(0, lastX - firstX + 1);
  const depth = Math.max(0, lastY - firstY + 1);
  const required = width * depth;
  if (required === 0) return { ok: false, reason: "footprint_outside_the_scan" };

  const grid = new Map();
  for (const sample of samples) {
    const ix = Math.round((sample.x - originX) / stepCm);
    const iy = Math.round((sample.y - originY) / stepCm);
    const expectedX = originX + ix * stepCm;
    const expectedY = originY + iy * stepCm;
    // Do not round an arbitrary point into a lattice cell it might not cover.
    if (Math.abs(sample.x - expectedX) > tolerance || Math.abs(sample.y - expectedY) > tolerance) {
      continue;
    }
    const key = `${ix},${iy}`;
    const prior = grid.get(key) ?? { present: false, grounded: false };
    prior.present = true;
    prior.grounded ||= sample.hit !== false && Number.isFinite(sample.z);
    grid.set(key, prior);
  }

  let recordedInFootprint = 0;
  for (const key of grid.keys()) {
    const [ix, iy] = key.split(",").map(Number);
    if (ix >= firstX && ix <= lastX && iy >= firstY && iy <= lastY) {
      recordedInFootprint += 1;
    }
  }

  // No scan has more usable cells than recorded points. This fast path also
  // avoids looping a gigantic out-of-range blueprint one cell at a time.
  if (required > grid.size) {
    return {
      ok: false,
      reason: "footprint_scan_coverage_incomplete",
      required_probes: required,
      recorded_probes: recordedInFootprint,
      step_m: Number((stepCm / 100).toFixed(3)),
    };
  }

  let grounded = 0;
  let missing = 0;
  let noGround = 0;
  for (let ix = firstX; ix <= lastX; ix += 1) {
    for (let iy = firstY; iy <= lastY; iy += 1) {
      const probe = grid.get(`${ix},${iy}`);
      if (!probe?.present) missing += 1;
      else if (!probe.grounded) noGround += 1;
      else grounded += 1;
    }
  }

  if (missing > 0) {
    return {
      ok: false,
      reason: "footprint_scan_coverage_incomplete",
      required_probes: required,
      recorded_probes: required - missing,
      step_m: Number((stepCm / 100).toFixed(3)),
    };
  }
  if (noGround > 0) {
    return {
      ok: false,
      reason: "footprint_ground_coverage_incomplete",
      required_probes: required,
      ground_probes: grounded,
      missing_ground_probes: noGround,
      step_m: Number((stepCm / 100).toFixed(3)),
    };
  }

  return {
    ok: true,
    samples,
    coverage: {
      required_probes: required,
      ground_probes: grounded,
      step_m: Number((stepCm / 100).toFixed(3)),
    },
  };
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
  const centre = origin ?? scan.center;
  if (!Number.isFinite(centre?.x) || !Number.isFinite(centre?.y)) {
    return { ok: false, reason: "terrain_scan_has_no_centre" };
  }
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

  const coverage = footprintCoverage(scan, centre, halfX, halfY);
  if (!coverage.ok) return coverage;

  // Include the same cells coverage validated. A cell centred just outside the
  // geometric edge still covers a strip of the blueprint, and excluding it
  // from relief/water statistics would quietly judge that strip from nothing.
  const sampleHalfStepCm = (coverage.coverage.step_m * 100) / 2;
  const under = coverage.samples.filter(
    (sample) =>
      sample.hit !== false &&
      Number.isFinite(sample.z) &&
      Math.abs(sample.x - centre.x) <= halfX + sampleHalfStepCm &&
      Math.abs(sample.y - centre.y) <= halfY + sampleHalfStepCm,
  );

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
      coverage: coverage.coverage,
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
      terrain_scan_truncated:
        "That terrain scan was cut short, so it does not cover this whole footprint. Re-run `/ai terrain` with a smaller radius or coarser step.",
      terrain_scan_spacing_unknown:
        "That terrain scan does not record a usable grid spacing, so full footprint coverage cannot be proven. Re-run `/ai terrain`.",
      terrain_scan_has_no_centre:
        "That terrain scan has no usable centre coordinate, so the footprint cannot be aligned to it. Re-run `/ai terrain`.",
      footprint_scan_coverage_incomplete:
        `Only ${site?.recorded_probes ?? 0} of ${site?.required_probes ?? "the required"} terrain grid probes cover this footprint. Re-run \`/ai terrain\` standing where it would go, or widen its radius.`,
      footprint_ground_coverage_incomplete:
        `${site?.missing_ground_probes ?? "Some"} terrain probe(s) inside the footprint did not find ground. The site stays unknown rather than being called flat; scan again after the terrain is streamed in.`,
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
      `(${site.ground.min_m}–${site.ground.max_m} m), from ${site.ground.probes} probes ` +
      `at ${site.ground.coverage.step_m} m spacing.`,
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
