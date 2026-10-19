import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createLocalModelGateway} from '../../../lib/local-worker-gateway.mjs';
const root=process.cwd(),source=root+'/workspaces/architect/blueprint-force-save',dir=root+'/state/live-architect/tunnel-milestone/';
const groups=[
 ['native-pose',['Source/AIFactoryCopilot/Private/AIFactoryActions.cpp','Source/AIFactoryCopilot/Public/AIFactoryFoundationPosePolicy.h'],'v7 permits shortening only one horizontal foundation axis; heights and thickness preserved; v6 unchanged. Shared pure policy used by parser and exporter.17 compiled boundary cases pass.'],
 ['native-capture',['Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp'],'Actual422 selection refused307 already-designer-flagged pieces. Explicit native archive writer takes Members directly: preserve flags/owners and avoid adopting those pieces. Legacy fallback retains original guard. Native scale policy is also checked here.'],
 ['bridge',['companion/lib/actions.mjs','companion/lib/tools.mjs'],'Check v6/v7 validation matches native: finite full unit quaternion, one horizontal X or Y shortening [.01,1], Z=1, no dual-axis shortening, foundation-only/no configuration/no topology <=512. Preserve v1-v6.'],
 ['curve',['companion/lib/level-tunnel.mjs'],'v7 measured dimensions/full poses, only longitudinal shortening. Shared stations. New reference_frame is read-only. Native render/clearance still unverified.'],
 ['lighting',['companion/lib/tunnel-lighting.mjs'],'v1 separate fixtures, shell untouched. Two flat saved light rows; two beam rows mirrored at roof. Captured default length400/current0. Power and actual mesh clearance explicitly unknown; live test next. Check math and validation.'],
 ['route',['companion/lib/router.mjs'],'Deterministic opt-in lighting save via existing native v1 plus opt-in v7 fitted panels. Reference from bounded exact local library. Keep originals/new names. No arbitrary action sink or paid gameplay model.'],
];
for(const [name,files,context] of groups){
 const file=dir+'local-lighting-'+name+'-'+(name==='curve'?'v3':'v2')+'-review.json';
 if(existsSync(file)){
  const prior=JSON.parse(readFileSync(file));
  if(prior.files.some(f=>createHash('sha256').update(readFileSync(source+'/'+f.file)).digest('hex')!==f.sha256))throw Error('Review source changed');
  if(prior.status==='completed'||existsSync(file.replace('.json','-path-repair.json'))&&JSON.parse(readFileSync(file.replace('.json','-path-repair.json'))).status==='completed')continue;
  const repairFile=file.replace('.json','-path-repair.json');
  if(prior.status!=='failed'||!prior.result?.lastError?.message?.includes('Choose a literal project source path')||existsSync(repairFile))throw Error('Not an eligible unrepeated same-context path repair');
  const repair={startedAt:new Date().toISOString(),files:prior.files,conversationId:prior.result.id,repair:'Invalid redundant source path; original exact diff stays in same conversation.',status:'running'};writeFileSync(repairFile,JSON.stringify(repair,null,2));
  try{repair.result=await createLocalModelGateway({root}).dispatch('local_model_chat',{conversationId:prior.result.id,message:'Continue this SAME independent review using the exact original diff in original-goal context. No additional tools, project_context, lookups, paths, edits or handoff. This native checkout is not exposed by root project file tools. Return JSON verdict, concrete findings and limitations only. You are reviewing supplied code, not certifying game success.'});repair.status=repair.result.status;}catch(e){repair.status='failed';repair.error=e.message;}
  repair.finishedAt=new Date().toISOString();writeFileSync(repairFile,JSON.stringify(repair,null,2));console.log(JSON.stringify({name,repair:true,status:repair.status,assistant:repair.result?.messages.filter(m=>m.role==='assistant').map(m=>m.content),error:repair.error??repair.result?.lastError}));
  if(repair.status!=='completed')break;
  continue;
 }
 let code='';for(const f of files){const existed=spawnSync('git',['cat-file','-e','d89f7cf:'+f],{cwd:source,windowsHide:true,stdio:'ignore'}).status===0;code+='\n'+f+'\n'+(existed?execFileSync('git',['diff','d89f7cf','--unified=1','--',f],{cwd:source,windowsHide:true,encoding:'utf8'}):readFileSync(source+'/'+f,'utf8'));}
 const message='READ ONLY independent review. NO tools, source lookups, edits or game actions. Return JSON {verdict:"approve|request_changes|uncertain",findings:[],limitations:[]}. '+context+'\n'+code;
 const r={startedAt:new Date().toISOString(),promptCharacters:message.length,files:files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(source+'/'+file)).digest('hex')})),status:'running'};
 if(message.length>6000)throw Error('Review input too large: '+name+' '+message.length);
 writeFileSync(file,JSON.stringify(r,null,2));
 try{r.result=await createLocalModelGateway({root}).dispatch('local_model_chat',{message});r.status=r.result.status;}catch(e){r.status='failed';r.error=e.message;}
 r.finishedAt=new Date().toISOString();writeFileSync(file,JSON.stringify(r,null,2));console.log(JSON.stringify({name,status:r.status,promptCharacters:r.promptCharacters,assistant:r.result?.messages.filter(m=>m.role==='assistant').map(m=>m.content),error:r.error??r.result?.lastError}));
 if(r.status!=='completed')break;
}
