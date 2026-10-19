import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../lib/app.mjs';
import { attachLocalChat } from '../lib/local-chat-http.mjs';

test('direct model chat shares the app origin, validates input and does not infer on refresh', async()=>{
  const root=mkdtempSync(join(tmpdir(),'chat-http-'));let sends=0;
  const server=await createAppServer({root,project:'test',port:0,readStatus:async()=>({}),runCheck:async()=>({ok:true})});
  attachLocalChat(server,{status:async()=>({installed:true,status:'ready'}),list:()=>({conversations:[]}),get:()=>null,
    send:async args=>{sends++;assert.deepEqual(args,{message:'hello'});return {id:'saved',messages:[{role:'assistant',content:'hi'}]};},cancel:()=>({cancelled:false})});
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const html=await(await fetch(url)).text();assert.match(html,/local-chat.js/);
    assert.equal((await fetch(url+'/local-chat.js')).status,200);
    assert.equal((await fetch(url+'/api/local-chat/status')).status,200);assert.equal(sends,0);
    assert.equal((await fetch(url+'/api/local-chat/send',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/api/local-chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'hello',command:'bad'})})).status,400);
    assert.equal((await fetch(url+'/api/local-chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'x'.repeat(7000)})})).status,413);
    assert.equal((await fetch(url+'/api/local-chat/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'hello'})})).status,200);
    assert.equal(sends,1);assert.equal((await fetch(url+'/api/identity')).status,200);
  }finally{await new Promise(ok=>server.close(ok));rmSync(root,{recursive:true,force:true});}
});

test('RE starts only from explicit same-origin fixed-target POST and preserves existing chat/check routes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'re-http-'));let starts=0,cancels=0;
  const server=await createAppServer({root,project:'test',port:0,readStatus:async()=>({}),runCheck:async()=>({ok:true})});
  const id='11111111-1111-4111-8111-111111111111';
  attachLocalChat(server,{status:async()=>({installed:true}),list:()=>({conversations:[]})},{investigation:{
    status:()=>({id,status:'idle',busy:false}),start:args=>{assert.deepEqual(args,{targetId:'satisfactory'});starts++;return {id,status:'running',busy:true};},cancel:value=>{assert.equal(value,id);cancels++;return {id,status:'cancelling'};},
  }});
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.match(await(await fetch(url)).text(),/re-investigation.js/);
    assert.equal((await fetch(url+'/api/re-investigation/status')).status,200);assert.equal(starts,0);
    const post=(path,args,origin)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}: {})},body:JSON.stringify(args)});
    assert.equal((await post('/api/re-investigation/start',{targetId:'satisfactory'},'https://example.com')).status,403);
    assert.equal((await post('/api/re-investigation/start',{targetId:'satisfactory',command:'bad'})).status,400);
    assert.equal((await post('/api/re-investigation/start',{targetId:'other'})).status,400);
    assert.equal((await post('/api/re-investigation/start',{targetId:'satisfactory'})).status,200);assert.equal(starts,1);
    assert.equal((await post('/api/re-investigation/cancel',{id})).status,200);assert.equal(cancels,1);
  }finally{await new Promise(ok=>server.close(ok));rmSync(root,{recursive:true,force:true});}
});
