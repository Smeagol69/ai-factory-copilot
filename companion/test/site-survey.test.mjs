import assert from "node:assert/strict";
import test from "node:test";

import { deckRule, surveyDecks } from "../lib/site-survey.mjs";
import { solveActorLookup } from "../lib/solvers.mjs";

/** A lightweight instance with world-space bounds, as the scanner emits them. */
function piece(id, classPath, { x, y, z, halfX = 400, halfY = 400, halfZ = 100 }) {
  return {
    actor_id: id,
    kind: "lightweight_buildable",
    class_path: classPath,
    location_cm: { x, y, z },
    raw: {
      name: id,
      kind: "lightweight_buildable",
      location: { x, y, z },
      bounds: { origin: { x, y, z }, extent: { x: halfX, y: halfY, z: halfZ } },
    },
  };
}

/** An 8 m grid of foundations at one height. */
function deck(prefix, classPath, { cols, rows, z, originX = 0, originY = 0 }) {
  const nodes = [];
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cy = 0; cy < rows; cy += 1) {
      nodes.push(
        piece(`${prefix}_${cx}_${cy}`, classPath, {
          x: originX + cx * 800,
          y: originY + cy * 800,
          z,
        }),
      );
    }
  }
  return nodes;
}

function graphOf(nodes) {
  return { nodes: new Map(nodes.map((node) => [node.actor_id, node])) };
}

test("contiguous foundations become one deck with a usable size and height", () => {
  const survey = surveyDecks(graphOf(deck("f", "/Game/Build_Foundation_8x4_01.Build_Foundation_8x4_01_C", {
    cols: 5, rows: 6, z: 8100,
  })));
  assert.equal(survey.deck_count, 1);
  const [only] = survey.decks;
  assert.equal(only.pieces, 30);
  // 5 x 6 cells of 8 m, measured corner to corner across the piece extents.
  assert.equal(only.size_m.x, 40);
  assert.equal(only.size_m.y, 48);
  assert.equal(only.top_z_cm, 8200, "the top of the deck, not its centre");
  assert.ok(only.centre_cm.x > 0 && only.centre_cm.y > 0);
});

test("a modded foundation with no matching name is still found, by geometry", () => {
  // This is the case that matters: the owner's base is built from DodNFPiece4m
  // and ConcreteConstruction parts. A name-only rule would report empty ground
  // on top of their factory.
  const survey = surveyDecks(graphOf(deck("d", "/Game/Build_DodNFPiece4m.Build_DodNFPiece4m_C", {
    cols: 4, rows: 4, z: 0,
  })));
  assert.equal(survey.deck_count, 1);
  assert.equal(survey.decks[0].classified_by.thin_and_broad_geometry, 16);
  assert.equal(survey.decks[0].classified_by.class_name, undefined);
});

test("a wall is not a deck, however long it is", () => {
  // Tall relative to its footprint. If this classified as a surface the
  // collision fix would be undone from the other direction.
  const wall = piece("w", "/Game/Build_Wall_8x4.Build_Wall_8x4_C", {
    x: 0, y: 0, z: 200, halfX: 400, halfY: 20, halfZ: 200,
  });
  assert.equal(deckRule(wall, {
    minX: -400, maxX: 400, minY: -20, maxY: 20, minZ: 0, maxZ: 400,
    width: 800, depth: 40, thickness: 400,
  }), null);
});

test("two levels are two decks, not one merged blob", () => {
  const nodes = [
    ...deck("ground", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 0 }),
    ...deck("upper", "/Game/Build_Foundation.Build_Foundation_C", { cols: 3, rows: 3, z: 1600 }),
  ];
  const survey = surveyDecks(graphOf(nodes));
  assert.equal(survey.deck_count, 2);
  const heights = survey.decks.map((entry) => entry.top_z_cm).sort((a, b) => a - b);
  assert.deepEqual(heights, [100, 1700]);
  // Largest first, so the main deck leads.
  assert.ok(survey.decks[0].pieces >= survey.decks[1].pieces);
});

test("separated decks are separate, even at the same height", () => {
  const nodes = [
    ...deck("a", "/Game/Build_Foundation.Build_Foundation_C", { cols: 3, rows: 3, z: 0 }),
    ...deck("b", "/Game/Build_Foundation.Build_Foundation_C", { cols: 3, rows: 3, z: 0, originX: 50000 }),
  ];
  assert.equal(surveyDecks(graphOf(nodes)).deck_count, 2);
});

test("what stands on a deck is reported, but the deck itself is not an occupant", () => {
  const nodes = [
    ...deck("f", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 0 }),
    // A machine on the deck: thick, so not deck-like, and above the surface.
    piece("smelter", "/Game/Build_SmelterMk1.Build_SmelterMk1_C", {
      x: 800, y: 800, z: 400, halfX: 300, halfY: 300, halfZ: 300,
    }),
  ];
  const survey = surveyDecks(graphOf(nodes));
  assert.equal(survey.deck_count, 1);
  // Counted by class rather than enumerated: a real base puts hundreds of
  // buildings on one deck, and listing every actor_id made a single survey big
  // enough to crowd out the rest of a conversation.
  const occupants = survey.decks[0].standing_on_it;
  assert.equal(occupants.total, 1);
  assert.equal(occupants.distinct_classes, 1);
  assert.equal(occupants.by_class[0].count, 1);
  assert.deepEqual(occupants.by_class[0].example_actor_ids, ["smelter"]);
});

test("a survey can be scoped to one area", () => {
  const nodes = [
    ...deck("near", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 0 }),
    ...deck("far", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 0, originX: 200000 }),
  ];
  const scoped = surveyDecks(graphOf(nodes), { center_cm: { x: 0, y: 0 }, radius_m: 100 });
  assert.equal(scoped.deck_count, 1);
  assert.equal(scoped.scope.radius_m, 100);
  assert.equal(surveyDecks(graphOf(nodes)).deck_count, 2, "unscoped still sees both");
});

test("how a deck was identified is always reported", () => {
  // A geometry match on something unexpected should be arguable, not silent.
  const survey = surveyDecks(graphOf(deck("f", "/Game/Build_Foundation.Build_Foundation_C", {
    cols: 3, rows: 3, z: 0,
  })));
  assert.equal(survey.decks[0].classified_by.class_name, 9);
  assert.ok(survey.how_decks_were_identified.why_two_rules.length > 0);
});

test("locate can answer what is at a position, not only what is near the player", () => {
  // Before this it took no centre at all and sorted by distance to the player,
  // so "what is at these coordinates" was unanswerable.
  const nodes = [
    piece("here", "/Game/Build_Foundation.Build_Foundation_C", { x: 1000, y: 1000, z: 0 }),
    piece("far", "/Game/Build_Foundation.Build_Foundation_C", { x: 900000, y: 900000, z: 0 }),
  ];
  const graph = graphOf(nodes);
  const result = solveActorLookup(graph, {
    center_cm: { x: 1000, y: 1000 },
    radius_m: 50,
    kind: "lightweight_buildable",
  });
  assert.equal(result.found, true, result.reason);
  const ids = result.matches.map((entry) => entry.actor_id);
  assert.ok(ids.includes("here"));
  assert.ok(!ids.includes("far"), "the radius drops what is outside it");
});

test("a positional lookup needs no other search term", () => {
  const graph = graphOf([piece("a", "/Game/Build_Foundation.Build_Foundation_C", { x: 0, y: 0, z: 0 })]);
  const result = solveActorLookup(graph, { center_cm: { x: 0, y: 0 }, radius_m: 10 });
  assert.equal(result.found, true, result.reason);
});

test("with no search term at all it still refuses, and says a centre is one", () => {
  const result = solveActorLookup(graphOf([]), {});
  assert.equal(result.found, false);
  assert.match(result.reason, /center_cm/);
});

test("a deck reports its underside, so a service level can be planned at all", () => {
  // The owner runs belts beneath the foundation to keep the walking surface
  // clean. Nothing could plan that while the survey reported only the top.
  const survey = surveyDecks(graphOf(deck("f", "/Game/Build_Foundation.Build_Foundation_C", {
    cols: 4, rows: 4, z: 8100,
  })));
  const [only] = survey.decks;
  assert.equal(only.top_z_cm, 8200);
  assert.equal(only.underside.bottom_z_cm, 8000, "the deck is 2 m thick in this fixture");
  assert.equal(only.underside.clear_of_structures_below, true);
});

test("open space is measured against structures, and ground is refused as unknown", () => {
  // Terrain is probed only for site candidates, so a deck over open desert and
  // one flat on rock are indistinguishable here. Saying "clear" without that
  // caveat would let a service level be planned into solid rock.
  const survey = surveyDecks(graphOf(deck("f", "/Game/Build_Foundation.Build_Foundation_C", {
    cols: 4, rows: 4, z: 8100,
  })));
  const { underside } = survey.decks[0];
  assert.equal(underside.structural_clearance_cm, null, "nothing built below");
  assert.match(underside.ground_below, /unknown/);
  assert.match(underside.ground_below, /cannot tell open air from rock/);
  assert.match(underside.usable_for_a_service_level, /unknown/);
});

test("a structure below is found, and the gap to it measured", () => {
  const nodes = [
    ...deck("upper", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 2000 }),
    ...deck("lower", "/Game/Build_Foundation.Build_Foundation_C", { cols: 4, rows: 4, z: 0 }),
  ];
  const survey = surveyDecks(graphOf(nodes));
  const upper = survey.decks.find((entry) => entry.top_z_cm === 2100);
  assert.ok(upper, "the upper deck is surveyed");
  // Upper spans 1900..2100, lower tops out at 100, so 18 m of space between.
  assert.equal(upper.underside.structural_clearance_m, 18);
  assert.equal(upper.underside.clear_of_structures_below, false);
  assert.ok(upper.underside.nearest_structure_below.actor_id.startsWith("lower_"));
  assert.match(upper.underside.usable_for_a_service_level, /18 m of space/);
});

test("the deck's own pieces are never counted as the thing below it", () => {
  // Every member of a cluster overlaps its own footprint; treating one as the
  // obstruction below would report zero clearance on every deck.
  const survey = surveyDecks(graphOf(deck("f", "/Game/Build_Foundation.Build_Foundation_C", {
    cols: 5, rows: 5, z: 500,
  })));
  assert.equal(survey.decks[0].underside.clear_of_structures_below, true);
  assert.equal(survey.decks[0].underside.nearest_structure_below, null);
});
