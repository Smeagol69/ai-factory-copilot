import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {installReaQuietProcessPolicy,runReaNativeCheck} from '../lib/rea.mjs';

test('REA denies Ghidra before starting a child across launch APIs and promisify', {skip:process.platform!=='win32'},async()=>{
 const names=['spawn','spawnSync','execFile','execFileSync','exec','execSync'];
 const originals=Object.fromEntries(names.map(n=>[n,childProcess[n]]));let calls=0;
 try{
  for(const name of names){const fake=()=>{calls++;return {};};if(name==='execFile')fake[promisify.custom]=async()=>{calls++;return {stdout:'',stderr:''};};childProcess[name]=fake;}
  syncBuiltinESMExports();installReaQuietProcessPolicy();
  for(const name of names){const args=name.startsWith('exec')&&!name.startsWith('execFile')?['cmd /c C:\\tools\\ghidra\\support\\analyzeHeadless.bat project']:[String.raw`C:\tools\java\jdk-21\bin\java.exe`,['ghidra.Ghidra','ghidra.app.util.headless.AnalyzeHeadless']];
   assert.throws(()=>childProcess[name](...args),/Ghidra.*approval/i,name);
  }
  await assert.rejects(async()=>promisify(childProcess.execFile)(String.raw`C:\tools\java\bin\java.exe`,['ghidra.Ghidra']),/Ghidra.*approval/i);
  assert.equal(calls,0,'no OS launch may be reached');
 }finally{Object.assign(childProcess,originals);syncBuiltinESMExports();}
});

test('automatic native check returns approval-required without a child launch',async()=>{
 const names=['spawn','execFile'],originals=Object.fromEntries(names.map(n=>[n,childProcess[n]]));let calls=0;
 try{
  for(const name of names)childProcess[name]=()=>{calls++;throw Error('unexpected child launch');};syncBuiltinESMExports();
  const result=await runReaNativeCheck();
  assert.equal(result.ok,false);assert.equal(result.blocked,true);assert.equal(result.status,'user-approval-required');
  assert.equal(result.processesStarted,0);assert.equal(calls,0);
 }finally{Object.assign(childProcess,originals);syncBuiltinESMExports();}
});
