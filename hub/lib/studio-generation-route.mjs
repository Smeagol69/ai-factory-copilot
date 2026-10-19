import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { studioGenerationDirectory, STUDIO_GENERATION_CAPABILITY, STUDIO_PROPOSAL_MAX_BYTES } from '../../companion/lib/studio-generation.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function readBounded(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STUDIO_PROPOSAL_MAX_BYTES) throw Error('Proposal is not a bounded regular file');
  const bytes = readFileSync(file);
  if (bytes.length > STUDIO_PROPOSAL_MAX_BYTES) throw Error('Proposal exceeds its size limit');
  return bytes;
}
const defaultHealth = async port => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid companion port');
  const r = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error('Companion health is unavailable');
  let size = 0; const chunks = [];
  for await (const bytes of r.body ?? []) {
    size += bytes.length;
    if (size > 65536) throw Error('Companion health exceeds its size limit');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

// Identity is causal: audited hash-only command -> exact immutable proposal
// bytes -> exactly one normally validated action -> request-scoped native result.
// The native receipt proves exact saved geometry against that submitted action;
// it does not echo a proposal hash or provide an independent saved-pose listing.
export function createStudioGenerationRoute({ directory = studioGenerationDirectory(), port = 8142, readHealth = () => defaultHealth(port) } = {}) {
  let prepared = null;
  return {
    async question({ proposal, proposalFile, proposalHash }) {
      const health = await readHealth();
      if (health?.schema !== 'aifactory.bridge.health' || !Array.isArray(health.local_command_capabilities) ||
          !health.local_command_capabilities.includes(STUDIO_GENERATION_CAPABILITY)) throw Error('Companion lacks the fixed studio generation capability; install the reviewed route first');
      if (!/^sha256:[a-f0-9]{64}$/.test(proposalHash ?? '')) throw Error('A full proposal SHA-256 hash is required');
      if (typeof directory !== 'string' || !directory) throw Error('The studio proposal directory is unavailable');
      const bytes = readBounded(proposalFile);
      if (hash(bytes) !== proposalHash) throw Error('Proposal hash changed before staging');
      if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), proposal)) throw Error('Proposal object differs from its hash-bound bytes');
      mkdirSync(directory, { recursive: true });
      const target = join(directory, proposalHash.slice(7) + '.json');
      try { writeFileSync(target, bytes, { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (hash(readBounded(target)) !== proposalHash) throw Error('Staged proposal hash differs; the existing entry was preserved');
      prepared = { proposalHash, proposal: structuredClone(proposal) };
      return `aifactory studio generate ${proposalHash}`;
    },
    verify(result, proposal, { proposalHash, request } = {}) {
      const bad = reason => ({ matchesProposal: false, blueprintName: null, savedReadback: false, reason });
      if (!prepared || prepared.proposalHash !== proposalHash || !isDeepStrictEqual(prepared.proposal, proposal)) return bad('No matching hash-bound command was prepared');
      const r = result?.receipt;
      if (!request || r?.schema !== 'aifactory.playtest-result/v1' || r.id !== request.id ||
          r.operation !== 'askall' || request.operation !== 'askall' || r.map !== request.map || r.session !== request.session ||
          r.world_instance !== request.worldInstance || r.player !== request.player) return bad('Native request identity does not match');
      if (result.pipelineCompleted !== true || result.actionsAccepted !== true || result.committedActions !== 1 ||
          r.accepted !== true || r.state !== 'completed' || r.terminal !== true || r.game_actions_refused !== false ||
          r.game_actions_requested_count !== 1 || r.game_actions_executed_count !== 1 || r.game_action_results_omitted_due_to_size === true ||
          !Array.isArray(r.game_action_results) || r.game_action_results.length !== 1) return bad('Native pipeline did not commit exactly one action');
      const a = r.game_action_results[0], p = a.predicted ?? {}, o = a.observed ?? {}, count = proposal.buildables?.length;
      if (a.action !== 'generate_native_blueprint' || a.source !== 'executed_by_the_game_and_read_back' ||
          a.status !== 'committed' || a.accepted !== true || a.committed !== true || a.dry_run !== false ||
          p.blueprint_name !== String(proposal.blueprint_name ?? '').replace(/\s+/g, ' ').trim() || p.layout_schema !== proposal.layout_schema || p.resolved_buildables !== count ||
          !Number.isInteger(count) || count < 1 || count > 512) return bad('Native generation name, schema or member count differs');
      if (!['designer_left_empty','blueprint_readable_from_disc','native_readback_descriptor_resolved','exact_native_geometry_readback','exact_native_topology_readback'].every(k => o[k] === true) ||
          !['staged_buildables','expected_saved_part_transforms','exact_saved_part_transforms','native_loaded_buildables'].every(k => o[k] === count)) return bad('Exact native save/readback is incomplete');
      if (!['configured_manufacturers','requested_conveyors','requested_power_wires','requested_pipelines','requested_resource_anchors','requested_miners'].every(k => p[k] === 0) ||
          !['staged_conveyors','staged_power_wires','staged_pipelines','staged_resource_anchors','staged_miners','native_loaded_configured_manufacturers','native_loaded_conveyors','native_loaded_power_wires','native_loaded_pipelines','native_loaded_resource_anchors','native_loaded_supported_vanilla_miners'].every(k => o[k] === 0)) return bad('Native result includes configuration or topology outside the structural proposal');
      return { matchesProposal: true, blueprintName: p.blueprint_name, savedReadback: true,
        binding: 'hash_bound_deterministic_command_and_request_scoped_native_readback' };
    },
  };
}
