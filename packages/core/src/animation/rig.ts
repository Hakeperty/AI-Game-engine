/**
 * Pose authoring for the built-in clip library: anatomical parameters (degrees of bend/raise/twist per joint),
 * two-bone IK for hands and feet, and ground-contact solving, all evaluated on the reference skeleton and
 * converted to per-bone quaternions in the AIGE humanoid convention (identity bind rotations, see skeleton.ts).
 */
import {
  cross,
  normalize3,
  type Quat,
  quatAxisAngle,
  quatChain,
  quatConj,
  quatFromEuler,
  quatMirrorX,
  quatMul,
  quatNormalize,
  quatRotate,
  type V3,
} from './quat.ts';
import {
  forwardKinematics,
  HUMANOID_ARM_ANGLE,
  type JointWorld,
  pointOnBone,
  referenceSkeleton,
  type SkeletonInfo,
} from './skeleton.ts';

/** Arm parameters (degrees). Right-arm values mean the mirrored motion. */
export interface ArmPose {
  /** Clavicle raise (shrug). */
  shrug?: number;
  /** Clavicle forward (protraction). */
  reach?: number;
  /** Lower the arm from the bind A-pose (42 = hanging at the side, -40 = horizontal T). */
  down?: number;
  /** Swing forward (flexion) in the sagittal plane. */
  fwd?: number;
  /** Swing across the body (horizontal adduction). */
  across?: number;
  /** Internal rotation of the upper arm. */
  twist?: number;
  /** Elbow bend. */
  elbow?: number;
  /** Forearm pronation. */
  ftwist?: number;
  /** Wrist flexion (toward the palm). */
  wrist?: number;
  /** Radial deviation (toward the thumb). */
  wside?: number;
  /** Finger curl (0 open, 90 fist). */
  fingers?: number;
  /** Thumb opposition. */
  thumb?: number;
  /** IK wrist target in reference model space (meters); blends with the FK angles by `ikw`. */
  ik?: V3;
  /** Elbow pole direction for IK (model space), default down/back/out. */
  pole?: V3;
  /** IK weight 0..1. */
  ikw?: number;
}

export interface LegPose {
  /** Hip flexion (thigh forward). */
  flex?: number;
  /** Abduction (thigh outward). */
  abd?: number;
  /** External rotation (toe out). */
  twist?: number;
  knee?: number;
  /** Dorsiflexion (toes up). */
  ankle?: number;
  /** Toe extension at the ball of the foot (toes bent up, e.g. push-off or kneeling). */
  toe?: number;
  /** IK ankle target in reference model space. */
  ik?: V3;
  /** IK weight 0..1. */
  ikw?: number;
  /** With IK: 1 keeps the foot flat on the ground (0 = use `ankle`). */
  flat?: number;
}

/** A full-body pose in anatomical terms. Spine triples are [bend forward, turn left, lean right] degrees. */
export interface BodyPose {
  /** Hips offset from bind (reference meters). */
  pos?: V3;
  hips?: V3;
  spine?: V3;
  chest?: V3;
  neck?: V3;
  head?: V3;
  /** Jaw opening (degrees). */
  jaw?: number;
  armL?: ArmPose;
  armR?: ArmPose;
  legL?: LegPose;
  legR?: LegPose;
  /** When set, the hips move vertically so the lowest contact point of `contacts` touches this height. */
  ground?: number;
  /** Contact groups used by `ground` (default feet). */
  contacts?: ContactGroup[];
  /** 0..1 weight of the ground solve (lets clips ease in/out of contact). */
  groundw?: number;
  /** Extra hips height added after the ground solve (flight phase of a run). */
  lift?: number;
}

export type ContactGroup = 'feet' | 'knees' | 'sit' | 'back' | 'hands' | 'side_r' | 'side_l' | 'head';

const A = (HUMANOID_ARM_ANGLE * Math.PI) / 180;
const DIR_L: V3 = [Math.cos(A), -Math.sin(A), 0];
const HINGE_L: V3 = [-Math.sin(A), -Math.cos(A), 0];
const WFLEX_L: V3 = [0, 0, -1];
const DIR_R: V3 = [-Math.cos(A), -Math.sin(A), 0];
const HINGE_R: V3 = [-Math.sin(A), Math.cos(A), 0];

const n0 = (v: number | undefined) => v ?? 0;

export const REF = referenceSkeleton();
const REF_BY = new Map(REF.joints.map((j) => [j.name, j]));
const jointPos = (name: string): V3 => REF_BY.get(name)!.position;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const UPPER_ARM = dist(jointPos('upperarm_l'), jointPos('forearm_l'));
const FOREARM = dist(jointPos('forearm_l'), jointPos('hand_l'));
const THIGH = dist(jointPos('thigh_l'), jointPos('shin_l'));
const SHIN = dist(jointPos('shin_l'), jointPos('foot_l'));

/** Left-arm FK quaternions from parameters. */
function armQuatsLeft(p: ArmPose): Record<string, Quat> {
  return {
    shoulder: quatChain(quatAxisAngle([0, 1, 0], -n0(p.reach)), quatAxisAngle([0, 0, 1], n0(p.shrug))),
    upperarm: quatChain(
      quatAxisAngle([0, 1, 0], -n0(p.across)),
      quatAxisAngle([1, 0, 0], -n0(p.fwd)),
      quatAxisAngle([0, 0, 1], -n0(p.down)),
      quatAxisAngle(DIR_L, n0(p.twist)),
    ),
    forearm: quatChain(quatAxisAngle(HINGE_L, n0(p.elbow)), quatAxisAngle(DIR_L, n0(p.ftwist))),
    hand: quatChain(quatAxisAngle(WFLEX_L, n0(p.wrist)), quatAxisAngle(HINGE_L, n0(p.wside))),
    fingers: quatAxisAngle(WFLEX_L, n0(p.fingers) * 0.6),
    fingertips: quatAxisAngle(WFLEX_L, n0(p.fingers) * 0.9),
    thumb: quatChain(quatAxisAngle(DIR_L, n0(p.thumb) * 0.7), quatAxisAngle(WFLEX_L, n0(p.thumb) * 0.35)),
  };
}

function legQuatsLeft(p: LegPose): Record<string, Quat> {
  return {
    thigh: quatChain(
      quatAxisAngle([0, 0, 1], n0(p.abd)),
      quatAxisAngle([1, 0, 0], -n0(p.flex)),
      quatAxisAngle([0, 1, 0], n0(p.twist)),
    ),
    shin: quatAxisAngle([1, 0, 0], n0(p.knee)),
    foot: quatAxisAngle([1, 0, 0], -n0(p.ankle)),
    toe: quatAxisAngle([1, 0, 0], -n0(p.toe)),
  };
}

const spineQ = (v: V3 | undefined): Quat => (v ? quatFromEuler(v[0], v[1], v[2], 'YXZ') : [0, 0, 0, 1]);

/** Rotation matrix columns (orthonormal) -> quaternion. */
function quatFromBasis(x: V3, y: V3, z: V3): Quat {
  const m00 = x[0];
  const m10 = x[1];
  const m20 = x[2];
  const m01 = y[0];
  const m11 = y[1];
  const m21 = y[2];
  const m02 = z[0];
  const m12 = z[1];
  const m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** Rotation taking the orthonormal frame (a1, b1) onto (a2, b2). */
function quatFrames(a1: V3, b1: V3, a2: V3, b2: V3): Quat {
  const c1 = cross(a1, b1);
  const c2 = cross(a2, b2);
  const q1 = quatFromBasis(a1, b1, c1);
  const q2 = quatFromBasis(a2, b2, c2);
  return quatMul(q2, quatConj(q1));
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Two-bone IK in model space. Returns the upper bone's *world* rotation and the hinge bend angle.
 * bindDir/hinge are the upper bone's bind direction and the hinge axis a positive bend rotates around.
 */
function twoBone(
  root: V3,
  target: V3,
  l1: number,
  l2: number,
  pole: V3,
  bindDir: V3,
  hinge: V3,
): { rot: Quat; bend: number } {
  let d = sub(target, root);
  let D = Math.hypot(d[0], d[1], d[2]);
  const maxD = l1 + l2 - 1e-4;
  const minD = Math.abs(l1 - l2) + 1e-3;
  if (D < 1e-6) {
    d = [0, -1, 0];
    D = minD;
  }
  const t = scale(d, 1 / D);
  D = Math.max(minD, Math.min(maxD, D));
  const cosBend = (D * D - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  const bend = Math.acos(Math.max(-1, Math.min(1, cosBend)));
  const cosB = (l1 * l1 + D * D - l2 * l2) / (2 * l1 * D);
  const beta = Math.acos(Math.max(-1, Math.min(1, cosB)));
  let p = sub(pole, scale(t, dot(pole, t)));
  if (Math.hypot(p[0], p[1], p[2]) < 1e-6) p = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  p = normalize3(p);
  const elbow = add(root, add(scale(t, l1 * Math.cos(beta)), scale(p, l1 * Math.sin(beta))));
  const u = normalize3(sub(elbow, root));
  const wrist = add(root, scale(t, D));
  const f = normalize3(sub(wrist, elbow));
  let h = cross(u, f);
  if (Math.hypot(h[0], h[1], h[2]) < 1e-6) h = cross(u, p);
  h = normalize3(h);
  const hb = normalize3(sub(hinge, scale(bindDir, dot(hinge, bindDir))));
  return { rot: quatFrames(bindDir, hb, u, h), bend: (bend * 180) / Math.PI };
}

/** Contact probes: points on bones (offset in the bone's bind frame) that can touch the ground. */
const PROBES: Record<ContactGroup, [string, V3][]> = {
  feet: [
    ['foot_l', [0, -0.078, -0.05]],
    ['foot_l', [0, -0.078, 0.16]],
    ['foot_r', [0, -0.078, -0.05]],
    ['foot_r', [0, -0.078, 0.16]],
  ],
  knees: [
    ['shin_l', [0, -0.02, 0.06]],
    ['shin_r', [0, -0.02, 0.06]],
  ],
  sit: [
    ['hips', [0.07, -0.16, -0.03]],
    ['hips', [-0.07, -0.16, -0.03]],
  ],
  back: [
    ['hips', [0, -0.05, -0.13]],
    ['spine', [0, 0.05, -0.13]],
    ['chest', [0, 0.1, -0.13]],
  ],
  hands: [
    ['fingers_l', [0.04, -0.03, 0]],
    ['fingers_r', [-0.04, -0.03, 0]],
  ],
  side_r: [
    ['hips', [-0.17, -0.05, 0]],
    ['chest', [-0.2, 0.12, 0]],
  ],
  side_l: [
    ['hips', [0.17, -0.05, 0]],
    ['chest', [0.2, 0.12, 0]],
  ],
  head: [['head', [0, 0.12, -0.1]]],
};

function lowestContact(fk: Map<string, JointWorld>, groups: ContactGroup[]): number {
  let min = Infinity;
  for (const g of groups)
    for (const [bone, off] of PROBES[g]) min = Math.min(min, pointOnBone(fk, bone, off)[1]);
  return min;
}

export interface EvaluatedPose {
  rot: Record<string, Quat>;
  hips: V3;
}

/**
 * Converts an anatomical pose into bone rotations + hips offset on the reference skeleton
 * (FK params -> ground solve -> leg IK -> arm IK).
 */
export function evaluateBodyPose(p: BodyPose, skel: SkeletonInfo = REF): EvaluatedPose {
  const rot: Record<string, Quat> = {};
  rot.hips = spineQ(p.hips);
  rot.spine = spineQ(p.spine);
  rot.chest = spineQ(p.chest);
  rot.neck = spineQ(p.neck);
  rot.head = spineQ(p.head);
  rot.jaw = quatAxisAngle([1, 0, 0], n0(p.jaw));
  const armL = armQuatsLeft(p.armL ?? {});
  const armR = armQuatsLeft(p.armR ?? {});
  for (const k of Object.keys(armL)) {
    rot[`${k}_l`] = armL[k]!;
    rot[`${k}_r`] = quatMirrorX(armR[k]!);
  }
  const legL = legQuatsLeft(p.legL ?? {});
  const legR = legQuatsLeft(p.legR ?? {});
  for (const k of Object.keys(legL)) {
    rot[`${k}_l`] = legL[k]!;
    rot[`${k}_r`] = quatMirrorX(legR[k]!);
  }
  const hips: V3 = [...(p.pos ?? [0, 0, 0])] as V3;
  let fk = forwardKinematics(skel, { rot, hips });

  if (p.ground !== undefined) {
    const low = lowestContact(fk, p.contacts ?? ['feet']);
    const w = p.groundw ?? 1;
    hips[1] += (p.ground - low) * w + (p.lift ?? 0);
    fk = forwardKinematics(skel, { rot, hips });
  } else if (p.lift) {
    hips[1] += p.lift;
    fk = forwardKinematics(skel, { rot, hips });
  }

  // Leg IK (in model space, knee pole forward).
  for (const side of ['l', 'r'] as const) {
    const lp = side === 'l' ? p.legL : p.legR;
    const w = lp?.ik ? (lp.ikw ?? 1) : 0;
    if (!lp?.ik || w <= 0) continue;
    const hipsW = fk.get('hips')!;
    const root = fk.get(`thigh_${side}`)!.pos;
    const pole = quatRotate(hipsW.rot, [side === 'l' ? 0.15 : -0.15, 0, 1]);
    const r = twoBone(root, lp.ik, THIGH, SHIN, pole, [0, -1, 0], [1, 0, 0]);
    const local = quatMul(quatConj(hipsW.rot), r.rot);
    rot[`thigh_${side}`] = blendQ(rot[`thigh_${side}`]!, local, w);
    rot[`shin_${side}`] = blendQ(rot[`shin_${side}`]!, quatAxisAngle([1, 0, 0], r.bend), w);
    fk = forwardKinematics(skel, { rot, hips });
    const flat = lp.flat ?? 1;
    if (flat > 0) {
      // foot level with the ground, facing where the hips face (yaw only)
      const hq = hipsW.rot;
      const fwd = quatRotate(hq, [0, 0, 1]);
      const yaw = Math.atan2(fwd[0], fwd[2]);
      const toe = ((side === 'l' ? 1 : -1) * n0(lp.twist) * Math.PI) / 180;
      const want = quatAxisAngle([0, 1, 0], ((yaw + toe) * 180) / Math.PI);
      const shinW = fk.get(`shin_${side}`)!.rot;
      const footLocal = quatMul(quatConj(shinW), want);
      rot[`foot_${side}`] = blendQ(rot[`foot_${side}`]!, footLocal, flat * w);
      fk = forwardKinematics(skel, { rot, hips });
    }
  }

  // Arm IK.
  for (const side of ['l', 'r'] as const) {
    const ap = side === 'l' ? p.armL : p.armR;
    const w = ap?.ik ? (ap.ikw ?? 1) : 0;
    if (!ap?.ik || w <= 0) continue;
    const parent = fk.get(`shoulder_${side}`)!;
    const root = fk.get(`upperarm_${side}`)!.pos;
    const chestW = fk.get('chest')!.rot;
    const pole = ap.pole ?? quatRotate(chestW, [side === 'l' ? 0.6 : -0.6, -0.5, -0.6]);
    const r = twoBone(
      root,
      ap.ik,
      UPPER_ARM,
      FOREARM,
      pole,
      side === 'l' ? DIR_L : DIR_R,
      side === 'l' ? HINGE_L : HINGE_R,
    );
    const local = quatMul(quatConj(parent.rot), r.rot);
    // keep the FK forearm twist on top of the IK bend
    const dir = side === 'l' ? DIR_L : DIR_R;
    const hinge = side === 'l' ? HINGE_L : HINGE_R;
    const tw = (side === 'l' ? 1 : -1) * n0(ap.ftwist);
    rot[`upperarm_${side}`] = blendQ(rot[`upperarm_${side}`]!, local, w);
    rot[`forearm_${side}`] = blendQ(
      rot[`forearm_${side}`]!,
      quatChain(quatAxisAngle(hinge, r.bend), quatAxisAngle(dir, tw)),
      w,
    );
    fk = forwardKinematics(skel, { rot, hips });
  }
  return { rot, hips };
}

function blendQ(a: Quat, b: Quat, w: number): Quat {
  if (w >= 1) return b;
  if (w <= 0) return a;
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  if (a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  return quatNormalize([
    a[0] + (bx - a[0]) * w,
    a[1] + (by - a[1]) * w,
    a[2] + (bz - a[2]) * w,
    a[3] + (bw - a[3]) * w,
  ]);
}

/** World positions of the reference skeleton joints for a body pose (used by tests and IK targets). */
export function referenceJointPositions(p: BodyPose): Map<string, JointWorld> {
  const e = evaluateBodyPose(p);
  return forwardKinematics(REF, e);
}

export const REF_LIMBS = { UPPER_ARM, FOREARM, THIGH, SHIN };
