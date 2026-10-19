import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalProjectTools} from '../lib/local-project-tools.mjs';
test('local peer edits an actual owned source using its read hash and retains a verifiable receipt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'local-edit-'));mkdirSync(join(root,'app'));writeFileSync(join(root,'app/example.js'),'export const value=1;\n');
  const tools=createLocalProjectTools({root,conversationId:'test',authorize:async p=>{assert.equal(p,'app/example.js');}});
  try{
    const before=await tools.read({path:'app/example.js'});assert.match(before.text,/value=1/);
    const changed=await tools.edit({path:'app/example.js',expected_sha256:before.sha256,old_text:'value=1',new_text:'value=2'});
    assert.equal(readFileSync(join(root,'app/example.js'),'utf8'),'export const value=2;\n');assert.equal(changed.effect,'file-written');assert.notEqual(changed.sha256,before.sha256);
    await assert.rejects(tools.edit({path:'app/example.js',expected_sha256:before.sha256,old_text:'value=2',new_text:'value=3'}),/changed/i);
    const checked=await tools.check({check:'syntax',path:'app/example.js'});assert.equal(checked.ok,true);assert.equal(checked.effect,'checks-passed');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('read paths cannot reach private state and absent write ownership cannot mutate source',async()=>{
  const root=mkdtempSync(join(tmpdir(),'local-edit-'));mkdirSync(join(root,'app'));writeFileSync(join(root,'app/example.js'),'old');
  const tools=createLocalProjectTools({root,conversationId:'test',authorize:async()=>{throw Error('No active delegated owner');}});
  try{
    for(const path of ['../private','.env','state/architect/claim.json','runtime/agent-pair/store.mjs'])await assert.rejects(tools.read({path}),/source path/i);
    const before=await tools.read({path:'app/example.js'});await assert.rejects(tools.edit({path:'app/example.js',expected_sha256:before.sha256,old_text:'old',new_text:'new'}),/owner/);
    assert.equal(readFileSync(join(root,'app/example.js'),'utf8'),'old');
  }finally{rmSync(root,{recursive:true,force:true});}
});
