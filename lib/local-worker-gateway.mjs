import { resolve } from 'node:path';
import { ensureApp as startApp } from './start-app.mjs';
const BASE='http://127.0.0.1:8795';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createLocalModelGateway({root,fetchImpl=globalThis.fetch,identity,ensureApp}={}){
  const request=async(path,body)=>{
    const r=await fetchImpl(BASE+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(body?200000:3000),
      headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    let bytes=0;const chunks=[];for await(const c of r.body??[]){bytes+=c.length;if(bytes>262144)throw Error('Local MCP result too large');chunks.push(c);}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!r.ok)throw Error(value.error??`Local app HTTP ${r.status}; no automatic replay`);
    return value;
  };
  const check=identity??(async()=>{const i=await request('/api/identity');return i.application==='copilot-control-room/v1'&&resolve(i.root)===resolve(root)&&i.project==='satisfactory-mcp-lab';});
  const ensure=ensureApp??(()=>startApp({root,project:'satisfactory-mcp-lab',port:8795}));
  return {names:['local_model_status','local_model_chat','local_model_cancel'],async dispatch(name,args){
    if(!['local_model_status','local_model_chat','local_model_cancel'].includes(name))throw Error('Unknown local model MCP tool');
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid local model arguments');
    const keys=Object.keys(args),cancel=name==='local_model_cancel',chat=name==='local_model_chat';
    if(keys.some(k=>!(chat?['message','conversationId']:cancel?['conversationId']:[]).includes(k))||
      (args.conversationId!==undefined&&!UUID.test(args.conversationId))||(cancel&&!args.conversationId)||
      (chat&&(typeof args.message!=='string'||!args.message.trim()||args.message.length>6000)))throw Error('Invalid local model arguments');
    if(chat)await ensure();
    if(!await check())throw Error('Local Copilot application identity is unverified');
    return request('/api/local-chat/'+(chat?'send':cancel?'cancel':'status'),chat||cancel?args:undefined);
  }};
}
