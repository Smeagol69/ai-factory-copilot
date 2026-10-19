// Reserved, deterministic studio command. A question can select only exact
// content-addressed bytes in the configured spool, never a path or action text.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validatePlan } from './actions.mjs';

export const STUDIO_GENERATION_CAPABILITY = 'studio_native_generation_v1';
export const STUDIO_PROPOSAL_MAX_BYTES = 5 * 1024 * 1024;
export function studioGenerationDirectory(env = process.env) {
  return env.AIFACTORY_STUDIO_PROPOSAL_DIR || (env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'FactoryGame/Saved/AIFactoryCopilot/StudioProposals') : null);
}

export function answerStudioGeneration(question, graph, services = {}) {
  const text = String(question ?? '').trim();
  if (!/^aifactory\s+studio\b/i.test(text)) return null;
  const started = Date.now();
  const answer = reply => ({ reply, provider:'solvers', model:'deterministic',
    solver_calls:[{name:'studio_native_generation',source:'local_route'}],sources:[],search_errors:[],cache:null,
    local:{routed:true,solver:'studio_native_generation',elapsed_ms:Date.now()-started,
      why:'Exact SHA-256 proposal bytes; existing action validation; native save/readback is required.'} });
  const refuse = reason => answer(`Studio generation refused: ${reason}. No generation action was sent.`);
  const match = text.match(/^aifactory studio generate sha256:([a-f0-9]{64})$/);
  if (!match) return refuse('expected aifactory studio generate sha256:<64 lowercase hex digits>');
  const directory = services.studioGenerationDirectory;
  if (typeof directory !== 'string' || !directory) return refuse('the proposal directory is unavailable');
  let proposal;
  try {
    const file = join(directory, match[1] + '.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STUDIO_PROPOSAL_MAX_BYTES) throw Error('proposal is not a bounded regular file');
    const bytes = readFileSync(file);
    if (bytes.length > STUDIO_PROPOSAL_MAX_BYTES) throw Error('proposal exceeds the size limit');
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw Error('proposal hash does not match its reviewed bytes');
    proposal = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) { return refuse(error.message); }
  if (proposal?.action !== 'generate_native_blueprint' || proposal.commit !== true ||
      !Array.isArray(proposal.buildables) || !proposal.buildables.length || proposal.buildables.length > 512 ||
      ['conveyors','power_wires','pipes','pipelines'].some(k => proposal[k] !== undefined && (!Array.isArray(proposal[k]) || proposal[k].length))) {
    return refuse('the proposal must be one committed native generation of at most 512 pieces without transport or wiring');
  }
  if (typeof services.listBlueprints !== 'function') return refuse('the saved blueprint library is unavailable');
  let library;
  try { library = services.listBlueprints(); } catch { return refuse('the saved blueprint library could not be read'); }
  if (!Array.isArray(library)) return refuse('the saved blueprint library is unknown');
  if (typeof services.actions?.emit !== 'function') return refuse('the action sink is unavailable');
  const plan = validatePlan(graph, [proposal]);
  if (!plan.valid) return refuse(`normal action validation rejected the proposal (${plan.reason ?? plan.results?.find(r=>!r.valid)?.reason ?? 'invalid plan'})`);
  // Compare the name the validator will actually send, including its whitespace
  // normalization, before any action can enter the response sink.
  const name = plan.actions[0].blueprint_name;
  if (library.some(b => String(b.name).trim().toLowerCase() === name.toLowerCase())) return refuse('that blueprint already exists; its file is preserved');
  services.actions.emit(plan.actions);
  return answer(`Requested native generation of **${name}** from the reviewed proposal sha256:${match[1]}. The game must report whether it saved and read back the blueprint; no world placement was requested.`);
}
