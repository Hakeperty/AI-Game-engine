/**
 * Skeletal animation clips: the JSON format (`animations/<name>.anim.json`), compiled sampling, blending and the
 * serializable pose state the runtime shares with renderers (so headless play-tests and screenshots are
 * deterministic).
 */
import { z } from 'zod';
import { type Quat, quatFromEuler, quatIdentity, quatNormalize, quatSlerp, type V3 } from './quat.ts';
import { BONE_MASK_NAMES, BONE_MASKS, type BoneMask } from './skeleton.ts';

export const EASINGS = ['linear', 'in', 'out', 'inOut', 'step'] as const;
export type Ease = (typeof EASINGS)[number];

/** Rotation keyframe: `rot` is Euler degrees [x, y, z] (XYZ order) or a quaternion [x, y, z, w]. */
export interface RotKey {
  t: number;
  rot: number[];
  /** Easing of the segment arriving at this key (default 'inOut'). */
  ease?: Ease;
}

/** Hips translation keyframe: offset from the bind position in meters (for a 0.96 m hip height). */
export interface PosKey {
  t: number;
  pos: V3;
  ease?: Ease;
}

export interface ClipEvent {
  t: number;
  name: string;
}

/**
 * An animation clip. Rotations are relative to the bind pose, per bone (see the skeleton convention in
 * skeleton.ts: +X bends forward, +Y turns left, +Z leans right for spine bones).
 */
export interface AnimClip {
  format?: 'aige.anim';
  version?: 1;
  name: string;
  description?: string;
  /** Seconds. */
  duration: number;
  loop: boolean;
  /** Bone name -> rotation keys (sorted by t). */
  tracks: Record<string, RotKey[]>;
  /** Hips translation keys (meters, authored for a 0.96 m hip height and scaled to the character). */
  hips?: PosKey[];
  /** One-shot clips: clip to crossfade to when this one ends ('hold' keeps the last frame). */
  next?: string;
  /** Bones the clip affects when used as a layer (animator.layer(...)). Default 'full'. */
  mask?: BoneMask;
  /** Named markers; the Animator fires them (animator.onEvent) as playback passes them. */
  events?: ClipEvent[];
  /** Built-in clips: 'bed' or 'floor' setting hint for previews. */
  setting?: 'bed' | 'floor' | 'none';
  /** Locomotion clips: ground speed (m/s at a 0.96 m hip height) the cycle was authored for. */
  speed?: number;
}

const EaseSchema = z.enum(EASINGS);
const RotKeySchema = z
  .object({
    t: z.number().min(0),
    rot: z.array(z.number()).min(3).max(4).describe('Euler degrees [x,y,z] or quaternion [x,y,z,w]'),
    ease: EaseSchema.optional(),
  })
  .strict();
const PosKeySchema = z
  .object({
    t: z.number().min(0),
    pos: z.tuple([z.number(), z.number(), z.number()]),
    ease: EaseSchema.optional(),
  })
  .strict();

/** Zod schema of an `.anim.json` file. */
export const AnimClipSchema = z
  .object({
    format: z.literal('aige.anim').default('aige.anim'),
    version: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),
    duration: z.number().positive(),
    loop: z.boolean().default(false),
    tracks: z.record(z.string(), z.array(RotKeySchema).min(1)).default({}),
    hips: z.array(PosKeySchema).optional(),
    next: z.string().optional(),
    mask: z.enum(BONE_MASK_NAMES as [BoneMask, ...BoneMask[]]).optional(),
    events: z.array(z.object({ t: z.number().min(0), name: z.string().min(1) }).strict()).optional(),
    setting: z.enum(['bed', 'floor', 'none']).optional(),
    speed: z.number().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Compiled clips (fast sampling)
// ---------------------------------------------------------------------------------------------

interface RotTrack {
  times: Float64Array;
  /** 4 floats per key. */
  quats: Float64Array;
  eases: Uint8Array;
}

interface PosTrack {
  times: Float64Array;
  pos: Float64Array;
  eases: Uint8Array;
}

export interface CompiledClip {
  readonly clip: AnimClip;
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: Map<string, RotTrack>;
  readonly hips: PosTrack | null;
}

const EASE_INDEX: Record<Ease, number> = { linear: 0, in: 1, out: 2, inOut: 3, step: 4 };

function ease(kind: number, t: number): number {
  switch (kind) {
    case 0:
      return t;
    case 1:
      return t * t * t;
    case 2:
      return 1 - (1 - t) ** 3;
    case 4:
      return t < 1 ? 0 : 1;
    default:
      return t * t * (3 - 2 * t);
  }
}

const compiledCache = new WeakMap<AnimClip, CompiledClip>();

/** Pre-processes a clip for sampling (cached per clip object). */
export function compileClip(clip: AnimClip): CompiledClip {
  const cached = compiledCache.get(clip);
  if (cached) return cached;
  const tracks = new Map<string, RotTrack>();
  for (const [bone, keys] of Object.entries(clip.tracks ?? {})) {
    if (!keys?.length) continue;
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    const times = new Float64Array(sorted.length);
    const quats = new Float64Array(sorted.length * 4);
    const eases = new Uint8Array(sorted.length);
    let prev: Quat | null = null;
    sorted.forEach((k, i) => {
      times[i] = k.t;
      const q: Quat =
        k.rot.length >= 4
          ? quatNormalize([k.rot[0]!, k.rot[1]!, k.rot[2]!, k.rot[3]!])
          : quatFromEuler(k.rot[0] ?? 0, k.rot[1] ?? 0, k.rot[2] ?? 0, 'XYZ');
      // keep consecutive keys in the same hemisphere so linear blends stay short
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) {
        q[0] = -q[0];
        q[1] = -q[1];
        q[2] = -q[2];
        q[3] = -q[3];
      }
      prev = q;
      quats.set(q, i * 4);
      eases[i] = EASE_INDEX[k.ease ?? 'inOut'] ?? 3;
    });
    tracks.set(bone, { times, quats, eases });
  }
  let hips: PosTrack | null = null;
  if (clip.hips?.length) {
    const sorted = [...clip.hips].sort((a, b) => a.t - b.t);
    hips = {
      times: Float64Array.from(sorted.map((k) => k.t)),
      pos: Float64Array.from(sorted.flatMap((k) => k.pos)),
      eases: Uint8Array.from(sorted.map((k) => EASE_INDEX[k.ease ?? 'inOut'] ?? 3)),
    };
  }
  const c: CompiledClip = {
    clip,
    name: clip.name,
    duration: Math.max(1e-3, clip.duration),
    loop: !!clip.loop,
    tracks,
    hips,
  };
  compiledCache.set(clip, c);
  return c;
}

/** Index of the segment containing t (key i..i+1) and the eased blend factor. */
function locate(times: Float64Array, eases: Uint8Array, t: number): [number, number, number] {
  const n = times.length;
  if (n === 1 || t <= times[0]!) return [0, 0, 0];
  if (t >= times[n - 1]!) return [n - 1, n - 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi]! - times[lo]!;
  const f = span > 1e-9 ? (t - times[lo]!) / span : 1;
  return [lo, hi, ease(eases[hi]!, f)];
}

/** A skeletal pose: local rotation per bone (relative to bind) plus the hips offset (reference meters). */
export interface Pose {
  rot: Record<string, Quat>;
  hips: V3;
  /** Extra jaw opening 0..1 from speech (applied by renderers on top of the jaw track). */
  mouth?: number;
}

export function emptyPose(): Pose {
  return { rot: {}, hips: [0, 0, 0] };
}

/** Clamps (one-shot) or wraps (looping) a playback time into [0, duration]. */
export function clipTime(c: CompiledClip, time: number, loop = c.loop): number {
  if (!Number.isFinite(time)) return 0;
  if (loop) {
    const d = c.duration;
    const r = time % d;
    return r < 0 ? r + d : r;
  }
  return Math.max(0, Math.min(c.duration, time));
}

/** Samples a clip at `time` (seconds; already wrapped/clamped by the caller or via clipTime). */
export function sampleClip(c: CompiledClip, time: number, out: Pose = emptyPose()): Pose {
  const t = Math.max(0, Math.min(c.duration, time));
  for (const [bone, tr] of c.tracks) {
    const [i, j, f] = locate(tr.times, tr.eases, t);
    const q: Quat = out.rot[bone] ?? quatIdentity();
    if (i === j || f <= 0) {
      q[0] = tr.quats[i * 4]!;
      q[1] = tr.quats[i * 4 + 1]!;
      q[2] = tr.quats[i * 4 + 2]!;
      q[3] = tr.quats[i * 4 + 3]!;
    } else {
      quatSlerp(tr.quats.subarray(i * 4, i * 4 + 4), tr.quats.subarray(j * 4, j * 4 + 4), f, q);
    }
    out.rot[bone] = q;
  }
  if (c.hips) {
    const [i, j, f] = locate(c.hips.times, c.hips.eases, t);
    const p = c.hips.pos;
    out.hips[0] = p[i * 3]! + (p[j * 3]! - p[i * 3]!) * f;
    out.hips[1] = p[i * 3 + 1]! + (p[j * 3 + 1]! - p[i * 3 + 1]!) * f;
    out.hips[2] = p[i * 3 + 2]! + (p[j * 3 + 2]! - p[i * 3 + 2]!) * f;
  } else {
    out.hips[0] = 0;
    out.hips[1] = 0;
    out.hips[2] = 0;
  }
  return out;
}

/**
 * Blends pose `b` into `a` with weight w (0 = a, 1 = b), in place on `a`. With a mask only those bones blend
 * (and the hips offset only when the mask contains 'hips').
 */
export function blendPose(a: Pose, b: Pose, w: number, mask?: readonly string[] | null): Pose {
  if (w <= 0) return a;
  const bones = mask ?? [...new Set([...Object.keys(a.rot), ...Object.keys(b.rot)])];
  const id = quatIdentity();
  for (const bone of bones) {
    const qa = a.rot[bone] ?? quatIdentity();
    const qb = b.rot[bone] ?? id;
    a.rot[bone] = w >= 1 ? [qb[0], qb[1], qb[2], qb[3]] : quatSlerp(qa, qb, w, qa);
  }
  if (!mask || mask.includes('hips')) {
    a.hips[0] += (b.hips[0] - a.hips[0]) * w;
    a.hips[1] += (b.hips[1] - a.hips[1]) * w;
    a.hips[2] += (b.hips[2] - a.hips[2]) * w;
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// Pose state (what the runtime Animator publishes and renderers consume)
// ---------------------------------------------------------------------------------------------

export interface PoseLayerState {
  clip: string;
  time: number;
  weight: number;
  mask: BoneMask;
}

/**
 * Serializable animation state of one character. The runtime owns it (entity.animator.pose); snapshots carry it
 * as the Animator component's `_pose` field; renderers turn it into bone transforms.
 * Final pose = blend(prev @ prevTime, clip @ time, fade) then the optional masked layer; `mouth` opens the jaw.
 */
export interface AnimPoseState {
  clip: string;
  /** Playback time in `clip` (seconds, already wrapped for loops / clamped for one-shots). */
  time: number;
  prev: string | null;
  prevTime: number;
  /** Weight of `clip` against `prev` (1 = only clip). */
  fade: number;
  mouth: number;
  layer?: PoseLayerState | null;
}

export function poseState(clip: string, time = 0): AnimPoseState {
  return { clip, time, prev: null, prevTime: 0, fade: 1, mouth: 0, layer: null };
}

/** Reads a pose state from untrusted data (e.g. a snapshot's `_pose`); null when invalid. */
export function readPoseState(v: unknown): AnimPoseState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.clip !== 'string') return null;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const layer = o.layer as Record<string, unknown> | null | undefined;
  return {
    clip: o.clip,
    time: num(o.time, 0),
    prev: typeof o.prev === 'string' ? o.prev : null,
    prevTime: num(o.prevTime, 0),
    fade: Math.max(0, Math.min(1, num(o.fade, 1))),
    mouth: Math.max(0, Math.min(1, num(o.mouth, 0))),
    layer:
      layer && typeof layer === 'object' && typeof layer.clip === 'string'
        ? {
            clip: layer.clip,
            time: num(layer.time, 0),
            weight: Math.max(0, Math.min(1, num(layer.weight, 1))),
            mask: (BONE_MASK_NAMES as string[]).includes(layer.mask as string)
              ? (layer.mask as BoneMask)
              : 'upper',
          }
        : null,
  };
}

/** Evaluates a pose state into a Pose. `resolve` maps clip names to compiled clips (null = unknown). */
export function evaluatePoseState(
  state: AnimPoseState,
  resolve: (name: string) => CompiledClip | null,
  out: Pose = emptyPose(),
): Pose {
  for (const k of Object.keys(out.rot)) delete out.rot[k];
  out.hips[0] = 0;
  out.hips[1] = 0;
  out.hips[2] = 0;
  const cur = resolve(state.clip);
  const prev = state.prev && state.fade < 1 ? resolve(state.prev) : null;
  if (prev) {
    sampleClip(prev, state.prevTime, out);
    if (cur) blendPose(out, sampleClip(cur, state.time), state.fade);
  } else if (cur) sampleClip(cur, state.time, out);
  const layer = state.layer;
  if (layer && layer.weight > 0) {
    const lc = resolve(layer.clip);
    if (lc) blendPose(out, sampleClip(lc, layer.time), layer.weight, BONE_MASKS[layer.mask] ?? null);
  }
  out.mouth = state.mouth;
  return out;
}
