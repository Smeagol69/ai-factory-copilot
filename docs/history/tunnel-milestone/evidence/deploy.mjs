import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {companionStatus,stopCompanion,startCompanion} from '../../../lib/companion.mjs';
import {verifyStarterSync} from '../../../workspaces/architect/blueprint-force-save/scripts/verify-starter-sync.mjs';
const root=resolve('.'),source=join(root,'workspaces/architect/blueprint-force-save'),sdk=join(root,'tools/satisfactory-sdk-513885/Mods/AIFactoryCopilot'),runtime=join(root,'runtime/satisfactory-companion');
const dir=join(root,'state/live-architect/tunnel-milestone'),backup=join(dir,'deployment-backup'),receiptFile=join(dir,'deployment.json');
if(existsSync(receiptFile))throw Error('Do not replay a deployment');
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=p=>sha(readFileSync(p));
const run=(exe,args,cwd=root)=>execFileSync(exe,args,{cwd,windowsHide:true,encoding:'utf8'}).trim();
const git=(args,cwd=source)=>run('git',args,cwd);
const assert=(v,m)=>{if(!v)throw Error(m);};
const noGame=()=>assert(!run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-Process FactoryGame* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id']),'Game must be closed');
const clean=()=>assert(!git(['status','--porcelain']),'Source changed');
clean();git(['fetch','origin','master']);git(['merge-base','--is-ancestor','origin/master','HEAD']);
const commit=git(['rev-parse','HEAD']);assert(commit.startsWith('6a52be2'),'Unreviewed source commit');
const peers=['%USERPROFILE%/Documents/satisfactory-claude',join(root,'workspaces/architect/claude-reference-traits'),join(root,'workspaces/architect/integration')];
const peerState=peers.map(path=>{assert(!git(['status','--porcelain'],path),'Peer has unreviewed changes');return {path,head:git(['rev-parse','HEAD'],path)};});
git(['merge-base','--is-ancestor',peerState[0].head,'HEAD']);
const prior=JSON.parse(readFileSync(join(root,'state/local-game-re/runtime-repair-deployment.json')));
const prototype='%USERPROFILE%/Documents/satisfactory-codex-native-blueprints';
assert(git(['rev-parse','HEAD'],prototype)===prior.preservedHistoricalPrototype.head&&sha(git(['diff','--binary','HEAD'],prototype))===prior.preservedHistoricalPrototype.diffSha256,'Historical prototype changed since reviewed handoff');
const checkouts=[];
for(const old of prior.checkouts){
 if(old.name==='satisfactory-mcp-lab')continue;
 const path='%USERPROFILE%/Documents/'+old.name;
 const status=git(['status','--porcelain'],path),head=git(['rev-parse','HEAD'],path);
 assert(head===old.head&&status===old.status,'Historical checkout changed: '+old.name);checkouts.push({path,head,status});
}
const reviews=['review-native-contract.json','review-clarification.json'].map(name=>JSON.parse(readFileSync(join(dir,name))));
for(const review of reviews){
 assert(review.result?.status==='completed'&&review.calls.some(c=>c.completed&&JSON.parse(c.args.body).verdict==='approve'),'Missing exact-source approval');
 for(const file of review.files)assert(hash(join(source,file.file))===file.sha256,'Reviewed source bytes changed');
}
assert(/ℹ tests 1331[\s\S]*ℹ pass 1331[\s\S]*ℹ fail 0/.test(readFileSync(join(dir,'companion-suite.log'),'utf8')),'Full suite evidence missing');
verifyStarterSync(source,sdk);
const build=JSON.parse(readFileSync(join(root,'state/local-game-re/native-build/Shipping.json')));assert(build.exitCode===0,'Native build failed');
const dll='Binaries/Win64/FactoryGameSteam-AIFactoryCopilot-Win64-Shipping.dll',installed='D:/SteamLibrary/steamapps/common/Satisfactory/FactoryGame/Mods/AIFactoryCopilot';
const config='D:/SteamLibrary/steamapps/common/Satisfactory/FactoryGame/Configs/AIFactoryCopilot.cfg';
assert(hash(join(installed,dll))==='3149792c3e9a833952aeee5eb79151c15dcc07c66c58228b60e16b6b7161c707','Installed DLL changed');
assert(hash(join(sdk,dll))==='9c70d1f64343a9335c750fae65883bcb812d6bb570e0078952982150521204cd','Compiled DLL changed');
assert(JSON.parse(readFileSync('D:/SteamLibrary/steamapps/common/Satisfactory/Engine/Binaries/Win64/FactoryGameSteam-Win64-Shipping.version')).Changelist===513885,'Game updated');
const oldLockBytes=readFileSync(join(runtime,'install-lock.json')),oldLock=JSON.parse(oldLockBytes);
const within=(base,path)=>{const result=resolve(base,path);assert(result.startsWith(resolve(base)+'\\')&&!lstatSync(base).isSymbolicLink(),'Invalid owned runtime path');return result;};
for(const f of oldLock.files)assert(hash(within(runtime,f.path))===f.sha256,'Existing runtime manifest mismatch');
assert(hash(join(source,'companion/package-lock.json'))===hash(join(runtime,'package-lock.json')),'Dependencies changed');
const runtimePaths=git(['ls-files','--','companion/lib','companion/data','companion/server.mjs','companion/package.json','companion/package-lock.json','companion/.env.example']).split('\n');
const changes=[];
for(const path of runtimePaths){
 assert(/^companion\/(?:lib\/[^/]+\.mjs|data\/[^\x00-\x1f]+|server\.mjs|package(?:-lock)?\.json|\.env\.example)$/.test(path)&&!path.includes('..'),'Unexpected public runtime path');
 const rel=path.slice(10),bytes=readFileSync(join(source,path));
 if(oldLock.files.find(f=>f.path===rel)?.sha256!==sha(bytes))changes.push({path:rel,bytes,previous:existsSync(within(runtime,rel))?readFileSync(within(runtime,rel)):null});
}
const status=await companionStatus();assert(status.owned&&status.runtimeMatches,'Owned companion identity mismatch');
noGame();mkdirSync(backup,{recursive:true});copyFileSync(join(installed,dll),join(backup,'previous.dll'));writeFileSync(join(backup,'install-lock.json'),oldLockBytes);
for(const c of changes)if(c.previous){const file=join(backup,'companion',c.path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,c.previous);}
const receipt={startedAt:new Date().toISOString(),commit,master:git(['rev-parse','origin/master']),deploymentOwner:'codex-14540',peerState,checkouts,fullUatCookRelease:false,scheduledTasks:0,modelCalls:0,configSha256:hash(config),previousDll:hash(join(installed,dll)),newDll:hash(join(sdk,dll)),changes:changes.map(c=>c.path),deployed:false};
try{
 clean();noGame();verifyStarterSync(source,sdk);
 for(const p of peerState)assert(!git(['status','--porcelain'],p.path)&&git(['rev-parse','HEAD'],p.path)===p.head,'Peer changed immediately before copy');
 assert((await stopCompanion()).stopped,'Owned companion stop unconfirmed');
 copyFileSync(join(sdk,dll),join(installed,dll));
 for(const c of changes)writeFileSync(within(runtime,c.path),c.bytes);
 const files=new Map(oldLock.files.map(f=>[f.path,f]));for(const c of changes)files.set(c.path,{path:c.path,sha256:sha(c.bytes)});
 const lock={...oldLock,sourceCommit:commit,updatedFrom:'workspaces/architect/blueprint-force-save/companion',updatedAt:new Date().toISOString(),files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path))};lock.runtimeSha256=sha(JSON.stringify(lock.files));
 for(const f of lock.files)assert(hash(within(runtime,f.path))===f.sha256,'Updated runtime hash mismatch');
 writeFileSync(join(runtime,'install-lock.json'),JSON.stringify(lock,null,2)+'\n');
 const started=await startCompanion();assert(started.status.owned&&started.status.runtimeMatches&&started.status.policyMatches&&started.status.health.operationalReady,'Updated companion failed readiness');
 assert(hash(join(installed,dll))===receipt.newDll&&hash(config)===receipt.configSha256,'Installed bytes mismatch');
 receipt.deployed=true;receipt.companionPid=started.pid;receipt.runtimeSha256=lock.runtimeSha256;
}catch(error){
 receipt.error=error.message;await stopCompanion().catch(()=>{});copyFileSync(join(backup,'previous.dll'),join(installed,dll));
 for(const c of changes)if(c.previous)writeFileSync(within(runtime,c.path),c.previous);
 writeFileSync(join(runtime,'install-lock.json'),oldLockBytes);receipt.rollback=await startCompanion().then(()=>true,()=>false);
}finally{receipt.finishedAt=new Date().toISOString();writeFileSync(receiptFile,JSON.stringify(receipt,null,2));}
console.log(JSON.stringify({deployed:receipt.deployed,commit,companionPid:receipt.companionPid,error:receipt.error,changes:receipt.changes}));
if(!receipt.deployed)process.exitCode=1;
