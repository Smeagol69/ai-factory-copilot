import test from 'node:test';import assert from 'node:assert/strict';
import {buildGraph} from '../lib/graph.mjs';import {buildFactorySnapshot} from './fixtures/factory.mjs';
import {answerLocally} from '../lib/router.mjs';
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
