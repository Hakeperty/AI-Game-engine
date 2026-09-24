/**
 * Motion capture (BVH, e.g. the CMU Motion Capture Database) retargeted onto the AIGE humanoid skeleton, so
 * characters move like real people instead of keyframed poses.
 *
 * Retargeting: for each AIGE bone, the source bone's world rotation (its change from the BVH rest pose) is
 * applied to the AIGE bone after re-aiming the AIGE rest direction onto the source rest direction, so arms,
 * legs and spine follow the capture whatever the two rest poses are (CMU's splayed rest vs the AIGE A-pose).
 * Root motion is scaled by hip height; the whole take is turned to face +Z.
 */
import {
  normalize3,
  type Quat,
  quatAxisAngle,
  quatConj,
  quatFromTo,
  quatMul,
  quatNormalize,
  quatRotate,
  type V3,
} from '@aige/core';
import type { ModelAnimation, Skeleton } from '../model.ts';

interface BvhJoint {
  name: string;
  parent: number;
  offset: V3;
  channels: string[];
  /** Index of the first channel of this joint in a frame row. */
  channelStart: number;
  /** End Site offset, when the joint is a leaf. */
  end?: V3;
}

export interface Bvh {
  joints: BvhJoint[];
  frames: Float32Array[];
  frameTime: number;
}

export function parseBvh(text: string): Bvh {
  const tok = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const joints: BvhJoint[] = [];
  const stack: number[] = [];
  let channelCount = 0;
  let last = -1;
  while (i < tok.length && tok[i] !== 'MOTION') {
    const t = tok[i++]!;
    if (t === 'ROOT' || t === 'JOINT') {
      joints.push({
        name: tok[i++]!,
        parent: stack.at(-1) ?? -1,
        offset: [0, 0, 0],
        channels: [],
        channelStart: 0,
      });
      last = joints.length - 1;
    } else if (t === 'End') {
      i++; // "Site"
      // { OFFSET x y z }
      i++;
      i++;
      joints[stack.at(-1)!]!.end = [Number(tok[i++]), Number(tok[i++]), Number(tok[i++])];
      i++; // }
    } else if (t === '{') stack.push(last);
    else if (t === '}') stack.pop();
    else if (t === 'OFFSET') joints[last]!.offset = [Number(tok[i++]), Number(tok[i++]), Number(tok[i++])];
    else if (t === 'CHANNELS') {
      const n = Number(tok[i++]);
      const j = joints[last]!;
      j.channelStart = channelCount;
      j.channels = tok.slice(i, i + n);
      i += n;
      channelCount += n;
    }
  }
  i++; // MOTION
  i++; // Frames:
  const count = Number(tok[i++]);
  i += 2; // Frame Time:
  const frameTime = Number(tok[i++]);
  const frames: Float32Array[] = [];
  for (let f = 0; f < count && i + channelCount <= tok.length; f++) {
    const row = new Float32Array(channelCount);
    for (let c = 0; c < channelCount; c++) row[c] = Number(tok[i++]);
    frames.push(row);
  }
  return { joints, frames, frameTime };
}

/** World rotations and positions of every BVH joint for one frame (null row = the rest pose). */
function forward(bvh: Bvh, row: Float32Array | null): { rot: Quat[]; pos: V3[] } {
  const rot: Quat[] = [];
  const pos: V3[] = [];
  for (let j = 0; j < bvh.joints.length; j++) {
    const J = bvh.joints[j]!;
    let local: Quat = [0, 0, 0, 1];
    const t: V3 = [...J.offset];
    if (row)
      J.channels.forEach((ch, k) => {
        const v = row[J.channelStart + k]!;
        if (ch === 'Xposition') t[0] = v;
        else if (ch === 'Yposition') t[1] = v;
        else if (ch === 'Zposition') t[2] = v;
        else
          local = quatMul(
            local,
            quatAxisAngle(ch[0] === 'X' ? [1, 0, 0] : ch[0] === 'Y' ? [0, 1, 0] : [0, 0, 1], v),
          );
      });
    if (J.parent < 0) {
      rot.push(local);
      pos.push(t);
    } else {
      const pr = rot[J.parent]!;
      const pp = pos[J.parent]!;
      const o = quatRotate(pr, t);
      rot.push(quatNormalize(quatMul(pr, local)));
      pos.push([pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]]);
    }
  }
  return { rot, pos };
}

/** AIGE bone -> [source joint whose rotation drives it, source joint (or 'end') its direction points to]. */
const CMU_MAP: Record<string, [string, string]> = {
  hips: ['Hips', 'Spine'],
  spine: ['LowerBack', 'Spine1'],
  chest: ['Spine1', 'Neck1'],
  neck: ['Neck', 'Head'],
  head: ['Head', 'end'],
  shoulder_l: ['LeftShoulder', 'LeftArm'],
  upperarm_l: ['LeftArm', 'LeftForeArm'],
  forearm_l: ['LeftForeArm', 'LeftHand'],
  hand_l: ['LeftHand', 'LeftFingerBase'],
  shoulder_r: ['RightShoulder', 'RightArm'],
  upperarm_r: ['RightArm', 'RightForeArm'],
  forearm_r: ['RightForeArm', 'RightHand'],
  hand_r: ['RightHand', 'RightFingerBase'],
  thigh_l: ['LeftUpLeg', 'LeftLeg'],
  shin_l: ['LeftLeg', 'LeftFoot'],
  foot_l: ['LeftFoot', 'LeftToeBase'],
  toe_l: ['LeftToeBase', 'end'],
  thigh_r: ['RightUpLeg', 'RightLeg'],
  shin_r: ['RightLeg', 'RightFoot'],
  foot_r: ['RightFoot', 'RightToeBase'],
  toe_r: ['RightToeBase', 'end'],
};

/** AIGE bone -> the joint its rest direction points to ('+y'/'+z' for leaves). */
const TARGET_CHILD: Record<string, string> = {
  hips: 'spine',
  spine: 'chest',
  chest: 'neck',
  neck: 'head',
  head: '+y',
  shoulder_l: 'upperarm_l',
  upperarm_l: 'forearm_l',
  forearm_l: 'hand_l',
  hand_l: 'fingers_l',
  shoulder_r: 'upperarm_r',
  upperarm_r: 'forearm_r',
  forearm_r: 'hand_r',
  hand_r: 'fingers_r',
  thigh_l: 'shin_l',
  shin_l: 'foot_l',
  foot_l: 'toe_l',
  toe_l: '+z',
  thigh_r: 'shin_r',
  shin_r: 'foot_r',
  foot_r: 'toe_r',
  toe_r: '+z',
};

export interface MocapOptions {
  /** Animation name (e.g. 'wake_on_floor'; replaces a built-in clip of that name). */
  name: string;
  /** Seconds of the take to use. */
  from?: number;
  to?: number;
  fps?: number;
  loop?: boolean;
  /** One-shot clips: clip to continue with when this one ends. */
  next?: string;
  /** Which frame defines "facing +Z": the first, the last, or the one with the hips highest (default). */
  face?: 'first' | 'last' | 'standing';
  /** 'full' keeps the travel, 'vertical' only the hip height, 'none' pins the hips. */
  rootMotion?: 'full' | 'vertical' | 'none';
  /** Extra yaw (degrees) after facing +Z. */
  yaw?: number;
  /** Where the take is pinned to the entity: its first frame (default) or its last, so a stand-up ends on the spot the next clip starts from. */
  anchor?: 'start' | 'end';
  /** Meters added to the hips, e.g. [0, 0.46, -0.75] to lie on a bed instead of the floor. */
  offset?: V3;
}

/** Retargets a BVH take onto an AIGE humanoid skeleton. `hold` gives constant rotations for bones the take lacks (fingers). */
export function mocapAnimation(
  bvh: Bvh,
  skeleton: Skeleton,
  opts: MocapOptions,
  hold: Map<string, Quat> = new Map(),
): ModelAnimation {
  const index = new Map(bvh.joints.map((j, i) => [j.name, i]));
  const joints = new Map(skeleton.joints.map((j) => [j.name, j]));
  const rest = forward(bvh, null);
  const srcDir = (bone: string): V3 | null => {
    const [src, to] = CMU_MAP[bone]!;
    const a = index.get(src);
    if (a === undefined) return null;
    const p = rest.pos[a]!;
    let q: V3;
    if (to === 'end') {
      const e = bvh.joints[a]!.end ?? [0, 1, 0];
      q = [p[0] + e[0], p[1] + e[1], p[2] + e[2]];
    } else {
      const b = index.get(to);
      if (b === undefined) return null;
      q = rest.pos[b]!;
    }
    return normalize3([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
  };
  const tgtDir = (bone: string): V3 => {
    const c = TARGET_CHILD[bone]!;
    if (c === '+y') return [0, 1, 0];
    if (c === '+z') return [0, 0, 1];
    const a = joints.get(bone)!.position;
    const b = joints.get(c)?.position ?? [a[0], a[1] + 0.1, a[2]];
    return normalize3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  };
  const bones = Object.keys(CMU_MAP).filter((b) => joints.has(b) && index.has(CMU_MAP[b]![0]) && srcDir(b));
  const correction = new Map(bones.map((b) => [b, quatFromTo(tgtDir(b), srcDir(b)!)]));

  // frames to use, resampled
  const fps = opts.fps ?? 30;
  const dt = bvh.frameTime;
  const total = bvh.frames.length * dt;
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(total - dt, opts.to ?? total);
  const n = Math.max(2, Math.round((to - from) * fps) + 1);
  const sample = (t: number) => {
    const f = Math.min(bvh.frames.length - 1, Math.max(0, t / dt));
    return forward(bvh, bvh.frames[Math.round(f)]!);
  };
  const poses = Array.from({ length: n }, (_, i) => sample(from + (i / (n - 1)) * (to - from)));

  // scale: target hip height over the capture's standing hip height (rest pose: hips above the lowest foot)
  const hi = index.get('Hips')!;
  const minFoot = Math.min(...rest.pos.map((p) => p[1]));
  const srcHips = rest.pos[hi]![1] - minFoot;
  const tgtHips = joints.get('hips')!.position[1];
  const scale = tgtHips / srcHips;

  // facing: turn the take so the chosen frame's hips face +Z
  const faceFrame =
    opts.face === 'first'
      ? 0
      : opts.face === 'last'
        ? n - 1
        : poses.reduce((best, p, i) => (p.pos[hi]![1] > poses[best]!.pos[hi]![1] ? i : best), 0);
  const fwd = quatRotate(poses[faceFrame]!.rot[hi]!, [0, 0, 1]);
  const G = quatAxisAngle([0, 1, 0], (-Math.atan2(fwd[0], fwd[2]) * 180) / Math.PI + (opts.yaw ?? 0));
  const start = poses[opts.anchor === 'end' ? n - 1 : 0]!.pos[hi]!;

  const channels: ModelAnimation['channels'] = [];
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / fps;
  const world = new Map<string, Quat[]>();
  for (const b of bones) {
    const src = index.get(CMU_MAP[b]![0])!;
    const C = correction.get(b)!;
    world.set(
      b,
      poses.map((p) => quatNormalize(quatMul(G, quatMul(p.rot[src]!, C)))),
    );
  }
  const parentWorld = (bone: string, i: number): Quat => {
    let p = joints.get(bone)?.parent ?? null;
    let acc: Quat = [0, 0, 0, 1];
    // bones between a mapped bone and its mapped ancestor keep their rest (identity) rotation
    while (p && !world.has(p)) p = joints.get(p)?.parent ?? null;
    if (p) acc = world.get(p)![i]!;
    return acc;
  };
  for (const b of bones) {
    const values = new Float32Array(n * 4);
    let prev: Quat | null = null;
    for (let i = 0; i < n; i++) {
      let q = quatNormalize(quatMul(quatConj(parentWorld(b, i)), world.get(b)![i]!));
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0)
        q = [-q[0], -q[1], -q[2], -q[3]];
      values.set(q, i * 4);
      prev = q;
    }
    channels.push({ joint: b, path: 'rotation', times, values });
  }
  for (const [b, q] of hold) {
    if (!joints.has(b) || bones.includes(b)) continue;
    const values = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) values.set(q, i * 4);
    channels.push({ joint: b, path: 'rotation', times, values });
  }
  if (opts.rootMotion !== 'none') {
    const values = new Float32Array(n * 3);
    const h = joints.get('hips')!.position;
    for (let i = 0; i < n; i++) {
      const p = poses[i]!.pos[hi]!;
      const d = quatRotate(G, [p[0] - start[0], 0, p[2] - start[2]]);
      const full = opts.rootMotion !== 'vertical';
      const o = opts.offset ?? [0, 0, 0];
      values.set(
        [
          h[0] + o[0] + (full ? d[0] * scale : 0),
          p[1] * scale + o[1],
          h[2] + o[2] + (full ? d[2] * scale : 0),
        ],
        i * 3,
      );
    }
    channels.push({ joint: 'hips', path: 'translation', times, values });
  }
  const anim: ModelAnimation = {
    name: opts.name,
    channels,
    loop: opts.loop ?? false,
    duration: (n - 1) / fps,
    ...(opts.next ? { next: opts.next } : {}),
  };
  return opts.loop ? closeLoop(anim) : anim;
}

/** Blends the last `seconds` of a clip back toward its first frame so a take cut from a longer capture loops without a pop. */
export function closeLoop(anim: ModelAnimation, seconds = 0.6): ModelAnimation {
  for (const ch of anim.channels) {
    const w = ch.path === 'rotation' ? 4 : 3;
    const n = ch.times.length;
    const k = Math.min(n - 2, Math.max(1, Math.round((seconds / (anim.duration || 1)) * (n - 1))));
    const first = ch.values.slice(0, w);
    for (let i = n - 1 - k; i < n; i++) {
      const t = (i - (n - 1 - k)) / k; // 0 at the window start, 1 on the last frame
      const s = t * t * (3 - 2 * t);
      const v = ch.values.subarray(i * w, i * w + w);
      if (w === 4) {
        const dot = v[0]! * first[0]! + v[1]! * first[1]! + v[2]! * first[2]! + v[3]! * first[3]!;
        const f = dot < 0 ? [-first[0]!, -first[1]!, -first[2]!, -first[3]!] : [...first];
        const q: Quat = [0, 1, 2, 3].map((c) => v[c]! * (1 - s) + f[c]! * s) as Quat;
        v.set(quatNormalize(q));
      } else for (let c = 0; c < 3; c++) v[c] = v[c]! * (1 - s) + first[c]! * s;
    }
  }
  return anim;
}

/** A piece of an animation [from, to] seconds as a new clip starting at 0 (e.g. the tail of a keyframed clip). */
export function sliceAnimation(
  anim: ModelAnimation,
  from: number,
  to: number,
  name: string,
  extra: { loop?: boolean; next?: string } = {},
): ModelAnimation {
  const channels = anim.channels.map((ch) => {
    const w = ch.path === 'rotation' ? 4 : 3;
    const keep: number[] = [];
    for (let i = 0; i < ch.times.length; i++)
      if (ch.times[i]! >= from - 1e-4 && ch.times[i]! <= to + 1e-4) keep.push(i);
    const times = new Float32Array(keep.map((i) => ch.times[i]! - from));
    const values = new Float32Array(keep.length * w);
    keep.forEach((i, k) => {
      values.set(ch.values.subarray(i * w, i * w + w), k * w);
    });
    return { ...ch, times, values };
  });
  return {
    name,
    channels,
    loop: extra.loop ?? false,
    duration: to - from,
    ...(extra.next ? { next: extra.next } : {}),
  };
}
