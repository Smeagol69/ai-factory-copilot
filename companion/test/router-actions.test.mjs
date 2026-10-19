import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGraph} from '../lib/graph.mjs';
import {answerLocally} from '../lib/router.mjs';
const graph=buildGraph({world_revision:1,world:{scan_center:{x:0,y:0,z:0}},interaction_context:{player:{pawn_available:true,pawn_location:{x:0,y:0,z:0}}},actors:[]});
function action(question){const emitted=[];answerLocally(question,graph,{actions:{emit:actions=>emitted.push(...actions)}});assert.equal(emitted.length,1);return emitted[0];}
test('explicit exact-height coordinate teleport preserves the given height',()=>{
 const result=action('teleport me to x=100 y=200 z=350 at exact height');
 assert.equal(result.snap_to_ground,false);
 assert.deepEqual(result.target,{x:100,y:200,z:350});
});
test('ordinary coordinate teleport keeps existing ground snapping',()=>{
 assert.equal(action('teleport me to x=100 y=200 z=350').snap_to_ground,true);
});
test('exact-height wording cannot disable ground snapping without a supplied height',()=>{
 assert.equal(action('teleport me to x=100 y=200 at exact height').snap_to_ground,true);
});
