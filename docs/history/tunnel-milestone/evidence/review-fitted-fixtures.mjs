import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=process.cwd()+'/workspaces/architect/blueprint-force-save',dir='state/live-architect/tunnel-milestone/';
for(const [name,files,context] of [
 ['native',['Source/AIFactoryCopilot/Private/AIFactoryActions.cpp','Source/AIFactoryCopilot/Private/AIFactoryBlueprintExport.cpp','Source/AIFactoryCopilot/Public/AIFactoryFixturePosePolicy.h'],'v8 is opt-in, fixtures only, <=512, no topology/config. Exact classes checked natively. Structural beam contact allowed only after exact class-role validation; lamp collisions still refused. Existing v1-v7 must remain intact. Native exact saved class/XYZ/quaternion/scale readback is already unconditional for generated parts.'],
 ['bridge',['companion/lib/actions.mjs','companion/lib/tools.mjs'],'Existing generated action validator, opt-in v8 exact two fixture classes. Unit quaternion, uniform lamp shrink .05..1; beam local X .01..1 horizontal, Y/Z=1. <=512 and no topology/config. Preserve v1-v7. Native has independent validation.'],
 ['compiler',['companion/lib/tunnel-lighting.mjs','companion/lib/router.mjs'],'The v1 compiler works, but native clearance showed oversized lamp overlaps. Opt-in fitted v8 keeps existing shell, shared <=2 degree beam stations, chord lengths/native beam length400. Native beam +X is measured forward. Two lamp rows uniformly scale .3; measured foundation roof inner plane plus scaled original pivot offset preserves exposure. Native preflight/readback/render/power remain unverified. Existing compileLevelTunnel validates complete fingerprinted poses and finite radius/turn, returns measured reference frame; native collision checks remain. Review only changed routing hunk, not rest of router.']]){
 const out=dir+`local-fitted-${name}-review.json`;if(existsSync(out))throw Error('No inference replay');
 const evidence=files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(source+'/'+file)).digest('hex')}));
 let code=execFileSync('git',['diff','18e7022','--unified=2','--',...files],{cwd:source,windowsHide:true,encoding:'utf8'});
 if(name==='native')code+='\n'+readFileSync(source+'/'+files.at(-1),'utf8');
 const receipt={baseline:'18e7022',model:'copilot-hauhau-game:latest',files:evidence,status:'running',startedAt:new Date().toISOString()};writeFileSync(out,JSON.stringify(receipt,null,2));
 try{
  const response=await fetch('http://127.0.0.1:11436/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),body:JSON.stringify({model:receipt.model,stream:false,think:false,keep_alive:'60s',options:{num_ctx:8192,num_predict:600,temperature:.1},messages:[{role:'system',content:'Independent code review. No tools. Return valid JSON only, maximum150 words: {"verdict":"approve|request_changes|uncertain","findings":[],"limitations":[]}. Report concrete defects with consequences. Do not claim live verification. Do not repeat yourself.'},{role:'user',content:context+'\n'+code}]})});
  if(!response.ok)throw Error('HTTP '+response.status);receipt.result=await response.json();receipt.status='completed';
 }catch(e){receipt.status='failed';receipt.error=e.message;}
 receipt.finishedAt=new Date().toISOString();writeFileSync(out,JSON.stringify(receipt,null,2));console.log(JSON.stringify({name,status:receipt.status,answer:receipt.result?.message?.content,error:receipt.error}));
}
