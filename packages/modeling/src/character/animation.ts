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
