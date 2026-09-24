/**
 * The body skin as signed distance fields in model space (bind A-pose): torso with rib cage, pectorals, shoulder
 * girdle, abdomen, pelvis and glutes; limbs with muscle masses; five-fingered hands; feet; the neck joining the
 * head. `bodyProxy` is a smoother, simpler version used as the base for clothing and for skin-weight projection.
 */
import { HUMANOID_ARM_ANGLE } from '@aige/core';
import { add, mul, type V3 } from '../math.ts';
import { type Sdf, sdf } from '../sdf.ts';
import type { Anatomy } from './anatomy.ts';

const sym = (make: (side: 1 | -1) => Sdf): Sdf[] => [make(1), make(-1)];

/** Oriented ellipsoid: radii along (dir, up-ish, side) frame of the left arm, placed at c. */
function armEll(side: 1 | -1, r: V3, c: V3): Sdf {
  const e = sdf.ellipsoid(r, [0, 0, 0]).rotate([0, 0, -HUMANOID_ARM_ANGLE * side]);
  return e.translate(c);
}

const flipX = (p: V3, side: number): V3 => [p[0] * side, p[1], p[2]];

/** Point along the left arm (A-pose) from the shoulder joint: t meters along, plus an offset. */
function alongArm(an: Anatomy, side: 1 | -1, t: number, off: V3 = [0, 0, 0]): V3 {
  const sh = an.j.upperarm_l;
  const d = an.armDir;
  return flipX(add(add(sh, mul(d, t)), off), side);
}

export interface FingerChain {
  /** Knuckle, then the ends of the three phalanges (hand-local frame). */
  pts: V3[];
  radii: number[];
}

/** The four fingers (index..pinky) in the hand-local frame, slightly spread and relaxed. */
export function fingerChains(k: number): FingerChain[] {
  // [z, knuckle x, phalanx lengths, radius, spread deg]
  const fingers: [number, number, [number, number, number], number, number][] = [
    [0.027, 0.097, [0.041, 0.025, 0.02], 0.0092, 4],
    [0.009, 0.1, [0.046, 0.029, 0.021], 0.0095, 1],
    [-0.009, 0.096, [0.043, 0.027, 0.021], 0.009, -2],
    [-0.026, 0.087, [0.034, 0.02, 0.018], 0.0079, -6],
  ];
  const curl = [7, 10, 8];
  return fingers.map(([z, kx, ls, r0, spread]) => {
    let p: V3 = [kx * k, -0.003 * k, z * k];
    let ang = 0;
    const pts: V3[] = [p];
    const sp = (spread * Math.PI) / 180;
    ls.forEach((l, i) => {
      ang += (curl[i]! * Math.PI) / 180;
      const dir: V3 = [Math.cos(ang) * Math.cos(sp), -Math.sin(ang), Math.cos(ang) * Math.sin(sp)];
      p = add(p, mul(dir, l * k));
      pts.push(p);
    });
    return { pts, radii: [r0 * k, r0 * 0.93 * k, r0 * 0.86 * k, r0 * 0.78 * k] };
  });
}

/** Thumb chain (metacarpal base .. tip) in the hand-local frame. */
export function thumbChain(k: number): FingerChain {
  return {
    pts: [
      [0.018 * k, -0.006 * k, 0.026 * k],
      [0.05 * k, -0.013 * k, 0.047 * k],
      [0.077 * k, -0.018 * k, 0.059 * k],
      [0.098 * k, -0.02 * k, 0.066 * k],
    ],
    radii: [0.0135 * k, 0.0112 * k, 0.0098 * k, 0.0083 * k],
  };
}

/** Hand-local point -> model space for the given side (A-pose, wrist at the hand joint). */
export function handToModel(an: Anatomy, side: 1 | -1, p: V3): V3 {
  const c = Math.cos((-HUMANOID_ARM_ANGLE * Math.PI) / 180);
  const sn = Math.sin((-HUMANOID_ARM_ANGLE * Math.PI) / 180);
  const w = an.j.hand_l;
  const x = w[0] + p[0] * c - p[1] * sn;
  const y = w[1] + p[0] * sn + p[1] * c;
  return [x * side, y, w[2] + p[2]];
}

/** Hand in its local frame (x along the fingers, y = back of the hand, z = thumb side), wrist at the origin. */
function handLocal(an: Anatomy): Sdf {
  const k = an.dims.handScale;
  const fem = an.fem;
  const palmLen = 0.098 * k;
  const pw = 0.08 * k * (1 - 0.06 * fem);
  const parts: Sdf[] = [
    // palm: thicker at the heel of the hand, thinner at the knuckles
    sdf.box([palmLen * 0.9, 0.024 * k, pw * 0.92], [palmLen * 0.5, -0.002 * k, -0.002 * k], 0.01 * k),
    sdf.ellipsoid([0.034 * k, 0.015 * k, 0.03 * k], [0.022 * k, -0.004 * k, 0.012 * k]),
    // thenar (thumb ball) and hypothenar
    sdf.ellipsoid([0.032 * k, 0.016 * k, 0.018 * k], [0.03 * k, -0.009 * k, 0.026 * k]),
    sdf.ellipsoid([0.04 * k, 0.012 * k, 0.014 * k], [0.045 * k, -0.008 * k, -0.026 * k]),
    // wrist
    sdf.ellipsoid([0.02 * k, 0.017 * k, 0.029 * k], [0.002 * k, 0, 0]),
  ];
  for (const f of fingerChains(k)) {
    parts.push(sdf.chain(f.pts, f.radii, { curve: false, smooth: 0.002 * k }));
    // knuckle bump on the back of the hand
    const kn = f.pts[0]!;
    parts.push(sdf.sphere(f.radii[0]! * 0.95, [kn[0] - 0.004 * k, 0.001 * k, kn[2]]));
  }
  const th = thumbChain(k);
  parts.push(sdf.chain(th.pts, th.radii, { curve: false, smooth: 0.003 * k }));
  return sdf.smoothUnionAll(parts, 0.006 * k);
}

/** Left foot in model space (at the left ankle). */
function footLeft(an: Anatomy): Sdf {
  const a = an.j.foot_l;
  const s = an.s;
  const L = an.len.foot;
  const w = an.dims.footW;
  const x = a[0];
  const heelZ = -0.052 * (L / 0.267);
  const parts = [
    sdf.sphere(0.034 * s, [x, 0.036 * s, heelZ + 0.03 * s]),
    sdf.ellipsoid([w * 0.8, 0.028 * s, 0.07 * s], [x + 0.004 * s, 0.035 * s, heelZ + 0.1 * s]),
    sdf.ellipsoid([w, 0.022 * s, 0.045 * s], [x + 0.01 * s, 0.024 * s, heelZ + 0.19 * s * (L / 0.267)]),
    sdf.ellipsoid([w * 0.95, 0.017 * s, 0.035 * s], [x + 0.012 * s, 0.018 * s, heelZ + L - 0.035 * s]),
    // ankle and malleoli
    sdf.roundCone([x, a[1] + 0.02 * s, -0.004 * s], [x, 0.045 * s, 0.01 * s], an.dims.ankleR, 0.034 * s),
    sdf.sphere(0.017 * s, [x + 0.02 * s, a[1] + 0.005 * s, -0.004 * s]),
    sdf.sphere(0.017 * s, [x - 0.018 * s, a[1] + 0.012 * s, -0.002 * s]),
  ];
  return sdf.smoothUnionAll(parts, 0.018 * s).cutBelow(0.004 * s, 0.004 * s);
}

export interface BodySdfs {
  /** Full skin (head excluded; the neck is included). */
  body: Sdf;
  /** Left and right hand in model space (also part of `body`). */
  hands: Sdf;
  /** Smooth, simple body masses (legacy clothing base). */
  proxy: Sdf;
  /** Garment bases: the anatomical body split into torso(+neck), arms (shoulder to wrist) and legs. */
  cloth: ClothBase;
}

export interface ClothBase {
  torso: Sdf;
  arms: Sdf[];
  legs: Sdf[];
  all: Sdf;
}

export function bodySdfs(an: Anatomy): BodySdfs {
  const { y, dims: D, s, fem } = an;
  const g = s * an.w;
  const masc = (1 - fem) * an.maturity;
  const muscle = an.params.muscle;
  const build = an.params.build;
  // --- torso
  const ribY = y.chest + 0.03 * s;
  const torso: Sdf[] = [
    sdf.ellipsoid([D.chestW, 0.185 * s, D.chestD], [0, ribY, -0.012 * s]),
    // upper chest / pectorals (breasts for women)
    ...sym((sd) =>
      fem > 0.5
        ? sdf.ellipsoid(
            [0.058 * g, 0.052 * g, 0.048 * g],
            [sd * 0.058 * g, y.chest + 0.07 * s, D.chestD * 0.62],
          )
        : sdf.ellipsoid(
            [0.078 * g, 0.058 * g, 0.036 * g * (0.8 + 0.4 * muscle)],
            [sd * 0.066 * g, y.chest + 0.09 * s, D.chestD * 0.5],
          ),
    ),
    // scapulae
    ...sym((sd) =>
      sdf.ellipsoid([0.07 * g, 0.09 * s, 0.035 * g], [sd * 0.075 * g, y.chest + 0.08 * s, -D.chestD * 0.62]),
    ),
    // abdomen and waist
    sdf.ellipsoid([D.waistW, 0.13 * s, D.waistD], [0, y.waist, 0.002 * s]),
    // belly (heavier builds)
    ...(build > 0.55
      ? [
          sdf.ellipsoid(
            [D.waistW * 0.85, 0.1 * s, D.waistD * 0.7],
            [0, y.waist - 0.03 * s, D.waistD * (0.25 + 0.5 * (build - 0.55))],
          ),
        ]
      : []),
    // pelvis
    sdf.ellipsoid([D.pelvisW, 0.1 * s, D.pelvisD], [0, y.hipJoint + 0.035 * s, -0.012 * s]),
    // lower abdomen / groin
    sdf.ellipsoid([0.085 * g, 0.07 * s, 0.06 * g], [0, y.crotch + 0.06 * s, 0.03 * g]),
    // glutes
    ...sym((sd) =>
      sdf.ellipsoid(
        [0.075 * g * (1 + 0.08 * fem), 0.09 * s, 0.068 * g * (1 + 0.1 * fem)],
        [sd * 0.068 * g, y.hipJoint - 0.035 * s, -0.058 * g],
      ),
    ),
    // shoulder girdle: clavicle line and trapezius slope into the neck
    ...sym((sd) =>
      sdf.roundCone(
        [sd * 0.035 * s, y.neck + 0.035 * s, -0.04 * s],
        [sd * (D.shoulderHalf - 0.02 * s), y.shoulder - 0.005 * s, -0.022 * s],
        0.042 * g,
        0.04 * g,
      ),
    ),
    ...sym((sd) =>
      sdf.capsule(
        [sd * 0.02 * s, y.neck - 0.012 * s, 0.035 * s],
        [sd * (D.shoulderHalf - 0.03 * s), y.shoulder - 0.012 * s, 0.01 * s],
        0.018 * g,
      ),
    ),
  ];
  // --- neck (into the head)
  const neckTop: V3 = [0, y.chin + (0.012 * an.hh) / 0.232, -0.026 * s];
  const neck: Sdf[] = [
    sdf.roundCone([0, y.neck - 0.02 * s, -0.03 * s], neckTop, D.neckR, D.neckR * 0.86),
    // sternocleidomastoid
    ...sym((sd) =>
      sdf.capsule(
        [sd * 0.048 * s, y.chin + 0.045 * s, -0.022 * s],
        [sd * 0.014 * s, y.neck - 0.005 * s, 0.035 * s],
        0.013 * g,
      ),
    ),
    // nape
    sdf.ellipsoid([0.05 * g, 0.06 * s, 0.03 * g], [0, y.neck + 0.03 * s, -0.05 * s]),
  ];
  if (masc > 0.5)
    neck.push(sdf.ellipsoid([0.01 * s, 0.013 * s, 0.009 * s], [0, y.chin - 0.04 * s, 0.018 * s]));

  // --- arms (built on the left, mirrored)
  const arm = (sd: 1 | -1): Sdf[] => {
    const U = an.len.upperArm;
    const F = an.len.forearm;
    return [
      // deltoid over the shoulder joint
      armEll(sd, [0.056 * g, 0.04 * g, 0.045 * g], alongArm(an, sd, 0.014 * s, [-0.006 * s, 0.008 * s, 0])),
      // upper arm core, biceps, triceps
      sdf.roundCone(alongArm(an, sd, 0.02 * s), alongArm(an, sd, U), D.upperArmR, D.forearmR * 0.93),
      armEll(
        sd,
        [U * 0.3, D.upperArmR * 0.72, D.upperArmR * 0.75],
        alongArm(an, sd, U * 0.55, [0, -0.006 * s, 0.014 * s]),
      ),
      armEll(
        sd,
        [U * 0.33, D.upperArmR * 0.72, D.upperArmR * 0.72],
        alongArm(an, sd, U * 0.45, [0, 0.006 * s, -0.016 * s]),
      ),
      // elbow
      sdf.sphere(D.forearmR * 0.88, alongArm(an, sd, U)),
      // forearm: muscle mass near the elbow, flattening to the wrist
      armEll(sd, [F * 0.36, D.forearmR * 0.95, D.forearmR * 1.02], alongArm(an, sd, U + F * 0.3)),
      sdf.roundCone(alongArm(an, sd, U), alongArm(an, sd, U + F * 0.92), D.forearmR * 0.9, D.wristR),
      armEll(sd, [F * 0.18, D.wristR * 0.72, D.wristR * 1.1], alongArm(an, sd, U + F * 0.9)),
    ];
  };
  // --- legs
  const leg = (sd: 1 | -1): Sdf[] => {
    const hx = D.hipHalf * sd;
    const kz = 0.004 * s;
    return [
      sdf.roundCone(
        [hx * 1.05, y.hipJoint - 0.01 * s, -0.008 * s],
        [hx, y.knee + 0.05 * s, kz],
        D.thighR,
        D.kneeR * 1.08,
      ),
      // quadriceps, hamstrings, adductors
      sdf.ellipsoid([0.058 * g, 0.16 * s, 0.05 * g], [hx * 1.04, y.knee + 0.2 * s, 0.03 * g]),
      sdf.ellipsoid([0.055 * g, 0.15 * s, 0.048 * g], [hx * 1.02, y.knee + 0.22 * s, -0.03 * g]),
      sdf.ellipsoid([0.045 * g, 0.1 * s, 0.05 * g], [hx * 0.62, y.hipJoint - 0.12 * s, 0]),
      // knee and kneecap
      sdf.sphere(D.kneeR, [hx, y.knee, 0.006 * s]),
      sdf.sphere(D.kneeR * 0.5, [hx, y.knee + 0.006 * s, D.kneeR * 0.82]),
      // shin and calf
      sdf.roundCone(
        [hx, y.knee - 0.02 * s, 0],
        [hx, y.ankle + 0.03 * s, -0.004 * s],
        D.kneeR * 0.95,
        D.ankleR,
      ),
      sdf.ellipsoid([D.calfR * 0.95, 0.11 * s, D.calfR], [hx * 1.02, y.knee - 0.14 * s, -0.024 * g]),
    ];
  };
  const handL = handLocal(an).rotate([0, 0, -HUMANOID_ARM_ANGLE]).translate(an.j.hand_l);
  const hands = handL.union(handL.mirrorX().intersect(sdf.box([1, 3, 1], [-0.5, 1.5, 0])));
  const footL = footLeft(an);
  const torsoS = sdf.smoothUnionAll(torso, 0.05 * s);
  const neckS = sdf.smoothUnionAll(neck, 0.025 * s);
  const armS = [sdf.smoothUnionAll(arm(1), 0.012 * s), sdf.smoothUnionAll(arm(-1), 0.012 * s)];
  const legS = [sdf.smoothUnionAll(leg(1), 0.015 * s), sdf.smoothUnionAll(leg(-1), 0.015 * s)];
  const body = sdf
    .smoothUnionAll([torsoS, neckS, ...armS, ...legS], 0.022 * s)
    .smoothUnion(hands, 0.012 * s)
    .smoothUnion(footL.union(footL.mirrorX().intersect(sdf.box([1, 1, 1], [-0.5, 0.5, 0]))), 0.02 * s);
  // garments are built on the real body (without hands, feet and head) so they follow its anatomy
  const cloth = {
    torso: torsoS.smoothUnion(neckS, 0.03 * s),
    arms: armS,
    legs: legS,
    all: sdf.smoothUnionAll([torsoS, neckS, ...armS, ...legS], 0.03 * s),
  };

  // --- proxy: few, smooth masses
  const proxyParts: Sdf[] = [
    sdf.ellipsoid([D.chestW * 1.02, 0.2 * s, D.chestD * 1.05], [0, ribY, -0.008 * s]),
    sdf.ellipsoid([D.waistW * 1.02, 0.14 * s, D.waistD * 1.02], [0, y.waist, 0]),
    sdf.ellipsoid([D.pelvisW * 1.02, 0.12 * s, D.pelvisD * 1.02], [0, y.hipJoint + 0.02 * s, -0.012 * s]),
    ...sym((sd) =>
      sdf.roundCone(
        [sd * 0.03 * s, y.neck + 0.02 * s, -0.03 * s],
        [sd * (D.shoulderHalf - 0.01 * s), y.shoulder - 0.01 * s, -0.016 * s],
        0.05 * g,
        0.05 * g,
      ),
    ),
    sdf.roundCone([0, y.neck - 0.03 * s, -0.026 * s], neckTop, D.neckR * 1.05, D.neckR * 0.95),
  ];
  for (const sd of [1, -1] as const) {
    const U = an.len.upperArm;
    const F = an.len.forearm;
    proxyParts.push(
      sdf.roundCone(alongArm(an, sd, 0), alongArm(an, sd, U), D.upperArmR * 1.12, D.forearmR * 0.98),
      sdf.roundCone(alongArm(an, sd, U), alongArm(an, sd, U + F), D.forearmR, D.wristR * 1.05),
      sdf.roundCone(
        alongArm(an, sd, U + F),
        alongArm(an, sd, U + F + an.len.hand * 0.75),
        D.wristR,
        0.012 * s,
      ),
    );
    const hx = D.hipHalf * sd;
    proxyParts.push(
      sdf.roundCone(
        [hx * 1.05, y.hipJoint - 0.01 * s, -0.01 * s],
        [hx, y.knee, 0.004 * s],
        D.thighR * 1.05,
        D.kneeR,
      ),
      sdf.roundCone([hx, y.knee, 0.004 * s], [hx, y.ankle, -0.004 * s], D.kneeR, D.ankleR),
      sdf.roundCone(
        [hx, y.ankle, -0.02 * s],
        [hx + 0.01 * s * sd, 0.03 * s, an.len.foot * 0.55],
        0.04 * s,
        0.035 * s,
      ),
    );
  }
  const proxy = sdf.smoothUnionAll(proxyParts, 0.05 * s);
  return { body, hands, proxy, cloth };
}
