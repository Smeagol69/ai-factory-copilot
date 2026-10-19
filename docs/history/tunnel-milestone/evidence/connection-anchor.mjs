import {readFileSync,writeFileSync} from 'node:fs';
const dir=new URL('./',import.meta.url),ref=JSON.parse(readFileSync(new URL('Tunnel-Halfway-inspection.json',dir))),fit=JSON.parse(readFileSync(new URL('reference-world-fit.json',dir)));
if(fit.best[0]?.matched!==fit.expected)throw Error('Incomplete live reference match');
const p=ref.reference_traits.poses.filter(p=>p.class_path.includes('/Foundation/'));
// This vector is measured between the two complete repeated profile bays,
// already validated by compileLevelTunnel. Do not infer it from compass north.
const first=p[0].transform.translation_cm;
const repeated=p.filter(q=>Math.abs(q.transform.translation_cm.z-first.z)<.01&&Math.abs(Math.hypot(q.transform.translation_cm.x-first.x,q.transform.translation_cm.y-first.y)-800)<.01);
if(repeated.length!==1)throw Error('Reference bay axis is ambiguous');
const other=repeated[0].transform.translation_cm,axisSign=Math.sign(other.x-first.x);
const delta={x:(other.x-first.x)*axisSign,y:(other.y-first.y)*axisSign};
const length=Math.hypot(delta.x,delta.y),u={x:delta.x/length,y:delta.y/length},v={x:-u.y,y:u.x};
const s=p.map(p=>p.transform.translation_cm.x*u.x+p.transform.translation_cm.y*u.y),t=p.map(p=>p.transform.translation_cm.x*v.x+p.transform.translation_cm.y*v.y),center=(Math.min(...t)+Math.max(...t))/2,end=Math.max(...s)+length/2,floor=Math.min(...p.map(p=>p.transform.translation_cm.z));
const a=fit.best[0].translation;
const anchor={schema:'copilot.tunnel-connection-anchor/v1',capturedAt:fit.capturedAt,sourceFingerprint:fit.sourceFingerprint,matched:fit.expected,measuredBayPitchCm:length,headingDegrees:Math.atan2(u.y,u.x)*180/Math.PI,unitLongitudinal:u,unitTransverse:v,sourceReferenceTranslation:a,referenceProfileCenterCm:center,referenceEndLongitudinalCm:end,connectionFloorPivot:{x:a.x+u.x*end+v.x*center,y:a.y+u.y*end+v.y*center,z:a.z+floor},limitations:['Reference center uses measured profile pivots, not mesh clearance','Future placement still requires native bounds registration and live joint inspection']};
writeFileSync(new URL('connection-anchor.json',dir),JSON.stringify(anchor,null,2));console.log(JSON.stringify(anchor));
