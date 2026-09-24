import { type ComponentData, type Entity, localMatrix, type SceneDoc } from '@aige/core';
import { Matrix4 } from 'three';
import {
  color,
  ext,
  type GdValue,
  nodeName,
  pascal,
  Raw,
  strings,
  sub,
  TscnWriter,
  transform3d,
  vec2,
  vec3,
} from './tscn.ts';

type V3 = [number, number, number];

export interface ModelRef {
  /** res:// path of the baked GLB. */
  res: string;
  /** Model-space bounds, used for 'auto' colliders. */
  bounds?: { min: V3; max: V3 };
  /** Collider hint baked into the recipe (setCollider). */
  collider?: { shape: string; size?: V3; radius?: number; height?: number; offset?: V3 } | null;
  /** Model-space triangle soup (x,y,z per corner) for 'mesh' and 'convex' colliders. */
  triangles?: () => number[] | null;
  /** Name of the GLB's root node and its transparent parts (glass), which must not cast shadows. */
  root?: string;
  noShadowParts?: string[];
  /** Shared Godot materials per part (res:// .tres), assigned to each of the part's surfaces. */
  /** Per-part material overrides; `part` is the node path under the GLB root ('hoodie', 'Skeleton3D/hoodie'). */
  partMaterials?: { part: string; surfaces: number; material: string }[];
}

const packedVec3 = (xyz: number[]) =>
  new Raw(`PackedVector3Array(${xyz.map((v) => String(Math.round(v * 10000) / 10000)).join(', ')})`);

/** What the scene exporter needs from the host (assets are baked before scenes are written). */
export interface SceneExportContext {
  /** The baked GLB for an entity's MeshRenderer (null when it has no model or the build failed). */
  model(entity: Entity, meshRenderer: ComponentData): ModelRef | null;
  /** res:// path of a StandardMaterial3D .tres for a 'materials/x.material.json' path (primitives). */
  material(path: string): string | null;
  /** Base class of a project C# script, e.g. 'CharacterBody3D' (parsed from its source). */
  scriptBase(csPath: string): string | null;
  /** res:// audio stream for an AudioSource (clip file, baked ambience or sfx). */
  audio(source: ComponentData): string | null;
}

export interface SceneExportResult {
  tscn: string;
  warnings: string[];
  nodes: number;
  /** Environment resources to write (project-relative path + .tres text), one per Environment component. */
  environments: { path: string; tres: string; entity: string }[];
}

/** Built-in C# scripts shipped in addons/aige/Builtins and the node type each one extends. */
export const BUILTIN_SCRIPTS: Record<string, string> = {
  PlayerController: 'CharacterBody3D',
  ThirdPersonCamera: 'Node3D',
  Rotator: 'Node3D',
};

/** AIGE components that become a child node running addons/aige/Components/<Type>.cs. */
export const COMPONENT_SCRIPTS = ['Interactable', 'Door', 'Trigger', 'ParticleSystem', 'Animator'] as const;

const BODY_TYPES = new Set(['CharacterBody3D', 'RigidBody3D', 'AnimatableBody3D', 'StaticBody3D']);
const ADDON = 'res://addons/aige';
const res = (p: string) => (p.startsWith('res://') ? p : `res://${p.replace(/^\.?\//, '')}`);

/** Converts script props to Godot values: [x,y,z] → Vector3, [x,y] → Vector2, '#rrggbb' → Color. */
export function propValue(v: unknown): GdValue {
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
    if (v.length === 3) return vec3(v as number[]);
    if (v.length === 2) return vec2(v[0] as number, v[1] as number);
  }
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return color(v);
  if (v === undefined) return null;
  return v as GdValue;
}

/** AIGE schema fields → C# [Export] props (PascalCase; asset paths become res:// paths). */
function componentProps(c: ComponentData, assetKeys: string[] = []): Record<string, GdValue> {
  const out: Record<string, GdValue> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'type' || v === undefined || v === null) continue;
    if (assetKeys.includes(k) && typeof v === 'string') out[pascal(k)] = res(v);
    else if (Array.isArray(v) && assetKeys.includes(k))
      out[pascal(k)] = strings(v.map((x) => res(String(x))));
    else out[pascal(k)] = propValue(v);
  }
  return out;
}

const ASSET_KEYS: Record<string, string[]> = {
  Interactable: ['cutscene'],
  Trigger: ['cutscene', 'sound'],
  Animator: ['clips'],
};

function translation(offset: readonly number[]): Raw {
  return transform3d(new Matrix4().makeTranslation(offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0).elements);
}

/** Converts one AIGE scene to a Godot scene. */
export function sceneToTscn(scene: SceneDoc, ctx: SceneExportContext): SceneExportResult {
  const w = new TscnWriter();
  const warnings: string[] = [];
  const rootName = nodeName(scene.name || 'Scene');
  w.node({ name: rootName, type: 'Node3D', props: { 'metadata/aige_scene': scene.name } });

  const byParent = new Map<string | null, Entity[]>();
  const ids = new Set(scene.entities.map((e) => e.id));
  for (const e of scene.entities) {
    const p = e.parent && ids.has(e.parent) ? e.parent : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(e);
  }
  const usedNames = new Map<string, Set<string>>();
  const unique = (parentPath: string, name: string) => {
    let set = usedNames.get(parentPath);
    if (!set) usedNames.set(parentPath, (set = new Set()));
    let n = nodeName(name);
    for (let i = 2; set.has(n); i++) n = `${nodeName(name)}_${i}`;
    set.add(n);
    return n;
  };
  const child = (parentPath: string, name: string) => {
    const n = unique(parentPath, name);
    return { name: n, path: parentPath === '.' ? n : `${parentPath}/${n}` };
  };

  const environments: { entity: Entity; env: ComponentData }[] = [];
  const ambient: { color: string; energy: number }[] = [];

  const shapeFor = (c: ComponentData, model: ModelRef | null): { shape: string; offset: number[] } | null => {
    const offset = (c.offset as number[]) ?? [0, 0, 0];
    let kind = c.shape as string;
    let size = (c.size as number[]) ?? [1, 1, 1];
    let radius = (c.radius as number) ?? 0.5;
    let height = (c.height as number) ?? 1;
    let base = [0, 0, 0];
    if (kind === 'mesh' || kind === 'convex') {
      const tris = model?.triangles?.();
      if (tris?.length) {
        if (kind === 'mesh')
          return { shape: w.sub('ConcavePolygonShape3D', { data: packedVec3(tris) }), offset };
        const seen = new Set<string>();
        const pts: number[] = [];
        for (let i = 0; i < tris.length; i += 3) {
          const k = `${tris[i]!.toFixed(3)},${tris[i + 1]!.toFixed(3)},${tris[i + 2]!.toFixed(3)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          pts.push(tris[i]!, tris[i + 1]!, tris[i + 2]!);
        }
        return { shape: w.sub('ConvexPolygonShape3D', { points: packedVec3(pts) }), offset };
      }
    }
    if (kind === 'auto' || kind === 'convex' || kind === 'mesh') {
      const hint = model?.collider;
      if (hint && kind === 'auto') {
        kind =
          hint.shape === 'cylinder' || hint.shape === 'sphere' || hint.shape === 'capsule'
            ? hint.shape
            : 'box';
        size = hint.size ?? size;
        radius = hint.radius ?? (hint.size ? Math.max(hint.size[0], hint.size[2]) / 2 : radius);
        height = hint.height ?? hint.size?.[1] ?? height;
        base = hint.offset ?? base;
      } else if (model?.bounds) {
        const { min, max } = model.bounds;
        size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        base = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
        if (kind !== 'auto') warnings.push(`'${c.shape}' collider exported as its bounding box.`);
        kind = 'box';
      } else {
        kind = 'box';
      }
    }
    let shape: string;
    switch (kind) {
      case 'sphere':
        shape = w.sub('SphereShape3D', { radius });
        break;
      case 'capsule':
        shape = w.sub('CapsuleShape3D', { radius, height: Math.max(height, radius * 2) });
        break;
      case 'cylinder':
        shape = w.sub('CylinderShape3D', { radius, height });
        break;
      default:
        shape = w.sub('BoxShape3D', { size: vec3(size.map((s) => Math.max(s, 0.001))) });
    }
    return { shape, offset: [base[0]! + offset[0]!, base[1]! + offset[1]!, base[2]! + offset[2]!] };
  };

  const addShapes = (parentPath: string, colliders: ComponentData[], model: ModelRef | null) => {
    for (const c of colliders) {
      const s = shapeFor(c, model);
      if (!s) continue;
      const n = child(parentPath, 'Shape');
      w.node({
        name: n.name,
        type: 'CollisionShape3D',
        parent: parentPath,
        props: { transform: translation(s.offset), shape: sub(s.shape) },
      });
    }
  };

  const visit = (e: Entity, parentPath: string) => {
    const comps = e.components;
    const get = (t: string) => comps.find((c) => c.type === t);
    const all = (t: string) => comps.filter((c) => c.type === t);
    const scripts = all('Script').filter((s) => s.enabled !== false);
    const mr = get('MeshRenderer');
    const model = mr?.model ? ctx.model(e, mr) : null;
    if (mr?.model && !model) warnings.push(`${e.name}: model '${mr.model}' could not be baked.`);

    // Node type and the script that runs on the entity node itself.
    let type = 'Node3D';
    let nodeScript: { path: string; props: Record<string, GdValue> } | null = null;
    const extraScripts: { name: string; base: string; path: string; props: Record<string, GdValue> }[] = [];
    const cc = get('CharacterController');
    const rb = get('RigidBody');
    if (cc) type = 'CharacterBody3D';
    else if (rb)
      type =
        rb.kind === 'dynamic' ? 'RigidBody3D' : rb.kind === 'kinematic' ? 'AnimatableBody3D' : 'StaticBody3D';
    else if (get('Door')) type = 'AnimatableBody3D';
    for (const s of scripts) {
      const src = String(s.script);
      let base: string | null;
      let path: string;
      let props: Record<string, GdValue>;
      if (src.startsWith('builtin:')) {
        const name = src.slice(8);
        base = BUILTIN_SCRIPTS[name] ?? null;
        if (!base) {
          warnings.push(
            `${e.name}: built-in script '${name}' has no Godot version (have: ${Object.keys(BUILTIN_SCRIPTS).join(', ')}).`,
          );
          continue;
        }
        path = `${ADDON}/Builtins/${name}.cs`;
        props = Object.fromEntries(
          Object.entries((s.props as Record<string, unknown>) ?? {}).map(([k, v]) => [
            pascal(k),
            propValue(v),
          ]),
        );
      } else if (src.endsWith('.cs')) {
        base = ctx.scriptBase(src);
        if (!base) {
          warnings.push(`${e.name}: could not find the class in '${src}'.`);
          continue;
        }
        path = res(src);
        props = Object.fromEntries(
          Object.entries((s.props as Record<string, unknown>) ?? {}).map(([k, v]) => [k, propValue(v)]),
        );
      } else {
        warnings.push(`${e.name}: '${src}' is a TypeScript script; Godot games use C# (scripts/*.cs).`);
        continue;
      }
      const compatible =
        !nodeScript &&
        (base === type ||
          (type === 'Node3D' && (base === 'Node3D' || BODY_TYPES.has(base) || base === 'Node')));
      if (compatible) {
        if (type === 'Node3D' && base !== 'Node') type = base;
        nodeScript = { path, props };
      } else {
        const name = path.split('/').pop()!.replace(/\.cs$/, '');
        extraScripts.push({ name, base: base === 'Node' ? 'Node' : 'Node3D', path, props });
        if (BODY_TYPES.has(base) && base !== type)
          warnings.push(
            `${e.name}: script '${src}' extends ${base} but the entity is a ${type}; it runs on a child node.`,
          );
      }
    }

    const me = child(parentPath, e.name);
    const props: Record<string, GdValue | undefined> = {
      transform: transform3d(localMatrix(e.transform).elements),
      visible: e.active ? undefined : false,
      // Inactive entities neither render nor run (ambience, triggers) until a cutscene or script enables them.
      process_mode: e.active ? undefined : 4,
      'metadata/aige_id': e.id,
      'metadata/aige_tags': e.tags.length ? strings(e.tags) : undefined,
    };
    if (nodeScript) {
      props.script = ext(w.ext('Script', nodeScript.path));
      Object.assign(props, nodeScript.props);
    }
    if (cc) {
      props.floor_max_angle = (((cc.maxSlope as number) ?? 50) * Math.PI) / 180;
      props.floor_snap_length = (cc.snapToGround as number) ?? 0.3;
    }
    if (type === 'RigidBody3D' && rb) {
      Object.assign(props, {
        mass: rb.mass as number,
        linear_damp: (rb.linearDamping as number) || undefined,
        angular_damp: rb.angularDamping as number,
        gravity_scale: rb.gravityScale as number,
        lock_rotation: rb.lockRotation ? true : undefined,
        continuous_cd: rb.ccd ? true : undefined,
      });
    }
    w.node({ name: me.name, type, parent: parentPath, groups: e.tags, props });

    // Collision
    const colliders = all('Collider');
    const solid = colliders.filter((c) => !c.isTrigger);
    const triggers = colliders.filter((c) => c.isTrigger);
    if (cc) {
      const height = (cc.height as number) ?? 1.8;
      const radius = (cc.radius as number) ?? 0.4;
      const shape = w.sub('CapsuleShape3D', { radius, height });
      w.node({
        name: 'Shape',
        type: 'CollisionShape3D',
        parent: me.path,
        props: { transform: translation([0, height / 2, 0]), shape: sub(shape) },
      });
      usedNames.set(me.path, new Set(['Shape']));
    } else if (solid.length) {
      if (BODY_TYPES.has(type)) addShapes(me.path, solid, model);
      else {
        const body = child(me.path, 'Body');
        w.node({ name: body.name, type: 'StaticBody3D', parent: me.path });
        addShapes(body.path, solid, model);
      }
    }
    if (triggers.length) {
      const area = child(me.path, 'Area');
      w.node({
        name: area.name,
        type: 'Area3D',
        parent: me.path,
        props: { collision_layer: 0, collision_mask: 1 },
      });
      addShapes(area.path, triggers, model);
    }

    // Mesh
    if (mr) {
      const hidden = mr.visible === false ? false : undefined;
      if (model) {
        const n = child(me.path, 'Mesh');
        w.node({
          name: n.name,
          parent: me.path,
          instance: w.ext('PackedScene', model.res),
          props: { visible: hidden },
        });
        // Per-part overrides on the instanced GLB: shared materials (each texture is imported once), and no
        // shadows from transparent parts (Godot lets glass cast solid shadows, which would block the moon).
        if (model.root) {
          const parts = new Map<string, Record<string, GdValue>>();
          const at = (p: string) => parts.get(p) ?? parts.set(p, {}).get(p)!;
          for (const pm of model.partMaterials ?? []) {
            const matId = w.ext('Material', pm.material);
            for (let i = 0; i < pm.surfaces; i++) at(pm.part)[`surface_material_override/${i}`] = ext(matId);
          }
          for (const part of model.noShadowParts ?? []) at(part).cast_shadow = 0;
          for (const [part, props] of parts) {
            // a part may sit deeper than the root, e.g. 'Skeleton3D/hoodie' for a skinned character
            const slash = part.lastIndexOf('/');
            const under = slash < 0 ? '' : `/${part.slice(0, slash)}`;
            w.node({ name: part.slice(slash + 1), parent: `${n.path}/${model.root}${under}`, props });
          }
        }
      } else if (!mr.model || !model) {
        const prim = (mr.primitive as string) ?? 'box';
        const matPath = mr.material ? ctx.material(mr.material as string) : null;
        const material = matPath
          ? ext(w.ext('Material', matPath))
          : sub(
              w.sub('StandardMaterial3D', {
                albedo_color: color((mr.color as string) ?? (mr.model ? '#ff00ff' : '#ffffff')),
                roughness: 0.7,
              }),
            );
        const mesh = primitiveMesh(w, prim);
        const n = child(me.path, 'Mesh');
        w.node({
          name: n.name,
          type: 'MeshInstance3D',
          parent: me.path,
          props: {
            mesh: sub(mesh),
            material_override: material,
            cast_shadow: mr.castShadow === false ? 0 : undefined,
            visible: hidden,
          },
        });
      }
    }

    // Light
    const light = get('Light');
    if (light) {
      const kind = light.kind as string;
      if (kind === 'ambient' || kind === 'hemisphere')
        ambient.push({ color: light.color as string, energy: light.intensity as number });
      else {
        const n = child(me.path, 'Light');
        const range = (light.range as number) || 20;
        const common: Record<string, GdValue | undefined> = {
          light_color: color(light.color as string),
          light_energy: light.intensity as number,
          shadow_enabled: light.castShadow ? true : undefined,
        };
        let lt = 'DirectionalLight3D';
        if (kind === 'directional') {
          Object.assign(common, {
            light_angular_distance: 0.6,
            directional_shadow_max_distance: 60,
            shadow_blur: 1.5,
          });
        } else if (kind === 'point') {
          lt = 'OmniLight3D';
          Object.assign(common, { omni_range: range, light_size: 0.04, shadow_blur: 1.2 });
        } else {
          lt = 'SpotLight3D';
          Object.assign(common, {
            spot_range: range,
            spot_angle: light.angle as number,
            light_size: 0.04,
            shadow_blur: 1.2,
          });
        }
        w.node({ name: n.name, type: lt, parent: me.path, props: common });
        // Light3D can't be subclassed from C#, so the flicker runs on a child node that drives its parent light.
        if ((light.flicker as number) > 0)
          w.node({
            name: 'Flicker',
            type: 'Node',
            parent: n.path,
            props: {
              script: ext(w.ext('Script', `${ADDON}/Components/LightFlicker.cs`)),
              Amount: light.flicker as number,
            },
          });
      }
    }

    // Decals (grime, stains, mold) project along the node's -Y, like AIGE's
    for (const d of all('Decal')) {
      const n = child(me.path, 'Decal');
      const size = (d.size as number[]) ?? [1, 0.4, 1];
      w.node({
        name: n.name,
        type: 'Decal',
        parent: me.path,
        props: {
          size: vec3([size[0]!, size[1]!, size[2]!]),
          texture_albedo: ext(w.ext('Texture2D', res(d.texture as string))),
          modulate: color((d.color as string) ?? '#ffffff', (d.opacity as number) ?? 1),
          normal_fade: 0.4,
          upper_fade: 0.2,
          lower_fade: 0.2,
        },
      });
    }

    // Camera
    const cam = get('Camera');
    if (cam) {
      const n = child(me.path, 'Camera');
      w.node({
        name: n.name,
        type: 'Camera3D',
        parent: me.path,
        props: {
          fov: cam.fov as number,
          near: cam.near as number,
          far: cam.far as number,
          current: cam.primary !== false,
        },
      });
    }

    // Audio
    for (const a of all('AudioSource')) {
      const stream = ctx.audio(a);
      if (!stream) {
        warnings.push(`${e.name}: AudioSource has no clip, sfx or ambience.`);
        continue;
      }
      const n = child(me.path, 'Audio');
      const spatial = a.spatial === true;
      w.node({
        name: n.name,
        type: spatial ? 'AudioStreamPlayer3D' : 'AudioStreamPlayer',
        parent: me.path,
        props: {
          stream: ext(w.ext('AudioStream', stream)),
          max_distance: spatial ? (a.range as number) * 1.5 : undefined,
          unit_size: spatial ? Math.max(1, (a.range as number) / 4) : undefined,
          script: ext(w.ext('Script', `${ADDON}/Components/AudioSource.cs`)),
          Volume: a.volume as number,
          Loop: (a.loop as boolean) || !!a.ambience,
          PlayOnStart: a.playOnStart as boolean,
          Range: a.range as number,
        },
      });
    }

    // Gameplay components
    for (const type of COMPONENT_SCRIPTS) {
      for (const c of all(type)) {
        const n = child(me.path, type);
        w.node({
          name: n.name,
          type: 'Node3D',
          parent: me.path,
          props: {
            script: ext(w.ext('Script', `${ADDON}/Components/${type}.cs`)),
            ...componentProps(c, ASSET_KEYS[type]),
          },
        });
      }
    }
    for (const s of extraScripts) {
      const n = child(me.path, s.name);
      w.node({
        name: n.name,
        type: s.base,
        parent: me.path,
        props: { script: ext(w.ext('Script', s.path)), ...s.props },
      });
    }

    // Environments: each becomes godot/environments/<scene>-<entity>.tres; the first active one is the scene's
    const env = get('Environment');
    if (env) environments.push({ entity: e, env });
    if (get('UIText'))
      warnings.push(`${e.name}: UIText is not exported; use Hud.Say / Story objectives from C#.`);

    for (const c of byParent.get(e.id) ?? []) visit(c, me.path);
  };

  for (const e of byParent.get(null) ?? []) visit(e, '.');

  const envFiles: { path: string; tres: string; entity: string }[] = [];
  for (const { entity, env } of environments) {
    const file = `godot/environments/${nodeName(scene.name || 'scene')}-${nodeName(entity.name)}.tres`;
    envFiles.push({ path: file, tres: environmentTres(env, ambient), entity: entity.name });
  }
  const mainEnv =
    environments.findIndex((x) => x.entity.active) >= 0 ? environments.findIndex((x) => x.entity.active) : 0;
  const main = environments[mainEnv];
  if (main) {
    const n = (k: string, d: number) => (typeof main.env[k] === 'number' ? (main.env[k] as number) : d);
    w.node({
      name: unique('.', 'Environment'),
      type: 'WorldEnvironment',
      parent: '.',
      props: {
        environment: ext(w.ext('Environment', `res://${envFiles[mainEnv]!.path}`)),
        camera_attributes:
          n('autoExposure', 0.5) > 0
            ? sub(
                w.sub('CameraAttributesPractical', {
                  auto_exposure_enabled: true,
                  auto_exposure_scale: 0.2 + n('autoExposure', 0.5) * 0.5,
                  auto_exposure_speed: 0.6,
                  auto_exposure_min_sensitivity: 25,
                  auto_exposure_max_sensitivity: 1600,
                }),
              )
            : undefined,
        script: ext(w.ext('Script', `${ADDON}/Components/EnvironmentFx.cs`)),
        Vignette: n('vignette', 0.25),
        Grain: n('grain', 0.12),
        Temperature: n('temperature', 0),
        Tint: n('tint', 0),
        LightShafts: n('lightShafts', 0),
        Chromatic: n('chromaticAberration', 0),
      },
    });
  } else
    warnings.push('No Environment component: the scene uses Godot defaults (add one for a realistic look).');

  return { tscn: w.scene(), warnings, nodes: w.nodeCount, environments: envFiles };
}

function primitiveMesh(w: TscnWriter, prim: string): string {
  switch (prim) {
    case 'sphere':
      return w.sub('SphereMesh', { radius: 0.5, height: 1 });
    case 'cylinder':
      return w.sub('CylinderMesh', { top_radius: 0.5, bottom_radius: 0.5, height: 1 });
    case 'cone':
      return w.sub('CylinderMesh', { top_radius: 0, bottom_radius: 0.5, height: 1 });
    case 'capsule':
      return w.sub('CapsuleMesh', { radius: 0.25, height: 1 });
    case 'plane':
      return w.sub('PlaneMesh', { size: vec2(1, 1) });
    case 'torus':
      return w.sub('TorusMesh', { inner_radius: 0.35, outer_radius: 0.65 });
    default:
      return w.sub('BoxMesh', { size: vec3([1, 1, 1]) });
  }
}

const SKIES: Record<string, { top: string; horizon: string; ground: string; energy: number }> = {
  night: { top: '#04060c', horizon: '#10151f', ground: '#030304', energy: 0.35 },
  storm: { top: '#0a0d13', horizon: '#1b2029', ground: '#050506', energy: 0.4 },
  dawn: { top: '#35557f', horizon: '#e7a57a', ground: '#2b2622', energy: 1 },
  day: { top: '#3a6db3', horizon: '#a8c4e2', ground: '#3d3a35', energy: 1 },
  dusk: { top: '#1b274c', horizon: '#cf7a4d', ground: '#1d1a19', energy: 0.8 },
  overcast: { top: '#79818c', horizon: '#a1a6ad', ground: '#3a3937', energy: 0.8 },
};

const TONEMAP: Record<string, number> = { none: 0, neutral: 2, aces: 3, agx: 4, project: 4 };

/**
 * An Environment component as a standalone Godot Environment resource (.tres). Screen-space extras
 * (vignette, grain, temperature, tint, light shafts) ride along as `metadata/aige_fx` for EnvironmentFx.
 */
export function environmentTres(
  env: ComponentData,
  ambient: { color: string; energy: number }[] = [],
): string {
  const w = new TscnWriter();
  const n = (k: string, d: number) => (typeof env[k] === 'number' ? (env[k] as number) : d);
  let sky: string | undefined;
  const hdri = env.hdri as string | undefined;
  if (hdri) {
    const tex = w.ext('Texture2D', res(hdri));
    const mat = w.sub('PanoramaSkyMaterial', { panorama: ext(tex), energy_multiplier: n('skyEnergy', 1) });
    sky = w.sub('Sky', { sky_material: sub(mat) });
  } else if (env.sky && env.sky !== 'none') {
    const s = SKIES[env.sky as string] ?? SKIES.night!;
    const mat = w.sub('ProceduralSkyMaterial', {
      sky_top_color: color(s.top),
      sky_horizon_color: color(s.horizon),
      ground_bottom_color: color(s.ground),
      ground_horizon_color: color(s.horizon),
      sky_energy_multiplier: s.energy * n('skyEnergy', 1),
      ground_energy_multiplier: s.energy * n('skyEnergy', 1),
    });
    sky = w.sub('Sky', { sky_material: sub(mat) });
  }
  const fogColor = (env.fogColor as string) ?? '#1a1f2a';
  const amb = ambient.reduce((s, a) => s + a.energy, 0);
  return w.resource('Environment', {
    background_mode: sky ? 2 : 1,
    background_color: sky ? undefined : color(fogColor),
    sky: sky ? sub(sky) : undefined,
    sky_rotation: n('hdriRotation', 0) ? vec3([0, (n('hdriRotation', 0) * Math.PI) / 180, 0]) : undefined,
    ambient_light_source: sky ? 3 : 2,
    ambient_light_color: sky ? undefined : color(ambient[0]?.color ?? '#20242c'),
    ambient_light_energy: n('ambient', 1) * (amb > 0 ? Math.max(0.2, amb) : 1),
    tonemap_mode: TONEMAP[(env.toneMapping as string) ?? 'aces'] ?? 3,
    tonemap_exposure: n('exposure', 1),
    ssao_enabled: n('ssao', 0.8) > 0,
    ssao_radius: n('ssaoRadius', 0.35) * 2.5,
    ssao_intensity: n('ssao', 0.8) * 2.5,
    ssil_enabled: env.ssil !== false,
    sdfgi_enabled: (env.gi ?? 'sdfgi') === 'sdfgi',
    sdfgi_use_occlusion: true,
    sdfgi_min_cell_size: 0.1,
    glow_enabled: n('bloom', 0.25) > 0,
    glow_intensity: n('bloom', 0.25) * 2,
    glow_bloom: 0.05,
    glow_hdr_threshold: n('bloomThreshold', 0.9),
    fog_enabled: n('fogDensity', 0) > 0,
    fog_light_color: color(fogColor),
    fog_density: n('fogDensity', 0),
    fog_sky_affect: 0.5,
    fog_height: n('fogBaseHeight', 0),
    fog_height_density: n('fogHeightFalloff', 0.2),
    volumetric_fog_enabled: n('volumetricFog', 0) > 0,
    volumetric_fog_density: n('volumetricFog', 0),
    volumetric_fog_albedo: color(fogColor),
    volumetric_fog_length: 32,
    adjustment_enabled: true,
    adjustment_contrast: n('contrast', 1.05),
    adjustment_saturation: n('saturation', 1),
    'metadata/aige_fx': {
      vignette: n('vignette', 0.25),
      grain: n('grain', 0.12),
      temperature: n('temperature', 0),
      tint: n('tint', 0),
      lightShafts: n('lightShafts', 0),
      chromatic: n('chromaticAberration', 0),
    },
  });
}
