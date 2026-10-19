import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalModelService } from '../lib/local-model-service.mjs';
import { LOCAL_MODEL } from '../lib/local-worker.mjs';

test('refresh reads only local status and never launches inference or subprocesses', async () => {
  const root = mkdtempSync(join(tmpdir(),'local-service-')); let inspected = 0, launched = 0;
  try {
    const service = createLocalModelService({root,inspect:async()=>{inspected++;},launch:async()=>{launched++;},fetchImpl:async()=>{throw Error('offline');}});
    const status = await service.status();
    assert.equal(status.installed,false); assert.equal(status.modelCalls,0);
    assert.equal(inspected,0); assert.equal(launched,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('an existing foreign Ollama listener is left alone', async () => {
  const root = mkdtempSync(join(tmpdir(),'local-service-')); let launched = 0;
  try {
    mkdirSync(join(root,'state/local-worker'),{recursive:true});
    writeFileSync(join(root,'state/local-worker/installed.json'),JSON.stringify({model:{name:LOCAL_MODEL,digest:'a'.repeat(64)}}));
    const service=createLocalModelService({root,inspect:async()=>({pid:4444,executable:'foreign.exe'}),launch:async()=>{launched++;},fetchImpl:async()=>Response.json({version:'0.40.5'})});
    await assert.rejects(service.ensure(),/ownership/i); assert.equal(launched,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('each explicit send rechecks listener ownership and rejects invalid saved timestamps',async()=>{
  const root=mkdtempSync(join(tmpdir(),'local-ownership-'));const state=join(root,'state/local-worker');
  mkdirSync(state,{recursive:true});const startedAt=new Date().toISOString(),exe=join(process.env.LOCALAPPDATA,'Programs/Ollama/ollama.exe');
  const receipt={schema:'copilot.local-ollama/v1',pid:1234,executable:exe,root,models:join(root,'models/ollama'),base:'http://127.0.0.1:11436',startedAt};
  writeFileSync(join(state,'installed.json'),JSON.stringify({model:{name:LOCAL_MODEL,digest:'a'.repeat(64)}}));
  writeFileSync(join(state,'server.json'),JSON.stringify(receipt));let foreign=false;
  const service=createLocalModelService({root,inspect:async()=>({pid:foreign?9999:1234,executable:exe,commandLine:'ollama.exe serve',createdAt:startedAt}),fetchImpl:async()=>Response.json({version:'0.40.5'})});
  try{
    await service.ensure();foreign=true;await assert.rejects(service.ensure(),/ownership/i);
    foreign=false;writeFileSync(join(state,'server.json'),JSON.stringify({...receipt,startedAt:'invalid'}));
    await assert.rejects(service.ensure(),/ownership/i);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('game model is derived without inference and retains an explicit larger context without changing the base',async()=>{
  const root=mkdtempSync(join(tmpdir(),'game-local-')),state=join(root,'state/local-worker');mkdirSync(state,{recursive:true});
  const startedAt=new Date().toISOString(),exe=join(process.env.LOCALAPPDATA,'Programs/Ollama/ollama.exe');
  writeFileSync(join(state,'installed.json'),JSON.stringify({model:{name:LOCAL_MODEL,digest:'a'.repeat(64)}}));
  writeFileSync(join(state,'server.json'),JSON.stringify({schema:'copilot.local-ollama/v1',pid:1234,executable:exe,root,models:join(root,'models/ollama'),base:'http://127.0.0.1:11436',startedAt}));
  const requests=[];let created=false;
  const service=createLocalModelService({root,inspect:async()=>({pid:1234,executable:exe,commandLine:'ollama.exe serve',createdAt:startedAt}),fetchImpl:async(url,options)=>{
    requests.push({url,body:options.body?JSON.parse(options.body):null});
    if(url.endsWith('/api/version'))return Response.json({version:'0.40.5'});
    if(url.endsWith('/api/show'))return Response.json(created?{parameters:'num_ctx 65536\nnum_predict 1024',modelfile:'FROM sha256-2ca636d9e81d3d23ca9b60c234fe185d30ec082eeba69ce770fdb0c76559a4f5'}:{error:'not found'},{status:created?200:404});
    if(url.endsWith('/api/create')){created=true;return Response.json({status:'success'});}
    if(url.endsWith('/api/tags'))return Response.json({models:[{name:'copilot-hauhau-game:latest',digest:'b'.repeat(64)}]});
    throw Error('Unexpected inference or network request');
  }});
  try{
    const result=await service.ensureGame();assert.equal(result.model,'copilot-hauhau-game:latest');assert.equal(result.numCtx,65536);
    const creation=requests.find(r=>r.url.endsWith('/api/create')).body;assert.equal(creation.from,LOCAL_MODEL);assert.equal(creation.parameters.num_ctx,65536);
    assert(!requests.some(r=>r.url.endsWith('/api/chat')||r.url.includes('completions')));
  }finally{rmSync(root,{recursive:true,force:true});}
});
