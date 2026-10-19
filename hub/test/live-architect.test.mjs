import test from 'node:test';
import assert from 'node:assert/strict';
import {turnLevelSection,chainLevelSections} from '../lib/live-architect.mjs';
const near=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const part=(q={x:0,y:0,z:0,w:1})=>({part_id:'panel',location_cm:{x:400,y:0,z:100},rotation_quat:q,scale3d:{x:1,y:1,z:1}});
test('world yaw90 around explicit pivot preserves panel height and scale',()=>{
 const p=part();const r=turnLevelSection([p],90,{x:50,y:50,z:700});assert.equal(r.valid,true);
 near(r.parts[0].location_cm.x,100);near(r.parts[0].location_cm.y,400);assert.equal(r.parts[0].location_cm.z,100);
 near(r.parts[0].rotation_quat.z,Math.SQRT1_2);near(r.parts[0].rotation_quat.w,Math.SQRT1_2);
 assert.deepEqual(r.parts[0].scale3d,p.scale3d);assert.equal(r.gameWrites,0);assert.equal(r.gamePlacementVerified,false);
});
test('tilted panel turns around WORLD up, preserving its tilt rather than descending',()=>{
 const q={x:0,y:Math.sin(Math.PI/8),z:0,w:Math.cos(Math.PI/8)},r=turnLevelSection([part(q)],90,{x:0,y:0,z:0});
 const t=r.parts[0];near(t.rotation_quat.x,-0.2705980500730985);near(t.rotation_quat.y,0.2705980500730985);
 near(t.rotation_quat.z,0.6532814824381883);near(t.rotation_quat.w,0.6532814824381883);
 near(1-2*(q.x*q.x+q.y*q.y),1-2*(t.rotation_quat.x**2+t.rotation_quat.y**2));assert.equal(t.location_cm.z,100);
});
test('negative turns, full revolution equivalence and immutable inputs',()=>{
 const source=[part()],before=JSON.stringify(source);let r=turnLevelSection(source,-90,{x:0,y:0,z:0});near(r.parts[0].location_cm.y,-400);
 r=turnLevelSection(source,360,{x:0,y:0,z:0});near(r.parts[0].location_cm.x,400);near(Math.abs(r.parts[0].rotation_quat.w),1);
 assert.equal(JSON.stringify(source),before);
});
test('two rigid sections meet at the supplied seam centerline without Z drift',()=>{
 const r=chainLevelSections([part({x:Math.sin(Math.PI/8),y:0,z:0,w:Math.cos(Math.PI/8)})],{start_cm:{x:0,y:0,z:0},end_cm:{x:800,y:0,z:0}},2,90);
 assert.equal(r.valid,true);assert.equal(r.parts.length,2);near(r.parts[1].location_cm.x,800);near(r.parts[1].location_cm.y,400);assert.equal(r.parts[1].location_cm.z,100);
 assert.deepEqual(r.sections[1].start_cm,r.sections[0].end_cm);assert.equal(r.actions.length,0);
 assert(r.limitations.includes('seam_centerline_only_not_mesh_edge_or_collision_proof'));
});
test('missing/nonunit/string quaternions and duplicate identities refuse whole draft',()=>{
 for(const q of [null,{x:0,y:0,z:0,w:2},{x:'0',y:0,z:0,w:1},{x:NaN,y:0,z:0,w:1}])assert.equal(turnLevelSection([part(q)],20,{x:0,y:0,z:0}).valid,false);
 assert.equal(turnLevelSection([part(),part()],20,{x:0,y:0,z:0}).valid,false);
 assert.equal(turnLevelSection([part()],Infinity,{x:0,y:0,z:0}).valid,false);
});
test('unknown or sloped seams refuse level chaining; finite bounds stop runaway copies',()=>{
 assert.equal(chainLevelSections([part()],null,2,10).valid,false);
 assert.equal(chainLevelSections([part()],{start_cm:{x:0,y:0,z:0},end_cm:{x:800,y:0,z:100}},2,10).valid,false);
 assert.equal(chainLevelSections([part()],{start_cm:{x:0,y:0,z:0},end_cm:{x:800,y:0,z:0}},513,10).valid,false);
});
