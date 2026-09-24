/**
 * Human proportions for the character generator: turns height / age / sex / build into the AIGE humanoid
 * skeleton (same joint names and bind A-pose as the core clip library, see @aige/core animation/skeleton.ts)
 * plus body landmarks and girths the body, head, clothing and hair builders share.
 */
import { HUMANOID_ARM_ANGLE, HUMANOID_PARENTS, type HumanoidBone } from '@aige/core';
import type { V3 } from '../math.ts';
import type { Joint } from '../model.ts';

export type Age = 'adult' | 'teen' | 'child';
export type Sex = 'male' | 'female';
export type HeadShape = 'oval' | 'round' | 'long' | 'square';

export interface BodyParams {
  /** Standing height in meters (crown to floor). */
  height: number;
  age: Age;
  sex: Sex;
  /** 0 = very slim, 0.5 = average, 1 = heavy. */
  build: number;
  /** 0 = soft, 1 = athletic. */
  muscle: number;
  headShape: HeadShape;
}

export interface Anatomy {
  params: BodyParams;
  /** Height. */
  H: number;
  /** Length scale relative to the 1.78 m reference adult. */
  s: number;
  /** Width multiplier from build/sex/age (1 = average adult male at this height). */
  w: number;
  /** Head height (chin to crown). */
  hh: number;
  /** 0 = child, 0.85 = 18-year-old, 1 = adult (drives proportions and facial maturity). */
  maturity: number;
  /** Femininity 0..1 (breadth of hips, narrower shoulders, softer jaw). */
  fem: number;
  joints: Joint[];
  /** Joint positions by name (bind pose, model space). */
  j: Record<HumanoidBone, V3>;
  /** A-pose arm direction for the left arm (unit); mirror x for the right. */
  armDir: V3;
  /** Bind A-pose arm angle below horizontal (degrees). */
  armAngle: number;
  y: {
    crown: number;
    chin: number;
    neck: number;
    shoulder: number;
    chest: number;
    waist: number;
    hipJoint: number;
    crotch: number;
    knee: number;
    ankle: number;
  };
  /** Segment lengths (meters). */
  len: { upperArm: number; forearm: number; hand: number; thigh: number; shin: number; foot: number };
  /** Half widths / radii (meters). */
  dims: {
    shoulderHalf: number;
    hipHalf: number;
    chestW: number;
    chestD: number;
    waistW: number;
    waistD: number;
    pelvisW: number;
    pelvisD: number;
    neckR: number;
    upperArmR: number;
    forearmR: number;
    wristR: number;
    thighR: number;
    kneeR: number;
    calfR: number;
    ankleR: number;
    handScale: number;
    footW: number;
  };
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Typical height of each age/sex group (m), used to keep head size from scaling 1:1 with height. */
const TYPICAL_H: Record<Age, Record<Sex, number>> = {
  adult: { male: 1.77, female: 1.64 },
  teen: { male: 1.76, female: 1.64 },
  child: { male: 1.4, female: 1.39 },
};
const HEAD_H: Record<Age, Record<Sex, number>> = {
  adult: { male: 0.232, female: 0.222 },
  teen: { male: 0.229, female: 0.22 },
  child: { male: 0.207, female: 0.205 },
};

export function computeAnatomy(params: BodyParams): Anatomy {
  const H = Math.max(0.6, Math.min(2.4, params.height));
  const s = H / 1.78;
  const maturity = params.age === 'adult' ? 1 : params.age === 'teen' ? 0.85 : 0;
  const fem = params.sex === 'female' ? (params.age === 'child' ? 0.35 : 1) : 0;
  const build = Math.max(0, Math.min(1, params.build));
  const muscle = Math.max(0, Math.min(1, params.muscle));
  const typical = TYPICAL_H[params.age][params.sex];
  const hh = HEAD_H[params.age][params.sex] * (H / typical) ** 0.3;
  // girth: build is the main driver; children and teens are slighter
  const w = (1 + (build - 0.5) * 0.42 + (muscle - 0.5) * 0.08) * mix(0.92, 1, maturity);

  const crown = H;
  const chin = H - hh;
  const neck = chin - 0.37 * hh;
  const shoulder = neck - 0.017 * s;
  const hipJoint = H * mix(0.505, 0.52, maturity);
  const hipsY = hipJoint + 0.035 * s;
  const knee = H * mix(0.284, 0.281, maturity);
  const ankle = H * mix(0.043, 0.045, maturity);
  const crotch = hipJoint - 0.085 * s;
  const chestJ = hipsY + 0.563 * (neck - hipsY);
  const spineJ = hipsY + 0.217 * (neck - hipsY);
  const waist = hipsY + 0.3 * (neck - hipsY);

  const shoulderFrac = params.age === 'child' ? 0.092 : mix(params.age === 'teen' ? 0.0955 : 0.1, 0.093, fem);
  const shoulderHalf = H * shoulderFrac * (0.94 + 0.12 * build + 0.05 * muscle);
  const hipHalf = H * mix(0.0506, 0.0575, fem) * (0.95 + 0.1 * build);
  const upperArm = H * mix(0.161, 0.166, maturity);
  const forearm = H * mix(0.139, 0.143, maturity);
  const hand = H * mix(0.105, 0.108, maturity);
  const handPalm = hand * 0.508;
  const finger1 = hand * 0.249;
  const foot = H * mix(0.153, 0.15, maturity) * mix(1, 0.94, fem);
  const a = (HUMANOID_ARM_ANGLE * Math.PI) / 180;
  const armDir: V3 = [Math.cos(a), -Math.sin(a), 0];

  const P: Partial<Record<HumanoidBone, V3>> = {
    hips: [0, hipsY, 0],
    spine: [0, spineJ, -0.012 * s],
    chest: [0, chestJ, -0.016 * s],
    neck: [0, neck, -0.03 * s],
    head: [0, chin + 0.06 * hh, -0.018 * s],
    jaw: [0, chin + 0.33 * hh, 0.004 * s],
  };
  for (const side of [1, -1]) {
    const k = side > 0 ? 'l' : 'r';
    const d: V3 = [armDir[0] * side, armDir[1], 0];
    const sh: V3 = [shoulderHalf * side, shoulder, -0.015 * s];
    const elbow: V3 = [sh[0] + d[0] * upperArm, sh[1] + d[1] * upperArm, sh[2]];
    const wrist: V3 = [elbow[0] + d[0] * forearm, elbow[1] + d[1] * forearm, elbow[2]];
    const knuckle: V3 = [wrist[0] + d[0] * handPalm, wrist[1] + d[1] * handPalm, wrist[2]];
    P[`shoulder_${k}` as HumanoidBone] = [0.025 * s * side, shoulder - 0.018 * s, 0];
    P[`upperarm_${k}` as HumanoidBone] = sh;
    P[`forearm_${k}` as HumanoidBone] = elbow;
    P[`hand_${k}` as HumanoidBone] = wrist;
    P[`fingers_${k}` as HumanoidBone] = knuckle;
    P[`fingertips_${k}` as HumanoidBone] = [
      knuckle[0] + d[0] * finger1,
      knuckle[1] + d[1] * finger1,
      knuckle[2],
    ];
    P[`thumb_${k}` as HumanoidBone] = [
      wrist[0] + d[0] * hand * 0.13,
      wrist[1] + d[1] * hand * 0.13,
      wrist[2] + hand * 0.114,
    ];
    P[`thigh_${k}` as HumanoidBone] = [hipHalf * side, hipJoint, 0];
    P[`shin_${k}` as HumanoidBone] = [hipHalf * side, knee, 0];
    P[`foot_${k}` as HumanoidBone] = [hipHalf * side, ankle, 0];
    P[`toe_${k}` as HumanoidBone] = [(hipHalf + 0.01 * s) * side, ankle * 0.25, foot * 0.51];
  }
  const j = P as Record<HumanoidBone, V3>;
  const joints: Joint[] = (Object.keys(HUMANOID_PARENTS) as HumanoidBone[]).map((name) => ({
    name,
    parent: HUMANOID_PARENTS[name],
    position: j[name],
  }));

  const g = s * w;
  // limbs: children's are relatively a little thicker than a scaled-down adult's
  const lg = g * mix(1.12, 1, maturity);
  const soft = 1 - muscle;
  return {
    params: { ...params, height: H, build, muscle },
    H,
    s,
    w,
    hh,
    maturity,
    fem,
    joints,
    j,
    armDir,
    armAngle: HUMANOID_ARM_ANGLE,
    y: { crown, chin, neck, shoulder, chest: chestJ, waist, hipJoint, crotch, knee, ankle },
    len: {
      upperArm,
      forearm,
      hand,
      thigh: hipJoint - knee,
      shin: knee - ankle,
      foot,
    },
    dims: {
      shoulderHalf,
      hipHalf,
      chestW: 0.138 * g * mix(1, 0.93, fem) * (0.97 + 0.06 * muscle),
      chestD: 0.1 * g * mix(1, 1.04, fem),
      waistW: 0.123 * g * mix(1, 0.9, fem) * (1 + (build - 0.5) * 0.35 * soft),
      waistD: 0.094 * g * (1 + (build - 0.5) * 0.45 * soft),
      pelvisW: 0.152 * g * mix(1, 1.1, fem),
      pelvisD: 0.104 * g * mix(1, 1.04, fem),
      neckR: 0.057 * g * mix(1, 0.86, fem) * mix(0.9, 1, maturity),
      upperArmR: 0.047 * lg * mix(1, 0.9, fem) * (0.95 + 0.1 * muscle),
      forearmR: 0.041 * lg * mix(1, 0.9, fem),
      wristR: 0.027 * s * mix(1, 0.9, fem) * mix(0.95, 1, maturity),
      thighR: 0.088 * lg * mix(1, 1.04, fem),
      kneeR: 0.05 * lg,
      calfR: 0.057 * lg,
      ankleR: 0.031 * s * mix(0.95, 1, maturity),
      handScale: hand / 0.193,
      footW: 0.047 * s * mix(1, 0.92, fem),
    },
  };
}

/** Mirrors a left-side point to the right side (x -> -x). */
export const mirrorX = (p: V3): V3 => [-p[0], p[1], p[2]];
