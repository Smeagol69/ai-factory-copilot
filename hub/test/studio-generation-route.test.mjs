import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioGenerationRoute } from '../lib/studio-generation-route.mjs';

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'studio-route-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const proposal={action:'generate_native_blueprint',blueprint_name:'Native Bay',layout_schema:'aifactory.generated-blueprint/v6',commit:true,
    buildables:[{part_id:'floor',role:'floor',recipe_class:'Recipe_Foundation',relative_location:{x:0,y:0,z:0},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}]};
  const bytes=Buffer.from(JSON.stringify(proposal,null,2)+'\n'),proposalHash='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const proposalFile=join(home,'proposal.json');writeFileSync(proposalFile,bytes);
  const directory=join(home,'spool'),readHealth=async()=>({schema:'aifactory.bridge.health',local_command_capabilities:['studio_native_generation_v1']});
  return {proposal,proposalHash,proposalFile,bytes,directory,route:createStudioGenerationRoute({directory,readHealth})};
}
const request={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operation:'askall',map:'Persistent_Level',session:'test',worldInstance:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',player:'player'};
function nativeResult() {
  return {pipelineCompleted:true,actionsAccepted:true,committedActions:1,receipt:{schema:'aifactory.playtest-result/v1',id:request.id,operation:'askall',map:request.map,session:request.session,world_instance:request.worldInstance,player:request.player,
    accepted:true,state:'completed',terminal:true,game_actions_refused:false,game_actions_requested_count:1,game_actions_executed_count:1,
    game_action_results:[{action:'generate_native_blueprint',source:'executed_by_the_game_and_read_back',status:'committed',accepted:true,committed:true,dry_run:false,
      predicted:{blueprint_name:'Native Bay',layout_schema:'aifactory.generated-blueprint/v6',resolved_buildables:1,configured_manufacturers:0,requested_conveyors:0,requested_power_wires:0,requested_pipelines:0,requested_resource_anchors:0,requested_miners:0},
      observed:{designer_left_empty:true,staged_buildables:1,staged_conveyors:0,staged_power_wires:0,staged_pipelines:0,staged_resource_anchors:0,staged_miners:0,
        exact_native_geometry_readback:true,native_readback_descriptor_resolved:true,expected_saved_part_transforms:1,exact_saved_part_transforms:1,native_loaded_buildables:1,native_loaded_configured_manufacturers:0,
        native_loaded_conveyors:0,native_loaded_power_wires:0,native_loaded_pipelines:0,native_loaded_resource_anchors:0,native_loaded_supported_vanilla_miners:0,
        blueprint_readable_from_disc:true,exact_native_topology_readback:true}}]}};
}
const context=f=>({proposalHash:f.proposalHash,request});

test('adapter stages exact reviewed bytes and returns only the fixed hash command',async t=>{
  const f=fixture(t),question=await f.route.question(f);
  assert.equal(question,`aifactory studio generate ${f.proposalHash}`);
  assert.deepEqual(readFileSync(join(f.directory,f.proposalHash.slice(7)+'.json')),f.bytes);
  assert.equal(question.includes(f.proposalFile),false);
  assert.equal((await f.route.verify(nativeResult(),f.proposal,context(f))).savedReadback,true);
});

test('missing companion capability and changed proposal bytes fail before a command is returned',async t=>{
  const f=fixture(t),unsupported=createStudioGenerationRoute({directory:f.directory,readHealth:async()=>({local_command_capabilities:[]})});
  await assert.rejects(unsupported.question(f),/capability|support/i);
  writeFileSync(f.proposalFile,JSON.stringify({...f.proposal,blueprint_name:'Changed'}));
  await assert.rejects(f.route.question(f),/hash/i);
});

test('an existing altered spool entry is refused rather than overwritten',async t=>{
  const f=fixture(t);mkdirSync(f.directory);const file=join(f.directory,f.proposalHash.slice(7)+'.json');writeFileSync(file,'changed');
  await assert.rejects(f.route.question(f),/hash|staged/i);
  assert.equal(readFileSync(file,'utf8'),'changed');
});

test('a capability string or an unrelated service response cannot enable submission',async t=>{
  const f=fixture(t);
  for(const health of [{schema:'other',local_command_capabilities:['studio_native_generation_v1']},
    {schema:'aifactory.bridge.health',local_command_capabilities:'studio_native_generation_v1'}]) {
    const route=createStudioGenerationRoute({directory:f.directory,readHealth:async()=>health});
    await assert.rejects(route.question(f),/capability|support/i);
  }
});

test('verification requires the prepared proposal and exact request identity',async t=>{
  const f=fixture(t);
  assert.equal((await f.route.verify(nativeResult(),f.proposal,context(f))).matchesProposal,false);
  await f.route.question(f);
  const r=nativeResult();r.receipt.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.equal((await f.route.verify(r,f.proposal,context(f))).matchesProposal,false);
  assert.equal((await f.route.verify(nativeResult(),{...f.proposal,blueprint_name:'Other'},context(f))).matchesProposal,false);
});

test('native verification accepts the actual validated name when proposal whitespace was normalized',async t=>{
  const f=fixture(t);f.proposal.blueprint_name='Native  Bay';
  f.bytes=Buffer.from(JSON.stringify(f.proposal));f.proposalHash='sha256:'+createHash('sha256').update(f.bytes).digest('hex');writeFileSync(f.proposalFile,f.bytes);
  await f.route.question(f);
  assert.equal((await f.route.verify(nativeResult(),f.proposal,context(f))).matchesProposal,true);
});

test('refusal, unrelated actions, wrong name/count and partial native readback cannot become build success',async t=>{
  const f=fixture(t);await f.route.question(f);
  const changes=[
    r=>r.pipelineCompleted=false,
    r=>r.receipt.game_actions_refused=true,
    r=>r.receipt.game_action_results[0].action='teleport_player',
    r=>r.receipt.game_action_results[0].predicted.blueprint_name='Other',
    r=>r.receipt.game_action_results[0].predicted.resolved_buildables=2,
    r=>r.receipt.game_action_results[0].observed.exact_native_geometry_readback=false,
    r=>r.receipt.game_action_results[0].observed.exact_saved_part_transforms=0,
    r=>r.receipt.game_action_results[0].observed.native_loaded_conveyors=1,
    r=>r.receipt.game_action_results[0].committed=false,
    r=>r.receipt.game_action_results.push({...r.receipt.game_action_results[0],action:'teleport_player'}),
    r=>{delete r.receipt.game_action_results;r.receipt.game_action_results_omitted_due_to_size=true;},
  ];
  for(const change of changes) {
    const r=nativeResult();change(r);
    const verdict=await f.route.verify(r,f.proposal,context(f));
    assert.equal(verdict.matchesProposal,false,change.toString());assert.equal(verdict.savedReadback,false);
  }
});
