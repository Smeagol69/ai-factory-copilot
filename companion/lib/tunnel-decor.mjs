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
