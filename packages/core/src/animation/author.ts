/**
 * Tiny authoring DSL for the built-in clip library: key poses with easing and per-body-part lag (overlapping
 * action), procedural overlays (breathing, sway), sampled at 30 fps into AnimClip keyframes.
 */
import type { AnimClip, ClipEvent } from './clip.ts';
import { type BodyPose, type ContactGroup, evaluateBodyPose } from './rig.ts';
import type { BoneMask } from './skeleton.ts';

export type KeyEase = 'linear' | 'in' | 'out' | 'inOut' | 'soft';

export interface Key {
  t: number;
  p: BodyPose;
  /** Easing of the segment arriving at this key (default inOut). */
  e?: KeyEase;
}

type Flat = Map<string, number>;

function flatten(p: BodyPose, out: Flat = new Map(), prefix = ''): Flat {
  for (const [k, v] of Object.entries(p)) {
    if (k === 'contacts' || k === 'ground' || v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out.set(key, v);
    else if (Array.isArray(v))
      v.forEach((x, i) => {
        if (typeof x === 'number') out.set(`${key}.${i}`, x);
      });
    else if (typeof v === 'object') flatten(v as BodyPose, out, key);
  }
  return out;
}

const ARRAY_KEYS = new Set(['pos', 'hips', 'spine', 'chest', 'neck', 'head', 'ik', 'pole']);

function unflatten(m: Flat): BodyPose {
  const out: Record<string, any> = {};
  for (const [path, v] of m) {
    const parts = path.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
      if (cur[part] === undefined) cur[part] = nextIsIndex || ARRAY_KEYS.has(part) ? [] : {};
      cur = cur[part];
    }
    const last = parts[parts.length - 1]!;
    cur[/^\d+$/.test(last) ? Number(last) : last] = v;
  }
  return out as BodyPose;
}

function easeFn(e: KeyEase | undefined, t: number): number {
  switch (e) {
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'soft':
      // gentle start/end (quintic smootherstep)
      return t * t * t * (t * (t * 6 - 15) + 10);
    default:
      return t * t * (3 - 2 * t);
  }
}

/** Deep merge of poses (b overrides a); arrays are replaced. */
export function mergePose(a: BodyPose, b: BodyPose): BodyPose {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const av = (a as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && av && typeof av === 'object' && !Array.isArray(av))
      out[k] = { ...(av as object), ...(v as object) };
    else out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as BodyPose;
}

/**
 * Key-pose timeline. Each key merges onto the previous full pose. `lag` delays whole groups (e.g. { head: 0.1 })
 * for overlapping action.
 */
export function keyed(base: BodyPose, keys: Key[], lag: Partial<Record<string, number>> = {}) {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const fulls: BodyPose[] = [];
  let acc = base;
  for (const k of sorted) {
    acc = mergePose(acc, k.p);
    fulls.push(acc);
  }
  const flats = fulls.map((f) => flatten(f));
  const allKeys = new Set<string>();
  for (const f of flats) for (const k of f.keys()) allKeys.add(k);
  // Before a parameter is first keyed it has its neutral value: 0 for angles/weights, or (for IK targets and
  // poles, which have no neutral value) the first keyed target, so weights can ease in toward a fixed target.
  const firstDefined = new Map<string, number>();
  for (const path of allKeys) {
    for (const f of flats) {
      const v = f.get(path);
      if (v !== undefined) {
        firstDefined.set(path, v);
        break;
      }
    }
  }
  const valueAt = (i: number, path: string): number => {
    const v = flats[i]!.get(path);
    if (v !== undefined) return v;
    return /\.(ik|pole)\.\d$/.test(path) ? (firstDefined.get(path) ?? 0) : path.endsWith('.flat') ? 1 : 0;
  };
  return (t: number): BodyPose => {
    const m: Flat = new Map();
    for (const path of allKeys) {
      const group = path.split('.')[0]!;
      const tt = t - (lag[group] ?? 0);
      let i = 0;
      while (i + 1 < sorted.length && sorted[i + 1]!.t <= tt) i++;
      if (tt <= sorted[0]!.t || i === sorted.length - 1) {
        m.set(path, valueAt(tt <= sorted[0]!.t ? 0 : i, path));
        continue;
      }
      const a = valueAt(i, path);
      const b = valueAt(i + 1, path);
      const ka = sorted[i]!;
      const kb = sorted[i + 1]!;
      const f = easeFn(kb.e, Math.max(0, Math.min(1, (tt - ka.t) / Math.max(1e-6, kb.t - ka.t))));
      m.set(path, a + (b - a) * f);
    }
    const pose = unflatten(m);
    let ci = 0;
    while (ci + 1 < sorted.length && sorted[ci + 1]!.t <= t) ci++;
    const contacts: ContactGroup[] | undefined = fulls[ci]!.contacts;
    if (contacts) pose.contacts = contacts;
    const ground = fulls[ci]!.ground;
    if (ground !== undefined) pose.ground = ground;
    return pose;
  };
}

/** Adds `v` to a numeric path of a pose ('chest.0', 'armL.shrug'), creating it as needed. */
export function addTo(p: BodyPose, path: string, v: number): void {
  const parts = path.split('.');
  let cur: any = p;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (cur[part] === undefined) cur[part] = /^\d+$/.test(parts[i + 1]!) ? [0, 0, 0] : {};
    cur = cur[part];
  }
  const last = parts[parts.length - 1]!;
  const key = /^\d+$/.test(last) ? Number(last) : last;
  cur[key] = (cur[key] ?? 0) + v;
}

/** Periodic smooth noise in [-1, 1] with period `period` (sum of harmonics; loops seamlessly). */
export function loopNoise(t: number, period: number, seed: number, harmonics = 3): number {
  let s = 0;
  let norm = 0;
  for (let h = 1; h <= harmonics; h++) {
    const a = 1 / h;
    const ph = Math.sin(seed * 12.9898 + h * 78.233) * 43758.5453;
    s += a * Math.sin(((2 * Math.PI * h) / period) * t + (ph - Math.floor(ph)) * 2 * Math.PI);
    norm += a;
  }
  return s / norm;
}

/** Smooth 0..1 ramp between t0 and t1. */
export function ramp(t: number, t0: number, t1: number): number {
  const x = Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)));
  return x * x * (3 - 2 * x);
}

/** Bump 0..1..0 centered at c with half-width w (cosine). */
export function bump(t: number, c: number, w: number): number {
  const x = (t - c) / w;
  return Math.abs(x) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
}

/** Periodic Catmull-Rom through (phase, value) points on [0, 1). */
export function cyclic(points: [number, number][]): (phase: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  return (phase: number) => {
    const x = ((phase % 1) + 1) % 1;
    let i = n - 1;
    for (let k = 0; k < n; k++) if (pts[k]![0] <= x) i = k;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p0 = pts[(i - 1 + n) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const x1 = p1[0];
    let x2 = p2[0];
    if (x2 <= x1) x2 += 1;
    const xx = x < x1 ? x + 1 : x;
    const u = (xx - x1) / (x2 - x1);
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * u +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3)
    );
  };
}

export interface ClipMeta {
  name: string;
  description: string;
  duration: number;
  loop: boolean;
  next?: string;
  mask?: BoneMask;
  events?: ClipEvent[];
  setting?: 'bed' | 'floor' | 'none';
  fps?: number;
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Samples a pose function into an AnimClip (dense linear keys). */
export function bake(meta: ClipMeta, fn: (t: number) => BodyPose): AnimClip {
  const fps = meta.fps ?? 30;
  const frames = Math.max(1, Math.round(meta.duration * fps));
  const tracks: Record<string, { t: number; rot: number[]; ease: 'linear' }[]> = {};
  const hips: { t: number; pos: [number, number, number]; ease: 'linear' }[] = [];
  for (let i = 0; i <= frames; i++) {
    const t = meta.loop && i === frames ? 0 : (i / frames) * meta.duration;
    const kt = r5((i / frames) * meta.duration);
    const e = evaluateBodyPose(fn(t));
    for (const [bone, q] of Object.entries(e.rot)) {
      (tracks[bone] ??= []).push({ t: kt, rot: q.map(r5), ease: 'linear' });
    }
    hips.push({ t: kt, pos: [r5(e.hips[0]), r5(e.hips[1]), r5(e.hips[2])], ease: 'linear' });
  }
  const clip: AnimClip = {
    format: 'aige.anim',
    version: 1,
    name: meta.name,
    description: meta.description,
    duration: meta.duration,
    loop: meta.loop,
    tracks,
    hips,
  };
  if (meta.next) clip.next = meta.next;
  if (meta.mask) clip.mask = meta.mask;
  if (meta.events) clip.events = meta.events;
  if (meta.setting) clip.setting = meta.setting;
  return clip;
}
