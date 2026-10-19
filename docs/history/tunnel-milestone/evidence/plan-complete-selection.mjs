import {readFileSync,writeFileSync} from 'node:fs';
const dir=new URL('./',import.meta.url);
const snapshot=JSON.parse(readFileSync(process.env.LOCALAPPDATA+'/FactoryGame/Saved/AIFactoryCopilot/Snapshots/latest.json'));
const ref=JSON.parse(readFileSync(new URL('Tunnel-Halfway-inspection.json',dir)));
const fit=JSON.parse(readFileSync(new URL('reference-world-fit.json',dir))).best[0];
const old=JSON.parse(readFileSync(new URL('v3-connected-actors.json',dir)));
const axes=['x','y','z'];
function q(r){const k=Math.PI/360,[sp,sy,sr]=[r.pitch,r.yaw,r.roll].map(v=>Math.sin(v*k)),[cp,cy,cr]=[r.pitch,r.yaw,r.roll].map(v=>Math.cos(v*k));return{x:cr*sp*sy-sr*cp*cy,y:-cr*sp*cy-sr*cp*sy,z:cr*cp*sy-sr*sp*cy,w:cr*cp*cy+sr*sp*sy};}
const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(['x','y','z','w'].reduce((s,k)=>s+a[k]*b[k],0))/(Math.hypot(...Object.values(a))*Math.hypot(...Object.values(b)))))*180/Math.PI;
const wanted=[],missing=[];
for(const [source,parts] of [['reference',ref.reference_traits.poses.map(p=>({class_path:p.class_path,location:Object.fromEntries(axes.map(k=>[k,p.transform.translation_cm[k]+fit.translation[k]])),q:p.transform.rotation_quat}))],['v3',old.parts.map(p=>({...p,q:q(p.rotation)}))]]){
 for(const p of parts){const matches=snapshot.actors.filter(a=>a.class_path===p.class_path&&a.location&&Math.hypot(...axes.map(k=>a.location[k]-p.location[k]))<1&&angle(q(a.rotation),p.q)<.01);
 if(matches.length===1)wanted.push({...matches[0],matchSource:source});else missing.push({source,location:p.location,matches:matches.length});}
}
const bounds={minimum:{},maximum:{},centre:{},size_m:{}};
for(const k of axes){bounds.minimum[k]=Math.min(...wanted.map(a=>a.location[k]))-10;bounds.maximum[k]=Math.max(...wanted.map(a=>a.location[k]))+10;bounds.centre[k]=(bounds.minimum[k]+bounds.maximum[k])/2;bounds.size_m[k]=Math.ceil((bounds.maximum[k]-bounds.minimum[k])/100);}
const ids=new Set(wanted.map(a=>a.actor_id));
const inBox=snapshot.actors.filter(a=>a.kind==='buildable'&&a.location&&axes.every(k=>Math.abs(a.location[k]-bounds.centre[k])<=bounds.size_m[k]*50));
const extras=inBox.filter(a=>!ids.has(a.actor_id));
const project=a=>({id:a.actor_id,class:a.class_path.split('.').pop(),location:a.location,source:a.matchSource});
const plan={at:snapshot.generated_at_utc,revision:snapshot.world_revision,world:snapshot.world,bounds,matched:wanted.length,missing,wanted:wanted.map(project),extra:extras.map(project),boxCount:inBox.length};
writeFileSync(new URL('complete-selection-plan.json',dir),JSON.stringify(plan,null,2));
console.log(JSON.stringify({...plan,wanted:undefined,extra:extras.map(project)}));
