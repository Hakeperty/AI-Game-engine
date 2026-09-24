"""
Builds a realistic human from the MakeHuman CC0 base with MPFB (Blender extension) and exports a skinned GLB
with facial blend shapes, which @aige/modeling humanoidFromMakeHuman() turns into an AIGE humanoid.

    blender --background --python tools/makehuman/build_human.py -- <config.json> <out.glb>

config.json:
    { "assets": "V:/AI/makehuman/system_assets",
      "macro": { "gender": 1.0, "age": 0.34, "muscle": 0.55, "weight": 0.42, "proportions": 0.6, "height": 0.68,
                 "cupsize": 0.5, "firmness": 0.5, "race": { "african": 0.0, "asian": 0.0, "caucasian": 1.0 } },
      "targets": { "<modelling target name>": 0.5 },
      "skin": "skins/young_caucasian_male/young_caucasian_male.mhmat",
      "expressions": "caucasian",
      "parts": [ ["Eyes", "eyes/high-poly/high-poly.mhclo"], ["Hair", "hair/short02/short02.mhclo"], ... ] }

The MakeHuman "default" rig is used because it has a jaw. Its rest pose (arms about 47 degrees below
horizontal) is close enough to the AIGE bind A-pose (50) for the clips. "expressions" loads MakeHuman's
expression units (eye closure, brows, mouth open, corner puller, retraction...) as blend shapes, carried over
to the eyebrows, lashes and other proxies, so faces can blink and show fear or pain.
"""

import glob
import json
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
cfg = json.load(open(argv[0], encoding="utf-8"))
out = os.path.abspath(argv[1])
root = cfg["assets"]

from bl_ext.blender_org.mpfb.services.faceservice import FaceService  # noqa: E402
from bl_ext.blender_org.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.blender_org.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.blender_org.mpfb.services.targetservice import TargetService  # noqa: E402

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def bake_shape_keys(o):
    """Fold the current shape key mix into the mesh and drop the keys."""
    if not o.data.shape_keys:
        return
    o.shape_key_add(name="mix", from_mix=True)
    for kb in list(o.data.shape_keys.key_blocks)[:-1]:
        o.shape_key_remove(kb)
    o.shape_key_remove(o.data.shape_keys.key_blocks[0])


# body shape first, baked, so the expression targets below are the only shape keys
basemesh = HumanService.create_human(macro_detail_dict=cfg["macro"], scale=0.1, feet_on_ground=True)
for name, value in cfg.get("targets", {}).items():
    TargetService.set_target_value(basemesh, name, value)
bpy.context.view_layer.update()
bake_shape_keys(basemesh)

rig = HumanService.add_builtin_rig(basemesh, "default", import_weights=True)
if cfg.get("skin"):
    HumanService.set_character_skin(os.path.join(root, cfg["skin"]), basemesh, skin_type="GAMEENGINE")
for asset_type, rel in cfg.get("parts", []):
    HumanService.add_mhclo_asset(os.path.join(root, rel), basemesh, asset_type=asset_type, subdiv_levels=0, material_type="MAKESKIN")

# facial expression units as blend shapes, carried to the proxies (brows, lashes, eyes, teeth...)
if cfg.get("expressions"):
    units = LocationService.get_mpfb_data(os.path.join("targets", "expression", "units", cfg["expressions"]))
    for path in sorted(glob.glob(os.path.join(units, "*.target.gz"))):
        name = os.path.basename(path)[: -len(".target.gz")].replace("-", "_")
        TargetService.load_target(basemesh, path, weight=0.0, name=name)
    FaceService.interpolate_targets(basemesh)
bpy.context.view_layer.update()

# mask modifiers hide helper geometry and the skin under clothes; delete those vertices instead (keeps shape keys)
for o in [o for o in bpy.data.objects if o.type == "MESH"]:
    masks = [m for m in o.modifiers if m.type == "MASK" and m.vertex_group]
    if not masks:
        continue
    drop = set()
    for m in masks:
        vg = o.vertex_groups.get(m.vertex_group)
        if vg is None:
            continue
        inside = set()
        for v in o.data.vertices:
            for g in v.groups:
                if g.group == vg.index and g.weight > 0.0:
                    inside.add(v.index)
        drop |= inside if m.invert_vertex_group else set(range(len(o.data.vertices))) - inside
    for m in masks:
        o.modifiers.remove(m)
    if drop:
        for v in o.data.vertices:
            v.select = v.index in drop
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="VERT")
        bpy.ops.mesh.delete(type="VERT")
        bpy.ops.object.mode_set(mode="OBJECT")
    print("mesh", o.name, "vertices", len(o.data.vertices), "shape keys", len(o.data.shape_keys.key_blocks) - 1 if o.data.shape_keys else 0)

for n in ("spine05", "neck01", "head", "jaw", "upperarm01.L", "wrist.L", "upperleg01.L", "foot.L"):
    b = rig.data.bones[n]
    print("joint", n, tuple(round(v, 3) for v in (rig.matrix_world @ b.head_local)))
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=False,
    export_skins=True,
    export_animations=False,
    export_morph=True,
    export_morph_normal=False,
    export_yup=True,
    export_image_format="NONE",
    export_def_bones=False,
)
print("wrote", out)
