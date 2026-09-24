import { z } from 'zod';
import { AssetPath, Color, EulerDeg, Transform, Vec3 } from './common.ts';

export const EntityId = z.string().min(1).describe("Entity id, e.g. 'e12'");

export const ComponentDataSchema = z.object({ type: z.string() }).loose();

export const Entity = z.object({
  id: EntityId,
  name: z.string().min(1),
  parent: EntityId.nullable().default(null),
  active: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  transform: Transform.default({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
  components: z.array(ComponentDataSchema).default([]),
  /** Prefab this entity was instantiated from (informational in v0.1). */
  prefab: AssetPath.optional(),
});
export type Entity = z.infer<typeof Entity>;

export const SceneSettings = z.object({
  background: Color.default('#87b5e0'),
  ambientColor: Color.default('#ffffff'),
  ambientIntensity: z.number().min(0).default(0.4),
  environment: z
    .enum(['none', 'studio', 'outdoor'])
    .default('outdoor')
    .describe('Image-based lighting preset'),
  fog: z
    .object({ color: Color.default('#87b5e0'), near: z.number().default(30), far: z.number().default(120) })
    .nullable()
    .default(null),
  killY: z
    .number()
    .default(-50)
    .describe('Entities with RigidBody/CharacterController below this height fire onFall'),
});
export type SceneSettings = z.infer<typeof SceneSettings>;

export const SceneDoc = z.object({
  format: z.literal('aige.scene'),
  version: z.literal(1),
  name: z.string(),
  nextId: z.number().int().positive(),
  settings: SceneSettings,
  entities: z.array(Entity),
});
export type SceneDoc = z.infer<typeof SceneDoc>;

export const InputAxis = z.object({
  positive: z.array(z.string()).default([]),
  negative: z.array(z.string()).default([]),
});

export const InputMap = z.object({
  actions: z
    .record(z.string(), z.array(z.string()))
    .describe("Action name -> key codes, e.g. {jump: ['Space']}"),
  axes: z.record(z.string(), InputAxis).describe('Axis name -> positive/negative key codes'),
});
export type InputMap = z.infer<typeof InputMap>;

export const defaultInputMap = (): InputMap => ({
  actions: {
    jump: ['Space', 'GamepadA'],
    fire: ['MouseLeft', 'KeyJ', 'GamepadX'],
    interact: ['KeyE', 'GamepadB'],
    sprint: ['ShiftLeft', 'GamepadLB'],
    pause: ['Escape', 'GamepadStart'],
  },
  axes: {
    move_x: { positive: ['KeyD', 'ArrowRight'], negative: ['KeyA', 'ArrowLeft'] },
    move_y: { positive: ['KeyW', 'ArrowUp'], negative: ['KeyS', 'ArrowDown'] },
  },
});

export const ProjectDoc = z.object({
  format: z.literal('aige.project'),
  version: z.literal(1),
  name: z.string(),
  description: z.string().default(''),
  startScene: AssetPath,
  input: InputMap,
  physics: z.object({
    gravity: Vec3.default([0, -20, 0]),
    fixedTimestep: z
      .number()
      .positive()
      .default(1 / 60),
  }),
  render: z.object({
    shadows: z.boolean().default(true),
    antialias: z.boolean().default(true),
    toneMapping: z.enum(['none', 'aces', 'agx', 'neutral']).default('neutral'),
    exposure: z.number().positive().default(1),
  }),
  window: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
    title: z.string().default(''),
  }),
});
export type ProjectDoc = z.infer<typeof ProjectDoc>;

export const MaterialDoc = z.object({
  format: z.literal('aige.material'),
  version: z.literal(1),
  color: Color.default('#ffffff'),
  metalness: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.6),
  emissive: Color.default('#000000'),
  emissiveIntensity: z.number().min(0).default(1),
  opacity: z.number().min(0).max(1).default(1),
  map: AssetPath.optional().describe("Color texture, e.g. 'textures/bricks.png' (see texture_generate)"),
  mapRepeat: z
    .tuple([z.number(), z.number()])
    .default([1, 1])
    .describe('Texture tiling [u, v]; raise it on big surfaces (a 40 m ground wants ~[20, 20])'),
  normalMap: AssetPath.optional().describe('Tangent-space normal map (OpenGL convention, green up)'),
  normalScale: z.number().default(1).describe('Normal map strength'),
  ormMap: AssetPath.optional().describe(
    'Packed occlusion (R) / roughness (G) / metalness (B) texture, glTF convention (Poly Haven "arm" maps). Roughness and metalness multiply the values above.',
  ),
  aoIntensity: z.number().min(0).default(1),
  heightMap: AssetPath.optional().describe(
    'Height map, white = high (Poly Haven "disp" maps). Rendered as parallax occlusion, so bark, stone, log grain and plaster get real depth.',
  ),
  heightScale: z
    .number()
    .min(0)
    .max(0.3)
    .default(0.05)
    .describe(
      'Parallax depth in texture space: 0.02 fine grain or plaster, 0.05 rough wood, 0.08-0.12 bark or stone',
    ),
  vertexColors: z.boolean().default(false),
  flatShading: z.boolean().default(false),
  doubleSided: z.boolean().default(false),
  alphaCutoff: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Cut out texels whose texture alpha is below this (0 = off): leaves, cobwebs, torn paper'),
});
export type MaterialDoc = z.infer<typeof MaterialDoc>;

/** Material properties an AI may set (everything except format/version). */
export const MaterialProps = MaterialDoc.omit({ format: true, version: true });

export const PrefabDoc = z.object({
  format: z.literal('aige.prefab'),
  version: z.literal(1),
  name: z.string(),
  /** Entities with prefab-local ids; exactly one has parent null (the root). */
  entities: z.array(Entity),
});
export type PrefabDoc = z.infer<typeof PrefabDoc>;

// ---------------------------------------------------------------------------------------------
// Cutscenes: a timeline of tracks. Times are seconds from the start of the cutscene.
// ---------------------------------------------------------------------------------------------

const Ease = z.enum(['linear', 'in', 'out', 'inOut', 'hold']).default('inOut');
const CamTarget = z.union([Vec3, z.string()]).describe('Point [x,y,z] or entity ref to look at');

export const CameraKey = z.object({
  t: z.number().min(0),
  position: z.union([Vec3, z.string()]).describe('World position, or an entity ref (e.g. a camera marker)'),
  lookAt: CamTarget,
  fov: z.number().min(10).max(120).default(50),
  ease: Ease,
  /** Hard cut to this shot instead of blending from the previous key. */
  cut: z.boolean().default(false),
  shake: z.number().min(0).max(1).default(0),
  /** Depth of field: focus distance in meters (0 = off). */
  focus: z.number().min(0).default(0).describe('Depth-of-field focus distance in meters (0 = no DoF)'),
  aperture: z.number().min(0).max(1).default(0.5).describe('Depth-of-field blur strength when focus > 0'),
});

export const CutsceneTrack = z.discriminatedUnion('type', [
  z.object({ type: z.literal('camera'), keys: z.array(CameraKey).min(1) }),
  z.object({
    type: z.literal('animation'),
    actor: z.string(),
    clips: z.array(
      z.object({
        t: z.number().min(0),
        clip: z.string(),
        loop: z.boolean().default(false),
        fade: z.number().min(0).default(0.25),
        speed: z.number().positive().default(1),
      }),
    ),
  }),
  z.object({
    type: z.literal('move'),
    actor: z.string(),
    keys: z
      .array(z.object({ t: z.number().min(0), position: Vec3, rotation: EulerDeg.optional(), ease: Ease }))
      .min(1),
  }),
  z.object({
    type: z.literal('voice'),
    clips: z.array(
      z.object({
        t: z.number().min(0),
        line: z.string().describe('Voice line id (audio/voice/<id>.json)'),
        actor: z.string().optional().describe('Entity whose jaw moves (lip-sync)'),
        subtitle: z.boolean().default(true),
      }),
    ),
  }),
  z.object({
    type: z.literal('sound'),
    clips: z.array(
      z.object({
        t: z.number().min(0),
        clip: AssetPath.optional(),
        sfx: z.string().optional(),
        volume: z.number().min(0).max(1).default(1),
        at: z.string().optional().describe('Entity to play it from (spatial)'),
      }),
    ),
  }),
  z.object({
    type: z.literal('subtitle'),
    items: z.array(
      z.object({
        t: z.number().min(0),
        duration: z.number().positive(),
        text: z.string(),
        speaker: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('fx'),
    items: z.array(
      z.object({
        t: z.number().min(0),
        effect: z.enum([
          'fade',
          'vignette',
          'blur',
          'darken',
          'desaturate',
          'flash',
          'shake',
          'letterbox',
          'heartbeat',
          'heartRate',
          'exposure',
          'fog',
          'bloom',
          'contrast',
          'saturation',
          'temperature',
          'tint',
          'grain',
          'volume',
        ]),
        to: z
          .number()
          .min(-1)
          .max(240)
          .describe(
            'Target value. 0..1 strengths (fade 1 = black); exposure/fog/contrast/saturation are multipliers (1 = unchanged); temperature/tint -1..1; heartRate in bpm; volume = master volume 0..1 (sounds fading away)',
          ),
        duration: z.number().min(0).default(0.5),
        color: Color.optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('light'),
    items: z.array(
      z.object({
        t: z.number().min(0),
        entity: z.string(),
        intensity: z.number().min(0),
        duration: z.number().min(0).default(0),
        color: Color.optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('event'),
    items: z.array(
      z.object({
        t: z.number().min(0),
        setFlag: z.string().optional(),
        clearFlag: z.string().optional(),
        enable: z.string().optional(),
        disable: z.string().optional(),
        give: z.string().optional().describe('Item id to add to the inventory'),
        take: z.string().optional(),
        objective: z.string().optional(),
        teleport: z.object({ entity: z.string(), position: Vec3, rotation: EulerDeg.optional() }).optional(),
        emit: z.string().optional().describe('Game event name (Game.on)'),
      }),
    ),
  }),
]);
export type CutsceneTrack = z.infer<typeof CutsceneTrack>;

export const CutsceneDoc = z.object({
  format: z.literal('aige.cutscene'),
  version: z.literal(1),
  name: z.string(),
  /** Seconds; defaults to the end of the last track item. */
  duration: z.number().positive().optional(),
  skippable: z.boolean().default(true),
  letterbox: z.boolean().default(true),
  /** Hand control back to the player at the end (false = the next cutscene/event takes over). */
  returnControl: z.boolean().default(true),
  tracks: z.array(CutsceneTrack),
});
export type CutsceneDoc = z.infer<typeof CutsceneDoc>;

/**
 * A generated voice line (audio/voice/<id>.json, written by the voice_line tool).
 * `mouth` is a lip-sync curve (jaw open 0..1) sampled at `fps`.
 */
export const VoiceLineDoc = z.object({
  format: z.literal('aige.voiceline'),
  version: z.literal(1),
  id: z.string(),
  speaker: z.string(),
  text: z.string(),
  voice: z.string().describe("Voice profile ('voices/hero.voice.json')"),
  instruct: z.string().default('').describe('Delivery/emotion instruction used for generation'),
  audio: AssetPath.describe("'audio/voice/<id>.ogg'"),
  duration: z.number().nonnegative(),
  fps: z.number().positive().default(30),
  mouth: z.array(z.number().min(0).max(1)).default([]),
});
export type VoiceLineDoc = z.infer<typeof VoiceLineDoc>;

export function createSceneDoc(name: string): SceneDoc {
  return {
    format: 'aige.scene',
    version: 1,
    name,
    nextId: 1,
    settings: SceneSettings.parse({}),
    entities: [],
  };
}

export function createProjectDoc(name: string, startScene = 'scenes/main.scene.json'): ProjectDoc {
  return ProjectDoc.parse({
    format: 'aige.project',
    version: 1,
    name,
    startScene,
    input: defaultInputMap(),
    physics: {},
    render: {},
    window: { title: name },
  });
}

export function createMaterialDoc(props: Partial<z.input<typeof MaterialProps>> = {}): MaterialDoc {
  return MaterialDoc.parse({ format: 'aige.material', version: 1, ...props });
}
