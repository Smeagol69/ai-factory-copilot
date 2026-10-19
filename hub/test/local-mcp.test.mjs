import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalModelGateway } from '../lib/local-worker-gateway.mjs';

test('other models can explicitly prompt the same persistent local chat through MCP without selecting commands or providers',async()=>{
  let calls=0;
  const gateway=createLocalModelGateway({root:'C:/test',identity:async()=>true,ensureApp:async()=>{},fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'http://127.0.0.1:8795/api/local-chat/send');
    assert.deepEqual(JSON.parse(options.body),{message:'Explain the recorded constraints.'});
    return Response.json({id:'abc',status:'completed',messages:[{role:'assistant',content:'Constraints explained.'}]});
  }});
  assert.deepEqual(gateway.names,['local_model_status','local_model_chat','local_model_cancel']);
  const answer=await gateway.dispatch('local_model_chat',{message:'Explain the recorded constraints.'});
  assert.equal(answer.status,'completed');assert.equal(calls,1);
  await assert.rejects(gateway.dispatch('local_model_chat',{message:'hello',provider:'cloud'}),/Invalid/);
  await assert.rejects(gateway.dispatch('shell',{}),/Unknown/);assert.equal(calls,1);
});

test('gateway identity failure cannot call another service or replay an unknown chat outcome',async()=>{
  let calls=0;const gateway=createLocalModelGateway({root:'C:/test',identity:async()=>false,ensureApp:async()=>{},fetchImpl:async()=>{calls++;}});
  await assert.rejects(gateway.dispatch('local_model_chat',{message:'hello'}),/identity/i);assert.equal(calls,0);
});
