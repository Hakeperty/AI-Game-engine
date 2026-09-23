import { AssetPath, Color } from '@aige/core';

/** Minimal structural view of a zod v4 schema (avoids a direct zod dependency in the renderer). */
interface ZodLike {
  def?: {
    type: string;
    innerType?: ZodLike;
    items?: ZodLike[];
    entries?: Record<string, string | number>;
    in?: ZodLike;
    shape?: Record<string, ZodLike>;
  };
  description?: string;
  options?: unknown[];
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
  format?: string | null;
  shape?: Record<string, ZodLike>;
  safeParse?(v: unknown): { success: boolean; data?: unknown };
}

export type FieldKind =
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string'
  | 'color'
  | 'asset'
  | 'vec3'
  | 'vec2'
  | 'record'
  | 'unknown';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  optional: boolean;
  defaultValue: unknown;
  options?: string[];
  min?: number;
  max?: number;
  int?: boolean;
  description?: string;
}

function unwrap(s: ZodLike): { core: ZodLike; optional: boolean; description?: string } {
  let cur = s;
  let optional = false;
  let description = s.description;
  for (let i = 0; i < 10; i++) {
    const t = cur.def?.type;
    if ((t === 'default' || t === 'optional' || t === 'nullable' || t === 'prefault') && cur.def?.innerType) {
      if (t === 'optional' || t === 'nullable') optional = true;
      cur = cur.def.innerType;
      description ??= cur.description;
      continue;
    }
    break;
  }
  return { core: cur, optional, ...(description ? { description } : {}) };
}

function defaultOf(s: ZodLike): unknown {
  try {
    const r = s.safeParse?.(undefined);
    return r?.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export function describeField(key: string, schema: unknown): FieldSpec {
  const s = schema as ZodLike;
  const { core, optional, description } = unwrap(s);
  const base = { key, optional, defaultValue: defaultOf(s), ...(description ? { description } : {}) };
  if (core === (Color as unknown)) return { ...base, kind: 'color' };
  if (core === (AssetPath as unknown)) return { ...base, kind: 'asset' };
  switch (core.def?.type) {
    case 'number': {
      const spec: FieldSpec = { ...base, kind: 'number' };
      if (typeof core.minValue === 'number' && Number.isFinite(core.minValue)) spec.min = core.minValue;
      if (typeof core.maxValue === 'number' && Number.isFinite(core.maxValue)) spec.max = core.maxValue;
      if (core.isInt || core.format === 'safeint' || core.format === 'int32') spec.int = true;
      return spec;
    }
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'enum': {
      const options =
        (core.options as string[] | undefined) ?? Object.values(core.def.entries ?? {}).map(String);
      return { ...base, kind: 'enum', options };
    }
    case 'string':
      return { ...base, kind: 'string' };
    case 'tuple': {
      const n = core.def.items?.length ?? 0;
      if (n === 3) return { ...base, kind: 'vec3' };
      if (n === 2) return { ...base, kind: 'vec2' };
      return { ...base, kind: 'unknown' };
    }
    case 'record':
      return { ...base, kind: 'record' };
    case 'pipe': {
      const inner = core.def.in;
      if (inner?.def?.type === 'string') return { ...base, kind: 'string' };
      return { ...base, kind: 'unknown' };
    }
    default:
      return { ...base, kind: 'unknown' };
  }
}

export function describeObject(schema: unknown): FieldSpec[] {
  const s = schema as ZodLike;
  const shape = s.shape ?? s.def?.shape ?? {};
  return Object.entries(shape).map(([k, v]) => describeField(k, v));
}

/** Human label: 'castShadow' -> 'Cast Shadow'. */
export function labelOf(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
