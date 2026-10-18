import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction} from '../lib/actions.mjs';
import {buildGraph} from '../lib/graph.mjs';
import {buildFactorySnapshot} from './fixtures/factory.mjs';
import {compileLevelTunnel} from '../lib/level-tunnel.mjs';
import {answerLocally} from '../lib/router.mjs';

const foundation='/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
function graph(){
 const s=buildFactorySnapshot();
 s.content.items.push({class_path:'Desc_TestFoundation',available:true,building:{class_path:foundation}});
 s.content.recipes.push({class_path:'Recipe_TestFoundation',available:true,products:[{item_class:'Desc_TestFoundation',amount:1}],produced_in:['BP_BuildGun']});
 return buildGraph(s);
}
const part=()=>({part_id:'tilted-wall',role:'wall',recipe_class:'Recipe_TestFoundation',relative_location:{x:100,y:200,z:300},rotation_quat:{x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},scale3d:{x:1,y:1,z:1}});
const action=p=>({action:'generate_native_blueprint',blueprint_name:'Level tunnel test',layout_schema:'aifactory.generated-blueprint/v6',buildables:[p],commit:true});
test('v6 retains a complete tilted foundation pose without inventing yaw',()=>{
 const p=part(),r=validateAction(graph(),action(p));
 assert.equal(r.valid,true,r.reason);assert.deepEqual(r.action.buildables[0].rotation_quat,p.rotation_quat);
 assert.deepEqual(r.action.buildables[0].scale3d,p.scale3d);assert.equal(Object.hasOwn(r.action.buildables[0],'yaw'),false);
});
test('v6 refuses malformed poses and conflicting Euler input',()=>{
 for(const patch of [{rotation_quat:null},{rotation_quat:{x:0,y:0,z:0,w:2}},{rotation_quat:{x:'0',y:0,z:0,w:1}}, {rotation_quat:{x:0,y:NaN,z:0,w:1}}, {scale3d:{x:1,y:2,z:1}}, {yaw:0},{pitch:30},{roll:90}])
  assert.equal(validateAction(graph(),action({...part(),...patch})).valid,false,JSON.stringify(patch));
});
test('older schemas reject full poses rather than silently flattening them',()=>{
 for(let i=1;i<=5;i++)assert.equal(validateAction(graph(),{...action({...part(),yaw:0}),layout_schema:`aifactory.generated-blueprint/v${i}`}).valid,false);
});
test('v6 refuses machines, configuration and topology',()=>{
 for(const patch of [{role:'machine'}, {production_recipe_class:'Recipe_IngotIron'}, {clock_percent:50}, {sort_rules:[]}])assert.equal(validateAction(graph(),action({...part(),...patch})).valid,false);
 for(const field of ['conveyors','power_wires','pipelines'])assert.equal(validateAction(graph(),{...action(part()),[field]:[{}]}).valid,false);
 const g=graph();const a=action({...part(),recipe_class:'Recipe_SmelterMk1'});assert.equal(validateAction(g,a).valid,false);
});
function reference(){
 const poses=[];
 for(const x of [0,800])for(const [y,z,q] of [[-800,0,{x:0,y:0,z:0,w:1}],[800,1000,{x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2}]])poses.push({entity_index:poses.length,class_path:foundation,transform:{translation_cm:{x,y,z},rotation_quat:q,scale3d:{x:1,y:1,z:1}}});
 return {available:true,reference_traits:{schema:'aifactory.blueprint-reference-traits/v1',source_fingerprint:'sha256:'+'a'.repeat(64),entity_total:4,eligible_entity_count:4,missing_transform_count:0,malformed_entity_count:0,poses_truncated:false,poses}};
}
test('reference-derived curve preserves each course height and wall normal elevation',()=>{
 const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Measured arc',radius_cm:5000,turn_degrees:30});
 assert.equal(r.compiled,true,r.reason);assert.equal(r.measured_pitch_cm,800);
 assert.equal(r.profile_parts,2);assert.equal(r.actions,undefined);
 assert.deepEqual([...new Set(r.proposal.buildables.map(p=>p.relative_location.z))],[0,1000]);
 for(const p of r.proposal.buildables){const q=p.rotation_quat;const nz=1-2*(q.x*q.x+q.y*q.y);assert.ok(Math.abs(nz-(p.relative_location.z===0?1:0))<1e-10);}
 assert.equal(validateAction(graph(),r.proposal).valid,true);
 assert.equal(r.gamePlacementVerified,false);assert.ok(r.limitations.includes('rigid_panel_joints_require_visual_clearance_check'));
});

test('all profile courses share angular stations so wall and roof joints line up',()=>{
 const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Aligned joints',radius_cm:5000,turn_degrees:30});
 assert.equal(r.compiled,true,r.reason);
 assert.equal(new Set(r.courses.map(c=>c.pieces)).size,1);
 const courses=r.courses.map(c=>r.proposal.buildables.filter(p=>p.part_id.startsWith(`course-${c.profile_index+1}-`)));
 for(let j=0;j<courses[0].length;j++){
  const angles=courses.map(parts=>Math.atan2(parts[j].relative_location.x,5000-parts[j].relative_location.y));
  assert.ok(Math.abs(angles[0]-angles[1])<1e-12);
 }
});

test('the full profile retains its measured transverse spacing at each station',()=>{
 for(const turn of [-30,30]){
  const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Exact section',radius_cm:5000,turn_degrees:turn});
  assert.equal(r.compiled,true,r.reason);
  for(const c of r.courses){
   const p=r.proposal.buildables.find(p=>p.part_id===`course-${c.profile_index+1}-piece-1`).relative_location;
   assert.ok(Math.abs(Math.hypot(p.x,5000-Math.sign(turn)*p.y)-c.radius_cm)<1e-9);
   assert.ok(c.joint_overlap_cm>=0);
  }
 }
});

test('visual sampling limits panel angle changes to two degrees when the part budget permits',()=>{
 const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Fine turn',radius_cm:5000,turn_degrees:29.5});
 assert.equal(r.compiled,true,r.reason);
 assert.ok(29.5/r.angular_stations<=2);
 assert.ok(r.proposal.buildables.length<=512);
});

test('visual sampling coarsens truthfully at the part cap instead of losing a previously valid turn',()=>{
 const ref=reference();
 const originals=[...ref.reference_traits.poses];
 ref.reference_traits.poses=[];
 for(let i=0;i<12;i++)for(const p of originals)ref.reference_traits.poses.push({...p,entity_index:ref.reference_traits.poses.length,transform:{...p.transform,translation_cm:{...p.transform.translation_cm,z:p.transform.translation_cm.z+i*2000}}});
 ref.reference_traits.entity_total=48;ref.reference_traits.eligible_entity_count=48;
 const r=compileLevelTunnel(graph(),{reference:ref,blueprint_name:'Bounded fine turn',radius_cm:5000,turn_degrees:90});
 assert.equal(r.compiled,true,r.reason);
 assert.ok(r.proposal.buildables.length<=512);
 assert.equal(r.visual_sampling_limited_by_part_cap,true);
});
test('curve refuses missing full poses, inconsistent repeated bays and unsafe inside radii',()=>{
 for(const ref of [null,{available:false},{...reference(),reference_traits:{...reference().reference_traits,poses_truncated:true}}])assert.equal(compileLevelTunnel(graph(),{reference:ref,blueprint_name:'X',radius_cm:5000,turn_degrees:30}).compiled,false);
 const ref=reference();ref.reference_traits.poses[3].transform.translation_cm.z+=1;
 assert.equal(compileLevelTunnel(graph(),{reference:ref,blueprint_name:'X',radius_cm:5000,turn_degrees:30}).compiled,false);
 assert.equal(compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'X',radius_cm:400,turn_degrees:30}).compiled,false);
});
test('square foundation in-plane half turns do not hide the repeated position profile',()=>{
 const ref=reference();ref.reference_traits.poses[2].transform.rotation_quat={x:0,y:0,z:1,w:0};
 const r=compileLevelTunnel(graph(),{reference:ref,blueprint_name:'X',radius_cm:5000,turn_degrees:30});
 assert.equal(r.compiled,true,r.reason);
});
test('explicit local tunnel command inspects full saved poses and emits one validated native save',()=>{
 const emitted=[];let options;
 const result=answerLocally('save level tunnel from "Reference" radius 50 m turn 30 degrees as "Measured arc"',graph(),{inspectBlueprint:(name,opts)=>{assert.equal(name,'Reference');options=opts;return reference();},actions:{emit:a=>emitted.push(...a)}});
 assert.equal(result?.local?.solver,'level_tunnel',JSON.stringify(result));assert.equal(options.includeReferenceTraits,true);
 assert.equal(emitted.length,1);assert.equal(emitted[0].layout_schema,'aifactory.generated-blueprint/v6');
 assert.match(result.reply,/game will report/i);
});
test('world-up quaternion turn has the hand-computed vertical-wall normal in both directions',()=>{
 for(const turn of [-30,30]){
  const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Q',radius_cm:5000,turn_degrees:turn});
  assert.equal(r.compiled,true,r.reason);
  const wall=r.proposal.buildables.find(p=>p.relative_location.z===1000),q=wall.rotation_quat;
  const count=r.courses.find(c=>c.height_cm===1000).pieces,a=(turn*Math.PI/180)/count/2;
  // Initial wall normal is (0,-1,0). A world-up turn gives (sin(a),-cos(a),0).
  assert.ok(Math.abs(2*(q.x*q.z+q.w*q.y)-Math.sin(a))<1e-12);
  assert.ok(Math.abs(2*(q.y*q.z-q.w*q.x)+Math.cos(a))<1e-12);
  assert.ok(Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1)<1e-12);
  assert.ok(wall.relative_location.x>0);
 }
});
test('repeated same-class coplanar floors retain spatially distinct cross-section courses',()=>{
 const ref=reference();
 for(const x of [0,800])for(const y of [-400,0])ref.reference_traits.poses.push({entity_index:ref.reference_traits.poses.length,class_path:foundation,transform:{translation_cm:{x,y,z:0},rotation_quat:{x:0,y:0,z:0,w:1},scale3d:{x:1,y:1,z:1}}});
 ref.reference_traits.entity_total=8;ref.reference_traits.eligible_entity_count=8;
 const r=compileLevelTunnel(graph(),{reference:ref,blueprint_name:'P',radius_cm:5000,turn_degrees:30});
 assert.equal(r.compiled,true,r.reason);assert.equal(r.profile_parts,4);
 assert.equal(new Set(r.courses.map(c=>c.radius_cm)).size,4);
});
test('measured foundation planes carry the existing native structural roles',()=>{
 const r=compileLevelTunnel(graph(),{reference:reference(),blueprint_name:'Roles',radius_cm:5000,turn_degrees:30});
 assert.equal(r.compiled,true,r.reason);
 assert.deepEqual([...new Set(r.proposal.buildables.map(p=>p.role))],['floor','wall']);
});
test('explicit blueprint XYZ placement stays deterministic and uses one validated native action',()=>{
 const emitted=[],services={listBlueprints:()=>[{name:'Measured arc'}],actions:{emit:a=>emitted.push(...a)}};
 const r=answerLocally('place blueprint "Measured arc" at x=12000 y=-4000 z=800 yaw=0',graph(),services);
 assert.equal(r?.local?.solver,'blueprint_place_coordinates');assert.equal(emitted.length,1);
 assert.deepEqual(emitted[0].location,{x:12000,y:-4000,z:800});assert.equal(emitted[0].yaw,0);
 assert.equal(emitted[0].commit,true);assert.equal(Object.hasOwn(emitted[0],'ignore_clearance'),false);
 assert.equal(emitted[0].exact_z,true);
 const no=[];const refused=answerLocally('place blueprint "Missing" at x=1 y=2 z=3 yaw=0',graph(),{...services,actions:{emit:a=>no.push(...a)}});
 assert.match(refused.reply,/not uniquely/i);assert.equal(no.length,0);
});
