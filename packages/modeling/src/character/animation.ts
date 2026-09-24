/**
 * Turns AIGE animation clips (core `AnimClip`, e.g. the built-in humanoid library) into keyframed
 * `ModelAnimation`s for glTF export: one rotation channel per animated bone and a hips translation channel,
 * resampled at a fixed rate, with values as final local joint transforms of the target skeleton.
 */
import {
  type AnimClip,
  builtinClip,
  builtinClipNames,
  CLIP_ALIASES,
  compileClip,
  emptyPose,
  hipsHeight,
  REFERENCE_HIPS_HEIGHT,
  sampleClip,
} from '@aige/core';
import type { ModelAnimation, Skeleton } from '../model.ts';

export interface ClipBakeOptions {
  /** Samples per second (default 30). */
  fps?: number;
}

/**
 * Bakes a clip onto a skeleton. Rotations are local joint rotations (bind rotations are identity in the AIGE
 * convention, so they are the clip rotations); the hips translation is the bind position plus the clip's hips
 * offset scaled from the reference hip height to this skeleton's.
 */
export function clipToModelAnimation(
  clip: AnimClip,
  skeleton: Skeleton,
  opts: ClipBakeOptions = {},
): ModelAnimation {
  const c = compileClip(clip);
  const fps = opts.fps ?? 30;
  const frames = Math.max(1, Math.round(c.duration * fps));
  const times = new Float32Array(frames + 1);
  for (let i = 0; i <= frames; i++) times[i] = (i / frames) * c.duration;
  const names = new Set(skeleton.joints.map((j) => j.name));
  const bones = [...c.tracks.keys()].filter((b) => names.has(b));
  const rot = new Map(bones.map((b) => [b, new Float32Array((frames + 1) * 4)]));
  const hipsJoint = skeleton.joints.find((j) => j.name === 'hips');
  const hipsPos = hipsJoint ? new Float32Array((frames + 1) * 3) : null;
  const k = hipsHeight(skeleton) / REFERENCE_HIPS_HEIGHT;
  const pose = emptyPose();
  for (let i = 0; i <= frames; i++) {
    sampleClip(c, times[i]!, pose);
    for (const b of bones) {
      const q = pose.rot[b]!;
      const arr = rot.get(b)!;
      // keep neighbouring keys in the same hemisphere so linear interpolation takes the short way
      let s = 1;
      if (i > 0) {
        const d =
          arr[(i - 1) * 4]! * q[0] +
          arr[(i - 1) * 4 + 1]! * q[1] +
          arr[(i - 1) * 4 + 2]! * q[2] +
          arr[(i - 1) * 4 + 3]! * q[3];
        if (d < 0) s = -1;
      }
      arr.set([q[0] * s, q[1] * s, q[2] * s, q[3] * s], i * 4);
    }
    if (hipsPos && hipsJoint) {
      hipsPos[i * 3] = hipsJoint.position[0] + pose.hips[0] * k;
      hipsPos[i * 3 + 1] = hipsJoint.position[1] + pose.hips[1] * k;
      hipsPos[i * 3 + 2] = hipsJoint.position[2] + pose.hips[2] * k;
    }
  }
  deriveFingers(rot, names, times, c.duration, frames, bones);
  const channels: ModelAnimation['channels'] = bones.map((b) => ({
    joint: b,
    path: 'rotation' as const,
    times,
    values: rot.get(b)!,
  }));
  if (hipsPos && c.hips) channels.push({ joint: 'hips', path: 'translation', times, values: hipsPos });
  return {
    name: clip.name,
    channels,
    loop: c.loop,
    duration: c.duration,
    ...(clip.next ? { next: clip.next } : {}),
    ...(clip.events?.length ? { events: clip.events.map((e) => ({ t: e.t, name: e.name })) } : {}),
  };
}

/**
 * Built-in clips baked for a skeleton. `names`: 'all' (default), 'none', or a list of clip names/aliases
 * (unknown names are ignored; the exported animation is named after the canonical clip).
 */
export function builtinAnimations(
  skeleton: Skeleton,
  names: 'all' | 'none' | readonly string[] = 'all',
  opts: ClipBakeOptions = {},
): ModelAnimation[] {
  if (names === 'none') return [];
  const list = names === 'all' ? builtinClipNames() : names;
  const out: ModelAnimation[] = [];
  const seen = new Set<string>();
  for (const n of list) {
    const clip = builtinClip(n);
    if (!clip || seen.has(clip.name)) continue;
    seen.add(clip.name);
    out.push(clipToModelAnimation(clip, skeleton, opts));
  }
  return out;
}

/** Alias -> canonical built-in clip name (exported with skinned models so runtimes can resolve story names). */
export function builtinClipAliases(): Record<string, string> {
  return { ...CLIP_ALIASES };
}

/** Adds the per-finger channels (see deriveFingers) to an animation with fingers/fingertips rotations (mocap takes). */
export function animateFingers(anim: ModelAnimation, skeleton: Skeleton): ModelAnimation {
  const names = new Set(skeleton.joints.map((j) => j.name));
  const rot = new Map<string, Float32Array>();
  let times: Float32Array | null = null;
  for (const ch of anim.channels)
    if (ch.path === 'rotation') {
      rot.set(ch.joint, ch.values);
      times = ch.times;
    }
  if (!times) return anim;
  const bones = [...rot.keys()];
  deriveFingers(rot, names, times, anim.duration ?? times[times.length - 1]!, times.length - 1, bones);
  for (const b of bones) {
    const ch = anim.channels.find((c) => c.joint === b && c.path === 'rotation');
    if (ch) ch.values = rot.get(b)!;
    else anim.channels.push({ joint: b, path: 'rotation', times, values: rot.get(b)! });
  }
  return anim;
}

/**
 * Skeletons with separate index/ring/pinky bones (MakeHuman characters) get them from the hand's curl: the
 * index curls less and the pinky more than the middle finger (fingers/fingertips), and every finger flexes a
 * little on its own, looping seamlessly, so hands never move as one block.
 */
function deriveFingers(
  rot: Map<string, Float32Array>,
  names: Set<string>,
  times: Float32Array,
  duration: number,
  frames: number,
  bones: string[],
): void {
  const FINGERS: [string, number, number][] = [
    ['index', 0.8, 0.4],
    ['ring', 1.1, 1.9],
    ['pinky', 1.3, 3.3],
  ];
  for (const s of ['l', 'r']) {
    const base = rot.get(`fingers_${s}`);
    const tip = rot.get(`fingertips_${s}`);
    if (!base || !tip || !names.has(`index_${s}`)) continue;
    const srcBase = base.slice();
    const srcTip = tip.slice();
    const add = (name: string, from: Float32Array, k: number, phase: number, amp: number) => {
      // the curl axis: from the most bent frame (the rest curl when the clip keeps the hand still)
      let axis: [number, number, number] = [1, 0, 0];
      let most = 0;
      for (let i = 0; i <= frames; i++) {
        const w = Math.min(1, Math.abs(from[i * 4 + 3]!));
        if (1 - w > most) {
          most = 1 - w;
          const n = Math.hypot(from[i * 4]!, from[i * 4 + 1]!, from[i * 4 + 2]!) || 1;
          axis = [from[i * 4]! / n, from[i * 4 + 1]! / n, from[i * 4 + 2]! / n];
        }
      }
      const cycles = Math.max(1, Math.round(duration / (2.4 + phase * 0.6)));
      const out = new Float32Array(from.length);
      for (let i = 0; i <= frames; i++) {
        const x = from[i * 4]!;
        const y = from[i * 4 + 1]!;
        const z = from[i * 4 + 2]!;
        const w = Math.max(-1, Math.min(1, from[i * 4 + 3]!));
        // signed angle about the curl axis
        const along = x * axis[0] + y * axis[1] + z * axis[2];
        const angle = 2 * Math.atan2(along, w);
        const wobble =
          ((amp * Math.PI) / 180) * Math.sin((2 * Math.PI * cycles * times[i]!) / duration + phase);
        const half = (angle * k + wobble) / 2;
        const sh = Math.sin(half);
        out.set([axis[0] * sh, axis[1] * sh, axis[2] * sh, Math.cos(half)], i * 4);
      }
      rot.set(name, out);
      if (!bones.includes(name)) bones.push(name);
    };
    for (const [f, k, phase] of FINGERS) {
      if (names.has(`${f}_${s}`)) add(`${f}_${s}`, srcBase, k, phase, 3);
      if (names.has(`${f}_tip_${s}`)) add(`${f}_tip_${s}`, srcTip, k, phase, 4);
    }
    // the middle finger flexes on its own too
    add(`fingers_${s}`, srcBase, 1, 1.1, 2.5);
    add(`fingertips_${s}`, srcTip, 1, 1.1, 3);
  }
}
