import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LOCAL_BASE, LOCAL_MODEL } from './local-worker.mjs';
export const GAME_LOCAL_MODEL='copilot-hauhau-game:latest';
const GAME_WEIGHT='2ca636d9e81d3d23ca9b60c234fe185d30ec082eeba69ce770fdb0c76559a4f5';

const read = path => { try { const stat=lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size>65536) return null; return JSON.parse(readFileSync(path,'utf8')); } catch { return null; } };
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
async function inspectListener({signal}={}) {
  const ps = join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = "$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction SilentlyContinue); if($rows.Count -eq 0){ 'null'; exit }; $ids=@($rows.OwningProcess | Sort-Object -Unique); if($ids.Count -ne 1){ throw 'Ambiguous local listener' }; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]); @{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress";
  const {stdout}=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:8192,signal,
    env:{...process.env,PSModulePath:join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}

export function createLocalModelService({root,fetchImpl=globalThis.fetch,inspect=inspectListener,launch}={}) {
  root=resolve(root); const state=join(root,'state/local-worker'), models=join(root,'models/ollama');
  const executable=join(process.env.LOCALAPPDATA??'','Programs/Ollama/ollama.exe');
  let verified=false, pending=null;
  const api=async (path,options={})=>{
    const r=await fetchImpl(LOCAL_BASE+path,{redirect:'error',signal:AbortSignal.timeout(10000),...options});
    if(!r.ok)throw Object.assign(Error('Local runtime unavailable'),{status:r.status});
    let bytes=0;const chunks=[];for await(const c of r.body??[]){bytes+=c.length;if(bytes>65536)throw Error('Oversized local status');chunks.push(c);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const ownership = async (receipt,signal) => {
    const p=await inspect({signal});
    if(!p || !receipt || receipt.schema!=='copilot.local-ollama/v1' || !same(receipt.root,root) || !same(receipt.models,models) ||
      receipt.base!==LOCAL_BASE || p.pid!==receipt.pid || !same(p.executable,executable) || !same(receipt.executable,executable) ||
      !/(?:^|\s)serve(?:\s|$)/i.test(p.commandLine??'') ||
      !Number.isFinite(Date.parse(p.createdAt)) || !Number.isFinite(Date.parse(receipt.startedAt)) || Math.abs(Date.parse(p.createdAt)-Date.parse(receipt.startedAt))>15000)
      throw Error('Local runtime ownership could not be verified; existing listener left alone');
    return p;
  };
  const start=async(signal)=>{
    signal?.throwIfAborted();
    const installed=read(join(state,'installed.json'));
    if(installed?.model?.name!==LOCAL_MODEL || !/^[a-f0-9]{64}$/.test(installed.model.digest??'')) throw Error('Local model is not installed; see its download status');
    let version;try{version=await api('/api/version');}catch{}
    if(version){await ownership(read(join(state,'server.json')),signal);verified=true;return;}
    if(await inspect({signal}))throw Error('Local runtime ownership unknown on port11436; listener left alone');
    signal?.throwIfAborted();
    mkdirSync(state,{recursive:true});mkdirSync(models,{recursive:true});
    let child;
    if(launch)child=await launch();
    else{
      const stdout=openSync(join(state,'server.stdout.log'),'a'),stderr=openSync(join(state,'server.stderr.log'),'a');
      const env={...process.env,OLLAMA_HOST:'127.0.0.1:11436',OLLAMA_MODELS:models,OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_CONTEXT_LENGTH:'8192',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_GPU_OVERHEAD:'2147483648'};
      for(const name of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIAL)/i.test(name))delete env[name];
      try{child=spawn(executable,['serve'],{cwd:root,env,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
        await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});child.unref();}
      finally{closeSync(stdout);closeSync(stderr);}
    }
    const receipt={schema:'copilot.local-ollama/v1',pid:child.pid,executable,root,base:LOCAL_BASE,models,startedAt:new Date().toISOString(),cloudDisabled:true};
    writeFileSync(join(state,'server.json'),JSON.stringify(receipt,null,2)+'\n');
    const startupDeadline=Date.now()+15000;
    while(Date.now()<startupDeadline){
      signal?.throwIfAborted();
      try{await api('/api/version');await ownership(receipt,signal);verified=true;return;}catch{}
      if(child.exitCode!=null)break;
      await new Promise(ok=>setTimeout(ok,100));
    }
    throw Error('Hidden Ollama startup did not become ready; see state/local-worker/server.stderr.log');
  };
  return {
    async ensure({signal}={}){
      signal?.throwIfAborted();
      if(verified){try{await ownership(read(join(state,'server.json')),signal);await api('/api/version');return;}catch(error){verified=false;throw error;}}
      if(!pending)pending=start(signal).finally(()=>{pending=null;});return pending;
    },
    async ensureGame({signal}={}){
      await this.ensure({signal});signal?.throwIfAborted();
      const post=(path,value)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),...(signal?{signal}: {})});
      let show;
      try{show=await post('/api/show',{model:GAME_LOCAL_MODEL});}catch(error){if(error.status!==404)throw error;}
      if(show&&!String(show.modelfile??'').includes(GAME_WEIGHT))throw Error('Existing game-model alias has different weights; left unchanged');
      if(!show||!/(?:^|\n)num_ctx\s+65536(?:\s|$)/.test(show.parameters??'')||!/(?:^|\n)num_predict\s+1024(?:\s|$)/.test(show.parameters??'')){
        const created=await post('/api/create',{model:GAME_LOCAL_MODEL,from:LOCAL_MODEL,stream:false,parameters:{num_ctx:65536,num_predict:1024,temperature:0.2}});
        if(created.status!=='success')throw Error('Game-model profile creation did not complete');
        show=await post('/api/show',{model:GAME_LOCAL_MODEL});
      }
      if(!String(show.modelfile??'').includes(GAME_WEIGHT)||!/(?:^|\n)num_ctx\s+65536(?:\s|$)/.test(show.parameters??''))throw Error('Game-model profile verification failed');
      const tags=await api('/api/tags'),model=tags.models?.find(m=>m.name===GAME_LOCAL_MODEL);
      if(!model)throw Error('Game-model profile is absent from Ollama inventory');
      const receipt={schema:'copilot.game-local-model/v1',model:GAME_LOCAL_MODEL,baseModel:LOCAL_MODEL,baseWeightSha256:GAME_WEIGHT,numCtx:65536,maxOutputTokens:1024,digest:model.digest,createdAt:new Date().toISOString(),inferenceCalls:0};
      writeFileSync(join(state,'game-model.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
    },
    async status(){
      const installed=read(join(state,'installed.json')),progress=read(join(state,'pull-progress.json'));
      const base={model:LOCAL_MODEL,displayName:'HauhauCS · Qwen3.5 9B',installed:installed?.model?.name===LOCAL_MODEL,
        status:'offline',owned:verified,modelCalls:0,cloudFallback:false,progress:progress?.status??null,download:progress?.total?{completed:progress.completed??0,total:progress.total}:null};
      try{const [v,t,p]=await Promise.all([api('/api/version'),api('/api/tags'),api('/api/ps')]);
        const model=t.models?.find(x=>x.name===LOCAL_MODEL),loaded=p.models?.find(x=>x.name===LOCAL_MODEL);
        return {...base,installed:!!model,status:verified&&model?'ready':model?'ownership-unverified':'installing',version:v.version,
          digest:model?.digest,loaded:!!loaded,gpuBytes:loaded?.size_vram??null};
      }catch{return base;}
    },
  };
}
