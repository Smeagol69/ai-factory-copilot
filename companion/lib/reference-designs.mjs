/**
 * The `find_reference_designs` solver.
 *
 * This reads the shipped catalog, never the filesystem and never the player's
 * save. It answers "how do people actually build this?", which is a different
 * question from "what does this save contain" - and the answer must never be
 * confused for the latter. Every result is labelled as a reference measurement,
 * and declared rates stay marked as author claims so the model cannot quietly
 * promote one into a planning constant.
 */

import { BLUEPRINT_REFERENCE_CATALOG } from "./blueprint-reference-catalog.mjs";
import { findReferenceDesigns } from "./blueprint-reference.mjs";

const DEFAULT_LIMIT = 5;
const MAXIMUM_LIMIT = 20;
const DEFAULT_VOCABULARY_ROWS = 25;
const MAXIMUM_VOCABULARY_ROWS = 60;

function bounded(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), maximum);
}

/**
 * A compact reference record. The full class list is replaced by the leading
 * classes plus the role census, so a handful of references cannot flood the
 * provider context.
 */
function presentReference(reference, { maximumClasses = 12 } = {}) {
  return {
    id: reference.id,
    kind: reference.kind,
    author: reference.author,
    notes: reference.notes,
    designer_dimensions: reference.designer_dimensions,
    occupied_span_cells: reference.occupied_span_cells,
    total_buildables: reference.role_census?.total_buildables ?? null,
    role_counts: reference.role_census?.counts ?? null,
    role_share: reference.role_census?.share ?? null,
    declared_io: {
      inputs: reference.declared_io?.inputs ?? [],
      outputs: reference.declared_io?.outputs ?? [],
      evidence: reference.declared_io?.evidence ?? null,
      caveat: reference.declared_io?.caveat ?? null,
    },
    reciprocal_conveyor_pairs: reference.topology?.reciprocal_conveyor_pairs ?? null,
    leading_classes: (reference.buildable_classes ?? []).slice(0, maximumClasses),
    buildable_classes_shown: Math.min(
      maximumClasses,
      (reference.buildable_classes ?? []).length,
    ),
    distinct_buildable_classes: reference.distinct_buildable_classes ?? null,
    build_cost: reference.build_cost ?? [],
  };
}

export function solveReferenceDesigns(_graph, args = {}, _services = {}) {
  const catalog = BLUEPRINT_REFERENCE_CATALOG;
  const limit = bounded(args.limit, DEFAULT_LIMIT, MAXIMUM_LIMIT);
  const matches = findReferenceDesigns(catalog, {
    produces: args.produces,
    consumes: args.consumes,
    kind: args.kind,
    uses_class: args.uses_class,
    max_cells: Number.isFinite(Number(args.max_cells)) ? Number(args.max_cells) : undefined,
    limit,
  });

  const includeVocabulary = args.include_vocabulary !== false;
  const vocabularyRows = bounded(
    args.vocabulary_rows,
    DEFAULT_VOCABULARY_ROWS,
    MAXIMUM_VOCABULARY_ROWS,
  );

  return {
    available: true,
    catalog_version: catalog.catalog_version,
    reference_count: catalog.reference_count,
    matched_count: matches.length,
    filters_applied: {
      produces: args.produces ?? null,
      consumes: args.consumes ?? null,
      kind: args.kind ?? null,
      uses_class: args.uses_class ?? null,
      max_cells: args.max_cells ?? null,
    },
    library_role_census: catalog.role_census,
    references: matches.map((reference) => presentReference(reference)),
    vocabulary: includeVocabulary ? catalog.vocabulary.slice(0, vocabularyRows) : [],
    vocabulary_rows_returned: includeVocabulary
      ? Math.min(vocabularyRows, catalog.vocabulary.length)
      : 0,
    vocabulary_total_classes: catalog.vocabulary.length,
    source: catalog.source,
    certainty: catalog.certainty,
    caveat: catalog.caveat,
    usage_note:
      "These are measurements of other people's finished builds, not facts about this save. Use them for proportion, part vocabulary, and module envelope. Machine counts and rates for an actual plan still come from content.recipes and the live snapshot.",
  };
}
