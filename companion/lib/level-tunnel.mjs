// Reuse a measured, two-bay foundation cross-section. This is a faceted shell,
// not a mesh deformation or an assertion that structural joint overlaps fit.
const PREFIX='/Game/FactoryGame/Buildable/Building/Foundation/';
const finite=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>typeof v[k]==='number'&&Number.isFinite(v[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;
const normal=q=>({x:2*(q.x*q.z+q.w*q.y),y:2*(q.y*q.z-q.w*q.x),z:1-2*(q.x*q.x+q.y*q.y),w:0});
const rotateQ=(q,a)=>({x:Math.cos(a/2)*q.x-Math.sin(a/2)*q.y,y:Math.cos(a/2)*q.y+Math.sin(a/2)*q.x,z:Math.cos(a/2)*q.z+Math.sin(a/2)*q.w,w:Math.cos(a/2)*q.w-Math.sin(a/2)*q.z});
const failure=reason=>({compiled:false,reason,gamePlacementVerified:false});

export function compileLevelTunnel(graph,{reference,blueprint_name,radius_cm,turn_degrees}={}){
 const traits=reference?.reference_traits;
 if(reference?.available!==true||traits?.schema!=='aifactory.blueprint-reference-traits/v1'||
    !/^sha256:[a-f0-9]{64}$/.test(traits.source_fingerprint??'')||traits.poses_truncated!==false||
    traits.missing_transform_count!==0||traits.malformed_entity_count!==0||
    !Array.isArray(traits.poses)||traits.poses.length!==traits.entity_total||traits.poses.length>512)
  return failure('complete_fingerprinted_saved_poses_required');
 if(typeof blueprint_name!=='string'||!blueprint_name.trim()||blueprint_name.length>240||
    typeof radius_cm!=='number'||!Number.isFinite(radius_cm)||radius_cm<=0||radius_cm>100000||
    typeof turn_degrees!=='number'||!Number.isFinite(turn_degrees)||Math.abs(turn_degrees)<1||Math.abs(turn_degrees)>90)
  return failure('explicit_name_radius_and_one_to_90_degree_turn_required');
 const parts=traits.poses.filter(p=>String(p.class_path).startsWith(PREFIX)).map(p=>({class_path:p.class_path,p:p.transform?.translation_cm,q:p.transform?.rotation_quat,s:p.transform?.scale3d}));
 if(parts.length<4||parts.length%2)return failure('two_matching_foundation_bays_required');
 if(parts.some(p=>!finite(p.p,['x','y','z'])||!finite(p.q,['x','y','z','w'])||Math.abs(Math.hypot(p.q.x,p.q.y,p.q.z,p.q.w)-1)>0.0001||!finite(p.s,['x','y','z'])||Object.values(p.s).some(v=>v!==1)))
  return failure('complete_unit_scale_saved_foundation_transforms_required');
 // The measured square panel may face the opposite way or be quarter-turned
 // inside its plane in the second bay. Use its plane to identify repetition,
 // but keep the selected FIRST bay's complete quaternion in the output.
 const same=(a,b)=>a.class_path===b.class_path&&Math.abs(Math.abs(dot(normal(a.q),normal(b.q)))-1)<0.0001;
 // A valid axis must pair EVERY foundation uniquely. A decorative repeat or
 // just two nearby floor pivots can never establish the whole tunnel profile.
 const axes=new Map();
 for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){
  const a=parts[i],b=parts[j];if(!same(a,b)||Math.abs(a.p.z-b.p.z)>0.1)continue;
  let dx=b.p.x-a.p.x,dy=b.p.y-a.p.y;if(Math.hypot(dx,dy)<1)continue;
  if(dx<0||(Math.abs(dx)<0.0001&&dy<0)){dx=-dx;dy=-dy;}
  axes.set(`${Math.round(dx*10)},${Math.round(dy*10)}`,{x:dx,y:dy,z:0});
 }
 const candidates=[];
 for(const delta of axes.values()){
  const selected=[],used=new Set();let good=true;
  for(let i=0;i<parts.length;i++){
   if(used.has(i))continue;
   const matches=[];
   for(let j=0;j<parts.length;j++)if(j!==i&&!used.has(j)&&same(parts[i],parts[j])){
    const diff={x:parts[j].p.x-parts[i].p.x,y:parts[j].p.y-parts[i].p.y,z:parts[j].p.z-parts[i].p.z};
    if(distance(diff,delta)<0.1||distance(diff,{x:-delta.x,y:-delta.y,z:0})<0.1)matches.push(j);
   }
   if(matches.length!==1){good=false;break;}
   const j=matches[0];used.add(i);used.add(j);
   selected.push((parts[j].p.x-parts[i].p.x)*delta.x+(parts[j].p.y-parts[i].p.y)*delta.y>0?parts[i]:parts[j]);
  }
  if(good&&used.size===parts.length)candidates.push({delta,selected});
 }
 if(candidates.length!==1)return failure('one_unambiguous_complete_repeated_bay_axis_required');
 const {delta,selected}=candidates[0],pitch=Math.hypot(delta.x,delta.y),ux=delta.x/pitch,uy=delta.y/pitch;
 const longitudinal=selected.map(p=>p.p.x*ux+p.p.y*uy);
 if(Math.max(...longitudinal)-Math.min(...longitudinal)>0.1)return failure('measured_profile_is_not_one_cross_section');
 const transverse=selected.map(p=>-p.p.x*uy+p.p.y*ux),center=(Math.min(...transverse)+Math.max(...transverse))/2;
 const floor=Math.min(...selected.map(p=>p.p.z)),heading=Math.atan2(uy,ux),sweep=turn_degrees*Math.PI/180,sign=Math.sign(sweep);
 const buildables=[],courses=[];
 for(let i=0;i<selected.length;i++){
  const p=selected[i],offset=transverse[i]-center,r=radius_cm-sign*offset;
  if(r<=pitch)return failure('inside_radius_must_exceed_measured_bay_pitch');
  const recipe=[...(graph?.recipesByClass?.values()??[])].filter(recipe=>recipe.available===true&&(recipe.produced_in??[]).some(v=>String(v).includes('BP_BuildGun'))&&(recipe.products??[]).some(product=>graph.itemsByClass?.get(product.item_class)?.building?.class_path===p.class_path));
  if(recipe.length!==1)return failure('one_exact_unlocked_build_recipe_required_per_foundation_class');
  const count=Math.max(1,Math.ceil(Math.abs(sweep)*r/pitch)),step=sweep/count;
  const chord=2*r*Math.sin(Math.abs(step)/2);
  courses.push({profile_index:i,pieces:count,radius_cm:r,height_cm:p.p.z-floor,joint_overlap_cm:pitch-chord});
  for(let j=0;j<count;j++){
   if(buildables.length>=512)return failure('generated_foundation_limit_exceeded');
   const a=(j+0.5)*step,radial=r*Math.cos(step/2);
   const nz=normal(p.q).z,role=nz>0.9999?'floor':nz< -0.9999?'roof':Math.abs(nz)<0.0001?'wall':'ramp';
   buildables.push({part_id:`course-${i+1}-piece-${j+1}`,role,recipe_class:recipe[0].class_path,
    relative_location:{x:sign*radial*Math.sin(a),y:sign*(radius_cm-radial*Math.cos(a)),z:p.p.z-floor},
    rotation_quat:rotateQ(p.q,a-heading),scale3d:{x:1,y:1,z:1}});
  }
 }
 return {compiled:true,source_fingerprint:traits.source_fingerprint,measured_pitch_cm:pitch,profile_parts:selected.length,
  excluded_nonfoundation_entities:traits.poses.length-parts.length,centerline_basis:'midpoint_of_profile_pivots_not_clearance',courses,
  gamePlacementVerified:false,limitations:['rigid_panel_joints_require_visual_clearance_check','foundation_shell_only_decoration_not_copied','native_save_and_placement_readback_required'],
  proposal:{action:'generate_native_blueprint',blueprint_name:blueprint_name.trim(),description:`Level foundation shell from saved reference ${traits.source_fingerprint}; ${turn_degrees} degree turn, ${radius_cm/100}m centerline radius. Native placement and joints require inspection.`,layout_schema:'aifactory.generated-blueprint/v6',buildables,commit:true}};
}
