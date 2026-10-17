# Saved Blueprint reference traits implementation plan

> **For agentic workers:** Use Superpowers subagent-driven development, tests first, and independent exact-source review.

**Goal:** Let Architect study repeated placements and saved appearance in the owner's supplied designs through the existing comparison tool, with a visible local result.

**Architecture:** The existing pinned native reader parses the complete stream once. An opt-in private carrier supplies normalized saved-entity poses and appearance to a pure bounded comparator. The existing comparison solver returns bounded evidence; the local control room runs that same solver. Native generation and revision identities stay unchanged.

**Tech stack:** Existing Node ES modules, pinned satisfactory-file-parser4.1.2, Node tests, existing localhost app/SVG.

**Spec:** Owner's entrance/underground Architect goal and docs/AI_ARCHITECT_MODE.md. This is a small read-only capability; curved/tilted/decorated generation and site fit remain separate work.

## Constraints and review focus

- Preserve all existing tools, comparison fields, legacy request/revision IDs and the game-owned writer. No new solver count or dependency.
- Opt in with `include_reference_traits:true` on `compare_blueprint_layouts`; the default comparison remains unchanged.
- Compute on all saved entities before display caps, including non-Build_ mod props. Poses are bounded at512; appearance aggregates cover all input rows. Unknown class/transform/appearance remains named.
- Exact class paths, complete quaternion (q/-q equivalent) and scale; translation only. Position tolerance0.1cm, quaternion/scale component tolerance0.0001. Never replace tilted orientation with yaw.
- Every match is one-to-one. Duplicate multiplicity is preserved; correspondence/translation uniqueness is not asserted. A deterministic greedy pairing is a witnessed subset, not maximum matching.
- Evaluate at most128 distinct candidate translations by default (hard256), from compatible class/orientation/scale pairs in deterministic rare-class-first order. At most32 returned pair rows (hard64); preserve full matched count. Mark incomplete coverage/search explicitly; bounded/unknown is not absence or global optimality.
- Saved swatch descriptor and legacy color-slot state are independent fields; missing/malformed is not default appearance or equality. Appearance differences do not invalidate geometry matches.
- Pair appearance is different if any mutually recorded field differs; otherwise equal only when both fields are recorded on both sides and equal; otherwise unknown. These three counts partition every matched pair.
- Complete quaternion components must be finite and near-unit (norm within0.001); zero/non-unit is unknown. Compare original saved values with sign equivalence, without replacing them with yaw. Class and index are strict strings/nonnegative integers, never coerced.
- Return source pair fingerprints, scope, bounds and limits. No absolute private paths, raw files, model prose or fabricated rendered colors.
- No game, shell, browser takeover or paid call on status refresh. All background child processes hidden. No SDK/version-gate bypass.

## Task1 — pure helper (Claude implementer, independent Codex review)

Create only `companion/lib/blueprint-reference-traits.mjs` and `companion/test/blueprint-reference-traits.test.mjs` in a separate author clone.

Interfaces:

`readSavedAppearance(properties)` reads existing parser property-map shapes:
`mCustomizationData.value.properties.SwatchDesc.value.pathName` and
`mColorSlot.value` (number or `{value:number}`). Return `swatch_descriptor`,
`color_slot`, `swatch_state`, `color_slot_state`, each state recorded/absent/malformed.

`collectReferenceTraits(rows,{sourceFingerprint,maximumEntities=512,maximumAppearanceRows=32}={})`
accepts complete normalized rows `{entity_index,class_path,transform,appearance}`;
transform has translation_cm{x,y,z},rotation_quat{x,y,z,w},scale3d{x,y,z}.
Return schema `aifactory.blueprint-reference-traits/v1`, source_fingerprint,
entity_total,eligible_entity_count,missing_transform_count,malformed_entity_count,
poses,poses_truncated, and appearance aggregate. Poses retain exact finite saved
values and entity indices. Duplicate/invalid indices and unusable transforms
must not silently become trusted poses. Appearance includes sorted bounded
swatches[{descriptor_class,count}],color_slots[{slot,count}],missing/malformed
counts and explicit row truncation. No mutation, file I/O, runtime imports or dependencies.

`compareReferenceTraits(left,right,{maximumCandidates=128,maximumMatches=32}={})`
returns schema, left/right bounded summaries without poses, appearance summaries,
and translated_motif{status,source_entity_count,target_entity_count,matched_entity_count,
translation_cm,tolerance_cm,rotation_policy,scale_policy,appearance_equal_count,
appearance_different_count,appearance_unknown_count,candidates_evaluated,
search_complete,input_coverage_complete,matches,matches_truncated}.
Rows: `{source_entity_index,target_entity_index,class_path,source_location_cm,
target_location_cm,source_appearance,target_appearance}`. `status` is matched,
bounded, absent_within_supported_search, or unknown. Missing fingerprints/profiles
are unknown. Search completeness means candidate enumeration, not certified
maximum assignment or aesthetic quality. Explicit claims_not_made names fit,
mesh/collision/navigation, rendered appearance, buildability and live functionality.

- [ ] Write failing hand-computed tests: translated subset, non-Build_ prop,
  duplicate multiplicity/no target reuse, q/-q and tilted pose preservation,
  changed class/rotation/scale, changed/missing/malformed appearance,
  invalid indices/transforms/fingerprints, entity/search/result caps,
  deterministic results and non-mutation.
- [ ] Implement the smallest bounded helper and run focused/full tests.
- [ ] Commit only owned files, send actual MCP handoff, preserve same task on failure.
- [ ] Independently review exact commit/hashes and repair before integration.

## Task2 — existing reader/comparison integration (Codex)

Modify `companion/lib/blueprints.mjs`: import helper; option
`includeReferenceTraits=false`; when opted in normalize every parsed entity
using existing readBuildableTransform and readSavedAppearance; private
`reference_traits` carrier. Add `includeReferenceTraits=false` comparison option
to attach helper output only when requested; comparisonSummary stays unchanged.

Modify `solvers.mjs`, `tools.mjs`, `providers.mjs`: boolean opt-in parameter,
same names/dispatch/grounding. Solver requests the carrier only for exact true.
Descriptions state when to study geometry/palette and limits.

- [ ] Serialized synthetic public-inspector and tool-dispatch tests fail first.
- [ ] Integrate helper; prove nonstandard actor retention and default legacy output.
- [ ] Full companion suite, exact-source integration review and handoff.

## Task3 — visible local comparison (Codex/app implementer)

Use existing `makeBlueprintReader` and `solveBlueprintComparison`, not another
reader. A local saved selection names exact library references; no HTTP-defined
paths/commands. `references` local check writes a bounded dated receipt with
fingerprints and code provenance, zero inference/game writes. It refuses missing
library/selection or unsupported source rather than reading arbitrary paths.

Add an existing-app panel/button, summary of matched/observed entities, search
coverage and palette changes. SVG plots saved pivot samples from both designs;
it is labeled pivot evidence rather than meshes or in-game preview.

- [ ] Fixture tests prove missing sources/selection, bounded results and zero writes/calls.
- [ ] Reuse current check origin guard and durable receipt flow.
- [ ] Run actual uploaded entrance/underground comparison and save local-only evidence.
- [ ] Full app suite, independent review, owned service update and visible endpoint check.

## Release/continuation

Native CL513885 build remains blocked on the separately documented Wwise2025
dependency. Do not claim game fit or launch it with an older SDK DLL. Review
latest Claude/Codex work and fetch immediately before any runtime copy. Deploy
only reviewed companion bytes with existing backup/ownership verification.

Ledger: owner delegates routine implementation choices; no repeated approval
questions. The fixture-first read-only comparison is useful independently of
native game availability. A structural consumer needs a versioned full-transform/
appearance request and native support; silently attaching metadata would lose it.
