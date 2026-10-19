import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaRunner } from '../lib/local-worker.mjs';

test('local inference uses fixed local model, bounded native MCP tools and exact tool results', async () => {
  const calls = [], events = [];
  let closed = false;
  const run = createOllamaRunner({ ensure: async () => {}, openMcp: async () => ({
    tools: [{type:'function',function:{name:'project_context',description:'Read project',parameters:{type:'object',properties:{},additionalProperties:false}}}],
    dispatch: async (name,args) => { assert.equal(name,'project_context'); assert.deepEqual(args,{}); return {value:42,unknowns:['world not loaded']}; },
    close: async () => { closed = true; },
  }), fetchImpl: async (url,options) => {
    assert.equal(url,'http://127.0.0.1:11436/api/chat');
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json(calls.length === 1 ? {message:{role:'assistant',content:'',tool_calls:[{function:{name:'project_context',arguments:{}}}]},done:true} :
      {message:{role:'assistant',content:'The recorded value is 42; the world is unknown.'},done:true,prompt_eval_count:9,eval_count:12});
  }});
  const answer = await run({messages:[{role:'user',content:'Read project context.'}],onTool:e=>events.push(e)});
  assert.equal(answer.content,'The recorded value is 42; the world is unknown.');
  assert.equal(closed,true); assert.equal(events.length,1);
  assert.equal(calls[0].stream,false); assert.equal(calls[0].think,false);
  assert.equal(calls[0].options.num_ctx,8192); assert.equal(calls[0].options.num_predict,1024);
  assert.match(calls[0].model,/HauhauCS/); assert.match(calls[1].messages.at(-1).content,/42/);
  assert.equal(answer.toolCalls,1);
});

test('unknown tools and excessive tool loops stop instead of calling an unrestricted dispatcher', async () => {
  let dispatched = 0, closed = 0;
  const run = createOllamaRunner({ensure:async()=>{},openMcp:async()=>({tools:[],dispatch:async()=>dispatched++,close:async()=>closed++}),
    fetchImpl:async()=>Response.json({done:true,message:{role:'assistant',content:'',tool_calls:[{function:{name:'shell',arguments:{command:'whoami'}}}]}})});
  await assert.rejects(run({messages:[{role:'user',content:'hello'}]}),/unavailable tool/i);
  assert.equal(dispatched,0); assert.equal(closed,1);
});

test('cancelled local work is never retried or sent to a cloud provider', async () => {
  let requests = 0; const controller = new AbortController(); controller.abort();
  const run = createOllamaRunner({ensure:async()=>{},openMcp:async()=>{throw Error('must not connect');},fetchImpl:async()=>{requests++;}});
  await assert.rejects(run({messages:[{role:'user',content:'hello'}],signal:controller.signal}),/abort/i);
  assert.equal(requests,0);
});

test('long supported chat retains original goal and latest turn while explicitly omitting older model context',async()=>{
  let body;const goal='original goal '.repeat(450),latest='Newest user request must remain';
  const messages=[{role:'system',content:goal},...Array.from({length:10},(_,i)=>({role:i%2?'assistant':'user',content:String(i)+'older detail '.repeat(150)})),{role:'user',content:latest}];
  const run=createOllamaRunner({ensure:async()=>{},openMcp:async()=>({tools:[],close:async()=>{}}),fetchImpl:async(url,options)=>{
    body=JSON.parse(options.body);return Response.json({done:true,message:{role:'assistant',content:'Answer'}});
  }});
  const result=await run({messages});
  assert(body.messages.some(m=>m.content.includes(goal)));assert.equal(body.messages.at(-1).content,latest);
  assert(body.messages.length<messages.length+1);assert.match(result.content,/earlier messages omitted/i);
});

test('chat system context is merged into one leading message for the actual Qwen template',async()=>{
  const run=createOllamaRunner({ensure:async()=>{},openMcp:async()=>({tools:[],close:async()=>{}}),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.messages.filter(m=>m.role==='system').length,1);
    assert.equal(body.messages[0].role,'system');assert.match(body.messages[0].content,/Original goal: make a useful local peer/);
    return Response.json({done:true,message:{role:'assistant',content:'Hello'}});
  }});
  assert.equal((await run({messages:[{role:'system',content:'Original goal: make a useful local peer'},{role:'user',content:'Hello'}]})).content,'Hello');
});

test('fabricated file completion is withheld when no actual file effect occurred',async()=>{
  const run=createOllamaRunner({ensure:async()=>{},openMcp:async()=>({tools:[],close:async()=>{}}),fetchImpl:async()=>Response.json({done:true,message:{role:'assistant',content:"I've added the button next to the native decompiler."}})});
  await assert.rejects(run({messages:[{role:'user',content:'Add the requested button.'}]}),/no file write receipt/i);
});

test('environment orientation is loaded automatically before the first model response',async()=>{
  let oriented=false;const events=[];
  const run=createOllamaRunner({ensure:async()=>{},openMcp:async()=>({tools:[],context:async()=>{oriented=true;return 'Copilot is Node.js and vanilla HTML, at localhost8795.';},close:async()=>{}}),fetchImpl:async(url,options)=>{
    assert(oriented);assert.match(JSON.parse(options.body).messages[0].content,/vanilla HTML/);
    return Response.json({done:true,message:{role:'assistant',content:'I can read the existing project source.'}});
  }});
  await run({messages:[{role:'user',content:'Help with this app.'}],onTool:e=>events.push(e)});assert.equal(events[0].name,'project_context');
});
