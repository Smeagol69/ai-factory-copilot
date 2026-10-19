import {readFileSync,writeFileSync} from 'node:fs';
const dir=new URL('./',import.meta.url),points=JSON.parse(readFileSync(new URL('existing-floor-near-connection.json',dir)));
const groups=new Map();
for(const p of points){const degrees=((p.yaw+90)%180+180)%180-90;if(Math.abs(degrees)<2||Math.abs(degrees)>60)continue;const key=Math.round(degrees*100)/100,a=key*Math.PI/180,b=p.x*Math.cos(a)+p.y*Math.sin(a);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...p,a,b});}
const lines=[...groups].map(([degrees,points])=>{const b=Math.min(...points.map(p=>p.b));return{degrees,a:degrees*Math.PI/180,b,points:points.filter(p=>Math.abs(p.b-b)<1)};}).filter(g=>g.points.length>=3);
if(lines.length<3)throw Error('Need three measured turn cross-sections');
let xx=0,xy=0,yy=0,xb=0,yb=0;
for(const l of lines){const x=Math.cos(l.a),y=Math.sin(l.a);xx+=x*x;xy+=x*y;yy+=y*y;xb+=x*l.b;yb+=y*l.b;}
const det=xx*yy-xy*xy;if(Math.abs(det)<1e-8)throw Error('Turn normals do not determine a center');
const center={x:(xb*yy-yb*xy)/det,y:(yb*xx-xb*xy)/det};
const residuals=lines.map(l=>({degrees:l.degrees,tangentResidualCm:Math.cos(l.a)*center.x+Math.sin(l.a)*center.y-l.b,radialDistancesCm:l.points.map(p=>Math.hypot(p.x-center.x,p.y-center.y))}));
const result={schema:'copilot.measured-floor-turn/v1',basis:'Least-squares intersection of actual foundation cross-section normals; duplicate actor positions are not independent evidence',centerInReferenceFrame:center,radiusToReferenceProfileCenterCm:Math.abs(center.y),curveStartLongitudinalCm:center.x,turnDegrees:Math.min(...lines.map(l=>l.degrees)),maximumTangentResidualCm:Math.max(...residuals.map(l=>Math.abs(l.tangentResidualCm))),crossSections:residuals,limitations:['This fits captured floor orientations and pivots, not clearance or meshes','Existing floor row spacing differs from reference floor row spacing; do not claim exact floor-tile correspondence']};
writeFileSync(new URL('measured-floor-turn.json',dir),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
