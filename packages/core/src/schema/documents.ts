import { z } from 'zod';
import { AssetPath, Color, Transform, Vec3 } from './common.ts';

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
  map: AssetPath.optional().describe('Color texture'),
  normalMap: AssetPath.optional(),
  vertexColors: z.boolean().default(false),
  flatShading: z.boolean().default(false),
  doubleSided: z.boolean().default(false),
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
