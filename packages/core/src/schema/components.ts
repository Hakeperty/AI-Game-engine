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
    'Plays a sound. Use `clip` for an audio file or `sfx` for a synthesized preset (no files needed).',
  schema: z.object({
    clip: AssetPath.optional(),
    sfx: z.enum(['coin', 'jump', 'hit', 'explosion', 'powerup', 'laser', 'click', 'win', 'lose']).optional(),
    volume: z.number().min(0).max(1).default(0.8),
    loop: z.boolean().default(false),
    playOnStart: z.boolean().default(false),
    spatial: z.boolean().default(false),
  }),
  example: { sfx: 'coin' },
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
