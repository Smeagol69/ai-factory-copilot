import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runtimeContext,ROOT} from '../../../lib/project.mjs';
import {GoogleClient,runGoogleTask} from '../../../runtime/agent-pair/managed-agents/google-client.mjs';
import {openPairBridge} from '../../../runtime/agent-pair/managed-agents/mcp-bridge.mjs';
const directory=ROOT+'/state/live-architect/tunnel-milestone',file=directory+'/review-clarification.json';
if(existsSync(file))throw Error('Do not replay review clarification');
const source=ROOT+'/workspaces/architect/blueprint-force-save',context=await runtimeContext(),project='satisfactory-ai-architect';
const files=['companion/lib/level-tunnel.mjs','companion/lib/blueprints.mjs','companion/lib/router.mjs','companion/lib/tools.mjs'];
const receipt={startedAt:new Date().toISOString(),policy:{maxRequests:2,maxToolCalls:1,maxOutputTokens:3072,noFurtherClarification:true},files:files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(source+'/'+file)).digest('hex')})),calls:[]};
const save=()=>writeFileSync(file,JSON.stringify(receipt,null,2));save();
const diff=execFileSync('git',['diff','--unified=1','--','companion/lib/blueprints.mjs','companion/lib/router.mjs','companion/lib/tools.mjs'],{cwd:source,windowsHide:true,encoding:'utf8'});
const prompt=`Continue your SAME exact-source geometry review with one bounded clarification, not a new generic audit. You raised2important findings. Verify the following counterevidence before retaining/retracting them. 1) rotateQ IS Hamilton qZ*q where qZ=(0,0,s,c): output(cx-sy,cy+sx,cz+sw,cw-sz). It preserves norm. Hand-computed +/-30deg tests verify initial normal(0,-1,0) becomes(sin(a),-cos(a),0) and unit norm. 2) Pairing DOES check explicit distance(diff,+/-delta)<0.1 and requires exactly1spatial match. A new same-class coplanar repeated-floor test passes with4separatecourses. Full actual native reference36foundations ->18profilepieces ->66outputpieces, keeping8distinct course heights. Source geometry remains EXACTLY the hash in prior review. The chosen source profile is foundation-only; no collision-free claim is made, rigid joint overlaps declared. Re-evaluate ONLY these two concrete findings. Also independently review the small integration diff below for any important issue. Do not invent test execution. Send ONE pair_send_message(project='${project}',to='codex-14540',channel='review',subject='Tunnel review clarification and integration',body=<JSON {verdict:'approve|request_changes|uncertain',prior_findings:[{finding,disposition,reason}],findings:[],limitations:[]}>). Then finish. No source edits, game writes, Ghidra or other tools. Max2requests1tool.\nINTEGRATION DIFF:\n${diff}`;
if(prompt.length>12000)throw Error('Prompt too large');
const bridge=await openPairBridge({database:context.database,instance:'google-tunnel-review-geometry-20261018',provider:'google',project,recipient:'codex-14540',role:'reviewer',capabilities:['exact-source-review']});
try{
 const client=new GoogleClient(process.env.GEMINI_API_KEY),request=client.request.bind(client);client.request=(p,b,s)=>request(p,{...b,generationConfig:{...b.generationConfig,thinkingConfig:{thinkingLevel:'minimal'}}},s);
 receipt.result=await runGoogleTask({client,model:'gemini-3.5-flash',prompt,tools:bridge.tools.filter(t=>t.name==='pair_send_message'),maxRequests:2,maxToolCalls:1,maxOutputTokens:3072,dispatch:async(name,args)=>{receipt.calls.push({name,args});save();const r=await bridge.dispatch(name,args);receipt.calls.at(-1).completed=true;save();return r;},onState:s=>{receipt.result=s;save();}});
}finally{await bridge.close();receipt.finishedAt=new Date().toISOString();save();}
console.log(JSON.stringify({status:receipt.result.status,handoff:receipt.calls.find(c=>c.completed)?.args.body}));
