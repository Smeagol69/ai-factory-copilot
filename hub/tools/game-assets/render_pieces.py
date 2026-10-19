# Renders a Satisfactory piece list with the game's real meshes (exported from the
# game's own packages by GameAssets.exe) in Blender. Every piece is placed at its
# exact pose; each class draws the meshes its game class draws, with the component
# transforms the game uses. Nothing is approximated: a class with no exported mesh is
# reported and drawn as a red marker cube.
#
#   blender -b -P render_pieces.py -- <manifest.json> <pieces.json> <out.png> [--view interior|exterior|both] [--title T]
import bpy, json, math, os, sys
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
manifest_path, pieces_path, out_path = argv[0], argv[1], argv[2]
view = argv[argv.index('--view') + 1] if '--view' in argv else 'both'
zoom = float(argv[argv.index('--zoom') + 1]) if '--zoom' in argv else 1.0
manifest = json.load(open(manifest_path, encoding='utf-8-sig'))
data = json.load(open(pieces_path, encoding='utf-8-sig'))
pieces = data['pieces'] if isinstance(data, dict) else data
mesh_root = os.path.dirname(manifest_path)

# Unreal: centimetres, left-handed (X forward, Y right, Z up). Blender: metres, right-handed.
FLIP = Matrix.Diagonal((1, -1, 1, 1))
def ue_matrix(loc, quat, scale):
    q = Quaternion((quat['w'], quat['x'], quat['y'], quat['z']))
    m = Matrix.Translation(Vector((loc['x'], loc['y'], loc['z'])) * 0.01) @ q.to_matrix().to_4x4() @ Matrix.Diagonal((scale['x'], scale['y'], scale['z'], 1))
    return FLIP @ m @ FLIP

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
library = bpy.data.collections.new('library'); scene.collection.children.link(library)
built = bpy.data.collections.new('build'); scene.collection.children.link(built)

def material(name, rgb, emit=0.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.55
    if emit:
        b.inputs['Emission Color'].default_value = (*rgb, 1); b.inputs['Emission Strength'].default_value = emit
    return m
def material_for(cls):
    n = cls.split('.')[-1].lower()
    if any(k in n for k in ('light', 'emissive', 'lamp', 'flood')): return material('light', (1.0, 0.78, 0.42), 6.0)
    if any(k in n for k in ('steel', 'beam', 'pillar', 'metal')): return material('steel', (0.18, 0.19, 0.21))
    if 'wall' in n: return material('wall', (0.42, 0.44, 0.47))
    return material('concrete', (0.62, 0.6, 0.56))

# The exported material descriptions (MI_*.json) and textures (*.png), found by name.
pngs, mats_json = {}, {}
for root, _, files in os.walk(mesh_root):
    for f in files:
        if f.endswith('.png'): pngs[f[:-4]] = os.path.join(root, f)
        elif f.endswith('.json') and f != 'manifest.json': mats_json[f[:-5]] = os.path.join(root, f)

def tex_name(ref):
    name = (ref or {}).get('ObjectName', '')
    return name.split("'")[1] if "'" in name else None

def game_material(mat):
    """Rebuild an imported (empty) material from the game's own texture slots."""
    info = mats_json.get(mat.name.split('.')[0])
    if not info: return False
    textures = json.load(open(info, encoding='utf-8-sig')).get('Textures', {})
    def pick(*keys):
        for k in keys:
            path = pngs.get(tex_name(textures.get(k)))
            if path: return path
        return None
    diffuse = pick('PM_Diffuse', 'Albedo', 'Diffuse', 'BaseColor', 'Base Color')
    normal = pick('PM_Normals', 'Normal', 'Normals')
    emissive = pick('Emissive', 'EmissiveTexture', 'PM_Emissive', 'Emission')
    if not diffuse and not emissive: return False
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF') or nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = nt.nodes.get('Material Output') or nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Metallic'].default_value = 0.0; bsdf.inputs['Roughness'].default_value = 0.7
    def image(path, colour=True):
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(path, check_existing=True)
        if not colour: n.image.colorspace_settings.name = 'Non-Color'
        return n
    if diffuse: nt.links.new(image(diffuse).outputs['Color'], bsdf.inputs['Base Color'])
    if normal:
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(image(normal, False).outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emissive:
        nt.links.new(image(emissive).outputs['Color'], bsdf.inputs['Emission Color']); bsdf.inputs['Emission Strength'].default_value = 4.0
    return True

meshes = {}  # mesh object path -> mesh datablock (in Blender space, metres)
def load_mesh(path):
    if path in meshes: return meshes[path]
    file = manifest['meshFiles'].get(path)
    if not file or not os.path.exists(file): meshes[path] = None; return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=file)
    new = [o for o in bpy.data.objects if o not in before]
    parts = [o for o in new if o.type == 'MESH']
    for o in parts:  # bake the importer's node transforms into the mesh data
        o.data.transform(o.matrix_world); o.matrix_world = Matrix.Identity(4)
    if len(parts) > 1:
        bpy.ops.object.select_all(action='DESELECT')
        for o in parts: o.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]; bpy.ops.object.join(); parts = [bpy.context.view_layer.objects.active]
    mesh = parts[0].data if parts else None
    if mesh:
        for m in mesh.materials:
            if m and not game_material(m): mesh.materials.clear(); break
    for o in new: bpy.data.objects.remove(o, do_unlink=True)
    meshes[path] = mesh
    return mesh

missing, drawn, skipped = set(), 0, 0
marker = None
for p in pieces:
    cls = p['class_path']; t = p['transform']
    if any(k in cls for k in ('PowerLine', 'Pipeline', 'ConveyorBelt', 'Wire', 'Railroad', 'Hypertube')): skipped += 1; continue
    world = ue_matrix(t['translation_cm'], t['rotation_quat'], t.get('scale3d') or {'x': 1, 'y': 1, 'z': 1})
    comps = (manifest['classes'].get(cls) or {}).get('components') or []
    placed = False
    for c in comps:
        mesh = load_mesh(c['mesh'])
        if mesh is None: continue
        o = bpy.data.objects.new(cls.split('.')[-1], mesh); built.objects.link(o)
        o.matrix_world = world @ ue_matrix(c['location'], c['rotation_quat'], c['scale'])
        if not o.data.materials: o.data.materials.append(material_for(cls))  # keep the game material when exported
        elif any(k in cls.lower() for k in ('light', 'emissive', 'lamp')):
            # Light fixtures glow: their game texture drives the emission (lit, as in game at night).
            for m in o.data.materials:
                # Only the fixture's own light materials; shared structural materials stay unlit.
                if not m or not any(k in m.name.lower() for k in ('emis', 'light', 'glow', 'lamp', 'led', 'neon')): continue
                b = m.node_tree.nodes.get('Principled BSDF') if m and m.node_tree else None
                if b and b.inputs['Emission Strength'].default_value == 0:
                    src = b.inputs['Base Color'].links[0].from_socket if b.inputs['Base Color'].links else None
                    if src: m.node_tree.links.new(src, b.inputs['Emission Color'])
                    b.inputs['Emission Strength'].default_value = 2.5
        placed = True
    if placed and p.get('label'):
        # A number above the piece (palette sheets), standing up to face the camera side.
        curve = bpy.data.curves.new('label', 'FONT'); curve.body = str(p['label']); curve.size = 1.6; curve.align_x = 'CENTER'
        tobj = bpy.data.objects.new('label', curve); built.objects.link(tobj)
        tobj.location = world.translation + Vector((0, 0, p.get('label_height', 6.0))); tobj.rotation_euler = (math.radians(90), 0, 0)
        curve.materials.append(material('label', (1.0, 1.0, 1.0), 3.0))
    if placed:
        drawn += 1
        if any(k in cls.lower() for k in ('light', 'flood', 'emissive', 'lamp')):
            l = bpy.data.objects.new('lamp', bpy.data.lights.new('lamp', 'POINT')); built.objects.link(l)
            l.data.energy = 2500; l.data.color = (1.0, 0.82, 0.55); l.data.shadow_soft_size = 0.5
            l.matrix_world = world @ Matrix.Translation((0, 0, -0.6))
        continue
    missing.add(cls.split('.')[-1])
    if marker is None:
        bpy.ops.mesh.primitive_cube_add(size=0.6); marker = bpy.context.active_object.data; bpy.data.objects.remove(bpy.context.active_object)
        marker.materials.append(material('missing', (0.9, 0.2, 0.15), 2.0))
    o = bpy.data.objects.new('missing', marker); built.objects.link(o); o.matrix_world = world

# Frame, light and render.
corners = [o.matrix_world @ Vector(c) for o in built.objects for c in o.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
centre, size = (lo + hi) / 2, (hi - lo)
world_bg = bpy.data.worlds.new('world'); scene.world = world_bg; world_bg.use_nodes = True
world_bg.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.055, 0.075, 1)
world_bg.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); scene.collection.objects.link(sun)
sun.data.energy = 2.5; sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x, scene.render.resolution_y = 1600, 900
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = float(argv[argv.index('--exposure') + 1]) if '--exposure' in argv else -1.0

def shoot(name, eye, target, lens):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name)); scene.collection.objects.link(cam)
    cam.location = eye; cam.data.lens = lens; cam.data.clip_end = 5000
    cam.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    path = out_path.replace('.png', f'-{name}.png') if view == 'both' else out_path
    scene.render.filepath = path; bpy.ops.render.render(write_still=True)
    return path

outs = []
span = max(size.x, size.y, size.z)
if view in ('exterior', 'both'):
    outs.append(shoot('exterior', centre + Vector((span * 1.1, -span * 1.3, span * 0.8)) * zoom, centre, 35))
if view in ('interior', 'both') and isinstance(data, dict) and data.get('camera'):
    # A camera the design gives (Unreal cm): eye and look-at point.
    cam = data['camera']; to_b = lambda p: Vector((p['x'] * 0.01, -p['y'] * 0.01, p['z'] * 0.01))
    outs.append(shoot('interior', to_b(cam['eye']), to_b(cam['look']), cam.get('lens', 16)))
elif view in ('interior', 'both'):
    # Along the tunnel: the main direction of the piece positions; eye on the floor, looking down the run.
    # Stand on the walkway: from the middle of the build, find the floor below, then
    # the longest open direction (down the tunnel), and look along it from one end.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    def hit(origin, direction, far=10000.0):
        ok, loc, *_ = scene.ray_cast(depsgraph, origin, direction.normalized(), distance=far)
        return (loc - origin).length if ok else far
    start = Vector((centre.x, centre.y, centre.z))
    floor_z = start.z - hit(start, Vector((0, 0, -1)))
    eye = Vector((centre.x, centre.y, floor_z + 1.7))
    best = max((Vector((math.cos(math.radians(a)), math.sin(math.radians(a)), 0)) for a in range(0, 360, 5)), key=lambda d: hit(eye, d))
    # Step back toward the near end, but stay inside the build (open ends have no wall to stop the ray).
    inside = min((eye - lo).dot(-best) if -best.x + -best.y > 0 else 1e9, 1e9)
    half_run = abs(Vector((size.x, size.y, 0)).dot(Vector((abs(best.x), abs(best.y), 0)))) / 2
    back = min(hit(eye, -best), half_run * 0.85)
    eye = eye - best * max(back - 1.0, 0.0)
    outs.append(shoot('interior', eye, eye + best * 10 + Vector((0, 0, 0.9)), 16))
print(json.dumps({'drawn': drawn, 'skipped_splines': skipped, 'missing_mesh': sorted(missing), 'renders': outs, 'size_m': [round(size.x, 2), round(size.y, 2), round(size.z, 2)]}))

