/**
 * The AIGE humanoid skeleton convention, shared by the character generator (@aige/modeling humanoid()),
 * the clip library, the runtime Animator and the renderer.
 *
 * Convention (every humanoid made by `humanoid()` follows it, so clips work on any of them):
 * - the character faces +Z, up is +Y, feet on y = 0; `_l` bones are on the character's left (+X);
 * - every joint's bind rotation is identity (joints are only offset from their parent), so a clip rotation is
 *   expressed in model-aligned axes: +X bends a spine bone forward, +Y turns it to the character's left,
 *   +Z leans it to the character's right;
 * - bind pose is a relaxed A-pose: arms straight, 50 degrees below horizontal in the frontal plane, palms
 *   facing down/in, thumbs forward; legs straight down; feet pointing +Z.
 */
import { type Quat, quatMul, quatRotate, type V3 } from './quat.ts';

/**
 * Arm angle below horizontal in the bind A-pose (degrees). Must match @aige/modeling's humanoid(). A fairly low
 * A-pose keeps the shoulders from deforming much when the arms hang (most of the time).
 */
export const HUMANOID_ARM_ANGLE = 50;

/** A-pose angle the clip library's arm `down` values are authored against (the rig compensates). */
export const AUTHORED_ARM_ANGLE = 40;

/** Hip height the built-in clips' hips translations are authored for (meters); scaled per character. */
export const REFERENCE_HIPS_HEIGHT = 0.96;

export const HUMANOID_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'jaw',
  'shoulder_l',
  'upperarm_l',
  'forearm_l',
  'hand_l',
  'fingers_l',
  'fingertips_l',
  'thumb_l',
  'shoulder_r',
  'upperarm_r',
  'forearm_r',
  'hand_r',
  'fingers_r',
  'fingertips_r',
  'thumb_r',
  'thigh_l',
  'shin_l',
  'foot_l',
  'toe_l',
  'thigh_r',
  'shin_r',
  'foot_r',
  'toe_r',
] as const;
export type HumanoidBone = (typeof HUMANOID_BONES)[number];

export const HUMANOID_PARENTS: Record<HumanoidBone, HumanoidBone | null> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  jaw: 'head',
  shoulder_l: 'chest',
  upperarm_l: 'shoulder_l',
  forearm_l: 'upperarm_l',
  hand_l: 'forearm_l',
  fingers_l: 'hand_l',
  fingertips_l: 'fingers_l',
  thumb_l: 'hand_l',
  shoulder_r: 'chest',
  upperarm_r: 'shoulder_r',
  forearm_r: 'upperarm_r',
  hand_r: 'forearm_r',
  fingers_r: 'hand_r',
  fingertips_r: 'fingers_r',
  thumb_r: 'hand_r',
  thigh_l: 'hips',
  shin_l: 'thigh_l',
  foot_l: 'shin_l',
  toe_l: 'foot_l',
  thigh_r: 'hips',
  shin_r: 'thigh_r',
  foot_r: 'shin_r',
  toe_r: 'foot_r',
};

/** Bone masks for layered clips (e.g. hold_item on the right arm while walking). */
export const BONE_MASKS = {
  full: [...HUMANOID_BONES] as string[],
  upper: HUMANOID_BONES.filter((b) => !/^(hips|thigh|shin|foot|toe)/.test(b)) as string[],
  lower: ['hips', 'thigh_l', 'shin_l', 'foot_l', 'toe_l', 'thigh_r', 'shin_r', 'foot_r', 'toe_r'],
  head: ['neck', 'head', 'jaw'],
  arms: HUMANOID_BONES.filter((b) => /^(shoulder|upperarm|forearm|hand|fingers|thumb)/.test(b)) as string[],
  arm_l: ['shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l', 'fingers_l', 'fingertips_l', 'thumb_l'],
  arm_r: ['shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r', 'fingers_r', 'fingertips_r', 'thumb_r'],
  hand_l: ['hand_l', 'fingers_l', 'fingertips_l', 'thumb_l'],
  hand_r: ['hand_r', 'fingers_r', 'fingertips_r', 'thumb_r'],
} as const satisfies Record<string, readonly string[]>;
export type BoneMask = keyof typeof BONE_MASKS;
export const BONE_MASK_NAMES = Object.keys(BONE_MASKS) as BoneMask[];

/** One joint of a skeleton in its bind pose (model space). */
export interface SkeletonJointInfo {
  name: string;
  parent: string | null;
  /** Bind position in model space (meters). */
  position: V3;
}

export interface SkeletonInfo {
  joints: SkeletonJointInfo[];
}

/**
 * Reference humanoid (1.78 m adult) the clip library is authored on. Real characters differ in size and
 * proportions; rotations transfer directly and hips translations are scaled by hip height.
 */
export function referenceSkeleton(): SkeletonInfo {
  const a = (HUMANOID_ARM_ANGLE * Math.PI) / 180;
  const dir: V3 = [Math.cos(a), -Math.sin(a), 0];
  const sh: V3 = [0.182, 1.448, -0.015];
  const upper = 0.295;
  const fore = 0.255;
  const hand = 0.098;
  const finger1 = 0.048;
  const joints: SkeletonJointInfo[] = [
    { name: 'hips', parent: null, position: [0, REFERENCE_HIPS_HEIGHT, 0] },
    { name: 'spine', parent: 'hips', position: [0, 1.07, -0.012] },
    { name: 'chest', parent: 'spine', position: [0, 1.245, -0.016] },
    { name: 'neck', parent: 'chest', position: [0, 1.465, -0.03] },
    { name: 'head', parent: 'neck', position: [0, 1.56, -0.018] },
    { name: 'jaw', parent: 'head', position: [0, 1.622, 0.004] },
  ];
  for (const side of [1, -1]) {
    const s = side > 0 ? 'l' : 'r';
    const d: V3 = [dir[0] * side, dir[1], 0];
    const shoulder: V3 = [sh[0] * side, sh[1], sh[2]];
    const elbow: V3 = [shoulder[0] + d[0] * upper, shoulder[1] + d[1] * upper, shoulder[2]];
    const wrist: V3 = [elbow[0] + d[0] * fore, elbow[1] + d[1] * fore, elbow[2]];
    const knuckle: V3 = [wrist[0] + d[0] * hand, wrist[1] + d[1] * hand, wrist[2]];
    joints.push(
      { name: `shoulder_${s}`, parent: 'chest', position: [0.025 * side, 1.43, 0.0] },
      { name: `upperarm_${s}`, parent: `shoulder_${s}`, position: shoulder },
      { name: `forearm_${s}`, parent: `upperarm_${s}`, position: elbow },
      { name: `hand_${s}`, parent: `forearm_${s}`, position: wrist },
      { name: `fingers_${s}`, parent: `hand_${s}`, position: knuckle },
      {
        name: `fingertips_${s}`,
        parent: `fingers_${s}`,
        position: [knuckle[0] + d[0] * finger1, knuckle[1] + d[1] * finger1, knuckle[2]],
      },
      {
        name: `thumb_${s}`,
        parent: `hand_${s}`,
        position: [wrist[0] + d[0] * 0.025, wrist[1] + d[1] * 0.025, wrist[2] + 0.022],
      },
      { name: `thigh_${s}`, parent: 'hips', position: [0.09 * side, 0.925, 0.0] },
      { name: `shin_${s}`, parent: `thigh_${s}`, position: [0.09 * side, 0.5, 0.0] },
      { name: `foot_${s}`, parent: `shin_${s}`, position: [0.09 * side, 0.08, 0.0] },
      // ball of the foot (toe bend line)
      { name: `toe_${s}`, parent: `foot_${s}`, position: [0.1 * side, 0.02, 0.135] },
    );
  }
  return { joints };
}

/** Hip height (bind y of the 'hips' joint) of a skeleton, or the reference value. */
export function hipsHeight(skel: SkeletonInfo | null | undefined): number {
  const h = skel?.joints.find((j) => j.name === 'hips')?.position[1];
  return h && h > 0.05 ? h : REFERENCE_HIPS_HEIGHT;
}

export interface PoseLike {
  /** Local rotation per bone relative to the bind pose. Missing bones stay in bind pose. */
  rot: Record<string, Quat>;
  /** Hips offset from the bind position, in the skeleton's own meters. */
  hips: V3;
}

export interface JointWorld {
  pos: V3;
  rot: Quat;
}

/**
 * Forward kinematics: world (model-space) position and rotation of every joint for a pose.
 * Bind rotations are identity (AIGE convention), so child offsets are bind position differences.
 */
export function forwardKinematics(skel: SkeletonInfo, pose: PoseLike): Map<string, JointWorld> {
  const out = new Map<string, JointWorld>();
  const byName = new Map(skel.joints.map((j) => [j.name, j]));
  const visit = (name: string): JointWorld => {
    const done = out.get(name);
    if (done) return done;
    const j = byName.get(name)!;
    const local = pose.rot[name] ?? [0, 0, 0, 1];
    let w: JointWorld;
    if (!j.parent || !byName.has(j.parent)) {
      const h = name === 'hips' ? pose.hips : [0, 0, 0];
      w = {
        pos: [j.position[0] + h[0]!, j.position[1] + h[1]!, j.position[2] + h[2]!],
        rot: [local[0], local[1], local[2], local[3]],
      };
    } else {
      const p = visit(j.parent);
      const pj = byName.get(j.parent)!;
      const off: V3 = [
        j.position[0] - pj.position[0],
        j.position[1] - pj.position[1],
        j.position[2] - pj.position[2],
      ];
      const r = quatRotate(p.rot, off);
      w = { pos: [p.pos[0] + r[0], p.pos[1] + r[1], p.pos[2] + r[2]], rot: quatMul(p.rot, local) };
    }
    out.set(name, w);
    return w;
  };
  for (const j of skel.joints) visit(j.name);
  return out;
}

/** World position of a point given in a bone's bind-aligned local frame (offset from the joint). */
export function pointOnBone(fk: Map<string, JointWorld>, bone: string, offset: readonly number[]): V3 {
  const j = fk.get(bone);
  if (!j) return [0, 0, 0];
  const r = quatRotate(j.rot, offset);
  return [j.pos[0] + r[0], j.pos[1] + r[1], j.pos[2] + r[2]];
}
