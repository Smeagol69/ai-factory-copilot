import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSavedAppearance,
  collectReferenceTraits,
  compareReferenceTraits,
} from '../lib/blueprint-reference-traits.mjs';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const Q0 = { x: 0, y: 0, z: 0, w: 1 };
const S1 = { x: 1, y: 1, z: 1 };
const SW = (name) => ({
  swatch_descriptor: name, color_slot: null, swatch_state: 'recorded', color_slot_state: 'absent',
});
const NOAPP = { swatch_descriptor: null, color_slot: null, swatch_state: 'absent', color_slot_state: 'absent' };
function row(i, cls, x, y = 0, z = 0, extra = {}) {
  return {
    entity_index: i,
    class_path: cls,
    transform: {
      translation_cm: { x, y, z },
      rotation_quat: extra.q ?? Q0,
      scale3d: extra.s ?? S1,
    },
    appearance: extra.appearance ?? NOAPP,
  };
}
const A = '/Game/FactoryGame/Buildable/Build_A.Build_A_C';
const B = '/Game/FactoryGame/Buildable/Build_B.Build_B_C';
const PROP = '/Game/Mod/Props/Prop_Lamp.Prop_Lamp_C';
const collect = (rows, fp = FP_A, o = {}) => collectReferenceTraits(rows, { sourceFingerprint: fp, ...o });
const cmp = (l, r, o) => compareReferenceTraits(collect(l, FP_A), collect(r, FP_B), o);

test('readSavedAppearance reads recorded, absent and malformed shapes independently', () => {
  const rec = readSavedAppearance({
    mCustomizationData: { value: { properties: { SwatchDesc: { value: { pathName: '/Sw/Custom.Custom_C' } } } } },
    mColorSlot: { value: 3 },
  });
  assert.deepEqual(rec, {
    swatch_descriptor: '/Sw/Custom.Custom_C', color_slot: 3, swatch_state: 'recorded', color_slot_state: 'recorded',
  });
  assert.equal(readSavedAppearance({ mColorSlot: 5 }).color_slot, 5);
  assert.deepEqual(readSavedAppearance({}), NOAPP);
  assert.deepEqual(readSavedAppearance(undefined), NOAPP);
  const bad = readSavedAppearance({
    mCustomizationData: { value: { properties: { SwatchDesc: { value: { pathName: 7 } } } } },
    mColorSlot: { value: '3' },
  });
  assert.equal(bad.swatch_state, 'malformed');
  assert.equal(bad.color_slot_state, 'malformed');
  assert.equal(bad.swatch_descriptor, null);
  assert.equal(bad.color_slot, null);
  assert.equal(readSavedAppearance({ mColorSlot: Infinity }).color_slot_state, 'malformed');
  assert.equal(readSavedAppearance({ mCustomizationData: 'x' }).swatch_state, 'malformed');
});

test('collect keeps non-Build_ props and counts invalid, missing and duplicate rows', () => {
  const rows = [
    row(5, PROP, 1, 2, 3),
    row(1, A, 0),
    { ...row(2, A, 0), transform: undefined },
    row(3, A, 0, 0, 0, { q: { x: 0, y: 0, z: 0, w: 2 } }),          // non-unit
    row(4, A, 0, 0, 0, { q: { x: 0, y: 0, z: 0, w: 0 } }),          // zero
    row(6, A, Number.NaN),                                           // non-finite
    { ...row(7, A, 0), transform: { ...row(7, A, 0).transform, scale3d: { x: '1', y: 1, z: 1 } } }, // coercion
    row(-1, A, 0),
    row(1.5, A, 0),
    row('9', A, 0),
    row(10, 42, 0),
    row(11, A, 0), row(11, B, 9),                                    // duplicate index -> both excluded
  ];
  const t = collect(rows);
  assert.equal(t.schema, 'aifactory.blueprint-reference-traits/v1');
  assert.equal(t.source_fingerprint, FP_A);
  assert.equal(t.entity_total, 13);
  assert.equal(t.missing_transform_count, 1);
  assert.equal(t.eligible_entity_count, 2);
  assert.equal(t.malformed_entity_count, 10);
  assert.deepEqual(t.poses.map((p) => p.entity_index), [1, 5]);
  assert.equal(t.poses[1].class_path, PROP);
  assert.equal(t.poses_truncated, false);
});

test('collect preserves tilted quaternion and exact values; bad fingerprint is null', () => {
  const q = { x: 0.5, y: 0.5, z: 0.5, w: -0.5 };
  const t = collect([row(1, A, 1.25, -0.5, 7, { q, s: { x: 2, y: 1, z: 0.5 } })], 'ABC');
  assert.equal(t.source_fingerprint, null);
  assert.deepEqual(t.poses[0].transform.rotation_quat, q);
  assert.deepEqual(t.poses[0].transform.scale3d, { x: 2, y: 1, z: 0.5 });
  assert.deepEqual(t.poses[0].transform.translation_cm, { x: 1.25, y: -0.5, z: 7 });
  assert.equal(collectReferenceTraits([row(1, A, 0)]).source_fingerprint, null);
  // within 0.001 norm tolerance accepted
  assert.equal(collect([row(1, A, 0, 0, 0, { q: { x: 0, y: 0, z: 0, w: 1.0005 } })]).eligible_entity_count, 1);
  assert.equal(collect([row(1, A, 0, 0, 0, { q: { x: 0, y: 0, z: 0, w: 1.002 } })]).eligible_entity_count, 0);
});

test('collect aggregates appearance over all rows with bounded sorted output', () => {
  const rows = [
    row(1, A, 0, 0, 0, { appearance: { swatch_descriptor: '/Sw/Z', color_slot: 2, swatch_state: 'recorded', color_slot_state: 'recorded' } }),
    row(2, A, 1, 0, 0, { appearance: { swatch_descriptor: '/Sw/Z', color_slot: 2, swatch_state: 'recorded', color_slot_state: 'recorded' } }),
    row(3, A, 2, 0, 0, { appearance: SW('/Sw/Y') }),
    row(4, A, 3, 0, 0, { appearance: { swatch_descriptor: null, color_slot: null, swatch_state: 'malformed', color_slot_state: 'malformed' } }),
    row(5, A, 4),
    row(-1, A, 4, 0, 0, { appearance: SW('/Sw/X') }), // malformed row still counted in aggregate
  ];
  const ap = collect(rows).appearance;
  assert.deepEqual(ap.swatches, [
    { descriptor_class: '/Sw/Z', count: 2 }, { descriptor_class: '/Sw/X', count: 1 }, { descriptor_class: '/Sw/Y', count: 1 },
  ]);
  assert.deepEqual(ap.color_slots, [{ slot: 2, count: 2 }]);
  assert.equal(ap.swatch_missing_count, 1);
  assert.equal(ap.swatch_malformed_count, 1);
  assert.equal(ap.color_slot_missing_count, 3);
  assert.equal(ap.color_slot_malformed_count, 1);
  assert.equal(ap.rows_truncated, false);
  const small = collect(rows, FP_A, { maximumAppearanceRows: 1 }).appearance;
  assert.deepEqual(small.swatches, [{ descriptor_class: '/Sw/Z', count: 2 }]);
  assert.equal(small.rows_truncated, true);
});

test('collect caps poses at maximumEntities, hard 512, and does not mutate input', () => {
  const rows = Array.from({ length: 600 }, (_, i) => row(i, A, i));
  const frozen = JSON.stringify(rows);
  const t = collect(rows);
  assert.equal(t.entity_total, 600);
  assert.equal(t.eligible_entity_count, 600);
  assert.equal(t.poses.length, 512);
  assert.equal(t.poses_truncated, true);
  assert.equal(collect(rows, FP_A, { maximumEntities: 3 }).poses.length, 3);
  assert.equal(collect(rows, FP_A, { maximumEntities: 5000 }).poses.length, 512);
  assert.equal(JSON.stringify(rows), frozen);
});

test('translated subset incl. non-Build_ prop is matched with exact translation', () => {
  const L = [row(1, A, 0), row(2, A, 100), row(3, PROP, 0, 50)];
  const R = [row(10, A, 1000, 200, -5), row(11, A, 1100, 200, -5), row(12, A, 7, 7, 7), row(13, PROP, 1000, 250, -5)];
  const r = cmp(L, R);
  const m = r.translated_motif;
  assert.equal(r.schema, 'aifactory.blueprint-reference-traits-comparison/v1');
  assert.equal(m.status, 'matched');
  assert.equal(m.matched_entity_count, 3);
  assert.equal(m.source_entity_count, 3);
  assert.equal(m.target_entity_count, 4);
  assert.deepEqual(m.translation_cm, { x: 1000, y: 200, z: -5 });
  assert.equal(m.tolerance_cm, 0.1);
  assert.equal(m.candidates_evaluated, 5);
  assert.equal(m.search_complete, true);
  assert.equal(m.input_coverage_complete, true);
  assert.equal(m.matches_truncated, false);
  assert.deepEqual(m.matches.map((x) => [x.source_entity_index, x.target_entity_index]), [[1, 10], [2, 11], [3, 13]]);
  assert.equal(m.matches[2].class_path, PROP);
  assert.deepEqual(m.matches[0].source_location_cm, { x: 0, y: 0, z: 0 });
  assert.deepEqual(m.matches[0].target_location_cm, { x: 1000, y: 200, z: -5 });
  assert.equal(r.left.poses, undefined);
  assert.equal(r.left.source_fingerprint, FP_A);
  assert.equal(r.right.source_fingerprint, FP_B);
  assert.ok(Array.isArray(r.claims_not_made) && r.claims_not_made.length >= 5);
});

test('position tolerance is componentwise 0.1cm', () => {
  const ok = cmp([row(1, A, 0)], [row(2, A, 50.05, -0.09, 0.09)]);
  assert.equal(ok.translated_motif.matched_entity_count, 1);
  // second pair off by 0.2 in one component: only first matches under first anchor
  const L = [row(1, A, 0), row(2, A, 100)];
  const R = [row(5, A, 10), row(6, A, 110.2)];
  const m = cmp(L, R).translated_motif;
  assert.equal(m.matched_entity_count, 1);
});

test('duplicate multiplicity: no target reuse, lowest target first', () => {
  const m = cmp([row(1, A, 0), row(2, A, 0)], [row(5, A, 10)]).translated_motif;
  assert.equal(m.matched_entity_count, 1);
  assert.equal(m.candidates_evaluated, 1);
  assert.deepEqual(m.matches.map((x) => [x.source_entity_index, x.target_entity_index]), [[1, 5]]);
  const two = cmp([row(1, A, 0), row(2, A, 0)], [row(5, A, 10), row(6, A, 10)]).translated_motif;
  assert.deepEqual(two.matches.map((x) => [x.source_entity_index, x.target_entity_index]), [[1, 5], [2, 6]]);
});

test('q and -q are equivalent; tilted orientation changes are not yaw-approximated', () => {
  const q = { x: 0.5, y: 0.5, z: 0.5, w: 0.5 };
  const nq = { x: -0.5, y: -0.5, z: -0.5, w: -0.5 };
  const same = cmp([row(1, A, 0, 0, 0, { q })], [row(2, A, 5, 0, 0, { q: nq })]).translated_motif;
  assert.equal(same.status, 'matched');
  const other = { x: 0.5, y: 0.5, z: -0.5, w: 0.5 };
  const diff = cmp([row(1, A, 0, 0, 0, { q })], [row(2, A, 5, 0, 0, { q: other })]).translated_motif;
  assert.equal(diff.status, 'absent_within_supported_search');
  assert.equal(diff.matched_entity_count, 0);
  assert.equal(diff.translation_cm, null);
  assert.equal(diff.candidates_evaluated, 0);
});

test('changed class or scale prevents a match; tiny scale delta within 1e-4 matches', () => {
  assert.equal(cmp([row(1, A, 0)], [row(2, B, 0)]).translated_motif.status, 'absent_within_supported_search');
  const big = cmp([row(1, A, 0)], [row(2, A, 0, 0, 0, { s: { x: 1.001, y: 1, z: 1 } })]).translated_motif;
  assert.equal(big.status, 'absent_within_supported_search');
  const tiny = cmp([row(1, A, 0)], [row(2, A, 0, 0, 0, { s: { x: 1.00005, y: 1, z: 1 } })]).translated_motif;
  assert.equal(tiny.status, 'matched');
});

test('appearance partitions matched pairs: different, equal, unknown', () => {
  const full = (d, c) => ({ swatch_descriptor: d, color_slot: c, swatch_state: 'recorded', color_slot_state: 'recorded' });
  const L = [
    row(1, A, 0, 0, 0, { appearance: full('/S/1', 1) }),   // equal
    row(2, A, 10, 0, 0, { appearance: full('/S/1', 1) }),  // swatch differs
    row(3, A, 20, 0, 0, { appearance: SW('/S/1') }),       // slot absent both -> unknown
    row(4, A, 30, 0, 0, { appearance: SW('/S/1') }),       // slot differs? right slot recorded only -> swatch equal, unknown
    row(5, A, 40, 0, 0, { appearance: { swatch_descriptor: null, color_slot: 2, swatch_state: 'absent', color_slot_state: 'recorded' } }), // slot differs
  ];
  const R = [
    row(11, A, 100, 0, 0, { appearance: full('/S/1', 1) }),
    row(12, A, 110, 0, 0, { appearance: full('/S/2', 1) }),
    row(13, A, 120, 0, 0, { appearance: SW('/S/1') }),
    row(14, A, 130, 0, 0, { appearance: full('/S/1', 9) }),
    row(15, A, 140, 0, 0, { appearance: { swatch_descriptor: null, color_slot: 3, swatch_state: 'malformed', color_slot_state: 'recorded' } }),
  ];
  const m = cmp(L, R).translated_motif;
  assert.equal(m.matched_entity_count, 5);
  assert.equal(m.appearance_equal_count, 1);
  assert.equal(m.appearance_different_count, 2);
  assert.equal(m.appearance_unknown_count, 2);
  assert.equal(m.appearance_equal_count + m.appearance_different_count + m.appearance_unknown_count, 5);
  assert.deepEqual(m.matches[1].target_appearance, full('/S/2', 1));
});

test('candidate limit yields bounded status; hard limits clamp', () => {
  const L = [row(1, A, 0), row(2, A, 10)];
  const R = [row(11, A, 100), row(12, A, 110), row(13, A, 500)];
  const full = cmp(L, R).translated_motif;
  assert.equal(full.candidates_evaluated, 5);
  assert.equal(full.search_complete, true);
  assert.equal(full.status, 'matched');
  assert.equal(full.matched_entity_count, 2);
  const cut = cmp(L, R, { maximumCandidates: 1 }).translated_motif;
  assert.equal(cut.candidates_evaluated, 1);
  assert.equal(cut.search_complete, false);
  assert.equal(cut.status, 'bounded');
  assert.equal(cut.matched_entity_count, 2);
  const none = cmp([row(1, A, 0), row(2, B, 5000)], [row(3, A, 3), row(4, A, 9000)], { maximumCandidates: 1 }).translated_motif;
  assert.equal(none.search_complete, false);
  assert.equal(compareReferenceTraits(collect(L), collect(R), { maximumCandidates: 9999, maximumMatches: 9999 }).limits.maximum_candidates, 256);
  assert.equal(compareReferenceTraits(collect(L), collect(R), { maximumCandidates: 9999, maximumMatches: 9999 }).limits.maximum_matches, 64);
  assert.equal(compareReferenceTraits(collect(L), collect(R)).limits.maximum_candidates, 128);
  assert.equal(compareReferenceTraits(collect(L), collect(R)).limits.maximum_matches, 32);
});

test('rare classes anchor first; equal score retains first candidate', () => {
  // class B has 1 compatible pair so it anchors before the 4 pairs of A: candidates 300,0,10,-10.
  const L = [row(1, A, 0), row(2, A, 10), row(3, B, 500)];
  const R = [row(11, A, 0), row(12, A, 10), row(13, B, 800)];
  const r = cmp(L, R).translated_motif;
  assert.equal(r.candidates_evaluated, 4);
  assert.deepEqual(r.translation_cm, { x: 0, y: 0, z: 0 }); // A anchor d=0 scores 2 > B's 1
  assert.equal(r.matched_entity_count, 2);
  // tie: A and B each have one pair and both score 1; A (lexically first) is retained.
  const tie = cmp([row(1, A, 0), row(2, B, 500)], [row(11, A, 7), row(12, B, 800)]).translated_motif;
  assert.deepEqual(tie.translation_cm, { x: 7, y: 0, z: 0 });
  assert.equal(tie.matched_entity_count, 1);
  assert.equal(tie.candidates_evaluated, 2);
  const r2 = cmp([row(1, A, 0), row(2, A, 10), row(3, B, 500)], [row(11, A, 0), row(12, A, 10), row(13, B, 500)]).translated_motif;
  assert.deepEqual(r2.translation_cm, { x: 0, y: 0, z: 0 });
  assert.equal(r2.matched_entity_count, 3);
  assert.equal(Object.is(r2.translation_cm.x, -0), false);
});

test('result cap preserves full matched count', () => {
  const L = [row(1, A, 0), row(2, A, 1000), row(3, A, 2000)];
  const R = [row(4, A, 5), row(5, A, 1005), row(6, A, 2005)];
  const m = cmp(L, R, { maximumMatches: 2 }).translated_motif;
  assert.equal(m.matched_entity_count, 3);
  assert.equal(m.matches.length, 2);
  assert.equal(m.matches_truncated, true);
});

test('truncated pose input makes positive evidence bounded, never absence', () => {
  const rows = Array.from({ length: 600 }, (_, i) => row(i, A, i * 10));
  const m = compareReferenceTraits(collect(rows, FP_A), collect(rows, FP_B)).translated_motif;
  assert.equal(m.input_coverage_complete, false);
  assert.equal(m.status, 'bounded');
  assert.ok(m.matched_entity_count >= 1);
  assert.equal(m.source_entity_count, 512);
  const none = compareReferenceTraits(collect(rows, FP_A), collect([row(1, B, 0)], FP_B)).translated_motif;
  assert.equal(none.status, 'unknown');
});

test('missing fingerprints or invalid profiles are unknown', () => {
  const ok = collect([row(1, A, 0)], FP_A);
  for (const bad of [collectReferenceTraits([row(1, A, 0)]), null, undefined, {}, { schema: 'x' }]) {
    const m = compareReferenceTraits(ok, bad).translated_motif;
    assert.equal(m.status, 'unknown');
    assert.equal(m.matched_entity_count, 0);
    assert.deepEqual(m.matches, []);
    const m2 = compareReferenceTraits(bad, ok).translated_motif;
    assert.equal(m2.status, 'unknown');
  }
  assert.equal(compareReferenceTraits(collect([], FP_A), ok).translated_motif.status, 'unknown');
});

test('real reader sha256:-prefixed fingerprints work in collect and compare; malformed ones do not', () => {
  const H = 'c'.repeat(64);
  const H2 = 'd'.repeat(63) + 'e';
  const l = collect([row(1, A, 0)], `sha256:${H}`);
  const r = collect([row(2, A, 5)], `sha256:${H2}`);
  assert.equal(l.source_fingerprint, `sha256:${H}`);
  const c = compareReferenceTraits(l, r);
  assert.equal(c.translated_motif.status, 'matched');
  assert.equal(c.left.source_fingerprint, `sha256:${H}`);
  assert.equal(c.right.source_fingerprint, `sha256:${H2}`);
  assert.equal(compareReferenceTraits(l, collect([row(2, A, 5)], H)).translated_motif.status, 'matched');
  for (const bad of [`SHA256:${H}`, `sha256:${'C'.repeat(64)}`, `sha256:${H}0`, `sha256:${H.slice(1)}`, `sha1:${H}`, `sha256:sha256:${H}`, 'sha256:', ` sha256:${H}`]) {
    assert.equal(collect([row(1, A, 0)], bad).source_fingerprint, null, bad);
  }
  assert.equal(collect([row(1, A, 0)], 'C'.repeat(64)).source_fingerprint, null);
});

test('color slot is a byte 0..255, wrapped or direct; absent and malformed stay distinct', () => {
  const slot = (v) => readSavedAppearance({ mColorSlot: v });
  assert.deepEqual([slot({ value: { value: 0 } }).color_slot, slot({ value: { value: 0 } }).color_slot_state], [0, 'recorded']);
  assert.deepEqual([slot({ value: { value: 255 } }).color_slot, slot({ value: { value: 255 } }).color_slot_state], [255, 'recorded']);
  assert.equal(slot({ value: 7 }).color_slot, 7);
  assert.equal(slot(0).color_slot, 0);
  assert.equal(slot(255).color_slot_state, 'recorded');
  for (const bad of [256, -1, 1.5, NaN, Infinity, '3', { value: '3' }, { value: { value: 256 } }, { value: { value: -1 } },
    { value: { value: 2.5 } }, { value: { value: { value: 1 } } }, { value: {} }, {}, true]) {
    const a = slot(bad);
    assert.equal(a.color_slot_state, 'malformed', JSON.stringify(bad));
    assert.equal(a.color_slot, null);
  }
  assert.equal(readSavedAppearance({}).color_slot_state, 'absent');
  assert.equal(slot(null).color_slot_state, 'absent');
  // supplied profiles apply the same byte rule
  const mk = (c) => collect([row(1, A, 0, 0, 0, { appearance: { swatch_descriptor: null, color_slot: c, swatch_state: 'absent', color_slot_state: 'recorded' } })]).appearance;
  assert.deepEqual(mk(255).color_slots, [{ slot: 255, count: 1 }]);
  assert.deepEqual(mk(0).color_slots, [{ slot: 0, count: 1 }]);
  for (const bad of [256, -1, 1.5, '3', NaN]) {
    const ap = mk(bad);
    assert.deepEqual(ap.color_slots, []);
    assert.equal(ap.color_slot_malformed_count, 1);
  }
});

test('comparison is deterministic and does not mutate frozen inputs', () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => typeof v === 'object' && v && deepFreeze(v)); return Object.freeze(o); };
  const l = deepFreeze(collect([row(1, A, 0), row(2, B, 50)], FP_A));
  const r = deepFreeze(collect([row(3, A, 9), row(4, B, 59)], FP_B));
  const first = JSON.stringify(compareReferenceTraits(l, r));
  assert.equal(JSON.stringify(compareReferenceTraits(l, r)), first);
  assert.equal(JSON.parse(first).translated_motif.matched_entity_count, 2);
});
