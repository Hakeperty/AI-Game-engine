import { z } from 'zod';

/** [x, y, z] in meters (Y is up). */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]).describe('[x, y, z]');
export type Vec3 = z.infer<typeof Vec3>;

export const Vec2 = z.tuple([z.number(), z.number()]).describe('[x, y]');
export type Vec2 = z.infer<typeof Vec2>;

/** Euler rotation in degrees, applied in XYZ order. */
export const EulerDeg = z
  .tuple([z.number(), z.number(), z.number()])
  .describe('Euler rotation in degrees [x, y, z]');
export type EulerDeg = z.infer<typeof EulerDeg>;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#e53935',
  green: '#43a047',
  blue: '#1e88e5',
  yellow: '#fdd835',
  orange: '#fb8c00',
  purple: '#8e24aa',
  pink: '#ec407a',
  cyan: '#00acc1',
  brown: '#6d4c41',
  gray: '#9e9e9e',
  grey: '#9e9e9e',
  gold: '#ffc107',
  silver: '#c0c0c0',
};

/** '#rrggbb'. Common color names (red, gold, ...) and '#rgb' are accepted and normalized. */
export const Color = z
  .string()
  .transform((s, ctx) => {
    const v = s.trim().toLowerCase();
    if (COLOR_RE.test(v)) return v;
    if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    const named = NAMED_COLORS[v];
    if (named) return named;
    ctx.addIssue({ code: 'custom', message: `Invalid color '${s}'. Use '#rrggbb' (for example '#ff8800').` });
    return z.NEVER;
  })
  .describe("Color as '#rrggbb'");
export type Color = string;

/** Project-relative asset path with forward slashes, e.g. 'models/coin.model.ts'. */
export const AssetPath = z
  .string()
  .min(1)
  .transform((s) => s.replaceAll('\\', '/').replace(/^\.\//, ''))
  .describe("Project-relative path, e.g. 'models/coin.model.ts'");

export const Transform = z.object({
  position: Vec3.default([0, 0, 0]),
  rotation: EulerDeg.default([0, 0, 0]),
  scale: Vec3.default([1, 1, 1]),
});
export type Transform = z.infer<typeof Transform>;

export const defaultTransform = (): Transform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Patch version of an object schema: every field optional and *without* defaults, so parsing
 * `{a: 1}` yields only `{a: 1}` (zod's `.partial()` would fill in defaults for missing keys).
 */
export function patchOf<T extends z.ZodObject>(
  schema: T,
): z.ZodObject<{
  [K in keyof T['shape']]: z.ZodOptional<z.ZodType<z.output<T['shape'][K]>, z.input<T['shape'][K]>>>;
}> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) {
    let t = v as z.ZodType;
    for (;;) {
      if (t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType;
      else if (t instanceof z.ZodOptional) t = t.unwrap() as z.ZodType;
      else break;
    }
    shape[k] = t.optional();
  }
  return z.object(shape) as any;
}

/** Drops keys whose value is undefined. */
export function definedOnly<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
