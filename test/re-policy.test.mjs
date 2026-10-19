import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRePolicy, assertRePurpose } from '../lib/re-policy.mjs';
test('unlimited hosted usage is restricted to explicitly authorized RE jobs and preserves finite work limits',()=>{
  const policy=loadRePolicy();assert.equal(policy.maxCostUsd,null);assert.equal(policy.hostedModelsAllowed,true);
  assert.equal(policy.gameRequestsPaidFallback,false);assert.equal(policy.automaticPromptPolling,false);
  assert(policy.phaseTimeoutMs>0);assertRePurpose('reverse-engineering',policy);
  assert.throws(()=>assertRePurpose('in-game',policy),/reverse-engineering/);
});
