import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runtimeContext,ROOT} from '../../../lib/project.mjs';
import {GoogleClient,runGoogleTask} from '../../../runtime/agent-pair/managed-agents/google-client.mjs';
import {openPairBridge} from '../../../runtime/agent-pair/managed-agents/mcp-bridge.mjs';
import {safeData} from '../../../runtime/agent-pair/process.mjs';
const source=ROOT+'/workspaces/architect/blueprint-force-save',directory=ROOT+'/state/live-architect/tunnel-milestone';
const context=await runtimeContext(),project='satisfactory-ai-architect';
const sha=s=>createHash('sha256').update(s).digest('hex');
const batches=[{name:'geometry',files:['companion/lib/level-tunnel.mjs'],body:readFileSync(source+'/companion/lib/level-tunnel.mjs','utf8')},
 {name:'native-contract',files:['Source/AIFactoryCopilot/Private/AIFactoryActions.cpp','Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp','companion/lib/actions.mjs'],body:execFileSync('git',['diff','--unified=2','--','Source/AIFactoryCopilot/Private/AIFactoryActions.cpp','Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp','companion/lib/actions.mjs'],{cwd:source,windowsHide:true,encoding:'utf8'})}];
await Promise.allSettled(batches.map(async batch=>{
 const path=directory+'/review-'+batch.name+'.json';if(existsSync(path))throw Error('Existing review cannot be replayed');
 const receipt={schema:'copilot.tunnel-source-review/v1',startedAt:new Date().toISOString(),policy:{maxRequests:2,maxToolCalls:1,maxOutputTokens:3072,noFallback:true,noReplay:true,gameWrites:0,ghidraAllowed:false},files:batch.files.map(file=>({file,sha256:sha(readFileSync(source+'/'+file))})),calls:[]};
 const save=()=>writeFileSync(path,JSON.stringify(safeData(receipt),null,2));save();
 const bridge=await openPairBridge({database:context.database,instance:'google-tunnel-review-'+batch.name+'-20261018',provider:'google',project,recipient:'codex-14540',role:'reviewer',capabilities:['exact-source-review']});
 try{
  const prompt=`Independent exact-source review of the owner-authorized tunnel change. You did not implement this source. User wants wall/foundation profiles to turn horizontally without falling downward. Review only code correctness, not generic advice. v6 foundation-only full quaternion generation preserves existing v1-v5; game stages/saves/reloads and matches actual transforms. No Ghidra, game writes, credentials, shell or other tools. Inspect the exact source/diff below for concrete important bugs, especially sign/heading conventions, malformed input handling, repeated-profile ambiguity, quaternion scale checks and unintended old-contract regression. Rigid panel joints intentionally overlap and need actual visual review; no no-clipping claim. 1329 tests pass, Shipping CL513885 compiled. Do not claim independent test execution. Return JSON {verdict:'approve|request_changes|uncertain',findings:[{severity:'important|minor',location,trigger,problem,fix}],limitations:[...]}. Deliver that JSON through exactly ONE pair_send_message(project='${project}',to='codex-14540',channel='review',subject='Tunnel ${batch.name} exact-source review',body=<JSON>). Then finish. Max2requests1tool3072tokens. No invented failure without a concrete trigger.\nSOURCE:\n${batch.body}`;
  if(prompt.length>12000)throw Error('Review prompt bound exceeded');
  const client=new GoogleClient(process.env.GEMINI_API_KEY),request=client.request.bind(client);
  client.request=(p,b,s)=>request(p,{...b,generationConfig:{...b.generationConfig,thinkingConfig:{thinkingLevel:'minimal'}}},s);
  receipt.result=await runGoogleTask({client,model:'gemini-3.5-flash',prompt,tools:bridge.tools.filter(t=>t.name==='pair_send_message'),maxRequests:2,maxToolCalls:1,maxOutputTokens:3072,
   dispatch:async(name,args)=>{receipt.calls.push({name,args});save();const result=await bridge.dispatch(name,args);receipt.calls.at(-1).completed=true;receipt.calls.at(-1).result=result;save();return result;},onState:s=>{receipt.result=s;save();}});
 }catch(error){receipt.error=error.message;}finally{await bridge.close();receipt.finishedAt=new Date().toISOString();save();}
 console.log(JSON.stringify({review:batch.name,status:receipt.result?.status,error:receipt.error,handoff:receipt.calls.find(c=>c.completed)?.args.body}));
}));
