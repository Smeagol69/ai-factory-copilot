import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const manifest='state/team/integration/jobs.json';
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'copilot-work-proof-'));
  mkdirSync(join(root,'state/team/integration'),{recursive:true});mkdirSync(join(root,'lib'));
  writeFileSync(join(root,manifest),JSON.stringify(['state/team/integration/worker.json']));
  const save=value=>writeFileSync(join(root,'state/team/integration/worker.json'),JSON.stringify(value));
  return {root,save,close:()=>rmSync(root,{recursive:true,force:true})};
}
const now=Date.parse('2026-10-18T03:00:00Z');
test('work evidence requires actual current file bytes, not a completion claim',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');
  const f=fixture();try{
    const contents='export const complete=true;\n',sha=createHash('sha256').update(contents).digest('hex');
    const record={provider:'codex',taskId:'builder-1',task:'Useful implementation',status:'completed',updatedAt:new Date(now).toISOString(),toolCallsCompleted:3,artifacts:[{path:'lib/result.mjs',sha256:sha}],claim_token:'never-public',sessionId:'never-public'};
    f.save(record);
    let w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];
    assert.equal(w.verifiedArtifacts,0);assert.equal(w.outputVerified,false);
    writeFileSync(join(f.root,'lib/result.mjs'),contents);
    w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];
    assert.equal(w.verifiedArtifacts,1);assert.equal(w.outputVerified,true);
    assert.equal(w.artifacts[0].verified,true);
    assert(!JSON.stringify(w).includes('never-public'));
    writeFileSync(join(f.root,'lib/result.mjs'),'changed');
    w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];
    assert.equal(w.outputVerified,false);assert.equal(w.artifacts[0].reason,'hash-mismatch');
  }finally{f.close();}
});
test('queued and stale running reports never establish current inference',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    f.save({provider:'google',taskId:'queued',status:'queued',updatedAt:new Date(now).toISOString(),toolCallsCompleted:0});
    assert.equal(readAgentWorkEvidence(f.root,{manifest,now}).jobs[0].activity,'not-observed');
    f.save({provider:'google',taskId:'running',status:'running',updatedAt:new Date(now-180000).toISOString(),toolCallsCompleted:2});
    const w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.fresh,false);assert.equal(w.activity,'unknown');
    f.save({provider:'google',taskId:'future',status:'running',updatedAt:new Date(now+60000).toISOString()});
    assert.equal(readAgentWorkEvidence(f.root,{manifest,now}).jobs[0].fresh,false);
  }finally{f.close();}
});
test('failed and partial jobs retain their state even with a valid artifact',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    const bytes='partial';writeFileSync(join(f.root,'lib/partial.mjs'),bytes);
    for(const status of ['failed','partial']){
      f.save({provider:'anthropic',taskId:status,status,updatedAt:new Date(now).toISOString(),error:{code:'AUTH_EXPIRED',message:'OAuth login expired'},artifacts:[{path:'lib/partial.mjs',sha256:createHash('sha256').update(bytes).digest('hex')}]});
      const w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.status,status);assert.equal(w.outputVerified,true);assert.equal(w.error.code,'AUTH_EXPIRED');
    }
  }finally{f.close();}
});
test('unsafe paths and malformed reports stay unknown without reading outside the project',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    f.save({provider:'ollama',taskId:'local',status:'completed',toolCallsCompleted:-1,artifacts:[{path:'../outside.txt',sha256:'a'.repeat(64)}]});
    const w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.verifiedArtifacts,0);assert.equal(w.toolCallsCompleted,null);assert.equal(w.artifacts[0].reason,'unsafe-path');
    writeFileSync(join(f.root,manifest),JSON.stringify(['../outside.json','state/team/integration/missing.json']));
    const s=readAgentWorkEvidence(f.root,{manifest,now});assert.equal(s.jobs.length,0);assert.equal(s.unavailableReports,2);
    writeFileSync(join(f.root,manifest),'bad json');assert.equal(readAgentWorkEvidence(f.root,{manifest,now}).available,false);
  }finally{f.close();}
});
test('malformed hashes and artifact lists beyond the verification cap cannot claim verified completion',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    const bytes='verified';writeFileSync(join(f.root,'lib/result.mjs'),bytes);
    const sha=createHash('sha256').update(bytes).digest('hex');
    f.save({provider:'codex',taskId:'malformed',status:'completed',artifacts:[{path:'lib/result.mjs',sha256:[sha]}]});
    let w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.outputVerified,false);assert.equal(w.artifacts[0].reason,'missing-hash');
    f.save({provider:'codex',taskId:'over-cap',status:'completed',artifacts:[...Array.from({length:8},()=>({path:'lib/result.mjs',sha256:sha})),{path:'lib/result.mjs',sha256:'a'.repeat(64)}]});
    w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.artifacts.length,8);assert.equal(w.omittedArtifacts,1);assert.equal(w.outputVerified,false);
  }finally{f.close();}
});
test('artifact verification uses the exact claimed path before display redaction',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    const bytes='valid',sha=createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(f.root,'lib/[redacted].mjs'),bytes);
    f.save({provider:'codex',taskId:'exact-path',status:'completed',artifacts:[{path:'lib/sk-proj-AAAAAAAAAAAA.mjs',sha256:sha}]});
    const w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.outputVerified,false);assert.equal(w.artifacts[0].reason,'unavailable-file');
  }finally{f.close();}
});
test('repeated claims for one file do not multiply the verified file count',async()=>{
  const {readAgentWorkEvidence}=await import('../lib/agent-work-evidence.mjs');const f=fixture();try{
    const bytes='valid',sha=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(f.root,'lib/result.mjs'),bytes);
    f.save({provider:'codex',taskId:'duplicates',status:'completed',artifacts:[{path:'lib/result.mjs',sha256:sha},{path:'lib/result.mjs',sha256:sha}]});
    const w=readAgentWorkEvidence(f.root,{manifest,now}).jobs[0];assert.equal(w.verifiedArtifacts,1);assert.equal(w.outputVerified,true);
  }finally{f.close();}
});
