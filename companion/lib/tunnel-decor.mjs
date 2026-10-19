import {compileLevelTunnel} from './level-tunnel.mjs';
// The game bounds-checks and reloads this real prop palette before world use.
export const TUNNEL_DECOR_ASSETS=Object.freeze(['Steel Wall Fan','Control Panel','M.A.M. Console','Tall Vent','Pioneer Crate','Pot 2','Ficus Plant']);
export function compileTunnelDecorPalette(graph,{blueprint_name}={}){
 if(typeof blueprint_name!=='string'||!blueprint_name.trim()||blueprint_name.length>240)return {compiled:false,reason:'explicit_blueprint_name_required'};
 const buildables=[];
 for(const [i,name] of TUNNEL_DECOR_ASSETS.entries()){
  const matches=[...graph.recipesByClass.values()].filter(r=>r.available===true&&
   (r.produced_in??[]).some(p=>p==='/Script/FactoryGame.FGBuildGun'||String(p).includes('BP_BuildGun'))&&
   (r.products??[]).length===1&&(r.products??[]).some(p=>{
    const item=graph.itemsByClass.get(p.item_class);return (item?.display_name??item?.name)===name&&item?.building?.class_path?.startsWith('/Factory_Prop_Mod/');
   }));
  if(matches.length!==1)return {compiled:false,reason:'one_exact_unlocked_decor_recipe_required',asset:name};
  buildables.push({part_id:`decor-sample-${i+1}`,role:'standalone',recipe_class:matches[0].class_path,relative_location:{x:i*2000,y:0,z:0},yaw:0});
 }
 return {compiled:true,assets:[...TUNNEL_DECOR_ASSETS],gamePlacementVerified:false,
  limitations:['native_bounds_and_pivots_require_measured_world_readback','palette_is_not_a_decorated_tunnel'],
  proposal:{action:'generate_native_blueprint',blueprint_name:blueprint_name.trim(),layout_schema:'aifactory.generated-blueprint/v1',description:'Industrial pedestrian-tunnel prop calibration palette. Exact unlocked Factory Props; native mesh bounds and pivots require live measurement. No railway.',buildables,commit:true}};
}

const finite=(v,keys)=>v&&keys.every(k=>typeof v[k]==='number'&&Number.isFinite(v[k]));
const refuse=reason=>({compiled:false,reason,gamePlacementVerified:false});
function measuredProp(graph,name){
 const recipes=[...graph.recipesByClass.values()].filter(r=>r.available===true&&(r.produced_in??[]).some(p=>p==='/Script/FactoryGame.FGBuildGun'||String(p).includes('BP_BuildGun'))&&(r.products??[]).length===1&&r.products.some(p=>{
  const i=graph.itemsByClass.get(p.item_class);return (i?.display_name??i?.name)===name&&i?.building?.class_path?.startsWith('/Factory_Prop_Mod/');
 }));
 if(recipes.length!==1)return null;
 const recipe=recipes[0],class_path=graph.itemsByClass.get(recipe.products[0].item_class).building.class_path;
 const samples=(graph.snapshot?.actors??[]).filter(a=>a.class_path===class_path&&a.kind==='buildable'&&finite(a.location,['x','y','z'])&&finite(a.rotation,['yaw','pitch','roll'])&&Object.values(a.rotation).every(v=>Math.abs(v)<.0001)&&finite(a.scale,['x','y','z'])&&Object.values(a.scale).every(v=>v===1)&&finite(a.bounds?.origin,['x','y','z'])&&finite(a.bounds?.extent,['x','y','z'])&&Object.values(a.bounds.extent).every(v=>v>0)).map(a=>({center:Object.fromEntries(['x','y','z'].map(k=>[k,a.bounds.origin[k]-a.location[k]])),extent:a.bounds.extent,actor_id:a.actor_id}));
 if(!samples.length||samples.some(s=>['x','y','z'].some(k=>Math.abs(s.center[k]-samples[0].center[k])>.1||Math.abs(s.extent[k]-samples[0].extent[k])>.1)))return null;
 return {name,class_path,recipe_class:recipe.class_path,...samples[0]};
}

// A separate, native-size utility-bay kit. Nothing touches the approved shell.
// Measurements come from captured unit/yaw-zero props and native floor dimensions.
export function compileIndustrialTunnelDecor(graph,args={}){
 const shell=compileLevelTunnel(graph,{...args,fit_panel_lengths:false});if(!shell.compiled)return shell;
 const f=shell.reference_frame,u=f.longitudinal,n={x:-u.y,y:u.x},poses=args.reference.reference_traits.poses;
 const floors=poses.filter(p=>p.class_path.startsWith('/Game/FactoryGame/Buildable/Building/Foundation/')&&Math.abs(p.transform.translation_cm.z-f.floor_cm)<.1&&1-2*(p.transform.rotation_quat.x**2+p.transform.rotation_quat.y**2)>.9999);
 const intervals=[];
 for(const p of floors){
  const samples=(graph.snapshot?.actors??[]).filter(a=>a.class_path===p.class_path).map(a=>['mWidth','mDepth','mHeight'].map(name=>{
   const v=a.reflected_properties?.find(v=>v.name===name&&v.declared_by==='/Script/FactoryGame.FGBuildableFoundation'&&v.source==='unreal_reflection'&&v.certainty==='authoritative');return v?Number(v.value):NaN;
  })).filter(s=>s.every(v=>Number.isFinite(v)&&v>0));
  if(!samples.length||samples.some(s=>s.some((v,i)=>Math.abs(v-samples[0][i])>.01)))return refuse('consistent_native_floor_dimensions_required');
  const [w,d,h]=samples[0],q=p.transform.rotation_quat,t=p.transform.translation_cm;
  const x={x:1-2*(q.y*q.y+q.z*q.z),y:2*(q.x*q.y+q.w*q.z)},y={x:2*(q.x*q.y-q.w*q.z),y:1-2*(q.x*q.x+q.z*q.z)};
  const half=(Math.abs(x.x*n.x+x.y*n.y)*w+Math.abs(y.x*n.x+y.y*n.y)*d)/2,c=t.x*n.x+t.y*n.y-f.transverse_center_cm;
  intervals.push({min:c-half,max:c+half,top:t.z+h/2-f.floor_cm});
 }
 if(!intervals.length||intervals.some(p=>Math.abs(p.top-intervals[0].top)>.1))return refuse('level_measured_floor_required');
 intervals.sort((a,b)=>a.min-b.min);let end=intervals[0].max;
 for(const p of intervals){if(p.min>end+.1)return refuse('continuous_measured_floor_required');end=Math.max(end,p.max);}
 const floor={min:intervals[0].min,max:end,top:intervals[0].top};
 const assets=['Tall Vent','M.A.M. Console','Pioneer Crate','Ficus Plant'].map(name=>measuredProp(graph,name));
 if(assets.some(a=>!a))return refuse('consistent_captured_unit_prop_bounds_required');
 const sweep=args.turn_degrees*Math.PI/180,sign=Math.sign(sweep),collar=args.straight_collars?shell.measured_pitch_cm:0,buildables=[],placements=[];
 // Stagger tall utilities, consoles, crates and greenery; reserve both wall pipe bands.
 const fractions=[[1/6,1/2,5/6],[1/3,2/3],[1/9,8/9],[1/18,17/18]];
 for(const [i,asset] of assets.entries())for(const fraction of fractions[i])for(const side of [-1,1]){
  const a=fraction*sweep,relativeYaw=i===3?0:-side*Math.PI/2,yaw=a+relativeYaw;
  const radialHalf=Math.abs(Math.sin(relativeYaw))*asset.extent.x+Math.abs(Math.cos(relativeYaw))*asset.extent.y;
  const offset=side*(600+100+radialHalf),radialMin=offset-radialHalf,radialMax=offset+radialHalf;
  if(radialMin<floor.min||radialMax>floor.max)return refuse('prop_does_not_fit_measured_side_bay');
  const z=floor.top-(asset.center.z-asset.extent.z),top=z+asset.center.z+asset.extent.z;
  if(top>=f.highest_pivot_cm-f.floor_cm)return refuse('prop_exceeds_measured_roof');
  const r=args.radius_cm-sign*offset,c=Math.cos(yaw),s=Math.sin(yaw),part_id=`utility-${i+1}-${Math.round(fraction*180)}-${side<0?'left':'right'}`;
  if(r<=shell.measured_pitch_cm)return refuse('decor_inside_radius_too_small');
  const center={x:collar+sign*r*Math.sin(a),y:sign*(args.radius_cm-r*Math.cos(a))};
  // Check the complete rectangular measured footprint against the curved floor
  // and corridor, including the small radial change at its tangent corners.
  for(const dx of [-asset.extent.x,asset.extent.x])for(const dy of [-asset.extent.y,asset.extent.y]){
   const px=center.x+c*dx-s*dy,py=center.y+s*dx+c*dy;
   const radial=sign*(args.radius_cm-Math.hypot(px-collar,py-sign*args.radius_cm));
   if(radial<floor.min||radial>floor.max||Math.abs(radial)<600)return refuse('prop_footprint_crosses_curved_floor_or_walkway');
  }
  buildables.push({part_id,role:'standalone',recipe_class:asset.recipe_class,relative_location:{x:center.x-c*asset.center.x+s*asset.center.y,y:center.y-s*asset.center.x-c*asset.center.y,z},yaw:yaw*180/Math.PI});
  placements.push({part_id,asset:asset.name,measurement_actor:asset.actor_id,radial_min_cm:radialMin,radial_max_cm:radialMax,floor_contact_cm:floor.top,top_cm:top});
 }
 return {compiled:true,gamePlacementVerified:false,source_fingerprint:shell.source_fingerprint,clear_walkway_width_cm:1200,placements,
  limitations:['wall_pipe_band_reserved','native_mesh_clearance_and_appearance_require_live_verification','separate_undoable_addon_not_a_finished_tunnel'],
  proposal:{action:'generate_native_blueprint',blueprint_name:args.blueprint_name.trim(),layout_schema:'aifactory.generated-blueprint/v1',description:'Measured industrial pedestrian-tunnel side bays: vents, consoles, crates and greenery; native-size props, central12m walking corridor reserved, no railway. Native fit and appearance require live verification.',buildables,commit:true}};
}
