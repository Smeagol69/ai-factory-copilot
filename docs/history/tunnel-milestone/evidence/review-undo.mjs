import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createLocalModelGateway} from '../../../lib/local-worker-gateway.mjs';
const root=process.cwd(),source=root+'/workspaces/architect/blueprint-force-save',dir=root+'/state/live-architect/tunnel-milestone';
const files=['Source/AIFactoryCopilot/Private/AIFactoryActions.cpp','Source/AIFactoryCopilot/Public/AIFactoryActions.h'];
const diff=execFileSync('git',['diff','--unified=1','--',...files],{cwd:source,windowsHide:true,encoding:'utf8'});
const compact=diff.split('\n').filter(l=>!/^[-+ ]\s*\/\//.test(l)).map(l=>l.replace(/^([+ -])\s+/,'$1')).join('\n');
const split=compact.indexOf('@@',compact.indexOf('@@ -390'));
// Review coherent helper/rollback and UndoLast sections separately within the
// actual local endpoint's 6000-character user-message bound.
const marker=compact.indexOf('@@ -391');
const hunks=compact.split(/(?=^@@ )/m);
let helper='',undo='';
for(const h of hunks){const n=Number(/^@@ -(\d+)/.exec(h)?.[1]??0);if(n>3800||h.startsWith('diff --git a/Source/AIFactoryCopilot/Public'))undo+=h;else helper+=h;}
for(const [section,patch] of [['membership',helper],['readback',undo.split('\n').filter(l=>!l.startsWith('-')).join('\n')]]){
 if(process.argv[2] && section!==process.argv[2])continue;
 const path=dir+'/local-undo-review-'+section+'.json';if(existsSync(path))throw Error('No review replay');
 const message=`READ-ONLY native undo ${section} review. NO tools, edits or game actions. Return JSON {verdict:"approve|request_changes|uncertain",findings:[],limitations:[]}. Live bug: proxy-only dismantle reported 66 removed, but 66 survived reload. Separate approved helper expands current actor/lightweight members. Review new member removal and actual readback; failure retains journal before reclaim/teleport. Proxy self-destructs after last member per SDK. Native build and1333tests pass; live retest pending. Compact exact diff, indentation/comments omitted:\n${patch}`;
 if(message.length>6000)throw Error('Section exceeds endpoint bound: '+section+' '+message.length);
 const receipt={startedAt:new Date().toISOString(),section,files:files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(source+'/'+file)).digest('hex')})),status:'running'};writeFileSync(path,JSON.stringify(receipt,null,2));
 try{receipt.result=await createLocalModelGateway({root}).dispatch('local_model_chat',{message});receipt.status=receipt.result.status;}catch(error){receipt.status='failed';receipt.error=error.message;}
 receipt.finishedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(receipt,null,2));console.log(JSON.stringify({section,status:receipt.status,messages:receipt.result?.messages.filter(m=>m.role==='assistant'),error:receipt.error??receipt.result?.lastError}));
}
