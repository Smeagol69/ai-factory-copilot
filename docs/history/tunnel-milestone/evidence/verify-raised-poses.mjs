import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir = new URL('./', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('saved-shell-inspection.json', dir)));
const observed = JSON.parse(readFileSync(new URL('raised-actors.json', dir)));
const poses = expected.reference_traits.poses;
function quaternion(r) {
  const k = Math.PI / 360;
  const [sp,sy,sr] = [r.pitch,r.yaw,r.roll].map(v=>Math.sin(v*k));
  const [cp,cy,cr] = [r.pitch,r.yaw,r.roll].map(v=>Math.cos(v*k));
  return {x:cr*sp*sy-sr*cp*cy,y:-cr*sp*cy-sr*cp*sy,z:cr*cp*sy-sr*sp*cy,w:cr*cp*cy+sr*sp*sy};
}
function angle(a,b) {
  const keys=['x','y','z','w'];
  const d=Math.abs(keys.reduce((n,k)=>n+a[k]*b[k],0));
  const norm=q=>Math.hypot(...keys.map(k=>q[k]));
  return 2*Math.acos(Math.min(1,d/(norm(a)*norm(b))))*180/Math.PI;
}
const first=poses[0];
let proof;
for(const anchor of observed.parts) {
  if(anchor.class_path!==first.class_path || angle(quaternion(anchor.rotation),first.transform.rotation_quat)>.001) continue;
  const translation=Object.fromEntries(['x','y','z'].map(k=>[k,anchor.location[k]-first.transform.translation_cm[k]]));
  const used=new Set(),matches=[];
  for(const pose of poses) {
    const candidates=observed.parts.filter(a=>!used.has(a.actor_id)&&a.class_path===pose.class_path).map(a=>({
      actor:a, positionErrorCm:Math.hypot(...['x','y','z'].map(k=>a.location[k]-pose.transform.translation_cm[k]-translation[k])),
      rotationErrorDegrees:angle(quaternion(a.rotation),pose.transform.rotation_quat),
      scaleMatches:['x','y','z'].every(k=>a.scale[k]===pose.transform.scale3d[k])
    })).filter(m=>m.positionErrorCm<.1&&m.rotationErrorDegrees<.001&&m.scaleMatches);
    if(candidates.length!==1) break;
    const m=candidates[0];used.add(m.actor.actor_id);matches.push({entity_index:pose.entity_index,actor_id:m.actor.actor_id,positionErrorCm:m.positionErrorCm,rotationErrorDegrees:m.rotationErrorDegrees,scaleMatches:m.scaleMatches});
  }
  if(matches.length===poses.length) {
    proof={schema:'copilot.tunnel-world-pose-proof/v1',capturedAt:observed.at,revision:observed.revision,sourceFingerprint:expected.source_fingerprint,expected:poses.length,matched:matches.length,registrationTranslation:translation,registrationBasis:'Fitted one translation from exact class and full-quaternion matches; native hologram aligns serialized local bounds, so proxy origin differs from archive origin',maximumPositionErrorCm:Math.max(...matches.map(m=>m.positionErrorCm)),maximumRotationErrorDegrees:Math.max(...matches.map(m=>m.rotationErrorDegrees)),allScaleMatches:matches.every(m=>m.scaleMatches),matches};break;
  }
}
assert(proof,'All saved pieces must match unique observed world poses under one rigid translation');
writeFileSync(new URL('raised-placement-pose-proof.json',dir),JSON.stringify(proof,null,2));
console.log(JSON.stringify({...proof,matches:undefined}));
