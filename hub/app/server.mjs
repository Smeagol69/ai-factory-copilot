import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
import { createTeamRoom, attachTeamRoom } from '../lib/team-http.mjs';
import { createBackupShift } from '../lib/backup-shift.mjs';
import { createShiftTools } from '../lib/shift-tools.mjs';

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
  // The Team room is the front page: live model columns from each app's own logs
  // and the owner's milestones, published to shared memory for every model.
  const projects=[context.config.project,context.config.architectProject??context.config.project];
  // Models work in the main checkout and in worktrees of it; both count as this project.
  let mainCheckout=dirname(context.root);
  try{mainCheckout=dirname(resolve(context.root,execFileSync('git',['rev-parse','--git-common-dir'],{cwd:context.root,encoding:'utf8',windowsHide:true,timeout:5000}).trim()));}catch{/* not a git checkout: the repo folder alone */}
  // The local model's backup shift: one small step at a time in its own worktree,
  // only while every subscription model is out of usage; reviewed before merging.
  let latestColumns=[],teamState=null;
  const shift=createBackupShift({root:context.root,repo:mainCheckout,
    readColumns:()=>latestColumns,readMilestones:()=>teamState?.milestones()??[],
    runnerFor:({worktree,onEvent})=>createOllamaRunner({ensure:options=>localModel.ensure(options),openMcp:async()=>createShiftTools({worktree,onEvent})}),
    postReview:async review=>{
      const author=new PairStore(context.database,'hauhaucs-local',Date.now,'coordinator');
      try{author.send({project:context.config.project,subject:`Review requested: ${review.branch} ${review.commit.slice(0,7)} (local backup shift)`,
        body:`HauhauCS worked alone while Claude and Codex were out of usage.\nMilestone: ${review.milestone}\nChanged: ${review.changed}\nPlease check: ${review.review}\nCommit ${review.commit} on branch ${review.branch} (worktree hub/workspaces/local-shift). Merge into master only after review; discard it otherwise.`});}
      finally{author.close();}
    }});
  const room=createTeamRoom({root:context.root,roots:[...new Set([dirname(context.root),mainCheckout])],codexHome:join(homedir(),'.codex'),claudeHome:join(homedir(),'.claude'),
    defaultLocal:['copilot-hauhau-game:latest'],shift,
    readLedger:()=>store.db.prepare('SELECT sender, subject, created_at AS t FROM messages WHERE project IN (?, ?) ORDER BY id DESC LIMIT 60').all(...projects),
    publishMilestones:async value=>{
      const author=new PairStore(context.database,'copilot-team-room',Date.now,'coordinator');
      try{
        const saved=new OfficeMemory(author).remember({project:context.config.project,key:'milestones',value,evidence:['hub/state/team/milestones.json'],tags:['milestones','owner']});
        return {published:true,entryId:saved?.entry?.id??saved?.id??null};
      }finally{author.close();}
    }});
  attachTeamRoom(server,room);
  teamState=room.state;
  // Checking costs no model calls; a step only starts when shouldRun says so.
  const shiftTimer=setInterval(async()=>{try{latestColumns=(await room.view()).columns;await shift.tick();}catch{/* next minute */}},60000);
  server.on('close', () => { clearInterval(shiftTimer); store.close(); });
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
  console.log(`Copilot: http://127.0.0.1:${server.address().port}/`);
} catch (error) { store.close(); throw error; }
