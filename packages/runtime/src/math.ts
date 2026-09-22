import { AigeError } from '@aige/core';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { V3, Vec3Like } from './types.ts';

export const DEG = MathUtils.DEG2RAD;
export const RAD = MathUtils.RAD2DEG;

function describe(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** True for anything readVec3 accepts. */
export function isVec3Like(v: unknown): v is Vec3Like {
  if (Array.isArray(v)) return v.length >= 3 && v.every((n) => typeof n === 'number');
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as any).x === 'number' &&
    typeof (v as any).y === 'number' &&
    typeof (v as any).z === 'number'
  );
}

/**
 * Reads a vector from `[x,y,z]`, `{x,y,z}`, a Vector3 or a single number (uniform). Writes into `out`.
 * Throws a readable error for anything else.
 */
export function readVec3(v: unknown, out: Vector3 = new Vector3(), what = 'vector'): Vector3 {
  if (typeof v === 'number' && Number.isFinite(v)) return out.set(v, v, v);
  if (Array.isArray(v)) {
    const x = Number(v[0] ?? 0);
    const y = Number(v[1] ?? 0);
    const z = Number(v[2] ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return out.set(x, y, z);
  } else if (v && typeof v === 'object') {
    const o = v as { x?: unknown; y?: unknown; z?: unknown };
    const x = Number(o.x ?? 0);
    const y = Number(o.y ?? 0);
    const z = Number(o.z ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return out.set(x, y, z);
  }
  throw new AigeError('INVALID_INPUT', `Expected a ${what} like [x, y, z], got ${describe(v)}.`, {
    hint: 'Pass an array [x, y, z], an object {x, y, z} or a Vector3.',
  });
}

/** Like readVec3 but returns `fallback` instead of throwing. */
export function vec3Or(v: unknown, fallback: V3): V3 {
  if (
    Array.isArray(v) &&
    v.length >= 3 &&
    v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    return [v[0], v[1], v[2]];
  if (isVec3Like(v)) return [(v as any).x, (v as any).y, (v as any).z];
  return [...fallback];
}

export function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Reads a rotation: Quaternion, three.js Euler (radians) or Euler degrees as `[x,y,z]` / `{x,y,z}`.
 */
export function readRotation(r: unknown, out: Quaternion = new Quaternion()): Quaternion {
  if (r && typeof r === 'object') {
    const o = r as any;
    if (o.isQuaternion || (typeof o.w === 'number' && typeof o.x === 'number' && !Array.isArray(r))) {
      return out.set(o.x, o.y, o.z, o.w).normalize();
    }
    if (o.isEuler) return out.setFromEuler(o as Euler);
  }
  const d = readVec3(r, _v, 'rotation in degrees');
  return out.setFromEuler(_e.set(d.x * DEG, d.y * DEG, d.z * DEG, 'XYZ'));
}

const _v = new Vector3();
const _e = new Euler();

export function quatToEulerDeg(q: Quaternion): V3 {
  _e.setFromQuaternion(q, 'XYZ');
  return [_e.x * RAD, _e.y * RAD, _e.z * RAD];
}

export function round(n: number, decimals = 6): number {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function roundV(v: { x: number; y: number; z: number } | readonly number[], decimals = 6): V3 {
  if (Array.isArray(v)) return [round(v[0], decimals), round(v[1], decimals), round(v[2], decimals)];
  const o = v as { x: number; y: number; z: number };
  return [round(o.x, decimals), round(o.y, decimals), round(o.z, decimals)];
}

// ---------------------------------------------------------------------------------------------
// Seeded random numbers
// ---------------------------------------------------------------------------------------------

/** Small, fast, seedable PRNG (sfc32). Same seed, same sequence, on every platform. */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed = 1) {
    this.seed(seed);
  }

  seed(seed: number): void {
    // splitmix32 to spread the seed over the state
    let s = seed >>> 0 || 0x9e3779b9;
    const next = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
}

// ---------------------------------------------------------------------------------------------
// Hashing & plain-data conversion
// ---------------------------------------------------------------------------------------------

/** cyrb53: fast 53-bit string hash, returned as 14 hex chars. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/**
 * Converts arbitrary script data (Game.state, event payloads) into JSON-safe plain data:
 * vectors become arrays, entities become `{entity, name}`, functions are dropped, cycles are cut.
 */
export function toPlain(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  const o = value as any;
  if (o.isRuntimeEntity) return { entity: o.id, name: o.name };
  if (o.isVector3) return [o.x, o.y, o.z];
  if (o.isVector2) return [o.x, o.y];
  if (o.isQuaternion) return [o.x, o.y, o.z, o.w];
  if (o.isEuler) return [o.x * RAD, o.y * RAD, o.z * RAD];
  if (o.isColor) return `#${o.getHexString()}`;
  if (depth > 12 || seen.has(o)) return '[Circular]';
  seen.add(o);
  try {
    if (Array.isArray(o)) return o.map((x) => toPlain(x, depth + 1, seen) ?? null);
    const tag = Object.prototype.toString.call(o);
    if (tag === '[object Map]') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of o) out[String(k)] = toPlain(v, depth + 1, seen);
      return out;
    }
    if (tag === '[object Set]') return [...o].map((x) => toPlain(x, depth + 1, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      const v = toPlain(o[k], depth + 1, seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

/** JSON with sorted keys (for hashing). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** Formats one log argument for humans (and AIs reading logs). */
export function formatArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(round(v, 3));
  if (v === undefined) return 'undefined';
  if (v && typeof v === 'object') {
    const o = v as any;
    if (o.isRuntimeEntity) return `${o.name}(${o.id})`;
    if (o.isVector3) return `(${round(o.x, 3)}, ${round(o.y, 3)}, ${round(o.z, 3)})`;
    if (o instanceof Error || (typeof o.message === 'string' && typeof o.stack === 'string'))
      return String(o.message);
  }
  try {
    return JSON.stringify(toPlain(v));
  } catch {
    return String(v);
  }
}

/** Deep clone of JSON-like data (components, documents). */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return toPlain(v) as T;
}

/**
 * Deep-copies script props: arrays and plain objects are copied, objects with a `clone()` method
 * (Vector3, Color, ...) are cloned, everything else is shared.
 */
export function cloneProps<T>(v: T, depth = 0): T {
  if (v === null || typeof v !== 'object' || depth > 16) return v;
  if (Array.isArray(v)) return v.map((x) => cloneProps(x, depth + 1)) as T;
  const o = v as any;
  if (typeof o.clone === 'function') return o.clone();
  // plain object (also from another realm, e.g. a sandboxed script): its prototype's prototype is null
  const proto = Object.getPrototypeOf(o);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = cloneProps(o[k], depth + 1);
  return out as T;
}
