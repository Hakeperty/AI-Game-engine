import { z } from 'zod';
import { AigeError, didYouMean } from '../errors.ts';
import { AssetPath, Color, definedOnly, patchOf, Vec2, Vec3 } from './common.ts';

export type ComponentCategory = 'rendering' | 'physics' | 'gameplay' | 'audio' | 'ui';

export interface ComponentDef<S extends z.ZodObject = z.ZodObject> {
  type: string;
  category: ComponentCategory;
  description: string;
  /** Component properties (excluding `type`). Every field must have a default or be optional. */
  schema: S;
  /** Whether an entity may carry more than one of this component. */
  multiple: boolean;
  example: Record<string, unknown>;
}

/** Stored form of a component: `{ type: 'Light', ...props }`. */
export type ComponentData = { type: string } & Record<string, unknown>;

const registry = new Map<string, ComponentDef>();

export function defineComponent<S extends z.ZodObject>(def: ComponentDef<S>): ComponentDef<S> {
  if (registry.has(def.type)) throw new Error(`Component '${def.type}' is already registered`);
  registry.set(def.type, def as unknown as ComponentDef);
  return def;
}

export function getComponentDef(type: string): ComponentDef {
  const def = registry.get(type);
  if (!def) {
    throw new AigeError('NOT_FOUND', `Unknown component type '${type}'.`, {
      hint: didYouMean(type, registry.keys()) ?? `Available: ${[...registry.keys()].join(', ')}`,
    });
  }
  return def;
}

export function listComponentDefs(): ComponentDef[] {
  return [...registry.values()];
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Validates a full component (applies defaults). Throws INVALID_INPUT with an actionable message. */
export function parseComponent(input: unknown): ComponentData {
  if (!input || typeof input !== 'object' || typeof (input as any).type !== 'string') {
    throw new AigeError('INVALID_INPUT', "A component must be an object with a string 'type'.", {
      hint: `Example: {"type":"Light","kind":"point","color":"#ffffff"}. Types: ${[...registry.keys()].join(', ')}`,
    });
  }
  const { type, ...props } = input as ComponentData;
  const def = getComponentDef(type);
  const res = def.schema.strict().safeParse(props);
  if (!res.success) {
    throw new AigeError('INVALID_INPUT', `Invalid ${type} component: ${formatIssues(res.error)}`, {
      hint: `Example ${type}: ${JSON.stringify({ type, ...def.example })}`,
    });
  }
  return { type, ...(res.data as Record<string, unknown>) };
}

/**
 * Validates a partial update to an existing component's props.
 * A `null` value clears an optional property (or resets one that has a default); cleared keys come
 * back as `undefined` and must be deleted by the caller.
 */
export function parseComponentPatch(type: string, patch: Record<string, unknown>): Record<string, unknown> {
  const def = getComponentDef(type);
  const nulls = Object.keys(patch).filter((k) => patch[k] === null);
  const rest = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const res = patchOf(def.schema).strict().safeParse(rest);
  if (!res.success) {
    throw new AigeError('INVALID_INPUT', `Invalid ${type} properties: ${formatIssues(res.error)}`, {
      hint: `Valid properties: ${Object.keys(def.schema.shape).join(', ')}`,
    });
  }
  const out = definedOnly(res.data as Record<string, unknown>);
  for (const key of nulls) {
    const field = (def.schema.shape as Record<string, z.ZodType>)[key];
    if (!field) {
      throw new AigeError('INVALID_INPUT', `Invalid ${type} properties: unknown property '${key}'.`, {
        hint: `Valid properties: ${Object.keys(def.schema.shape).join(', ')}`,
      });
    }
    out[key] = field instanceof z.ZodOptional ? undefined : field.parse(undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Built-in components
// ---------------------------------------------------------------------------------------------

export const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane', 'torus'] as const;

export const MeshRenderer = defineComponent({
  type: 'MeshRenderer',
  category: 'rendering',
  multiple: false,
  description:
    "Renders a mesh. Use `model` for a procedural recipe ('models/x.model.ts') or a '.glb' file, or `primitive` for a unit-size built-in shape (scale it with the transform).",
  schema: z.object({
    model: AssetPath.optional().describe("Model asset: 'models/name.model.ts' recipe or '.glb' file"),
    params: z.record(z.string(), z.unknown()).optional().describe('Recipe parameter overrides'),
    primitive: z.enum(PRIMITIVES).optional().describe('Built-in unit primitive, used when no model is set'),
    material: AssetPath.optional().describe(
      "Material asset 'materials/name.material.json' (overrides recipe materials)",
    ),
    materials: z
      .record(z.string(), AssetPath)
      .optional()
      .describe(
        'Per-part material overrides by model part name, e.g. {"logs": "materials/log_wood.material.json"}',
      ),
    color: Color.optional().describe('Tint color; for primitives this is the base color'),
    castShadow: z.boolean().default(true),
    receiveShadow: z.boolean().default(true),
    visible: z.boolean().default(true),
  }),
  example: { primitive: 'box', color: '#44aa88' },
});

export const Light = defineComponent({
  type: 'Light',
  category: 'rendering',
  multiple: false,
  description:
    'A light source. Directional lights shine along the entity forward (-Z rotated by the transform); a rotation of [-50, 30, 0] gives a nice sun.',
  schema: z.object({
    kind: z.enum(['directional', 'point', 'spot', 'ambient', 'hemisphere']).default('directional'),
    color: Color.default('#ffffff'),
    intensity: z.number().min(0).default(1),
    groundColor: Color.default('#444444').describe('Hemisphere lights only'),
    range: z.number().min(0).default(0).describe('Point/spot: 0 = infinite'),
    angle: z.number().min(1).max(89).default(30).describe('Spot cone angle in degrees'),
    castShadow: z.boolean().default(false),
    flicker: z.number().min(0).max(1).default(0).describe('0 = steady, 1 = a dying bulb / candle'),
  }),
  example: { kind: 'directional', intensity: 2, castShadow: true },
});

export const Camera = defineComponent({
  type: 'Camera',
  category: 'rendering',
  multiple: false,
  description:
    'A perspective camera looking along the entity forward direction (-Z). The primary camera is used when the game runs.',
  schema: z.object({
    fov: z.number().min(10).max(150).default(60).describe('Vertical field of view in degrees'),
    near: z.number().positive().default(0.1),
    far: z.number().positive().default(500),
    primary: z.boolean().default(true),
  }),
  example: { fov: 60, primary: true },
});

export const RigidBody = defineComponent({
  type: 'RigidBody',
  category: 'physics',
  multiple: false,
  description:
    "Makes the entity take part in physics. 'dynamic' bodies fall and collide, 'fixed' never move, 'kinematic' are moved by scripts. Needs a Collider.",
  schema: z.object({
    kind: z.enum(['dynamic', 'fixed', 'kinematic']).default('dynamic'),
    mass: z.number().positive().default(1),
    linearDamping: z.number().min(0).default(0),
    angularDamping: z.number().min(0).default(0.05),
    gravityScale: z.number().default(1),
    lockRotation: z.boolean().default(false).describe('Prevent the body from tipping over'),
    ccd: z.boolean().default(false).describe('Continuous collision detection for fast objects'),
  }),
  example: { kind: 'dynamic', mass: 1 },
});

export const Collider = defineComponent({
  type: 'Collider',
  category: 'physics',
  multiple: true,
  description:
    "Collision shape. 'auto' fits a box to the mesh bounds. Sizes are in local space before the entity scale. Set isTrigger for pickups/zones (fires onTriggerEnter, no collision response).",
  schema: z.object({
    shape: z.enum(['auto', 'box', 'sphere', 'capsule', 'cylinder', 'convex', 'mesh']).default('auto'),
    size: Vec3.default([1, 1, 1]).describe('Box full extents'),
    radius: z.number().positive().default(0.5).describe('Sphere/capsule/cylinder radius'),
    height: z.number().positive().default(1).describe('Capsule/cylinder total height'),
    offset: Vec3.default([0, 0, 0]),
    isTrigger: z.boolean().default(false),
    friction: z.number().min(0).default(0.5),
    restitution: z.number().min(0).max(1).default(0).describe('Bounciness 0..1'),
  }),
  example: { shape: 'box', size: [1, 1, 1] },
});

export const CharacterController = defineComponent({
  type: 'CharacterController',
  category: 'physics',
  multiple: false,
  description:
    "Kinematic capsule character that walks, climbs steps, slides along walls and snaps to the ground. Move it from a script with `this.entity.character.move(velocity, dt)`, or add the built-in script 'builtin:PlayerController'.",
  schema: z.object({
    height: z.number().positive().default(1.8),
    radius: z.number().positive().default(0.4),
    stepHeight: z.number().min(0).default(0.35),
    maxSlope: z.number().min(0).max(89).default(50).describe('Degrees'),
    snapToGround: z.number().min(0).default(0.3),
  }),
  example: { height: 1.8, radius: 0.4 },
});

export const Script = defineComponent({
  type: 'Script',
  category: 'gameplay',
  multiple: true,
  description:
    "Attaches a behaviour. `script` is a project script ('scripts/player.ts', exporting a default class extending Behaviour) or a built-in ('builtin:Rotator'). `props` override the script's static props.",
  schema: z.object({
    script: z.string().min(1).describe("'scripts/name.ts' or 'builtin:Name'"),
    props: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  }),
  example: { script: 'builtin:Rotator', props: { speed: [0, 90, 0] } },
});

export const AudioSource = defineComponent({
  type: 'AudioSource',
  category: 'audio',
  multiple: true,
  description:
    "Plays a sound. Use `clip` for an audio file ('audio/sfx/creak.ogg'), `sfx` for a synthesized one-shot preset, or `ambience` for a looping synthesized ambience (wind, rain, fridge hum...). Spatial sources fade out over `range` meters.",
  schema: z.object({
    clip: AssetPath.optional(),
    sfx: z.enum(['coin', 'jump', 'hit', 'explosion', 'powerup', 'laser', 'click', 'win', 'lose']).optional(),
    ambience: z
      .enum([
        'wind',
        'storm',
        'rain',
        'rain_window',
        'fridge_hum',
        'fire',
        'creaks',
        'birds',
        'crickets',
        'room_tone',
        'heartbeat',
        'breathing',
      ])
      .optional()
      .describe('Looping procedural ambience'),
    volume: z.number().min(0).max(1).default(0.8),
    loop: z.boolean().default(false),
    playOnStart: z.boolean().default(false),
    spatial: z.boolean().default(false),
    range: z.number().positive().default(12).describe('Spatial: distance at which the sound fades out'),
  }),
  example: { ambience: 'wind', volume: 0.5, playOnStart: true },
});

export const Animator = defineComponent({
  type: 'Animator',
  category: 'rendering',
  multiple: false,
  description:
    "Plays skeletal animations on a character model (a skinned GLB, e.g. from character_create). With `locomotion` it blends idle/walk/run from how fast the entity moves. Scripts and cutscenes play clips by name ('sit_up', 'look_around', 'faint'...). Voice lines drive the jaw automatically (lip-sync).",
  schema: z.object({
    clips: z
      .array(AssetPath)
      .default([])
      .describe(
        "Extra clip files ('animations/wave.anim.json'); built-in humanoid clips are always available",
      ),
    initial: z.string().default('idle').describe('Clip to play at start'),
    locomotion: z.boolean().default(true).describe('Auto idle/walk/run from movement speed'),
    speed: z.number().positive().default(1).describe('Playback speed multiplier'),
  }),
  example: { initial: 'lie_asleep', locomotion: true },
});

export const Interactable = defineComponent({
  type: 'Interactable',
  category: 'gameplay',
  multiple: false,
  description:
    'Something the player can interact with (press E when close and facing it): examine, pick up, open. Shows `prompt` on screen. On interact it can play a cutscene or voice line, show a thought text, give an item (the entity is then hidden), and set a story flag. `requireFlag` hides the prompt until that flag is set.',
  schema: z.object({
    prompt: z.string().default('Examine'),
    range: z.number().positive().default(1.8),
    once: z.boolean().default(false),
    requireFlag: z.string().optional(),
    setFlag: z.string().optional(),
    cutscene: AssetPath.optional().describe("'cutscenes/intro.cutscene.json'"),
    voice: z.string().optional().describe("Voice line id to play (the player character's thoughts)"),
    text: z.string().optional().describe('Thought text shown as a subtitle when there is no voice line'),
    item: z.string().optional().describe("Item id added to the inventory ('knife'); hides this entity"),
    enabled: z.boolean().default(true),
  }),
  example: { prompt: 'Look at picture', voice: 'hero_picture_1', setFlag: 'saw_picture_1' },
});

export const Door = defineComponent({
  type: 'Door',
  category: 'gameplay',
  multiple: false,
  description:
    'A hinged door the player opens with E. The entity origin is the hinge; the door swings around its local Y axis. Locked doors show `lockedText`; they unlock when `unlockFlag` is set.',
  schema: z.object({
    openAngle: z.number().min(-180).max(180).default(100).describe('Degrees; negative swings the other way'),
    speed: z.number().positive().default(1.6).describe('Swings per second'),
    locked: z.boolean().default(false),
    unlockFlag: z.string().optional(),
    lockedText: z.string().default("It won't open."),
    startOpen: z.boolean().default(false),
    prompt: z.string().default('Open'),
  }),
  example: { openAngle: 100, locked: true, unlockFlag: 'upstairs_unlocked', lockedText: 'Not yet...' },
});

export const Trigger = defineComponent({
  type: 'Trigger',
  category: 'gameplay',
  multiple: true,
  description:
    "Fires when the player enters this entity's trigger Collider (isTrigger): plays a cutscene, voice line, sound or thought text, sets a flag, or sets the current objective. Use it for story beats ('audio plays near the table') and room transitions.",
  schema: z.object({
    once: z.boolean().default(true),
    tag: z.string().default('Player'),
    requireFlag: z.string().optional(),
    setFlag: z.string().optional(),
    cutscene: AssetPath.optional(),
    voice: z.string().optional(),
    sound: AssetPath.optional(),
    text: z.string().optional(),
    objective: z.string().optional().describe('Sets the current objective text'),
    delay: z.number().min(0).default(0).describe('Seconds to wait after entering'),
  }),
  example: { voice: 'hero_locked_door', once: true, setFlag: 'saw_table' },
});

export const ParticleSystem = defineComponent({
  type: 'ParticleSystem',
  category: 'rendering',
  multiple: true,
  description:
    'Floating/falling particles inside a box `area` around the entity: dust motes in the air, rain, snow, embers, fireflies, smoke, falling leaves.',
  schema: z.object({
    preset: z
      .enum(['dust', 'rain', 'snow', 'embers', 'fireflies', 'smoke', 'sparks', 'leaves'])
      .default('dust'),
    count: z.number().int().min(1).max(20000).default(300),
    area: Vec3.default([4, 2.5, 4]).describe('Box size in meters (centered on the entity)'),
    color: Color.default('#fff3d6'),
    size: z.number().positive().default(0.02).describe('Particle size in meters'),
    speed: z.number().min(0).default(1).describe('Speed multiplier'),
    opacity: z.number().min(0).max(1).default(0.6),
  }),
  example: { preset: 'dust', count: 400, area: [4, 2.6, 4] },
});

export const Decal = defineComponent({
  type: 'Decal',
  category: 'rendering',
  multiple: true,
  description:
    "Projects a texture (with alpha) onto the surfaces inside a box: water stains, mold, grime streaks, blood, footprints, cracks. The box is centered on the entity and projects along the entity's local -Y (so a floor stain needs no rotation; rotate [90,0,0] for a wall facing +Z).",
  schema: z.object({
    texture: AssetPath.describe("PNG with transparency, e.g. 'textures/decals/water_stain.png'"),
    size: Vec3.default([1, 0.4, 1]).describe('Box size [width, projection depth, height] in meters'),
    color: Color.default('#ffffff').describe('Tint'),
    opacity: z.number().min(0).max(1).default(1),
  }),
  example: { texture: 'textures/decals/water_stain.png', size: [1.2, 0.3, 1.2], opacity: 0.8 },
});

export const UIText = defineComponent({
  type: 'UIText',
  category: 'ui',
  multiple: false,
  description:
    'Screen-space text overlay (HUD). Update from scripts with `UI.text(id, text)` or `this.entity.get(UIText)`.',
  schema: z.object({
    text: z.string().default(''),
    anchor: z
      .enum([
        'top-left',
        'top',
        'top-right',
        'left',
        'center',
        'right',
        'bottom-left',
        'bottom',
        'bottom-right',
      ])
      .default('top-left'),
    offset: Vec2.default([16, 16]).describe('Pixels from the anchor'),
    fontSize: z.number().positive().default(24),
    color: Color.default('#ffffff'),
    id: z.string().optional().describe('Handle used by UI.text(id, ...)'),
  }),
  example: { text: 'Score: 0', anchor: 'top-left', id: 'score' },
});
