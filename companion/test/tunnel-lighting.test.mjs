import test from 'node:test';
import assert from 'node:assert/strict';
import {answerLocally} from '../lib/router.mjs';
import {buildGraph} from '../lib/graph.mjs';
import {buildFactorySnapshot} from './fixtures/factory.mjs';
import {validateAction} from '../lib/actions.mjs';
const foundation='/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const lamp='/Game/FactoryGame/Buildable/Factory/CeilingLight/Build_CeilingLight.Build_CeilingLight_C';
const beam='/SS_Mod/Builders/Beams/Build_EmissiveBeam_4x2.Build_EmissiveBeam_4x2_C';
function setup(){
 const s=buildFactorySnapshot();
 s.actors.push({actor_id:'RoofEvidence',kind:'buildable',class_path:foundation,reflected_properties:[{name:'mHeight',value:'200',declared_by:'/Script/FactoryGame.FGBuildableFoundation',source:'unreal_reflection',certainty:'authoritative'}]});
 for(const [i,c] of [foundation,lamp,beam].entries()){
  s.content.items.push({class_path:`Desc_Lighting_${i}`,available:true,building:{class_path:c}});
  s.content.recipes.push({class_path:`Recipe_Lighting_${i}`,available:true,products:[{item_class:`Desc_Lighting_${i}`,amount:1}],produced_in:['BP_BuildGun']});
 }
 s.actors.push({actor_id:'ReferenceBeam',kind:'buildable',class_path:beam,reflected_properties:[['mDefaultLength',400],['mLength',0]].map(([name,v])=>({name,value:String(v),declared_by:'/Script/FactoryGame.FGBuildableBeam',source:'unreal_reflection',certainty:'authoritative'}))});
 const pose=(class_path,x,y,z)=>({class_path,transform:{translation_cm:{x,y,z},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}});
 const poses=[pose(foundation,-400,0,0),pose(foundation,400,0,0),pose(foundation,-400,0,2000),pose(foundation,400,0,2000),pose(lamp,0,-200,1900),pose(lamp,0,200,1900),pose(beam,-800,-400,0),pose(beam,-800,400,0)];
 const reference={available:true,reference_traits:{schema:'aifactory.blueprint-reference-traits/v1',source_fingerprint:'sha256:'+'a'.repeat(64),poses_truncated:false,missing_transform_count:0,malformed_entity_count:0,entity_total:poses.length,poses}};
 const emitted=[];return {graph:buildGraph(s),reference,emitted,services:{inspectBlueprint:()=>reference,listBlueprints:()=>[],actions:{emit:a=>emitted.push(...a)}}};
}
const command='save tunnel lighting from "Reference" radius 50 m turn 30 degrees as "Lighting test"';
test('fitted fixtures retain roof exposure and use chord-length beams on shared stations',()=>{
 const {graph,reference,services,emitted}=setup();
 for(const p of reference.reference_traits.poses.filter(p=>p.class_path===lamp))p.transform.translation_cm.z=1950;
 answerLocally(command+' with fitted fixtures',graph,services);
 assert.equal(emitted.length,1);
 const a=emitted[0];assert.equal(a.layout_schema,'aifactory.generated-blueprint/v8');
 const lamps=a.buildables.filter(p=>p.recipe_class==='Recipe_Lighting_1');
 assert.equal(lamps.length,8);assert.ok(lamps.every(p=>p.relative_location.z===1915&&p.scale3d.x===.3&&p.scale3d.y===.3&&p.scale3d.z===.3));
 const beams=a.buildables.filter(p=>p.role==='beam');assert.equal(beams.length,60);
 const first=beams[0];assert.ok(Math.abs(first.scale3d.x-2*5400*Math.sin(Math.PI/180)/400)<1e-12);
 assert.ok(beams.every(p=>p.scale3d.x>0&&p.scale3d.x<1&&p.scale3d.y===1&&p.scale3d.z===1));
 assert.ok(a.buildables.every(p=>p.rotation_quat&&!Object.hasOwn(p,'yaw')));
 assert.equal(validateAction(graph,a).valid,true);
 for(const change of [p=>p.scale3d.z=.2,p=>p.rotation_quat.x=.5,p=>p.yaw=0,p=>p.role='floor']){
  const bad=structuredClone(a);change(bad.buildables[0]);assert.equal(validateAction(graph,bad).valid,false);
 }
 const badBeam=structuredClone(a);badBeam.buildables.find(p=>p.role==='beam').scale3d.y=.5;assert.equal(validateAction(graph,badBeam).valid,false);
 for(const patch of [{power_wires:[{}]},{layout_schema:'aifactory.generated-blueprint/v7'}])assert.equal(validateAction(graph,{...a,...patch}).valid,false);
});
test('fitted fixtures require measured roof thickness and a forward beam axis',()=>{
 for(const kind of ['missing_roof','reverse_beam']){
  const {graph,reference,services,emitted}=setup();
  if(kind==='missing_roof')graph.snapshot.actors=graph.snapshot.actors.filter(a=>a.class_path!==foundation);
  else for(const p of reference.reference_traits.poses.filter(p=>p.class_path===beam))p.transform.rotation_quat={x:0,y:0,z:1,w:0};
  answerLocally(command+' with fitted fixtures',graph,services);assert.equal(emitted.length,0,kind);
 }
});
test('lighting uses the existing native generator with measured rows and no shell replacement',()=>{
 const {graph,services,emitted}=setup(),r=answerLocally(command,graph,services);
 assert.equal(r?.local?.solver,'tunnel_lighting');assert.equal(emitted.length,1);
 const a=emitted[0];assert.equal(a.layout_schema,'aifactory.generated-blueprint/v1');
 assert.equal(a.buildables.length,40);assert.ok(a.buildables.every(p=>p.role==='standalone'&&p.recipe_class!=='Recipe_Lighting_0'));
 const lamps=a.buildables.filter(p=>p.recipe_class==='Recipe_Lighting_1');assert.equal(lamps.length,8);
 assert.ok(lamps.every(p=>p.relative_location.z===1900));
 const beams=a.buildables.filter(p=>p.recipe_class==='Recipe_Lighting_2');assert.equal(beams.length,32);
 assert.deepEqual([...new Set(beams.map(p=>p.relative_location.z))],[0,2000]);
 const row=lamps.filter(p=>p.part_id.startsWith('ceiling-1-'));
 const angles=row.map(p=>Math.atan2(p.relative_location.x,5000-p.relative_location.y));
 assert.ok(angles.every((v,i)=>i===0||Math.abs(v-angles[i-1]-Math.PI/24)<1e-10));
 assert.ok(r.reply.includes('power'));
});
test('lighting preserves existing blueprints and refuses missing or altered beam evidence',()=>{
 for(const kind of ['existing','missing','dynamic','tilted']){
  const {graph,reference,services,emitted}=setup();
  if(kind==='existing')services.listBlueprints=()=>[{name:'Lighting test'}];
  if(kind==='missing')graph.snapshot.actors=[];
  if(kind==='dynamic')graph.snapshot.actors.at(-1).reflected_properties.find(p=>p.name==='mLength').value='900';
  if(kind==='tilted')reference.reference_traits.poses.at(-1).transform.rotation_quat={x:.5,y:.5,z:.5,w:.5};
  answerLocally(command,graph,services);assert.equal(emitted.length,0,kind);
 }
});
test('lightweight beams without reflection do not erase complete actor evidence',()=>{
 const {graph,services,emitted}=setup();
 graph.snapshot.actors.push({class_path:beam,kind:'lightweight_buildable'});
 answerLocally(command,graph,services);assert.equal(emitted.length,1);
});
test('malformed saved fixture transforms refuse without throwing or emitting',()=>{
 for(const patch of [{transform:null},{transform:{translation_cm:{x:NaN,y:0,z:0},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}}]){
  const {graph,reference,services,emitted}=setup();Object.assign(reference.reference_traits.poses.at(-1),patch);
  assert.doesNotThrow(()=>answerLocally(command,graph,services));assert.equal(emitted.length,0);
 }
});
