import {compileLevelTunnel} from './level-tunnel.mjs';
const LAMP='/Game/FactoryGame/Buildable/Factory/CeilingLight/Build_CeilingLight.Build_CeilingLight_C';
const BEAM='/SS_Mod/Builders/Beams/Build_EmissiveBeam_4x2.Build_EmissiveBeam_4x2_C';
// Native .3-scale fixture bounds overlapped on the inner row of the 64 m sweep.
// Keep a smaller intentional fixture, including its measured roof exposure.
const FITTED_LAMP_SCALE=.25;
const fail=reason=>({compiled:false,reason,gamePlacementVerified:false});
const flat=p=>{const q=p.transform.rotation_quat,s=p.transform.scale3d;return Math.abs(q.x)<.0001&&Math.abs(q.y)<.0001&&['x','y','z'].every(k=>s[k]===1);};
const yaw=q=>Math.atan2(2*q.w*q.z,1-2*q.z*q.z)*180/Math.PI;

// Separate undoable fixtures: the existing shell and player pipes stay put.
// Reuse v1's unconfigured native serializer; do not synthesize .sbp records.
export function compileTunnelLighting(graph,args={}){
 const shell=compileLevelTunnel(graph,{...args,fit_panel_lengths:false,straight_collars:false});
 if(!shell.compiled)return shell;
 const poses=args.reference.reference_traits.poses;
 const fixtures=poses.filter(p=>p.class_path===LAMP||p.class_path===BEAM);
 const finite=(o,keys)=>o&&keys.every(k=>typeof o[k]==='number'&&Number.isFinite(o[k]));
 if(fixtures.some(p=>!finite(p.transform?.translation_cm,['x','y','z'])||!finite(p.transform?.rotation_quat,['x','y','z','w'])||Math.abs(Math.hypot(...['x','y','z','w'].map(k=>p.transform.rotation_quat[k]))-1)>.0001||!finite(p.transform?.scale3d,['x','y','z'])))return fail('complete_valid_saved_fixture_poses_required');
 const lamps=poses.filter(p=>p.class_path===LAMP&&flat(p));
 const beams=poses.filter(p=>p.class_path===BEAM);
 if(lamps.length!==2||beams.length!==2||beams.some(p=>!flat(p)))return fail('two_flat_ceiling_lights_and_two_unit_planar_emissive_beams_required');
 const f=shell.reference_frame,u=f.longitudinal;
 const transverse=p=>-p.transform.translation_cm.x*u.y+p.transform.translation_cm.y*u.x-f.transverse_center_cm;
 for(const row of [lamps,beams])if(Math.abs(transverse(row[0])-transverse(row[1]))<1||Math.abs(row[0].transform.translation_cm.z-row[1].transform.translation_cm.z)>.1)return fail('distinct_level_reference_lighting_rows_required');
 const evidence=(graph.snapshot?.actors??[]).filter(a=>a.class_path===BEAM).map(a=>{
  const get=name=>{const p=a.reflected_properties?.find(p=>p.name===name&&p.declared_by==='/Script/FactoryGame.FGBuildableBeam'&&p.source==='unreal_reflection'&&p.certainty==='authoritative');return p?Number(p.value):NaN;};
  return {length:get('mDefaultLength'),current:get('mLength')};
 }).filter(e=>Number.isFinite(e.length)&&Number.isFinite(e.current));
 if(!evidence.length||evidence.some(e=>!Number.isFinite(e.length)||e.length<=0||!Number.isFinite(e.current)||(e.current!==0&&Math.abs(e.current-e.length)>.01)||Math.abs(e.length-evidence[0].length)>.01))return fail('consistent_unconfigured_native_beam_length_evidence_required');
 const recipes=new Map();
 for(const c of [LAMP,BEAM]){
  const matches=[...graph.recipesByClass.values()].filter(r=>r.available===true&&(r.produced_in??[]).some(v=>String(v).includes('BP_BuildGun'))&&(r.products??[]).some(p=>graph.itemsByClass.get(p.item_class)?.building?.class_path===c));
  if(matches.length!==1)return fail('one_exact_unlocked_build_recipe_required_per_lighting_class');recipes.set(c,matches[0].class_path);
 }
 const radius=args.radius_cm,sweep=args.turn_degrees*Math.PI/180,sign=Math.sign(sweep);
 const radii=[...lamps,...beams].map(p=>radius-sign*transverse(p));
 if(Math.min(...radii)<=evidence[0].length)return fail('lighting_inside_radius_too_small');
 const lampCount=Math.max(1,Math.ceil(Math.abs(sweep)*Math.max(...lamps.map(p=>radius-sign*transverse(p)))/shell.measured_pitch_cm));
 const fitted=args.fit_fixtures===true;
 const collars=args.straight_collars===true;
 if(collars&&!fitted)return fail('lighting_collars_require_fitted_fixtures');
 const beamCount=fitted?Math.ceil(Math.abs(args.turn_degrees)/2):Math.max(1,Math.ceil(Math.abs(sweep)*Math.max(...beams.map(p=>radius-sign*transverse(p)))/evidence[0].length));
 let roofPlane;
 if(fitted){
  // Measured native thickness, not an assumed 2 m roof. Keep the original
  // fixture's exposed fraction when shrinking it about its saved pivot.
  const top=poses.filter(p=>p.class_path.startsWith('/Game/FactoryGame/Buildable/Building/Foundation/')&&Math.abs(p.transform.translation_cm.z-f.highest_pivot_cm)<.1);
  const heights=top.map(p=>(graph.snapshot?.actors??[]).filter(a=>a.class_path===p.class_path).flatMap(a=>(a.reflected_properties??[]).filter(v=>v.name==='mHeight'&&v.declared_by==='/Script/FactoryGame.FGBuildableFoundation'&&v.source==='unreal_reflection'&&v.certainty==='authoritative').map(v=>Number(v.value)))).flat();
  if(!top.length||!heights.length||heights.some(v=>!Number.isFinite(v)||v<=0||Math.abs(v-heights[0])>.01))return fail('consistent_native_roof_thickness_required');
  roofPlane=f.highest_pivot_cm-heights[0]/2;
  if(beams.some(p=>Math.cos((yaw(p.transform.rotation_quat)-f.heading_degrees)*Math.PI/180)<.9999))return fail('forward_longitudinal_beam_axis_required');
 }
 const collarBeamCount=collars?Math.ceil(shell.measured_pitch_cm/evidence[0].length):0;
 if(2*lampCount+4*beamCount+(collars?4+8*collarBeamCount:0)>512)return fail('lighting_part_limit_exceeded');
 const buildables=[];
 const add=(p,row,count,z,startAtJoint)=>{
  const r=radius-sign*transverse(p);
  for(let j=0;j<count;j++){
   const a=(j+(startAtJoint?0:.5))*sweep/count,direction=(j+.5)*sweep/count;
   const heading=yaw(p.transform.rotation_quat)-f.heading_degrees+direction*180/Math.PI;
   const scale=startAtJoint?{x:2*r*Math.sin(Math.abs(sweep/count)/2)/evidence[0].length,y:1,z:1}:{x:FITTED_LAMP_SCALE,y:FITTED_LAMP_SCALE,z:FITTED_LAMP_SCALE};
   buildables.push({part_id:`${row}-${j+1}`,role:fitted&&startAtJoint?'beam':'standalone',recipe_class:recipes.get(p.class_path),relative_location:{x:(collars?shell.measured_pitch_cm:0)+sign*r*Math.sin(a),y:sign*(radius-r*Math.cos(a)),z},
    ...(fitted?{rotation_quat:{x:0,y:0,z:Math.sin(heading*Math.PI/360),w:Math.cos(heading*Math.PI/360)},scale3d:scale}:{yaw:heading})});
  }
  if(collars)for(const end of ['entry','exit']){
   const n=startAtJoint?collarBeamCount:1,heading=yaw(p.transform.rotation_quat)-f.heading_degrees+(end==='entry'?0:args.turn_degrees);
   for(let j=0;j<n;j++){
    const t=(j+(startAtJoint?0:.5))*shell.measured_pitch_cm/n;
    const relative_location=end==='entry'?{x:t,y:transverse(p),z}:
     {x:shell.measured_pitch_cm+sign*r*Math.sin(sweep)+t*Math.cos(sweep),y:sign*(radius-r*Math.cos(sweep))+t*Math.sin(sweep),z};
    buildables.push({part_id:`${row}-${end}${startAtJoint?'-'+(j+1):''}`,role:startAtJoint?'beam':'standalone',recipe_class:recipes.get(p.class_path),relative_location,
     rotation_quat:{x:0,y:0,z:Math.sin(heading*Math.PI/360),w:Math.cos(heading*Math.PI/360)},
     scale3d:startAtJoint?{x:shell.measured_pitch_cm/n/evidence[0].length,y:1,z:1}:{x:FITTED_LAMP_SCALE,y:FITTED_LAMP_SCALE,z:FITTED_LAMP_SCALE}});
   }
  }
 };
 lamps.forEach((p,i)=>add(p,`ceiling-${i+1}`,lampCount,(fitted?roofPlane+FITTED_LAMP_SCALE*(p.transform.translation_cm.z-roofPlane):p.transform.translation_cm.z)-f.floor_cm,false));
 for(const level of ['lower','upper'])beams.forEach((p,i)=>add(p,`reveal-${level}-${i+1}`,beamCount,level==='lower'?p.transform.translation_cm.z-f.floor_cm:f.highest_pivot_cm-p.transform.translation_cm.z,true));
 return {compiled:true,source_fingerprint:shell.source_fingerprint,ceiling_lights:2*lampCount+(collars?4:0),emissive_beams:4*beamCount+8*collarBeamCount,reference_frame:f,
  limitations:['native_default_beam_length_is_not_visual_mesh_clearance','roof_reveal_mirrors_measured_lower_reveal','native_fixture_geometry_and_power_require_live_verification','angled_reference_side_lights_not_copied'],gamePlacementVerified:false,
  proposal:{action:'generate_native_blueprint',blueprint_name:args.blueprint_name.trim(),layout_schema:`aifactory.generated-blueprint/v${fitted?8:1}`,description:`Measured tunnel lighting add-on; ${args.turn_degrees} degree turn. Separate from shell. Native placement, emissive reveals and power require live inspection.`,buildables,commit:true}};
}
