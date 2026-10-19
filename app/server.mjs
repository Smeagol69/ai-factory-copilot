import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAppServer } from '../lib/app.mjs';
import { runtimeContext, projectStatus, companionHealth } from '../lib/project.mjs';
import { runLocalCheck } from '../lib/checks.mjs';
import { readTeamStatus } from '../lib/team-status.mjs';
import { readAgentWorkEvidence } from '../lib/agent-work-evidence.mjs';
import { companionStatus } from '../lib/companion.mjs';
import { createLocalModelService } from '../lib/local-model-service.mjs';
import { createOllamaRunner } from '../lib/local-worker.mjs';
import { createLocalChat } from '../lib/local-chat.mjs';
import { openLocalWorkerMcp } from '../lib/local-worker-mcp.mjs';
import { attachLocalChat } from '../lib/local-chat-http.mjs';
import { loadRePolicy } from '../lib/re-policy.mjs';
import { createReInvestigation } from '../lib/re-investigation.mjs';
import { createReGameAdapter } from '../lib/re-game-adapter.mjs';
import { runReModels } from '../lib/re-models.mjs';

const context = await runtimeContext();
const localModel = createLocalModelService({root:context.root});
// Service startup performs no inference and never takes over an unknown port.
try { await localModel.ensureGame(); } catch { /* Chat status explains installation/readiness. */ }
const localChat = createLocalChat({root:context.root,readModelStatus:()=>localModel.status(),
  tools:[{name:'project_context',description:'Read current project context and delegated work'},
    {name:'project_handoff',description:'Share an attributed finding with the team'},
    {name:'project_read_file',description:'Read existing source and its current hash'},
    {name:'project_edit_file',description:'Actually edit a delegated source file with a write receipt'},
    {name:'project_run_check',description:'Run a declared project check and retain its exit code'},
    {name:'project_team_request',description:'Start the shared reverse-engineering workflow'}],
  runModel:createOllamaRunner({ensure:options=>localModel.ensure(options),openMcp:({conversationId})=>openLocalWorkerMcp({root:context.root,conversationId})})});
const { PairStore } = await context.moduleAt('store.mjs');
const { OfficeMemory } = await context.moduleAt('office-memory.mjs');
const reAdapter=createReGameAdapter({root:context.root});
const investigation=createReInvestigation({root:context.root,policy:loadRePolicy(context.root),services:{
  target:args=>reAdapter.target(args),inspect:args=>reAdapter.inspect(args),
  models:args=>runReModels({...args,root:context.root,localChat}),
  publish:async args=>{
    const saved=await reAdapter.publish(args);
    const author=new PairStore(context.database,'copilot-re-coordinator',Date.now,'coordinator');
    try{
      const memory=new OfficeMemory(author);
      const observation=memory.remember({project:context.config.project,key:`reverse-engineering/${args.runId}`,
        value:`${args.targetId} investigation pass: ${args.report.findings.length} source-attributed findings. Coverage remains partial. ${args.report.unknowns.slice(0,3).join(' ').slice(0,1200)}`,
        evidence:[saved.reportFile,saved.summaryFile],tags:['reverse-engineering','partial','source-attributed']});
      return {...saved,sharedMemoryEntryId:observation.entry?.id??observation.id??null,receivedByPeer:false};
    }finally{author.close();}
  },
}});
const { safeText } = await context.moduleAt('process.mjs');
const store = new PairStore(context.database, 'copilot-app', Date.now, 'coordinator', { readOnly: true });
// Verify source once at startup. Refreshing the page never launches Git or a
// console subprocess; explicit MCP checks reverify the pinned source separately.
const baselineStatus = { ...await projectStatus({ offline: true }), sourceVerifiedAt: new Date().toISOString() };
const readStatus = async () => {
  const companionService = await companionStatus({ port: context.config.game.companionPort });
  const base = { ...baselineStatus, companion: companionService.health, companionService };
  const ledger = store.context({ project: context.config.project });
  let architect = null;
  if (context.config.architectProject) {
    try { architect = store.context({ project: context.config.architectProject }); } catch { /* Unknown until registered. */ }
  }
  let rea;
  try { rea = await (await import('../lib/rea.mjs')).reaStatus(); }
  catch { rea = { installed: false, status: 'unavailable', limitations: ['REA status could not be verified.'] }; }
  return { ...base, home: context.root, application: 'Copilot', rea,
    catalogue: JSON.parse(readFileSync(join(context.root, 'catalog/index.json'), 'utf8')),
    modelWork: readTeamStatus(context.root),
    currentWork: readAgentWorkEvidence(context.root),
    tasks: [...(architect?.tasks ?? []), ...ledger.tasks].map(t => ({ id: t.id, owner: t.owner, status: t.status, description: safeText(t.description ?? '').slice(0, 500) })),
    observedAt: new Date().toISOString(), modelCalls: 0,
    storage: { home: context.root, sharedLedger: 'Existing shared ledger in Windows app data; not copied or split.',
      gameSource: context.game, credentials: 'Existing secure Windows credential store; keys are not in this project.' } };
};
try {
  const server = await createAppServer({ root: context.root, project: context.config.project,
    port: context.config.appPort, readStatus, runCheck: runLocalCheck });
  attachLocalChat(server,localChat,{investigation});
  server.on('close', () => store.close());
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
  console.log(`Copilot: http://127.0.0.1:${server.address().port}/`);
} catch (error) { store.close(); throw error; }
