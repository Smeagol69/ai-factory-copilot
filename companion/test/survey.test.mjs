import assert from "node:assert/strict";
import test from "node:test";
import { formatSurvey, judgeSite, nodeYield, surveyResources } from "../lib/survey.mjs";
import { parseSiteSurveyRequest } from "../lib/router.mjs";

/**
 * Shaped exactly like the real capture around the owner's HUB: a handful of
 * permanent nodes buried in a pile of one-off deposits. The deposits are the
 * point of the fixture -- reporting them as "resource nodes" is the mistake this
 * module exists to avoid.
 */
function hubSnapshot() {
  const at = (x, y) => ({ x, y, z: 9000 });
  const node = (name, purity, x, occupied = false) => ({
    kind: "resource_node",
    actor_id: `node_${name}_${x}`,
    resource_name: name,
    purity,
    node_type: "Node",
    has_resources: true,
    occupied,
    location: at(x, 0),
  });
  const deposit = (x) => ({
    kind: "resource_node",
    actor_id: `dep_${x}`,
    resource_name: "Iron Ore",
    purity: "RP_Normal",
    node_type: "Deposit",
    has_resources: true,
    occupied: false,
    location: at(x, 0),
  });

  return {
    world: { scan_radius_meters: 250 },
    actors: [
      { kind: "buildable", class_path: "x.Build_TradingPost_C", location: at(0, 0) },
      node("Limestone", "RP_Normal", 3900),
      node("Copper Ore", "RP_Pure", 5400, true),
      node("Iron Ore", "RP_Pure", 9500),
      node("Iron Ore", "RP_Pure", 11500),
      node("Iron Ore", "RP_Inpure", 13000),
      deposit(1000),
      deposit(2000),
      deposit(2500),
    ],
  };
}

test("deposits are never counted as mineable nodes", () => {
  const survey = surveyResources(hubSnapshot());
  // Five permanent nodes and three deposits. Reporting eight would be true and
  // useless: deposits run out and cannot take a miner.
  assert.equal(survey.node_count, 5);
  assert.equal(survey.deposit_count, 3);
});

test("the origin defaults to the HUB when none is given", () => {
  const survey = surveyResources(hubSnapshot());
  assert.equal(survey.origin.x, 0);
  assert.equal(survey.resources[0].resource, "Limestone");
  assert.equal(survey.resources[0].nearest_m, 39);
});

test("nodes group by resource with purity and occupancy kept apart", () => {
  const survey = surveyResources(hubSnapshot());
  const iron = survey.resources.find((r) => r.resource === "Iron Ore");
  assert.equal(iron.total, 3);
  assert.deepEqual(iron.by_purity, { Pure: 2, Impure: 1 });
  const copper = survey.resources.find((r) => r.resource === "Copper Ore");
  assert.equal(copper.occupied, 1);
  assert.equal(copper.free, 0);
});

test("the game's spelling of Inpure is not repeated at the player", () => {
  const survey = surveyResources(hubSnapshot());
  const iron = survey.resources.find((r) => r.resource === "Iron Ore");
  assert.ok("Impure" in iron.by_purity);
  assert.ok(!("Inpure" in iron.by_purity));
});

test("a radius narrows the survey and is reported back", () => {
  const survey = surveyResources(hubSnapshot(), { radiusMeters: 100 });
  assert.equal(survey.radius_m, 100);
  // Nodes sit at 39, 54, 95, 115 and 130 m, so a 100 m radius keeps three.
  assert.equal(survey.node_count, 3);
});

test("the capture radius is reported so absence is never mistaken for evidence", () => {
  const survey = surveyResources(hubSnapshot());
  assert.equal(survey.snapshot_radius_meters, 250);
  assert.match(formatSurvey(survey, null), /absence past that is not evidence/);
});

test("missing essentials are named", () => {
  const survey = surveyResources(hubSnapshot());
  assert.ok(survey.missing_essentials.includes("Coal"));
  assert.ok(!survey.missing_essentials.includes("Iron Ore"));
});

test("a site with pure nodes and no gaps is allowed to be called good", () => {
  // An assistant that only ever finds fault is one whose praise means nothing.
  const snapshot = hubSnapshot();
  snapshot.actors.push(
    {
      kind: "resource_node",
      actor_id: "coal1",
      resource_name: "Coal",
      purity: "RP_Pure",
      node_type: "Node",
      has_resources: true,
      occupied: false,
      location: { x: 8000, y: 0, z: 9000 },
    },
    {
      kind: "resource_node",
      actor_id: "copper2",
      resource_name: "Copper Ore",
      purity: "RP_Pure",
      node_type: "Node",
      has_resources: true,
      occupied: false,
      location: { x: 6000, y: 0, z: 9000 },
    },
  );
  const judgement = judgeSite(surveyResources(snapshot));
  assert.equal(judgement.verdict, "strong");
  assert.ok(judgement.strong.some((s) => /Pure Iron Ore/.test(s)));
});

test("a resource whose every node is taken is called out", () => {
  const judgement = judgeSite(surveyResources(hubSnapshot()));
  assert.ok(judgement.weak.some((w) => /Copper Ore node here is already taken/.test(w)));
});

test("node yield uses the verified base rate and flags the unverified multiplier", () => {
  const pure = nodeYield("RP_Pure", 2);
  assert.equal(pure.miner, "Miner Mk.2");
  assert.equal(pure.per_minute, 240);
  // The base rate was read from the install; the purity multiplier was not.
  assert.equal(pure.estimated, true);
});

test("an unknown purity yields nothing rather than a guess", () => {
  assert.equal(nodeYield("RP_Nonsense", 2), null);
});

test("a capture with no HUB and no player refuses instead of picking a point", () => {
  const survey = surveyResources({ actors: [] });
  assert.equal(survey.ok, false);
  assert.equal(survey.reason, "no_origin");
  assert.match(formatSurvey(survey, null), /could not find a point to survey from/);
});

test("survey questions route locally, in the wordings a player would use", () => {
  for (const question of [
    "survey this site",
    "assess my hub",
    "what resources are near me",
    "what's around me",
    "is my hub a good spot",
    "rate this location",
  ]) {
    assert.notEqual(parseSiteSurveyRequest(question), null, question);
  }
});

test("a radius in the question is parsed out and honoured", () => {
  assert.equal(parseSiteSurveyRequest("what resources are near me within 300m").radius_meters, 300);
  assert.equal(parseSiteSurveyRequest("survey this site").radius_meters, null);
});

test("unrelated questions are left for the model", () => {
  for (const question of ["how do i make steel", "build me a smelter", "where am i"]) {
    assert.equal(parseSiteSurveyRequest(question), null, question);
  }
});
