// Deterministic draft geometry. Native writing and mesh clearance are separate.
const vector=(v,keys=['x','y','z'])=>v&&keys.every(k=>typeof v[k]==='number'&&Number.isFinite(v[k]));
const limitations=['seam_centerline_only_not_mesh_edge_or_collision_proof','rigid_panels_remain_faceted_not_deformed_meshes','native_full_quaternion_generation_adapter_required','game_clearance_and_world_readback_required'];
const base=()=>({schema:'copilot.level-section-plan/v1',valid:false,parts:[],actions:[],gameWrites:0,gamePlacementVerified:false,limitations:[...limitations]});
function validate(parts){
 if(!Array.isArray(parts)||parts.length<1||parts.length>512)return 'one_to_512_measured_parts_required';
 const ids=new Set();
 for(const p of parts){
  if(typeof p?.part_id!=='string'||!p.part_id||ids.has(p.part_id))return 'unique_part_ids_required';
  ids.add(p.part_id);
  if(!vector(p.location_cm)||!vector(p.rotation_quat,['x','y','z','w'])||!vector(p.scale3d)||Object.values(p.scale3d).some(v=>v<=0))return 'complete_finite_transform_required';
  if(Math.abs(Math.hypot(...['x','y','z','w'].map(k=>p.rotation_quat[k]))-1)>0.001)return 'unit_quaternion_required';
 }
 return null;
}
export function turnLevelSection(parts,angle,pivot){
 const result=base(),invalid=validate(parts);
 if(invalid||typeof angle!=='number'||!Number.isFinite(angle)||Math.abs(angle)>360||!vector(pivot))return {...result,reason:invalid??'finite_explicit_world_up_turn_and_pivot_required'};
 const rad=angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad),cz=Math.cos(rad/2),sz=Math.sin(rad/2);
 result.parts=parts.map(p=>{
  const dx=p.location_cm.x-pivot.x,dy=p.location_cm.y-pivot.y,q=p.rotation_quat;
  return {...p,location_cm:{x:pivot.x+c*dx-s*dy,y:pivot.y+s*dx+c*dy,z:p.location_cm.z},
   // Hamilton product qZ * q: the added rotation is around WORLD up.
   rotation_quat:{x:cz*q.x-sz*q.y,y:cz*q.y+sz*q.x,z:cz*q.z+sz*q.w,w:cz*q.w-sz*q.z},scale3d:{...p.scale3d}};
 });
 return {...result,valid:true,zPreserved:true,rotationAxis:'world_up_z'};
}
export function chainLevelSections(parts,seam,count,angleStep){
 const result=base(),invalid=validate(parts);
 if(invalid)return {...result,reason:invalid};
 if(!vector(seam?.start_cm)||!vector(seam?.end_cm)||Math.abs(seam.end_cm.z-seam.start_cm.z)>0.01||Math.hypot(seam.end_cm.x-seam.start_cm.x,seam.end_cm.y-seam.start_cm.y)<0.01)return {...result,reason:'explicit_nonzero_level_seam_required'};
 if(!Number.isSafeInteger(count)||count<1||count*parts.length>512||typeof angleStep!=='number'||!Number.isFinite(angleStep)||Math.abs(angleStep)>180)return {...result,reason:'bounded_copy_count_and_finite_turn_required'};
 let start={...seam.start_cm};const sections=[],output=[];
 for(let i=0;i<count;i++){
  const angle=((i*angleStep)%360+360)%360,turned=turnLevelSection(parts,angle,seam.start_cm);
  const dx=start.x-seam.start_cm.x,dy=start.y-seam.start_cm.y;
  for(const p of turned.parts)output.push({...p,part_id:`section-${i+1}/${p.part_id}`,location_cm:{x:p.location_cm.x+dx,y:p.location_cm.y+dy,z:p.location_cm.z}});
  const rad=angle*Math.PI/180,x=seam.end_cm.x-seam.start_cm.x,y=seam.end_cm.y-seam.start_cm.y;
  const end={x:start.x+Math.cos(rad)*x-Math.sin(rad)*y,y:start.y+Math.sin(rad)*x+Math.cos(rad)*y,z:start.z};
  sections.push({index:i,start_cm:{...start},end_cm:end,world_yaw_degrees:angle});start=end;
 }
 return {...result,valid:true,parts:output,sections,zPreserved:true,rotationAxis:'world_up_z'};
}
