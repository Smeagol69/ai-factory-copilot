import {readFileSync,lstatSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {evidenceCountLabel} from './agent-work-label.mjs';

const states=new Set(['queued','running','completed','partial','failed','unavailable','cancelled']);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const text=(value,max=160)=>typeof value==='string'?value.replace(/(?:sk-(?:ant-|proj-)?|AIza)[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,max):null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function file(root,path,limit){
  if(typeof path!=='string'||path.length>400||/[\\:\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('unsafe-path');
  const target=resolve(root,path);if(!target.startsWith(root+sep))throw Error('unsafe-path');
  let current=root;
  for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('unsafe-path');}
  const stat=lstatSync(target);if(!stat.isFile()||stat.size>limit)throw Error('unavailable-file');
  return readFileSync(target);
}
function artifact(root,value){
  const path=text(value?.path,400),sha256=typeof value?.sha256==='string'&&/^[a-f0-9]{64}$/i.test(value.sha256)?value.sha256.toLowerCase():null;
  if(!sha256)return {path,sha256,verified:false,reason:'missing-hash'};
  try{
    const bytes=file(root,value.path,2097152),actual=createHash('sha256').update(bytes).digest('hex');
    return {path,sha256,verified:actual===sha256,reason:actual===sha256?null:'hash-mismatch'};
  }catch(error){return {path,sha256,verified:false,reason:error.message==='unsafe-path'?'unsafe-path':'unavailable-file'};}
}

// Refresh reads bounded saved reports and hashes only. It never starts a model,
// process, game action or task. Counts from workers remain explicitly reported.
export function readAgentWorkEvidence(root,{manifest='state/team-work-20261017/integration/jobs.json',now=Date.now()}={}){
  root=resolve(root);
  const result={available:false,jobs:[],unavailableReports:0,observedAt:new Date(now).toISOString(),modelCalls:0,
    basis:'Saved worker reports and current artifact hashes. Tool/check counts are reported evidence, not proof of current inference.'};
  let paths;
  try{paths=JSON.parse(file(root,manifest,16384));if(!Array.isArray(paths)||paths.length>20)throw Error();}
  catch{return result;}
  result.available=true;
  for(const path of paths){
    let r;
    try{if(typeof path!=='string'||!path.startsWith('state/'))throw Error();r=JSON.parse(file(root,path,65536));
      if(!r||typeof r!=='object'||Array.isArray(r)||!['codex','google','claude','anthropic','ollama','local'].includes(r.provider)||typeof r.taskId!=='string')throw Error();}
    catch{result.unavailableReports++;continue;}
    const updatedAt=date(r.updatedAt),age=updatedAt?now-Date.parse(updatedAt):null,fresh=age!==null&&age>=0&&age<=120000;
    const status=states.has(r.status)?r.status:'unknown',claimed=Array.isArray(r.artifacts)?r.artifacts:[],artifacts=claimed.slice(0,8).map(a=>artifact(root,a));
    const omittedArtifacts=Math.max(0,claimed.length-artifacts.length);
    const verifiedArtifacts=new Set(artifacts.flatMap((a,index)=>a.verified?[claimed[index].path]:[])).size;
    result.jobs.push({provider:r.provider,model:text(r.model,200),taskId:text(r.taskId),task:text(r.task,300),status,
      startedAt:date(r.startedAt),updatedAt,finishedAt:date(r.finishedAt),fresh,
      activity:status==='running'?(fresh?'reported-running':'unknown'):'not-observed',
      toolCallsCompleted:count(r.toolCallsCompleted),artifacts,verifiedArtifacts,omittedArtifacts,
      evidenceLabel:evidenceCountLabel({toolCallsCompleted:count(r.toolCallsCompleted),verifiedArtifacts}),
      outputVerified:omittedArtifacts===0&&artifacts.length>0&&artifacts.every(a=>a.verified),
      tests:r.tests&&typeof r.tests==='object'?{passed:count(r.tests.passed),failed:count(r.tests.failed),command:text(r.tests.command,300),logFile:text(r.tests.logFile,400)}:null,
      error:r.error?{code:text(r.error.code,100),message:text(typeof r.error==='string'?r.error:r.error.message,400)}:null,
      reportPath:path});
  }
  return result;
}
