import { Random } from './math.ts';
import { type Model, toModel } from './model.ts';
import { Noise } from './noise.ts';
import type { PolyMesh } from './polymesh.ts';

export type ParamDef =
  | { type: 'number'; default: number; min?: number; max?: number; step?: number; description?: string }
  | { type: 'int'; default: number; min?: number; max?: number; description?: string }
  | { type: 'color'; default: string; description?: string }
  | { type: 'boolean'; default: boolean; description?: string }
  | { type: 'choice'; default: string; options: string[]; description?: string };

type ParamValue<D> = D extends { type: 'number' | 'int' }
  ? number
  : D extends { type: 'color' | 'choice' }
    ? string
    : D extends { type: 'boolean' }
      ? boolean
      : never;

export type ParamValues<P extends Record<string, ParamDef>> = { [K in keyof P]: ParamValue<P[K]> } & {
  seed: number;
};

/** Parameter builders. Params become sliders in the editor and can be overridden per entity. */
export const p = {
  number(def: number, opts: { min?: number; max?: number; step?: number; description?: string } = {}) {
    return { type: 'number' as const, default: def, ...opts };
  },
  int(def: number, opts: { min?: number; max?: number; description?: string } = {}) {
    return { type: 'int' as const, default: def, ...opts };
  },
  color(def: string, opts: { description?: string } = {}) {
    return { type: 'color' as const, default: def, ...opts };
  },
  boolean(def: boolean, opts: { description?: string } = {}) {
    return { type: 'boolean' as const, default: def, ...opts };
  },
  choice<const O extends string>(options: readonly O[], def: O, opts: { description?: string } = {}) {
    return { type: 'choice' as const, default: def as string, options: [...options] as string[], ...opts };
  },
};

export interface BuildContext {
  /** Seeded random numbers (same seed = same model). */
  rng: Random;
  /** Seeded 3D noise. */
  noise: Noise;
  seed: number;
}

export type BuildResult = PolyMesh | PolyMesh[] | Record<string, PolyMesh> | Model;

export interface RecipeDef<P extends Record<string, ParamDef> = Record<string, ParamDef>> {
  name?: string;
  description?: string;
  params?: P;
  /** Seed used when none is given (default 1). */
  defaultSeed?: number;
  build(params: ParamValues<P>, ctx: BuildContext): BuildResult;
}

export interface Recipe<P extends Record<string, ParamDef> = Record<string, ParamDef>> extends RecipeDef<P> {
  readonly __aige: 'model';
}

/**
 * A copy of `recipe` with different parameter defaults (and optionally a new name/description).
 * Used to make variants of templates: export default withDefaults(coin, { radius: 0.6, color: '#c0c0c0' }).
 */
export function withDefaults<P extends Record<string, ParamDef>>(
  recipe: Recipe<P>,
  defaults: Partial<Record<keyof P | 'seed', unknown>>,
  meta: { name?: string; description?: string } = {},
): Recipe<P> {
  const params = { ...(recipe.params ?? {}) } as Record<string, ParamDef>;
  let defaultSeed = recipe.defaultSeed;
  for (const [key, value] of Object.entries(defaults)) {
    if (key === 'seed') {
      defaultSeed = Number(value);
      continue;
    }
    const def = params[key];
    if (!def) {
      throw new Error(
        `Unknown parameter '${key}'. Parameters: ${Object.keys(params).join(', ') || '(none)'}, seed.`,
      );
    }
    params[key] = { ...def, default: value } as ParamDef;
  }
  return {
    ...recipe,
    ...meta,
    params: params as P,
    ...(defaultSeed !== undefined ? { defaultSeed } : {}),
    __aige: 'model',
  };
}

/**
 * Declares a procedural model. The default export of every models/*.model.ts file.
 * @example
 * export default defineModel({
 *   params: { radius: p.number(0.5, { min: 0.1, max: 2 }), color: p.color('#ffc107') },
 *   build: ({ radius, color }) => cylinder({ radius, height: 0.1 }).rotate([90, 0, 0]).material({ color, metalness: 1 }),
 * });
 */
export function defineModel<const P extends Record<string, ParamDef>>(def: RecipeDef<P>): Recipe<P> {
  return { ...def, __aige: 'model' };
}

export function isRecipe(v: unknown): v is Recipe {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as Recipe).__aige === 'model' &&
    typeof (v as Recipe).build === 'function'
  );
}

/** Resolves final parameter values: defaults, overrides, clamping and type checks. */
export function resolveParams(
  recipe: Recipe,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const defs = recipe.params ?? {};
  for (const key of Object.keys(overrides)) {
    if (key !== 'seed' && !(key in defs)) {
      throw new Error(
        `Unknown parameter '${key}'. Parameters: ${Object.keys(defs).join(', ') || '(none)'}, seed.`,
      );
    }
  }
  for (const [key, def] of Object.entries(defs)) {
    const raw = overrides[key] ?? def.default;
    switch (def.type) {
      case 'number':
      case 'int': {
        let v = Number(raw);
        if (!Number.isFinite(v)) throw new Error(`Parameter '${key}' must be a number.`);
        if (def.min !== undefined) v = Math.max(def.min, v);
        if (def.max !== undefined) v = Math.min(def.max, v);
        out[key] = def.type === 'int' ? Math.round(v) : v;
        break;
      }
      case 'color': {
        const s = String(raw);
        if (!/^#[0-9a-fA-F]{6}$/.test(s))
          throw new Error(`Parameter '${key}' must be a color like '#ff8800'.`);
        out[key] = s.toLowerCase();
        break;
      }
      case 'boolean':
        out[key] = Boolean(raw);
        break;
      case 'choice': {
        const s = String(raw);
        if (!def.options.includes(s))
          throw new Error(`Parameter '${key}' must be one of: ${def.options.join(', ')}.`);
        out[key] = s;
        break;
      }
    }
  }
  out.seed = Math.round(Number(overrides.seed ?? recipe.defaultSeed ?? 1)) || 1;
  return out;
}

/** Runs a recipe and returns a Model. */
export function buildRecipe(recipe: Recipe, overrides: Record<string, unknown> = {}): Model {
  const params = resolveParams(recipe, overrides);
  const seed = params.seed as number;
  const result = recipe.build(params as never, { rng: new Random(seed), noise: new Noise(seed), seed });
  return toModel(result);
}

/** JSON-friendly description of a recipe's parameters (for tools and the editor). */
export function describeParams(recipe: Recipe): Record<string, ParamDef> {
  return { ...(recipe.params ?? {}), seed: { type: 'int', default: 1, min: 1, description: 'Random seed' } };
}
