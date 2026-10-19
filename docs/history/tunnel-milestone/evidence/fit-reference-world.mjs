import {readFileSync,writeFileSync} from 'node:fs';
const dir=new URL('./',import.meta.url),snapshot=JSON.parse(readFileSync(process.env.LOCALAPPDATA+'/FactoryGame/Saved/AIFactoryCopilot/Snapshots/latest.json'));
const ref=JSON.parse(readFileSync(new URL('Tunnel-Halfway-inspection.json',dir)));
const poses=ref.reference_traits.poses.filter(p=>p.class_path.includes('/Foundation/'));
const actors=snapshot.actors.filter(a=>a.class_path===poses[0].class_path);
function quat(r){const k=Math.PI/360,[sp,sy,sr]=[r.pitch,r.yaw,r.roll].map(v=>Math.sin(v*k)),[cp,cy,cr]=[r.pitch,r.yaw,r.roll].map(v=>Math.cos(v*k));return{x:cr*sp*sy-sr*cp*cy,y:-cr*sp*cy-sr*cp*sy,z:cr*cp*sy-sr*sp*cy,w:cr*cp*cy+sr*sp*sy};}
const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(['x','y','z','w'].reduce((s,k)=>s+a[k]*b[k],0))/(Math.hypot(...Object.values(a))*Math.hypot(...Object.values(b)))))*180/Math.PI;
const keys=['x','y','z'],found=[];
for(const anchor of actors){
 if(angle(quat(anchor.rotation),poses[0].transform.rotation_quat)>.01)continue;
 const translation=Object.fromEntries(keys.map(k=>[k,anchor.location[k]-poses[0].transform.translation_cm[k]])),used=new Set(),matches=[];
 for(const p of poses){const a=actors.find(a=>!used.has(a.actor_id)&&Math.hypot(...keys.map(k=>a.location[k]-p.transform.translation_cm[k]-translation[k]))<1&&angle(quat(a.rotation),p.transform.rotation_quat)<.01);if(a){used.add(a.actor_id);matches.push({entity_index:p.entity_index,actor_id:a.actor_id,location:a.location,rotation:a.rotation});}}
 if(matches.length>0)found.push({matched:matches.length,translation,matches});
}
found.sort((a,b)=>b.matched-a.matched);
const result={capturedAt:snapshot.generated_at_utc,sourceFingerprint:ref.source_fingerprint,expected:poses.length,actorCandidates:actors.length,best:found.slice(0,3)};
writeFileSync(new URL('reference-world-fit.json',dir),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,best:result.best.map(({matches,...r})=>r)}));
