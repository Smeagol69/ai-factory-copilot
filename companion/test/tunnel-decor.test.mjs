import test from 'node:test';import assert from 'node:assert/strict';
import {buildGraph} from '../lib/graph.mjs';import {buildFactorySnapshot} from './fixtures/factory.mjs';
import {answerLocally} from '../lib/router.mjs';
import * as decor from '../lib/tunnel-decor.mjs';
const names=['Steel Wall Fan','Control Panel','M.A.M. Console','Tall Vent','Pioneer Crate','Pot 2','Ficus Plant'];
function setup(){const s=buildFactorySnapshot();for(const [i,name] of names.entries()){
 s.content.items.push({class_path:`Desc_Decor_${i}`,name,building:{class_path:`/Factory_Prop_Mod/Measured/Prop${i}.Prop${i}_C`}});
 s.content.recipes.push({class_path:`Recipe_Decor_${i}`,available:true,produced_in:['/Script/FactoryGame.FGBuildGun'],products:[{item_class:`Desc_Decor_${i}`,amount:1}]});
}return buildGraph(s);}
test('decor palette selects exact unlocked Factory Props through the native Build Gun producer',()=>{
 const emitted=[];const r=answerLocally('save tunnel decor palette as "Industrial palette"',setup(),{listBlueprints:()=>[],actions:{emit:a=>emitted.push(...a)}});
 assert.equal(r?.local?.solver,'tunnel_decor_palette');assert.equal(emitted.length,1);
 assert.equal(emitted[0].buildables.length,7);assert.ok(emitted[0].buildables.every(p=>p.role==='standalone'&&p.yaw===0));
 assert.match(r.reply,/native/i);assert.match(r.reply,/not.*placed/i);
});
test('decor palette refuses a missing or locked asset and preserves existing blueprint names',()=>{
 for(const kind of ['missing','locked','existing']){
  const graph=setup(),emitted=[];
  if(kind==='missing')graph.itemsByClass.delete('Desc_Decor_1');
  if(kind==='locked')graph.recipesByClass.get('Recipe_Decor_1').available=false;
  answerLocally('save tunnel decor palette as "Industrial palette"',graph,{listBlueprints:()=>kind==='existing'?[{name:'Industrial palette'}]:[],actions:{emit:a=>emitted.push(...a)}});
  assert.equal(emitted.length,0,kind);
 }
});

function measuredSetup(){
 const graph=setup(),s=graph.snapshot,foundation='/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
 graph.itemsByClass.set('Desc_Floor',{building:{class_path:foundation}});
 graph.recipesByClass.set('Recipe_Floor',{class_path:'Recipe_Floor',available:true,produced_in:['BP_BuildGun'],products:[{item_class:'Desc_Floor',amount:1}]});
 const dims=['mWidth','mDepth','mHeight'].map((name,i)=>({name,value:String([800,800,200][i]),declared_by:'/Script/FactoryGame.FGBuildableFoundation',source:'unreal_reflection',certainty:'authoritative'}));
 s.actors.push({class_path:foundation,reflected_properties:dims});
 const poses=[];for(const x of [0,800])for(const y of [-800,0,800])for(const z of [0,2000])poses.push({class_path:foundation,transform:{translation_cm:{x,y,z},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}});
 for(const x of [0,800])for(const y of [-1600,1600])poses.push({class_path:foundation,transform:{translation_cm:{x,y,z:1000},rotation_quat:{x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},scale3d:{x:1,y:1,z:1}}});
 for(const [i,name] of names.entries()){
  const extent=name==='Ficus Plant'?{x:226,y:195,z:182}:name==='M.A.M. Console'?{x:89,y:61,z:318}:name==='Tall Vent'?{x:170,y:174,z:307}:{x:79,y:44,z:39};
  s.actors.push({actor_id:'measured-'+i,kind:'buildable',class_path:`/Factory_Prop_Mod/Measured/Prop${i}.Prop${i}_C`,location:{x:20000+i*2000,y:0,z:0},rotation:{yaw:0,pitch:0,roll:0},scale:{x:1,y:1,z:1},bounds:{origin:{x:20000+i*2000,y:0,z:extent.z-1},extent}});
 }
 return {graph,reference:{available:true,reference_traits:{schema:'aifactory.blueprint-reference-traits/v1',source_fingerprint:'sha256:'+'a'.repeat(64),poses_truncated:false,missing_transform_count:0,malformed_entity_count:0,entity_total:poses.length,poses}}};
}

test('industrial accents use measured native props, preserve twelve metres of walking width and follow either turn',()=>{
 assert.equal(typeof decor.compileIndustrialTunnelDecor,'function');
 for(const turn of [90,-90]){
  const {graph,reference}=measuredSetup();
  const r=decor.compileIndustrialTunnelDecor(graph,{reference,blueprint_name:'Industrial accents',radius_cm:6400,turn_degrees:turn,straight_collars:true});
  assert.equal(r.compiled,true,r.reason);assert.equal(r.proposal.layout_schema,'aifactory.generated-blueprint/v1');
  assert.equal(r.proposal.buildables.length,18);assert.equal(r.clear_walkway_width_cm,1200);
  assert.ok(r.placements.every(p=>p.radial_min_cm>=600||p.radial_max_cm<=-600));
  assert.ok(r.placements.every(p=>p.floor_contact_cm===100&&p.top_cm<2000));
  assert.ok(r.proposal.buildables.every(p=>!p.scale3d&&!p.rotation_quat&&p.role==='standalone'));
  assert.equal(r.gamePlacementVerified,false);assert.ok(r.limitations.includes('wall_pipe_band_reserved'));
  const emitted=[];const answer=answerLocally(`save industrial tunnel decor from "Reference" radius 64 m turn ${turn} degrees as "Industrial accents" with straight collars`,graph,{listBlueprints:()=>[],inspectBlueprint:()=>reference,actions:{emit:a=>emitted.push(...a)}});
  assert.equal(emitted.length,1);assert.match(answer.reply,/game must verify/i);
 }
});

test('industrial accents refuse missing, inconsistent or oversized measured props and preserve existing names',()=>{
 assert.equal(typeof decor.compileIndustrialTunnelDecor,'function');
 for(const kind of ['missing','oversized','inconsistent','existing']){
  const {graph,reference}=measuredSetup(),emitted=[],actor=graph.snapshot.actors.find(a=>a.actor_id==='measured-3');
  if(kind==='missing')actor.bounds=null;
  if(kind==='oversized')actor.bounds.extent.x=900;
  if(kind==='inconsistent'){const other=structuredClone(actor);other.actor_id='contradiction';other.bounds.extent.x+=50;graph.snapshot.actors.push(other);}
  answerLocally('save industrial tunnel decor from "Reference" radius 64 m turn 90 degrees as "Industrial accents" with straight collars',graph,{listBlueprints:()=>kind==='existing'?[{name:'Industrial accents'}]:[],inspectBlueprint:()=>reference,actions:{emit:a=>emitted.push(...a)}});
  assert.equal(emitted.length,0,kind);
 }
});
