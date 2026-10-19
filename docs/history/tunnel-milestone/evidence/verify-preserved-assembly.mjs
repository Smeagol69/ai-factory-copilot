import {readFileSync,writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir)));
const entities=read('complete-preserved-raw-entities.json'),selection=read('complete-selection-plan.json'),receipt=read('complete-export-after-repair.json');
assert.equal(receipt.committed,true);assert.equal(entities.length,528);
const origin=receipt.predicted.blueprint_origin_cm,used=new Set(),matches=[];
for(const part of selection.wanted){
 const found=entities.map((e,index)=>({e,index,distance:Math.hypot(...['x','y','z'].map(k=>e.transform.translation[k]+origin[k]-part.location[k]))})).filter(m=>!used.has(m.index)&&m.e.typePath.split('.').pop()===part.class&&m.distance<.1);
 assert.equal(found.length,1,`Exactly one preserved part for ${part.source} ${part.id}`);
 used.add(found[0].index);matches.push({source:part.source,actor_id_at_selection:part.id,entity_index:found[0].index,errorCm:found[0].distance});
}
const result={schema:'copilot.preserved-assembly-members/v1',verifiedAt:new Date().toISOString(),blueprint:receipt.blueprint_name,archiveTotal:entities.length,expected:selection.wanted.length,matched:matches.length,maximumPositionErrorCm:Math.max(...matches.map(m=>m.errorCm)),basis:'Exact class and full XYZ for all60 original-reference entities and270 generated-shell members under the native capture origin; does not certify wiring or visual fit',additionalWorkAreaEntities:entities.length-matches.length,matches};
writeFileSync(new URL('complete-preserved-assembly-proof.json',dir),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,matches:undefined}));
