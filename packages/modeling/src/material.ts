import { z } from 'zod';

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use '#rrggbb'")
  .transform((s) => s.toLowerCase());

/** PBR material used by model parts. Mirrors glTF metallic-roughness. */
export const MaterialSpecSchema = z.object({
  name: z.string().optional(),
  color: hex.default('#ffffff'),
  metalness: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.7),
  emissive: hex.default('#000000'),
  emissiveIntensity: z.number().min(0).default(1),
  opacity: z.number().min(0).max(1).default(1),
  flatShading: z.boolean().default(false),
  doubleSided: z.boolean().default(false),
  /** Procedural texture applied as base color map (multiplied with color). */
  texture: z
    .object({
      kind: z.enum(['checker', 'noise', 'grid', 'bricks', 'stripes', 'dots', 'wood', 'marble']),
      colorA: hex.default('#ffffff'),
      colorB: hex.default('#808080'),
      scale: z.number().positive().default(4),
      size: z.number().int().min(16).max(1024).default(256),
    })
    .optional(),
});

export type MaterialSpec = z.output<typeof MaterialSpecSchema>;
export type MaterialInput = z.input<typeof MaterialSpecSchema>;

export function material(input: MaterialInput = {}): MaterialSpec {
  const res = MaterialSpecSchema.strict().safeParse(input);
  if (!res.success) {
    throw new Error(
      `Invalid material: ${res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return res.data;
}

export const DEFAULT_MATERIAL: MaterialSpec = material({});

export function materialKey(m: MaterialSpec): string {
  return JSON.stringify(m);
}

/** Ready-made materials for quick results. */
export const materials = {
  gold: () => material({ name: 'gold', color: '#ffc83d', metalness: 1, roughness: 0.28 }),
  silver: () => material({ name: 'silver', color: '#d8dde3', metalness: 1, roughness: 0.25 }),
  copper: () => material({ name: 'copper', color: '#d27d4a', metalness: 1, roughness: 0.35 }),
  iron: () => material({ name: 'iron', color: '#8a8f96', metalness: 0.9, roughness: 0.55 }),
  wood: () => material({ name: 'wood', color: '#9b6b43', roughness: 0.8 }),
  stone: () => material({ name: 'stone', color: '#8d8d8d', roughness: 0.95 }),
  grass: () => material({ name: 'grass', color: '#5fa052', roughness: 0.9 }),
  plastic: (color = '#e53935') => material({ name: 'plastic', color, roughness: 0.4 }),
  rubber: (color = '#222222') => material({ name: 'rubber', color, roughness: 0.95 }),
  glass: (color = '#bfe6ff') => material({ name: 'glass', color, roughness: 0.05, opacity: 0.35 }),
  glow: (color = '#ffee88', intensity = 2) =>
    material({ name: 'glow', color, emissive: color, emissiveIntensity: intensity }),
  vertexColor: () => material({ name: 'vertexColor', roughness: 0.8 }),
};
