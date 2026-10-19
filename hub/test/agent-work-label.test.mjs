import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceCountLabel } from '../lib/agent-work-label.mjs';

test('evidenceCountLabel: basic cases', () => {
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: 2, verifiedArtifacts: 1 }), '2 tool calls · 1 verified file');
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: 1, verifiedArtifacts: 2 }), '1 tool call · 2 verified files');
  assert.strictEqual(evidenceCountLabel({}), 'Tool calls unknown · verified files unknown');
});

test('evidenceCountLabel: edge cases', () => {
  // negative counts stay unknown
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: -1, verifiedArtifacts: 1 }), 'Tool calls unknown · 1 verified file');
  // numeric-string counts stay unknown
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: '2', verifiedArtifacts: 1 }), 'Tool calls unknown · 1 verified file');
  // NaN counts stay unknown
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: NaN, verifiedArtifacts: 1 }), 'Tool calls unknown · 1 verified file');
  // zero is valid
  assert.strictEqual(evidenceCountLabel({ toolCallsCompleted: 0, verifiedArtifacts: 0 }), '0 tool calls · 0 verified files');
});
test('evidenceCountLabel: absent input and invalid artifact counts stay unknown',()=>{
  assert.equal(evidenceCountLabel(),'Tool calls unknown · verified files unknown');
  for(const value of ['2',true,Infinity,1.5,-1,NaN,null])assert.equal(evidenceCountLabel({toolCallsCompleted:1,verifiedArtifacts:value}),'1 tool call · verified files unknown');
});
