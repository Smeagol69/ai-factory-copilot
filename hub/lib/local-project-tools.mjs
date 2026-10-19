import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,renameSync,existsSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const hash=data=>createHash('sha256').update(data).digest('hex');
const exec=promisify(execFile);
export function createLocalProjectTools({root,conversationId,authorize}={}){
  root=realpathSync(root);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(conversationId))throw Error('Invalid local conversation');
  const source=path=>{
    if(typeof path!=='string'||path.length>300||/[\\:\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||
      !(/^(app|lib|test|docs|settings)\/[\w./-]+\.(mjs|js|css|html|md|json)$/.test(path)||['README.md','AGENTS.md','project.json','package.json'].includes(path)))throw Error('Choose a literal project source path');
    const file=resolve(root,path);let current=root;
    for(const part of path.split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('Linked source paths are unavailable');}
    if(!file.startsWith(root+sep))throw Error('Invalid source path');return file;
  };
  const receipt=(kind,value)=>{
    const dir=join(root,'state/local-worker/actions',conversationId);mkdirSync(dir,{recursive:true});
    const file=join(dir,`${Date.now()}-${randomUUID()}-${kind}.json`);writeFileSync(file,JSON.stringify({at:new Date().toISOString(),...value},null,2)+'\n',{flag:'wx'});return file;
  };
  return {
    async read({path,start=1,end=120}){
      const file=source(path);if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end-start>=160)throw Error('Read1..160 numbered lines at once');
      if(!existsSync(file))return {path,exists:false,sha256:null,text:null};
      const st=lstatSync(file);if(!st.isFile()||st.size>524288)throw Error('Source file exceeds read limit');
      const data=readFileSync(file),lines=data.toString('utf8').split(/\r?\n/),text=lines.slice(start-1,end).join('\n');
      return {path,exists:true,sha256:hash(data),start,end:Math.min(end,lines.length),totalLines:lines.length,text:text.slice(0,9000),excerptTruncated:text.length>9000};
    },
    async edit({path,expected_sha256,old_text,new_text,content}){
      const file=source(path);await authorize(path);
      const data=existsSync(file)?readFileSync(file):null,current=data?hash(data):null;
      if(current!==expected_sha256)throw Error('Source changed since the supplied read hash; read again before editing');
      let next;
      if(current===null){if(typeof content!=='string'||content.length>18000||old_text!==undefined||new_text!==undefined)throw Error('New files require bounded content and a null hash');next=content;}
      else{
        if(typeof old_text!=='string'||!old_text||typeof new_text!=='string'||new_text.length>18000||content!==undefined)throw Error('Existing files require one exact old_text/new_text replacement');
        const text=data.toString('utf8').replace(/\r\n/g,'\n'),needle=old_text.replace(/\r\n/g,'\n'),index=text.indexOf(needle);
        if(index<0||text.indexOf(needle,index+1)>=0)throw Error('Replacement must match exactly once');
        next=text.slice(0,index)+new_text+text.slice(index+needle.length);
      }
      if(Buffer.byteLength(next)>524288)throw Error('Edited source exceeds limit');
      const evidenceFile=receipt('file-edit',{path,beforeSha256:current,afterSha256:hash(next),original:data?.toString('utf8')??null});
      mkdirSync(dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
      writeFileSync(temporary,next,{flag:'wx'});
      if((existsSync(file)?hash(readFileSync(file)):null)!==current)throw Error('Source changed during the edit; staged change was not promoted');
      renameSync(temporary,file);
      return {effect:'file-written',written:true,path,sha256:hash(readFileSync(file)),evidenceFile,testsRun:false,gameWrites:0};
    },
    async check({check,path}){
      const groups={'local-chat':['test/local-chat.test.mjs','test/local-model-service.test.mjs','test/local-worker-mcp.test.mjs','test/local-project-tools.test.mjs'],
        're-workflow':['test/re-investigation.test.mjs','test/re-game-adapter.test.mjs','test/re-models.test.mjs','test/re-policy.test.mjs'],companion:['test/companion.test.mjs']};
      let args,paths;
      if(check==='syntax'){const file=source(path);if(!/\.(mjs|js)$/.test(file))throw Error('Syntax checks require JavaScript source');paths=[path];args=['--check',file];}
      else{paths=groups[check];if(!paths||path!==undefined)throw Error('Choose a declared project check');args=['--test',...paths];}
      const env={...process.env};for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(key))delete env[key];
      let output='',exitCode=0;
      try{const result=await exec(process.execPath,args,{cwd:root,env,windowsHide:true,timeout:180000,maxBuffer:2*1024*1024});output=result.stdout+result.stderr;}
      catch(error){exitCode=Number.isInteger(error.code)?error.code:-1;output=String(error.stdout??'')+String(error.stderr??'');}
      const sourceHashes=Object.fromEntries(paths.filter(p=>existsSync(source(p))).map(p=>[p,hash(readFileSync(source(p)))]));
      const evidenceFile=receipt('check',{check,args,exitCode,output,sourceHashes});
      return {ok:exitCode===0,effect:exitCode===0?'checks-passed':'checks-failed',check,exitCode,sourceHashes,evidenceFile,output:output.slice(-2500),gameWrites:0};
    },
  };
}
