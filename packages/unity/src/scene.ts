import type { ComponentData, Entity, SceneDoc } from '@aige/core';
import { type Quat, toUnityRotation, toUnityVector, toUnityYaw, type V3 } from './coords.ts';

/**
 * The scene description the Unity importer (Assets/Aige/Editor/AigeImporter.cs) turns into a `.unity`
 * scene. Everything here is already in Unity coordinates (left-handed, see coords.ts); component props
 * keep their AIGE names and values (the C# components convert angles where they need to).
 */
export interface UnitySceneDoc {
  format: 'aige.unity.scene';
  version: 1;
  name: string;
  /** Scene settings: ambient color/intensity, background color, killY. */
  settings: { ambientColor: string; ambientIntensity: number; background: string; killY: number };
  /** Ambient and hemisphere lights, folded into the environment's ambient light. */
  ambient: { color: string; intensity: number; ground?: string }[];
  /** Entity name of the Environment used at start (null = none). */
  mainEnvironment: string | null;
  entities: UnityEntity[];
}

export interface UnityCollider {
  shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'mesh' | 'convex';
  /** Center in the entity's local space (Unity coordinates). */
  center: V3;
  size: V3;
  radius: number;
  height: number;
  isTrigger: boolean;
  friction: number;
  restitution: number;
}

export interface UnityScript {
  /** 'builtin' = Assets/Aige/Runtime/Builtins/<name>.cs; 'cs' = a game script class. */
  kind: 'builtin' | 'cs';
  /** C# class name. */
  name: string;
  /** Project path of the game script (kind 'cs'). */
  path?: string;
  /** AIGE props; matched case-insensitively to public fields (walkSpeed → WalkSpeed). */
  props: Record<string, unknown>;
}

export interface UnityEntity {
  id: string;
  name: string;
  parent: string | null;
  active: boolean;
  tags: string[];
  position: V3;
  rotation: Quat;
  scale: V3;
  mesh?: {
    /** Project path of the baked model (.glb/.gltf), imported by glTFast. */
    model?: string;
    primitive?: string;
    color?: string;
    /** Project path of an exported MaterialDoc JSON (primitives). */
    material?: string;
    castShadow: boolean;
    receiveShadow: boolean;
    visible: boolean;
  };
  colliders?: UnityCollider[];
  character?: { height: number; radius: number; stepHeight: number; maxSlope: number; snapToGround: number };
  rigidbody?: {
    kind: 'dynamic' | 'kinematic' | 'fixed';
    mass: number;
    linearDamping: number;
    angularDamping: number;
    gravityScale: number;
    lockRotation: boolean;
    ccd: boolean;
  };
  light?: {
    type: 'directional' | 'point' | 'spot';
    color: string;
    intensity: number;
    range: number;
    angle: number;
    shadows: boolean;
    flicker: number;
  };
  camera?: { fov: number; near: number; far: number; primary: boolean };
  audio?: {
    /** Project path of the AudioClip asset. */
    clip: string;
    volume: number;
    loop: boolean;
    playOnStart: boolean;
    spatial: boolean;
    range: number;
  }[];
  /** AIGE gameplay components (Interactable, Door, Trigger, ParticleSystem, Animator) with AIGE props. */
  components?: { type: string; props: Record<string, unknown> }[];
  scripts?: UnityScript[];
  /** Environment component with Unity-ready values (see UnityEnvironment). */
  environment?: UnityEnvironment;
}

/** An AIGE Environment component. Fields keep AIGE names; directions are converted, the HDRI is an asset path. */
export interface UnityEnvironment {
  [key: string]: unknown;
  hdri?: string;
  sunDirection?: V3;
  hdriRotation?: number;
}

/** Model-space data for a baked model (AIGE coordinates). */
export interface UnityModelRef {
  /** Project path, e.g. 'Assets/AigeData/models/table-1a2b3c.gltf'. */
  asset: string;
  bounds?: { min: V3; max: V3 };
  collider?: { shape: string; size?: V3; radius?: number; height?: number; offset?: V3 } | null;
}

/** What the scene exporter needs from the host (assets are exported before scenes). */
export interface UnitySceneContext {
  model(entity: Entity, meshRenderer: ComponentData): UnityModelRef | null;
  /** Project path of the exported MaterialDoc JSON for 'materials/x.material.json'. */
  material(path: string): string | null;
  /** Project path of the AudioClip for an AudioSource (clip, baked ambience or sfx). */
  audio(source: ComponentData): string | null;
  /** Project path of an HDRI or other texture ('textures/hdri/x.hdr'). */
  texture(path: string): string | null;
  /** Unity game script for an AIGE 'scripts/X.cs' path: class name + project path (null = missing). */
  script(csPath: string): { name: string; path: string } | null;
}

export interface UnitySceneResult {
  doc: UnitySceneDoc;
  warnings: string[];
}

/** Built-in C# scripts shipped in Assets/Aige/Runtime/Builtins. */
export const UNITY_BUILTINS = ['PlayerController', 'ThirdPersonCamera', 'Rotator'] as const;

/** AIGE components that become Aige.* MonoBehaviours on the entity (Unity class in parentheses). */
export const UNITY_COMPONENTS: Record<string, string> = {
  Interactable: 'Interactable',
  Door: 'Door',
  Trigger: 'Trigger',
  ParticleSystem: 'AigeParticles',
  Animator: 'AigeAnimator',
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Props without the discriminator and undefined values. */
function propsOf(c: ComponentData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (k !== 'type' && v !== undefined && v !== null) out[k] = v;
  return out;
}

/** Converts one AIGE collider to Unity (auto/convex/mesh fall back to the model's hint or bounds). */
export function colliderToUnity(
  c: ComponentData,
  model: UnityModelRef | null,
  warnings: string[] = [],
): UnityCollider {
  const offset = (c.offset as number[]) ?? [0, 0, 0];
  let shape = (c.shape as string) ?? 'auto';
  let size = (c.size as number[]) ?? [1, 1, 1];
  let radius = num(c.radius, 0.5);
  let height = num(c.height, 1);
  let base: number[] = [0, 0, 0];
  if ((shape === 'mesh' || shape === 'convex') && !model)
    warnings.push(`'${shape}' collider without a model exported as a box.`);
  if (shape === 'auto' || ((shape === 'mesh' || shape === 'convex') && !model)) {
    const hint = model?.collider;
    if (hint) {
      shape =
        hint.shape === 'cylinder' || hint.shape === 'sphere' || hint.shape === 'capsule' ? hint.shape : 'box';
      size = hint.size ?? size;
      radius = hint.radius ?? (hint.size ? Math.max(hint.size[0], hint.size[2]) / 2 : radius);
      height = hint.height ?? hint.size?.[1] ?? height;
      base = hint.offset ?? base;
    } else if (model?.bounds) {
      const { min, max } = model.bounds;
      size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      base = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
      shape = 'box';
    } else shape = 'box';
  }
  return {
    shape: shape as UnityCollider['shape'],
    center: toUnityVector([base[0]! + offset[0]!, base[1]! + offset[1]!, base[2]! + offset[2]!]),
    size: [Math.max(size[0] ?? 1, 0.001), Math.max(size[1] ?? 1, 0.001), Math.max(size[2] ?? 1, 0.001)],
    radius,
    height: shape === 'capsule' ? Math.max(height, radius * 2) : height,
    isTrigger: c.isTrigger === true,
    friction: num(c.friction, 0.5),
    restitution: num(c.restitution, 0),
  };
}

/** Converts an Environment component (directions to Unity, HDRI to a project path). */
export function environmentToUnity(
  env: ComponentData,
  ctx: Pick<UnitySceneContext, 'texture'>,
): UnityEnvironment {
  const out: UnityEnvironment = propsOf(env);
  if (Array.isArray(env.sunDirection)) out.sunDirection = toUnityVector(env.sunDirection as number[]);
  if (typeof env.hdriRotation === 'number') out.hdriRotation = toUnityYaw(env.hdriRotation);
  if (typeof env.hdri === 'string') {
    const t = ctx.texture(env.hdri);
    if (t) out.hdri = t;
    else delete out.hdri;
  }
  return out;
}

/** Converts one AIGE scene to the importer's scene description. */
export function sceneToUnity(scene: SceneDoc, ctx: UnitySceneContext): UnitySceneResult {
  const warnings: string[] = [];
  const ids = new Set(scene.entities.map((e) => e.id));
  const entities: UnityEntity[] = [];
  const ambient: UnitySceneDoc['ambient'] = [];
  const envs: { name: string; active: boolean }[] = [];

  for (const e of scene.entities) {
    const get = (t: string) => e.components.find((c) => c.type === t);
    const all = (t: string) => e.components.filter((c) => c.type === t);
    const warn = (m: string) => warnings.push(`${e.name}: ${m}`);
    const t = e.transform;
    const out: UnityEntity = {
      id: e.id,
      name: e.name,
      parent: e.parent && ids.has(e.parent) ? e.parent : null,
      active: e.active,
      tags: e.tags,
      position: toUnityVector(t.position),
      rotation: toUnityRotation(t.rotation),
      scale: [t.scale[0], t.scale[1], t.scale[2]],
    };

    const mr = get('MeshRenderer');
    const model = mr?.model ? ctx.model(e, mr) : null;
    if (mr) {
      if (mr.model && !model) warn(`model '${mr.model}' could not be baked; exported as a magenta box.`);
      out.mesh = {
        ...(model ? { model: model.asset } : { primitive: (mr.primitive as string) ?? 'box' }),
        ...(!model ? { color: (mr.color as string) ?? (mr.model ? '#ff00ff' : '#ffffff') } : {}),
        castShadow: mr.castShadow !== false,
        receiveShadow: mr.receiveShadow !== false,
        visible: mr.visible !== false,
      };
      if (!model && typeof mr.material === 'string') {
        const m = ctx.material(mr.material);
        if (m) out.mesh.material = m;
        else warn(`material '${mr.material}' not found.`);
      }
    }

    const colliders = all('Collider');
    if (colliders.length) out.colliders = colliders.map((c) => colliderToUnity(c, model, warnings));

    const cc = get('CharacterController');
    if (cc)
      out.character = {
        height: num(cc.height, 1.8),
        radius: num(cc.radius, 0.4),
        stepHeight: num(cc.stepHeight, 0.35),
        maxSlope: num(cc.maxSlope, 50),
        snapToGround: num(cc.snapToGround, 0.3),
      };
    const rb = get('RigidBody');
    if (rb)
      out.rigidbody = {
        kind: ((rb.kind as string) ?? 'dynamic') as 'dynamic',
        mass: num(rb.mass, 1),
        linearDamping: num(rb.linearDamping, 0),
        angularDamping: num(rb.angularDamping, 0.05),
        gravityScale: num(rb.gravityScale, 1),
        lockRotation: rb.lockRotation === true,
        ccd: rb.ccd === true,
      };

    const light = get('Light');
    if (light) {
      const kind = (light.kind as string) ?? 'directional';
      if (kind === 'ambient' || kind === 'hemisphere')
        ambient.push({
          color: (light.color as string) ?? '#ffffff',
          intensity: num(light.intensity, 1),
          ...(kind === 'hemisphere' ? { ground: (light.groundColor as string) ?? '#444444' } : {}),
        });
      else
        out.light = {
          type: kind as 'point',
          color: (light.color as string) ?? '#ffffff',
          intensity: num(light.intensity, 1),
          range: num(light.range, 0) || 30,
          angle: num(light.angle, 30),
          shadows: light.castShadow === true,
          flicker: num(light.flicker, 0),
        };
    }

    const cam = get('Camera');
    if (cam)
      out.camera = {
        fov: num(cam.fov, 60),
        near: num(cam.near, 0.1),
        far: num(cam.far, 500),
        primary: cam.primary !== false,
      };

    for (const a of all('AudioSource')) {
      const clip = ctx.audio(a);
      if (!clip) {
        warn('AudioSource has no clip, sfx or ambience.');
        continue;
      }
      (out.audio ??= []).push({
        clip,
        volume: num(a.volume, 0.8),
        loop: a.loop === true || !!a.ambience,
        playOnStart: a.playOnStart === true,
        spatial: a.spatial === true,
        range: num(a.range, 12),
      });
    }

    for (const c of e.components) {
      if (!UNITY_COMPONENTS[c.type]) continue;
      (out.components ??= []).push({ type: c.type, props: propsOf(c) });
    }

    for (const s of all('Script')) {
      if (s.enabled === false) continue;
      const src = String(s.script);
      const props = { ...((s.props as Record<string, unknown>) ?? {}) };
      if (src.startsWith('builtin:')) {
        const name = src.slice(8);
        if (!(UNITY_BUILTINS as readonly string[]).includes(name)) {
          warn(`built-in script '${name}' has no Unity version (have: ${UNITY_BUILTINS.join(', ')}).`);
          continue;
        }
        (out.scripts ??= []).push({ kind: 'builtin', name, props });
      } else if (src.endsWith('.cs')) {
        const found = ctx.script(src);
        if (!found) {
          warn(`no Unity port of '${src}' (expected Assets/Scripts/${src.split('/').pop()}).`);
          continue;
        }
        (out.scripts ??= []).push({ kind: 'cs', name: found.name, path: found.path, props });
      } else warn(`'${src}' is a TypeScript script; Unity games use C# (Assets/Scripts/*.cs).`);
    }

    const env = get('Environment');
    if (env) {
      out.environment = environmentToUnity(env, ctx);
      envs.push({ name: e.name, active: e.active });
    }
    if (get('UIText')) warn('UIText is not exported; use Hud.Say / Story objectives from C#.');
    entities.push(out);
  }

  const main = envs.find((x) => x.active) ?? envs[0];
  if (!main)
    warnings.push('No Environment component: the scene uses URP defaults (add one for a realistic look).');
  const s = scene.settings as Record<string, unknown>;
  return {
    doc: {
      format: 'aige.unity.scene',
      version: 1,
      name: scene.name,
      settings: {
        ambientColor: (s.ambientColor as string) ?? '#ffffff',
        ambientIntensity: num(s.ambientIntensity, 0.4),
        background: (s.background as string) ?? '#87b5e0',
        killY: num(s.killY, -50),
      },
      ambient,
      mainEnvironment: main?.name ?? null,
      entities,
    },
    warnings,
  };
}
