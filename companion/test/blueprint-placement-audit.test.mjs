import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph } from "../lib/graph.mjs";
import { solveBlueprintPlacementAudit } from "../lib/solvers.mjs";
import { buildFactorySnapshot } from "./fixtures/factory.mjs";

const TARGET = "/Game/FactoryMap.FactoryMap:PersistentLevel.BlueprintProxy_Test";
const ANCHOR = `${TARGET}.BlueprintResourceAnchor_C_1`;
const MINER = `${TARGET}.Build_MinerMk1_C_1`;

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

function resourceAnchor(overrides = {}) {
  return {
    anchor_actor_id: ANCHOR,
    anchor_actor_name: "BlueprintResourceAnchor_C_1",
    anchor_actor_class_path: "/AIFactoryCopilot/BlueprintResourceAnchor.BlueprintResourceAnchor_C",
    configuration: {
      schema_version: 1,
      state: "configured",
      resource_class: "/Game/FactoryGame/Resource/RawResources/Copper/Desc_OreCopper.Desc_OreCopper_C",
      resource_name: "Copper Ore",
      purity: "pure",
    },
    runtime_node: {
      state: "observed",
      actor_id: `${ANCHOR}.RuntimeNode`,
      owned_by_anchor_exactly: true,
      occupied: true,
      matches_configuration: true,
      resource_class: "/Game/FactoryGame/Resource/RawResources/Copper/Desc_OreCopper.Desc_OreCopper_C",
      resource_name: "Copper Ore",
      purity: "pure",
    },
    binding_census_state: "complete",
    bound_extractor_count_observed: 1,
    bound_extractor_details_returned: 1,
    bound_extractor_details_capped_omitted: 0,
    bound_extractor_actor_ids: [MINER],
    ...overrides,
  };
}

function readyResourceAnchorAudit(overrides = {}) {
  return {
    resource_anchor_count_observed: 1,
    lightweight_resource_anchor_count_uninspected: 0,
    resource_anchor_observation_complete: true,
    resource_anchor_count: 1,
    resource_anchor_details_returned: 1,
    resource_anchor_details_capped_omitted: 0,
    resource_anchors: [resourceAnchor()],
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
  assert.equal(result.resource_anchor_audit.status, "not_captured");
});

test("a ready proxy preserves a configured Anchor's exact resource, node, and miner identity", () => {
  const ordinary = readyAudit().extractors[0];
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit(),
    extractors: [{ ...ordinary, resource_anchor_actor_id: ANCHOR }],
  })));

  assert.equal(result.resource_anchor_audit.status, "complete");
  assert.equal(result.resource_anchor_audit.anchor_count, 1);
  assert.equal(result.resource_anchor_audit.anchors[0].configuration.resource_name, "Copper Ore");
  assert.equal(result.resource_anchor_audit.anchors[0].configuration.purity, "pure");
  assert.equal(result.resource_anchor_audit.anchors[0].runtime_node.occupied, true);
  assert.deepEqual(result.resource_anchor_audit.anchors[0].bound_extractor_actor_ids, [MINER]);
  assert.equal(result.extractors[0].resource_anchor_actor_id, ANCHOR);
});

test("an Anchor's client-null runtime node remains unknown rather than missing or unbound", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    proxy_has_authority: false,
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        runtime_node: { state: "unknown_on_client" },
        binding_census_state: "unknown_on_client",
        bound_extractor_count_observed: undefined,
        bound_extractor_details_returned: undefined,
        bound_extractor_details_capped_omitted: undefined,
        bound_extractor_actor_ids: undefined,
      })],
    }),
  })));

  assert.equal(result.resource_anchor_audit.status, "complete_with_unknown_runtime_node");
  assert.equal(result.resource_anchor_audit.anchors[0].runtime_node.state, "unknown_on_client");
  assert.equal(result.resource_anchor_audit.anchors[0].binding_census_state, "unknown_on_client");
});

test("a captured Anchor configuration mismatch stays explicit instead of healthy", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        runtime_node: {
          ...resourceAnchor().runtime_node,
          state: "configuration_mismatch",
          matches_configuration: false,
          resource_class: "/Game/FactoryGame/Resource/RawResources/Iron/Desc_OreIron.Desc_OreIron_C",
          resource_name: "Iron Ore",
        },
        binding_census_state: "complete_with_configuration_mismatch",
      })],
    }),
  })));

  assert.equal(result.resource_anchor_audit.status, "complete_with_configuration_mismatch");
  assert.equal(result.resource_anchor_audit.anchors[0].runtime_node.state, "configuration_mismatch");
});

test("two Anchors claiming one exact miner fail closed", () => {
  const secondAnchor = `${TARGET}.BlueprintResourceAnchor_C_2`;
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchor_count_observed: 2,
      resource_anchor_count: 2,
      resource_anchor_details_returned: 2,
      resource_anchors: [
        resourceAnchor(),
        resourceAnchor({
          anchor_actor_id: secondAnchor,
          anchor_actor_name: "BlueprintResourceAnchor_C_2",
          runtime_node: { ...resourceAnchor().runtime_node, actor_id: `${secondAnchor}.RuntimeNode` },
        }),
      ],
    }),
  })));

  assert.equal(result.resource_anchor_audit.status, "inconsistent_duplicate_bound_extractor");
  assert.deepEqual(result.resource_anchor_audit.duplicate_bound_extractor_actor_ids, [MINER]);
});

test("malformed or incomplete Anchor metadata cannot become a healthy audit", () => {
  const missingDetail = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({ resource_anchors: [] }),
  })));
  assert.equal(missingDetail.resource_anchor_audit.status, "partial_or_inconsistent");

  const missingBoundCount = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        bound_extractor_count_observed: undefined,
        bound_extractor_details_returned: undefined,
        bound_extractor_details_capped_omitted: undefined,
      })],
    }),
  })));
  assert.equal(missingBoundCount.resource_anchor_audit.status, "partial_or_inconsistent");

  const observedMismatch = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({ resource_anchor_count_observed: 0 }),
  })));
  assert.equal(observedMismatch.resource_anchor_audit.status, "partial_or_inconsistent");

  const invalidRuntime = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({ runtime_node: { state: "not_a_real_runtime_state" } })],
    }),
  })));
  assert.equal(invalidRuntime.resource_anchor_audit.status, "partial_or_inconsistent");
});

test("contradictory Anchor health fields fail closed instead of overriding exact invariants", () => {
  const schemaMismatch = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        configuration: { ...resourceAnchor().configuration, schema_version: 2 },
      })],
    }),
  })));
  assert.equal(schemaMismatch.resource_anchor_audit.status, "partial_or_inconsistent");

  const ownerMismatch = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        runtime_node: { ...resourceAnchor().runtime_node, owned_by_anchor_exactly: false },
      })],
    }),
  })));
  assert.equal(ownerMismatch.resource_anchor_audit.status, "partial_or_inconsistent");

  const resourceMismatch = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        runtime_node: {
          ...resourceAnchor().runtime_node,
          resource_class: "/Game/FactoryGame/Resource/RawResources/Iron/Desc_OreIron.Desc_OreIron_C",
          resource_name: "Iron Ore",
        },
      })],
    }),
  })));
  assert.equal(resourceMismatch.resource_anchor_audit.status, "partial_or_inconsistent");

  const falseCompleteWithLightweightAnchor = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({ lightweight_resource_anchor_count_uninspected: 1 }),
  })));
  assert.equal(falseCompleteWithLightweightAnchor.resource_anchor_audit.status, "partial_or_inconsistent");

  const falseClientBinding = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchors: [resourceAnchor({
        runtime_node: { state: "unknown_on_client" },
        binding_census_state: "complete",
      })],
    }),
  })));
  assert.equal(falseClientBinding.resource_anchor_audit.status, "partial_or_inconsistent");
});

test("a lightweight Anchor member keeps the Anchor census partial", () => {
  const result = solveBlueprintPlacementAudit(graphWithAudit(readyAudit({
    ...readyResourceAnchorAudit({
      resource_anchor_count_observed: 1,
      lightweight_resource_anchor_count_uninspected: 1,
      resource_anchor_observation_complete: false,
      resource_anchor_count: 2,
    }),
  })));

  assert.equal(result.resource_anchor_audit.status, "partial");
  assert.equal(result.resource_anchor_audit.anchor_count, 2);
  assert.equal(result.resource_anchor_audit.lightweight_anchor_count_uninspected, 1);
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
  assert.equal(result.resource_anchor_audit.status, "not_inspected_until_blueprint_proxy_ready");
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
  assert.equal(result.resource_anchor_audit.status, "not_inspected_until_extractor_counts_complete");
});
