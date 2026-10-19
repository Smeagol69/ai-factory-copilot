// Pure, bounded saved-Blueprint reference traits. No I/O, no imports.
// Evidence is about saved pivots/appearance only; it never proves fit or absence beyond its bounds.
const TRAITS_SCHEMA = 'aifactory.blueprint-reference-traits/v1';
const COMPARISON_SCHEMA = 'aifactory.blueprint-reference-traits-comparison/v1';
const POSITION_TOLERANCE_CM = 0.1;
const COMPONENT_TOLERANCE = 1e-4;
const QUAT_NORM_TOLERANCE = 0.001;
const INPUT_CAP = 512;
const CLAIMS_NOT_MADE = [
  'site_fit',
  'mesh_collision_or_navigation_compatibility',
  'rendered_appearance_or_color',
  'buildability',
  'live_functionality',
  'maximum_or_globally_best_assignment',
  'unique_correspondence',
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object';
const isFingerprint = (v) => typeof v === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(v);
const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;
const limit = (v, def, hard) => (Number.isSafeInteger(v) && v >= 1 ? Math.min(v, hard) : def);
const vec3 = (v, keys) => isObj(v) && keys.every((k) => isNum(v[k]));
const XYZ = ['x', 'y', 'z'];
const XYZW = ['x', 'y', 'z', 'w'];

function usableTransform(t) {
  if (!isObj(t) || !vec3(t.translation_cm, XYZ) || !vec3(t.rotation_quat, XYZW) || !vec3(t.scale3d, XYZ)) return false;
  const q = t.rotation_quat;
  const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return Number.isFinite(norm) && Math.abs(norm - 1) <= QUAT_NORM_TOLERANCE;
}

const copyXYZ = (v) => ({ x: v.x, y: v.y, z: v.z });
const copyTransform = (t) => ({
  translation_cm: copyXYZ(t.translation_cm),
  rotation_quat: { x: t.rotation_quat.x, y: t.rotation_quat.y, z: t.rotation_quat.z, w: t.rotation_quat.w },
  scale3d: copyXYZ(t.scale3d),
});

export function readSavedAppearance(properties) {
  const out = { swatch_descriptor: null, color_slot: null, swatch_state: 'absent', color_slot_state: 'absent' };
  const props = isObj(properties) ? properties : {};
  const cd = props.mCustomizationData;
  if (cd !== undefined && cd !== null) {
    const swatch = isObj(cd) && isObj(cd.value) && isObj(cd.value.properties) ? cd.value.properties.SwatchDesc : undefined;
    const path = isObj(swatch) && isObj(swatch.value) ? swatch.value.pathName : undefined;
    if (typeof path === 'string' && path.length > 0) {
      out.swatch_descriptor = path;
      out.swatch_state = 'recorded';
    } else if (!(isObj(cd) && isObj(cd.value) && isObj(cd.value.properties) && swatch === undefined)) {
      out.swatch_state = 'malformed';
    }
  }
  const slot = props.mColorSlot;
  if (slot !== undefined && slot !== null) {
    // Byte property: direct number, {value:n}, or parser-wrapped {value:{value:n}} (see blueprint-decode byteProperty).
    let v = slot;
    if (isObj(v)) v = v.value;
    if (isObj(v)) v = v.value;
    if (isByte(v)) {
      out.color_slot = v;
      out.color_slot_state = 'recorded';
    } else {
      out.color_slot_state = 'malformed';
    }
  }
  return out;
}

function normalizeAppearance(a) {
  const out = { swatch_descriptor: null, color_slot: null, swatch_state: 'absent', color_slot_state: 'absent' };
  if (a === undefined || a === null) return out;
  if (!isObj(a)) return { ...out, swatch_state: 'malformed', color_slot_state: 'malformed' };
  if (a.swatch_state === 'recorded' && typeof a.swatch_descriptor === 'string' && a.swatch_descriptor) {
    out.swatch_descriptor = a.swatch_descriptor;
    out.swatch_state = 'recorded';
  } else if (a.swatch_state !== 'absent') out.swatch_state = 'malformed';
  if (a.color_slot_state === 'recorded' && isByte(a.color_slot)) {
    out.color_slot = a.color_slot;
    out.color_slot_state = 'recorded';
  } else if (a.color_slot_state !== 'absent') out.color_slot_state = 'malformed';
  return out;
}

const byCountThen = (key) => (a, b) => b.count - a.count || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

export function collectReferenceTraits(rows, options = {}) {
  const opts = isObj(options) ? options : {};
  const maxEntities = limit(opts.maximumEntities, INPUT_CAP, INPUT_CAP);
  const maxAppearance = limit(opts.maximumAppearanceRows, 32, 128);
  const list = Array.isArray(rows) ? rows : [];
  const indexCounts = new Map();
  for (const r of list) {
    if (isObj(r) && isIndex(r.entity_index)) indexCounts.set(r.entity_index, (indexCounts.get(r.entity_index) || 0) + 1);
  }
  let missing = 0;
  let malformed = 0;
  const poses = [];
  const swatches = new Map();
  const slots = new Map();
  const ap = { swatch_missing_count: 0, swatch_malformed_count: 0, color_slot_missing_count: 0, color_slot_malformed_count: 0 };
  for (const r of list) {
    const a = normalizeAppearance(isObj(r) ? r.appearance : undefined);
    if (a.swatch_state === 'recorded') swatches.set(a.swatch_descriptor, (swatches.get(a.swatch_descriptor) || 0) + 1);
    else ap[a.swatch_state === 'absent' ? 'swatch_missing_count' : 'swatch_malformed_count'] += 1;
    if (a.color_slot_state === 'recorded') slots.set(a.color_slot, (slots.get(a.color_slot) || 0) + 1);
    else ap[a.color_slot_state === 'absent' ? 'color_slot_missing_count' : 'color_slot_malformed_count'] += 1;
    if (!isObj(r) || !isIndex(r.entity_index) || indexCounts.get(r.entity_index) !== 1
      || typeof r.class_path !== 'string' || r.class_path.length === 0) {
      malformed += 1;
    } else if (r.transform === undefined || r.transform === null) {
      missing += 1;
    } else if (!usableTransform(r.transform)) {
      malformed += 1;
    } else {
      poses.push({
        entity_index: r.entity_index,
        class_path: r.class_path,
        transform: copyTransform(r.transform),
        appearance: a,
      });
    }
  }
  poses.sort((x, y) => x.entity_index - y.entity_index);
  const sw = [...swatches].map(([descriptor_class, count]) => ({ descriptor_class, count })).sort(byCountThen('descriptor_class'));
  const cs = [...slots].map(([slot, count]) => ({ slot, count })).sort(byCountThen('slot'));
  return {
    schema: TRAITS_SCHEMA,
    source_fingerprint: isFingerprint(opts.sourceFingerprint) ? opts.sourceFingerprint : null,
    entity_total: list.length,
    eligible_entity_count: poses.length,
    missing_transform_count: missing,
    malformed_entity_count: malformed,
    poses: poses.slice(0, maxEntities),
    poses_truncated: poses.length > maxEntities,
    appearance: {
      row_count: list.length,
      swatches: sw.slice(0, maxAppearance),
      color_slots: cs.slice(0, maxAppearance),
      ...ap,
      rows_truncated: sw.length > maxAppearance || cs.length > maxAppearance,
    },
  };
}

function validProfile(p) {
  return isObj(p) && p.schema === TRAITS_SCHEMA && isFingerprint(p.source_fingerprint) && Array.isArray(p.poses);
}

function cleanPoses(p) {
  const seen = new Set();
  const good = [];
  for (const x of p.poses) {
    if (isObj(x) && isIndex(x.entity_index) && !seen.has(x.entity_index) && typeof x.class_path === 'string'
      && x.class_path && usableTransform(x.transform)) {
      seen.add(x.entity_index);
      good.push({ ...x, appearance: normalizeAppearance(x.appearance) });
    }
  }
  good.sort((a, b) => a.entity_index - b.entity_index);
  return { poses: good.slice(0, INPUT_CAP), dropped: good.length > INPUT_CAP || good.length !== p.poses.length };
}

function summary(p, poseCount) {
  return {
    source_fingerprint: isObj(p) && isFingerprint(p.source_fingerprint) ? p.source_fingerprint : null,
    entity_total: isObj(p) && isNum(p.entity_total) ? p.entity_total : null,
    eligible_entity_count: isObj(p) && isNum(p.eligible_entity_count) ? p.eligible_entity_count : null,
    pose_count: poseCount,
    missing_transform_count: isObj(p) && isNum(p.missing_transform_count) ? p.missing_transform_count : null,
    malformed_entity_count: isObj(p) && isNum(p.malformed_entity_count) ? p.malformed_entity_count : null,
    poses_truncated: isObj(p) ? p.poses_truncated === true : null,
    appearance: isObj(p) && isObj(p.appearance) ? p.appearance : null,
  };
}

const quatClose = (a, b, sign) => XYZW.every((k) => Math.abs(a[k] - sign * b[k]) <= COMPONENT_TOLERANCE);
const compatible = (s, t) => {
  const a = s.transform;
  const b = t.transform;
  return (quatClose(a.rotation_quat, b.rotation_quat, 1) || quatClose(a.rotation_quat, b.rotation_quat, -1))
    && XYZ.every((k) => Math.abs(a.scale3d[k] - b.scale3d[k]) <= COMPONENT_TOLERANCE);
};

function appearanceVerdict(a, b) {
  let differ = false;
  let allRecorded = true;
  for (const [val, state] of [['swatch_descriptor', 'swatch_state'], ['color_slot', 'color_slot_state']]) {
    const both = a[state] === 'recorded' && b[state] === 'recorded';
    if (!both) allRecorded = false;
    else if (a[val] !== b[val]) differ = true;
  }
  return differ ? 'different' : allRecorded ? 'equal' : 'unknown';
}

function motif(status, extra = {}) {
  return {
    status,
    source_entity_count: 0,
    target_entity_count: 0,
    matched_entity_count: 0,
    translation_cm: null,
    tolerance_cm: POSITION_TOLERANCE_CM,
    rotation_policy: 'complete_quaternion_sign_equivalent_component_tolerance_1e-4',
    scale_policy: 'componentwise_tolerance_1e-4',
    appearance_equal_count: 0,
    appearance_different_count: 0,
    appearance_unknown_count: 0,
    candidates_evaluated: 0,
    search_complete: false,
    input_coverage_complete: false,
    matches: [],
    matches_truncated: false,
    ...extra,
  };
}

export function compareReferenceTraits(left, right, options = {}) {
  const opts = isObj(options) ? options : {};
  const maxCandidates = limit(opts.maximumCandidates, 128, 256);
  const maxMatches = limit(opts.maximumMatches, 32, 64);
  const result = (l, r, m) => ({
    schema: COMPARISON_SCHEMA,
    left: l,
    right: r,
    scope: 'saved_entity_pivots_and_saved_appearance_only; greedy one-to-one witnessed subset under translation only',
    limits: {
      maximum_input_entities: INPUT_CAP,
      maximum_candidates: maxCandidates,
      maximum_matches: maxMatches,
      position_tolerance_cm: POSITION_TOLERANCE_CM,
    },
    translated_motif: m,
    claims_not_made: [...CLAIMS_NOT_MADE],
  });
  if (!validProfile(left) || !validProfile(right)) {
    return result(summary(left, 0), summary(right, 0), motif('unknown', { reason: 'missing_fingerprint_or_invalid_profile' }));
  }
  const L = cleanPoses(left);
  const R = cleanPoses(right);
  const lsum = summary(left, L.poses.length);
  const rsum = summary(right, R.poses.length);
  const counts = { source_entity_count: L.poses.length, target_entity_count: R.poses.length };
  if (L.poses.length === 0 || R.poses.length === 0) {
    return result(lsum, rsum, motif('unknown', { ...counts, reason: 'no_usable_poses' }));
  }
  const inputComplete = !left.poses_truncated && !right.poses_truncated && !L.dropped && !R.dropped;

  const targetsByClass = new Map();
  for (const t of R.poses) {
    if (!targetsByClass.has(t.class_path)) targetsByClass.set(t.class_path, []);
    targetsByClass.get(t.class_path).push(t);
  }
  const classPairs = new Map();
  for (const s of L.poses) {
    for (const t of targetsByClass.get(s.class_path) || []) {
      if (!compatible(s, t)) continue;
      if (!classPairs.has(s.class_path)) classPairs.set(s.class_path, []);
      classPairs.get(s.class_path).push([s, t]);
    }
  }
  const order = [...classPairs.keys()].sort((a, b) => classPairs.get(a).length - classPairs.get(b).length || (a < b ? -1 : a > b ? 1 : 0));

  const evaluate = (d) => {
    const used = new Set();
    const pairs = [];
    for (const s of L.poses) {
      for (const t of targetsByClass.get(s.class_path) || []) {
        if (used.has(t.entity_index)) continue;
        if (XYZ.some((k) => Math.abs(t.transform.translation_cm[k] - s.transform.translation_cm[k] - d[k]) > POSITION_TOLERANCE_CM)) continue;
        if (!compatible(s, t)) continue;
        used.add(t.entity_index);
        pairs.push([s, t]);
        break;
      }
    }
    return pairs;
  };

  const seen = new Set();
  let evaluated = 0;
  let searchComplete = true;
  let best = [];
  let bestD = null;
  outer: for (const cls of order) {
    for (const [s, t] of classPairs.get(cls)) {
      const d = {
        x: t.transform.translation_cm.x - s.transform.translation_cm.x + 0,
        y: t.transform.translation_cm.y - s.transform.translation_cm.y + 0,
        z: t.transform.translation_cm.z - s.transform.translation_cm.z + 0,
      };
      const key = JSON.stringify([d.x, d.y, d.z]);
      if (seen.has(key)) continue;
      if (evaluated >= maxCandidates) {
        searchComplete = false;
        break outer;
      }
      seen.add(key);
      evaluated += 1;
      const pairs = evaluate(d);
      if (pairs.length > best.length) {
        best = pairs;
        bestD = d;
      }
    }
  }

  const tally = { equal: 0, different: 0, unknown: 0 };
  const rowsAll = best.map(([s, t]) => {
    tally[appearanceVerdict(s.appearance, t.appearance)] += 1;
    return {
      source_entity_index: s.entity_index,
      target_entity_index: t.entity_index,
      class_path: s.class_path,
      source_location_cm: copyXYZ(s.transform.translation_cm),
      target_location_cm: copyXYZ(t.transform.translation_cm),
      source_appearance: { ...s.appearance },
      target_appearance: { ...t.appearance },
    };
  });
  const coverage = searchComplete && inputComplete;
  const status = best.length > 0 ? (coverage ? 'matched' : 'bounded') : coverage ? 'absent_within_supported_search' : 'unknown';
  return result(lsum, rsum, motif(status, {
    ...counts,
    matched_entity_count: best.length,
    translation_cm: bestD,
    appearance_equal_count: tally.equal,
    appearance_different_count: tally.different,
    appearance_unknown_count: tally.unknown,
    candidates_evaluated: evaluated,
    search_complete: searchComplete,
    input_coverage_complete: inputComplete,
    matches: rowsAll.slice(0, maxMatches),
    matches_truncated: rowsAll.length > maxMatches,
  }));
}
