import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { solveBlueprintPlacementAudit } from "../lib/solvers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const TARGET = "/Game/FactoryMap.FactoryMap:PersistentLevel.BlueprintProxy_Test";

function graphWithAudit(audit) {
  const snapshot = buildFactorySnapshot();
  snapshot.interaction_context.preferred_target = {
    available: true,
    selected_from: "game_cached_interaction",
    actor_id: TARGET,
    ...(audit === undefined ? {} : { blueprint_instance_audit: audit }),
  };
  return buildGraph(snapshot);
}

function readyAudit(overrides = {}) {
  return {
    available: true,
    source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
    certainty: "authoritative",
    target_actor_id: TARGET,
    target_relation: "blueprint_proxy",
    blueprint_proxy_id: TARGET,
    blueprint_name: "Copper Starter",
    replication_state: "ready",
    proxy_buildings_registered_and_valid: true,
    member_counts_complete: true,
    extractor_observation_complete: true,
    extractor_binding_states_fully_inspected: true,
    actor_member_count: 3,
    lightweight_member_count: 2,
    member_count: 5,
    extractor_count: 1,
    extractor_binding_counts: { bound: 1, unbound: 0, replication_pending: 0, unknown: 0 },
    extractor_details_returned: 1,
    extractor_details_capped_omitted: 0,
    extractors: [{
      actor_id: `${TARGET}.Build_MinerMk1_C_1`,
      actor_name: "Build_MinerMk1_C_1",
      actor_class_path: "/Game/FactoryGame/Buildable/Factory/MinerMk1.Build_MinerMk1_C",
      extractor_type: "Miner",
      binding_state: "bound",
      extractable_object_id: "/Game/FactoryMap.FactoryMap:PersistentLevel.BP_ResourceNode_C_1",
      extractable_actor_id: "/Game/FactoryMap.FactoryMap:PersistentLevel.BP_ResourceNode_C_1",
      resource_class: "/Game/FactoryGame/Resource/RawResources/Copper/Desc_OreCopper.Desc_OreCopper_C",
      resource_name: "Copper Ore",
    }],
    ...overrides,
  };
}

test("a missing runtime Blueprint observation stays explicitly unknown", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit());

  assert.equal(result.solver, "blueprint_placement_audit");
  assert.equal(result.available, false);
  assert.equal(result.reason, "blueprint_instance_audit_not_captured");
  assert.equal(result.certainty, "unknown");
  assert.equal(result.extractor_count, undefined);
});

test("an aimed non-Blueprint actor is not recast as an empty Blueprint", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit({
    available: false,
    source: "AFGBlueprintProxy and AFGBuildableResourceExtractorBase public accessors",
    certainty: "unknown",
    target_actor_id: TARGET,
    reason: "preferred_target_is_not_a_native_blueprint_proxy_or_actor_member",
  }));

  assert.equal(result.available, false);
  assert.equal(result.target_actor_id, TARGET);
  assert.equal(result.reason, "preferred_target_is_not_a_native_blueprint_proxy_or_actor_member");
  assert.equal(result.extractor_count, undefined);
});

test("a replication-pending proxy never claims its observed subset is a complete miner census", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    certainty: "partial",
    replication_state: "replication_pending",
    proxy_buildings_registered_and_valid: false,
    member_counts_complete: false,
    extractor_observation_complete: false,
    actor_member_count_observed: 1,
    lightweight_member_count_observed: 0,
    member_count_observed: 1,
    extractor_count_observed: 1,
    reason: "blueprint_proxy_replication_pending",
  })));

  assert.equal(result.available, true);
  assert.equal(result.inspection_complete, false);
  assert.equal(result.replication_state, "replication_pending");
  assert.equal(result.observed.extractor_count_observed, 1);
  assert.equal(result.extractor_count, undefined);
  assert.equal(result.extractor_binding_counts, undefined);
  assert.equal(result.extractors, undefined);
});

test("a ready proxy preserves the exact game-reported extractor/resource binding", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit()));

  assert.equal(result.available, true);
  assert.equal(result.inspection_complete, true);
  assert.equal(result.member_count, 5);
  assert.equal(result.extractor_count, 1);
  assert.deepEqual(result.extractor_binding_counts, {
    bound: 1,
    unbound: 0,
    replication_pending: 0,
    unknown: 0,
  });
  assert.equal(result.extractors[0].extractable_actor_id, "/Game/FactoryMap.FactoryMap:PersistentLevel.BP_ResourceNode_C_1");
  assert.equal(result.extractors[0].resource_name, "Copper Ore");
});

test("a client-ready null extractor binding remains unknown rather than unbound", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    proxy_has_authority: false,
    extractor_binding_counts: { bound: 0, unbound: 0, replication_pending: 0, unknown: 1 },
    extractors: [{
      actor_id: `${TARGET}.Build_MinerMk1_C_1`,
      actor_name: "Build_MinerMk1_C_1",
      actor_class_path: "/Game/FactoryGame/Buildable/Factory/MinerMk1.Build_MinerMk1_C",
      extractor_type: "Miner",
      binding_state: "unknown",
      reason: "extractable_resource_not_replicated_or_unbound",
    }],
  })));

  assert.equal(result.inspection_complete, true);
  assert.equal(result.proxy_has_authority, false);
  assert.equal(result.extractor_binding_counts.unbound, 0);
  assert.equal(result.extractor_binding_counts.unknown, 1);
  assert.equal(result.extractors[0].binding_state, "unknown");
  assert.equal(result.extractors[0].reason, "extractable_resource_not_replicated_or_unbound");
});

test("lightweight extractor members keep a ready proxy audit partial", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    extractor_observation_complete: false,
    extractor_binding_states_fully_inspected: false,
    extractor_count_observed: 2,
    actor_extractor_count_observed: 1,
    lightweight_extractor_count_uninspected: 1,
    extractor_count: 2,
    extractor_binding_counts: { bound: 1, unbound: 0, replication_pending: 0, unknown: 1 },
    binding_caveat: "lightweight_extractor_members_cannot_be_resolved_from_this_aim",
  })));

  assert.equal(result.inspection_complete, false);
  assert.equal(result.replication_state, "ready");
  assert.equal(result.observed.lightweight_extractor_count_uninspected, 1);
  assert.equal(result.extractor_binding_counts, undefined);
  assert.equal(result.binding_caveat, "lightweight_extractor_members_cannot_be_resolved_from_this_aim");
});

test("a camera-visible Blueprint fallback preserves both the preferred and audited actor identities", () => {
  const cameraMiner = `${TARGET}.Build_MinerMk1_C_1`;
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    target_actor_id: cameraMiner,
    audited_actor_id: cameraMiner,
    preferred_target_actor_id: TARGET,
    camera_fallback_actor_id: cameraMiner,
    selected_from: "camera_visibility_trace_fallback",
  })));

  assert.equal(result.target_actor_id, cameraMiner);
  assert.equal(result.audited_actor_id, cameraMiner);
  assert.equal(result.preferred_target_actor_id, TARGET);
  assert.equal(result.camera_fallback_actor_id, cameraMiner);
  assert.equal(result.selected_from, "camera_visibility_trace_fallback");
});

test("inconsistent ready counts fail closed instead of inventing a binding status", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    member_count: 4,
    extractor_binding_counts: { bound: 1, unbound: 1, replication_pending: 0, unknown: 0 },
  })));

  assert.equal(result.available, true);
  assert.equal(result.inspection_complete, false);
  assert.equal(result.reason, "blueprint_audit_counts_incomplete");
  assert.equal(result.extractor_binding_counts, undefined);
});
