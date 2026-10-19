import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';
import {verifyStarterSync} from '../../../workspaces/architect/blueprint-force-save/scripts/verify-starter-sync.mjs';
const root=resolve('.'),source=join(root,'workspaces/architect/blueprint-force-save'),sdk=join(root,'tools/satisfactory-sdk-513885/Mods/AIFactoryCopilot'),dir=join(root,'state/live-architect/tunnel-milestone'),out=join(dir,'click-deployment.json');
if(existsSync(out))throw Error('Do not replay deployment');
const run=(exe,args,cwd=root)=>execFileSync(exe,args,{cwd,windowsHide:true,encoding:'utf8'}).trim(),git=(args,cwd=source)=>run('git',args,cwd),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),check=(v,m)=>{if(!v)throw Error(m);};
const noGame=()=>check(!run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-Process FactoryGame* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id']),'Game running');
git(['fetch','origin','master']);check(!git(['status','--porcelain']),'Dirty source');git(['merge-base','--is-ancestor','origin/master','HEAD']);
const commit=git(['rev-parse','HEAD']);check(commit.startsWith('c0f9b7b'),'Unreviewed source');
const peers=['%USERPROFILE%/Documents/satisfactory-claude',join(root,'workspaces/architect/claude-reference-traits'),join(root,'workspaces/architect/integration')];
const peerState=peers.map(path=>{check(!git(['status','--porcelain'],path),'Peer dirty');return {path,head:git(['rev-parse','HEAD'],path)};});
const review=JSON.parse(readFileSync(join(dir,'local-click-review-followup.json')));check(review.result?.status==='completed'&&review.result.messages.some(m=>m.name==='project_handoff'&&JSON.parse(m.content).recorded===true)&&review.result.messages.some(m=>m.role==='assistant'&&m.content.includes('approve')),'No completed local review');
check(hash(join(source,review.source))===review.sha256,'Reviewed source changed');
check(/ℹ pass 1333[\s\S]*ℹ fail 0/.test(readFileSync(join(dir,'companion-click-suite.log'),'utf8')),'Missing full suite');
check(JSON.parse(readFileSync(join(root,'state/local-game-re/native-build/Shipping.json'))).exitCode===0,'Native build failed');verifyStarterSync(source,sdk);
const dll='Binaries/Win64/FactoryGameSteam-AIFactoryCopilot-Win64-Shipping.dll',installed='D:/SteamLibrary/steamapps/common/Satisfactory/FactoryGame/Mods/AIFactoryCopilot',config='D:/SteamLibrary/steamapps/common/Satisfactory/FactoryGame/Configs/AIFactoryCopilot.cfg';
check(hash(join(installed,dll))==='9c70d1f64343a9335c750fae65883bcb812d6bb570e0078952982150521204cd','Installed DLL changed');
check(hash(join(sdk,dll))==='6bc34c6beaafa05ca19b00e6d0d4afef072d74e25a09f531c2da103d14a53c54','Built DLL changed');
noGame();mkdirSync(join(dir,'click-backup'),{recursive:true});copyFileSync(join(installed,dll),join(dir,'click-backup/previous.dll'));
const r={startedAt:new Date().toISOString(),commit,deploymentOwner:'codex-14540',peerState,newDll:hash(join(sdk,dll)),configSha256:hash(config),deployed:false,fullUatCookRelease:false,scheduledTasks:0,modelCalls:0};
try{noGame();check(!git(['status','--porcelain']),'Source changed');for(const p of peerState)check(!git(['status','--porcelain'],p.path)&&git(['rev-parse','HEAD'],p.path)===p.head,'Peer changed before copy');verifyStarterSync(source,sdk);copyFileSync(join(sdk,dll),join(installed,dll));check(hash(join(installed,dll))===r.newDll&&hash(config)===r.configSha256,'Installed hash mismatch');r.deployed=true;}
catch(error){copyFileSync(join(dir,'click-backup/previous.dll'),join(installed,dll));r.error=error.message;r.rolledBack=true;}
finally{r.finishedAt=new Date().toISOString();writeFileSync(out,JSON.stringify(r,null,2));}console.log(JSON.stringify(r));if(!r.deployed)process.exitCode=1;
