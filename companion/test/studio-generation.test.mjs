import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { answerLocally } from '../lib/router.mjs';
import { buildGraph } from '../lib/graph.mjs';
import { buildFactorySnapshot } from './fixtures/factory.mjs';

const foundation='/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
function graph() {
  const s=buildFactorySnapshot();
  s.content.items.push({class_path:'Desc_TestFoundation',available:true,building:{class_path:foundation}});
  s.content.recipes.push({class_path:'Recipe_TestFoundation',available:true,products:[{item_class:'Desc_TestFoundation',amount:1}],produced_in:['BP_BuildGun']});
  s.actors.push({actor_id:'MeasuredFoundation',class_path:foundation,kind:'buildable',location:{x:0,y:0,z:0},reflected_properties:[['mWidth',800],['mDepth',800],['mHeight',200]].map(([name,value])=>({name,value:String(value),declared_by:'/Script/FactoryGame.FGBuildableFoundation',source:'unreal_reflection',certainty:'authoritative'}))});
  return buildGraph(s);
}
const proposal=()=>({action:'generate_native_blueprint',blueprint_name:'AI Studio Test',layout_schema:'aifactory.generated-blueprint/v6',commit:true,
  buildables:[{part_id:'floor',role:'floor',recipe_class:'Recipe_TestFoundation',relative_location:{x:0,y:0,z:0},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}]});
function fixture(t, value=proposal()) {
  const directory=mkdtempSync(join(tmpdir(),'studio-proposal-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const bytes=JSON.stringify(value),hash=createHash('sha256').update(bytes).digest('hex');
  const file=join(directory,hash+'.json'); writeFileSync(file,bytes);
  const actions=[];
  return {file,hash,command:`aifactory studio generate sha256:${hash}`,actions,
    services:{studioGenerationDirectory:directory,listBlueprints:()=>[],actions:{emit:items=>actions.push(...items)}}};
}

test('fixed studio command emits only the exact hash-bound proposal through normal validation',t=>{
  const f=fixture(t),result=answerLocally(f.command,graph(),f.services);
  assert.equal(result?.provider,'solvers');
  assert.equal(result?.local.solver,'studio_native_generation');
  assert.equal(f.actions.length,1);
  assert.equal(f.actions[0].action,'generate_native_blueprint');
  assert.equal(f.actions[0].blueprint_name,'AI Studio Test');
  assert.deepEqual(f.actions[0].buildables[0].relative_location,{x:0,y:0,z:0});
  assert.equal(f.actions[0].commit,true);
  assert.ok(Object.hasOwn(f.actions[0],'expect_world_revision'));
});

test('tampering after staging refuses locally and emits no action',t=>{
  const f=fixture(t);writeFileSync(f.file,JSON.stringify({...proposal(),blueprint_name:'Changed'}));
  const r=answerLocally(f.command,graph(),f.services);
  assert.equal(r?.provider,'solvers'); assert.match(r.reply,/hash/i);assert.deepEqual(f.actions,[]);
});

test('malformed reserved commands never become unrelated or provider requests',t=>{
  const f=fixture(t);
  for(const command of ['aifactory studio generate','aifactory studio generate sha256:../other','aifactory studio generate sha256:'+'a'.repeat(64)+' then teleport me','AIFACTORY studio generate bad']) {
    const r=answerLocally(command,graph(),f.services);
    assert.equal(r?.provider,'solvers',command); assert.deepEqual(f.actions,[]);
  }
});

test('missing, malformed and oversized staged files refuse locally',t=>{
  const f=fixture(t);
  for(const bytes of [null,'{bad json', ' '.repeat(5*1024*1024+1)]) {
    if(bytes===null)rmSync(f.file);else writeFileSync(f.file,bytes);
    const r=answerLocally(f.command,graph(),f.services);
    assert.equal(r?.provider,'solvers');assert.deepEqual(f.actions,[]);
  }
});

test('invalid catalog or non-generation proposal cannot emit a studio action',t=>{
  for(const value of [{...proposal(),action:'teleport_player'}, {...proposal(),buildables:[{...proposal().buildables[0],recipe_class:'MissingRecipe'}]}, {...proposal(),conveyors:[{}]}]) {
    const f=fixture(t,value),r=answerLocally(f.command,graph(),f.services);
    assert.equal(r?.provider,'solvers'); assert.deepEqual(f.actions,[]);
  }
});

test('existing or unknown blueprint library is preserved without generation',t=>{
  for(const listBlueprints of [()=>[{name:'ai studio test',error:'Unreadable old file'}],null]) {
    const f=fixture(t);f.services.listBlueprints=listBlueprints;
    const r=answerLocally(f.command,graph(),f.services);
    assert.equal(r?.provider,'solvers');assert.deepEqual(f.actions,[]);
  }
});

test('a name that validation collapses to an existing blueprint emits no action',t=>{
  const f=fixture(t,{...proposal(),blueprint_name:'AI  Studio\tTest'});
  f.services.listBlueprints=()=>[{name:'AI Studio Test'}];
  const r=answerLocally(f.command,graph(),f.services);
  assert.equal(r?.provider,'solvers');assert.deepEqual(f.actions,[]);
  assert.match(r.reply,/already exists/);
});

test('unconfigured spool and absent action sink refuse locally',t=>{
  for(const patch of [{studioGenerationDirectory:null},{actions:null}]) {
    const f=fixture(t),r=answerLocally(f.command,graph(),{...f.services,...patch});
    assert.equal(r?.provider,'solvers');assert.deepEqual(f.actions,[]);
  }
});
