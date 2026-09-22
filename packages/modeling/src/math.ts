/** Tiny vector math on plain tuples. Recipes pass literals like [1, 2, 3], so we stay array-based. */
export type V2 = [number, number];
export type V3 = [number, number, number];
export type RGB = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const mulv = (a: V3, b: V3): V3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => len(sub(a, b));
export const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const lerp1 = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function normalize(a: V3): V3 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export const DEG = Math.PI / 180;

/** Rotation matrix (row-major 3x3) from Euler degrees, XYZ order (same as three.js / AIGE files). */
export function rotationMatrix(deg: V3): number[] {
  const [x, y, z] = [deg[0] * DEG, deg[1] * DEG, deg[2] * DEG];
  const a = Math.cos(x);
  const b = Math.sin(x);
  const c = Math.cos(y);
  const d = Math.sin(y);
  const e = Math.cos(z);
  const f = Math.sin(z);
  // Matches THREE.Matrix4.makeRotationFromEuler for order 'XYZ'
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  return [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
}

export function applyMat3(m: number[], v: V3): V3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

/** Rotation of `v` around unit `axis` by `angle` radians (Rodrigues). */
export function rotateAxis(v: V3, axis: V3, angle: number): V3 {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

export type Axis = 'x' | 'y' | 'z';
export const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** Parses '+y', '-x', 'up', 'down' or a vector into a unit direction. */
export function parseDirection(d: string | V3): V3 {
  if (Array.isArray(d)) return normalize(d as V3);
  const map: Record<string, V3> = {
    '+x': [1, 0, 0],
    x: [1, 0, 0],
    right: [1, 0, 0],
    '-x': [-1, 0, 0],
    left: [-1, 0, 0],
    '+y': [0, 1, 0],
    y: [0, 1, 0],
    up: [0, 1, 0],
    top: [0, 1, 0],
    '-y': [0, -1, 0],
    down: [0, -1, 0],
    bottom: [0, -1, 0],
    '+z': [0, 0, 1],
    z: [0, 0, 1],
    front: [0, 0, 1],
    forward: [0, 0, 1],
    '-z': [0, 0, -1],
    back: [0, 0, -1],
  };
  const v = map[d.toLowerCase()];
  if (!v) throw new Error(`Unknown direction '${d}'. Use '+x','-x','+y','-y','+z','-z' or [x,y,z].`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0]! + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid color '${hex}'. Use '#rrggbb'.`);
  const n = Number.parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: RGB): string {
  const h = (x: number) =>
    Math.round(clamp(x, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export type ColorInput = string | RGB;
export const toRgb = (c: ColorInput): RGB => (typeof c === 'string' ? hexToRgb(c) : [c[0], c[1], c[2]]);

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function mixColor(a: ColorInput, b: ColorInput, t: number): RGB {
  const x = toRgb(a);
  const y = toRgb(b);
  return [lerp1(x[0], y[0], t), lerp1(x[1], y[1], t), lerp1(x[2], y[2], t)];
}

// ---------------------------------------------------------------------------------------------
// Seeded random
// ---------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). Recipes get one seeded from the model's `seed` param. */
export class Random {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Random unit vector. */
  direction(): V3 {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  }
}
