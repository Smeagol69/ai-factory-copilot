import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT} from './project.mjs';
export function loadRePolicy(root=ROOT){
  const path=resolve(root,'settings/reverse-engineering.json'),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error('Invalid RE policy file');
  const p=JSON.parse(readFileSync(path,'utf8'));
  if(p.schema!=='copilot.re-policy/v1'||p.scope!=='all-projects-in-this-mcp-application'||p.purpose!=='reverse-engineering'||
    p.hostedModelsAllowed!==true||p.maxCostUsd!==null||typeof p.authorization!=='string'||!p.authorization.trim()||
    !Number.isInteger(p.phaseTimeoutMs)||p.phaseTimeoutMs<1000||p.phaseTimeoutMs>3600000||
    !Number.isInteger(p.maxParallelModels)||p.maxParallelModels<1||p.maxParallelModels>4||
    !Number.isInteger(p.maxToolCallsPerModelTurn)||p.maxToolCallsPerModelTurn<1||p.maxToolCallsPerModelTurn>64||
    p.maxUnchangedFailures!==2||p.gameRequestsPaidFallback!==false||p.automaticPromptPolling!==false)throw Error('Invalid RE-only usage policy');
  return Object.freeze(p);
}
export function assertRePurpose(purpose,policy){
  if(purpose!=='reverse-engineering'||policy.purpose!=='reverse-engineering'||policy.hostedModelsAllowed!==true)throw Error('Hosted usage is authorized only for reverse-engineering investigations');
}
