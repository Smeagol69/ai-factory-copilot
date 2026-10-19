import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
const root=resolve('.'),output=join(root,'state/local-game-re/native-build');mkdirSync(output,{recursive:true});
const vc='D:/Modding/Satisfactory/VisualStudio2022/VC/Tools/MSVC/14.38.33130';
const kits='C:/Program Files (x86)/Windows Kits/10',version='10.0.26100.0';
const env={...process.env,INCLUDE:[vc+'/include',`${kits}/Include/${version}/ucrt`,`${kits}/Include/${version}/shared`,`${kits}/Include/${version}/um`].join(';'),LIB:[vc+'/lib/x64',`${kits}/Lib/${version}/ucrt/x64`,`${kits}/Lib/${version}/um/x64`].join(';'),PATH:vc+'/bin/Hostx64/x64;'+process.env.PATH};
const built=spawnSync(vc+'/bin/Hostx64/x64/cl.exe',['/nologo','/EHsc','/std:c++20','/MD','/Fe:'+output+'/foundation-pose-policy.exe','/Fo:'+output+'/foundation-pose-policy.obj',join(root,'workspaces/architect/blueprint-force-save/scripts/test-foundation-pose-policy.cpp')],{env,windowsHide:true,encoding:'utf8'});
writeFileSync(join(output,'foundation-pose-compile.log'),built.stdout+built.stderr);
console.log(JSON.stringify({compileExit:built.status,output:(built.stdout+built.stderr).slice(0,1500)}));
if(built.status!==0){process.exitCode=1;}else{const checked=spawnSync(join(output,'foundation-pose-policy.exe'),[],{windowsHide:true,encoding:'utf8'});console.log(JSON.stringify({testExit:checked.status,output:checked.stdout+checked.stderr}));writeFileSync(join(output,'foundation-pose-tests.json'),JSON.stringify({exitCode:checked.status,stdout:checked.stdout,at:new Date().toISOString()}));process.exitCode=checked.status??1;}

