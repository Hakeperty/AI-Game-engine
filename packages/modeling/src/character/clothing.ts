/**
 * Layered garments for the character generator. Each garment is a closed SDF shell built on the smooth body
 * proxy (offset outward by its ease), cut to its coverage, with sculpted folds (sleeves bunching at cuffs,
 * knees, ankles, drape at the hem), ribbed bands and worn, faded colors with baked occlusion. The set also
 * reports how much skin stays visible so only that skin is meshed.
 */

import type { MaterialInput } from '../material.ts';
import { clamp, hexToRgb, mixColor, type RGB, smoothstep, type V3 } from '../math.ts';
import { Noise } from '../noise.ts';
import { Sdf, sdf } from '../sdf.ts';
import type { Anatomy } from './anatomy.ts';
import type { ClothBase } from './body.ts';
import type { FaceLayout } from './head.ts';

export type TopKind = 'hoodie' | 'tshirt' | 'sweater';
export type BottomKind = 'jeans' | 'shorts' | 'trousers';
export type ShoesKind = 'boots' | 'sneakers' | 'shoes' | 'barefoot';

export interface Garment {
  name: string;
  shape: Sdf;
  material: MaterialInput;
  /** Triangle budget after decimation (medium detail). */
  triangles: number;
  /** Meshing cell size override (meters). */
  cell?: number;
  /** Give the mesh meter-scale box UVs (for tiling fabric textures). */
  uv?: boolean;
}

export interface ClothingSet {
  garments: Garment[];
  /** Skin of the head/neck is meshed above this height. */
  neckCut: number;
  /** Arm skin is meshed from this distance along the arm (from the shoulder joint). */
  armCut: number;
  /** Bare legs between these heights (legTop <= legBottom: none). */
  legTop: number;
  legBottom: number;
  /** Feet are bare. */
  barefoot: boolean;
}

export interface DressOptions {
  top: TopKind;
  topColor: string;
  bottom: BottomKind;
  bottomColor: string;
  shoes: ShoesKind;
  shoeColor: string;
  wear: number;
  seed: number;
  /** Garments get scanned fabric textures in the game: vertex colors then only tint and shade them. */
  textured?: boolean;
}

/** Region mask with explicit bounds (negative inside). */
const mask = (f: (x: number, y: number, z: number) => number, min: V3, max: V3) => new Sdf(f, { min, max });

const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function dressUp(
  an: Anatomy,
  cloth: ClothBase,
  o: DressOptions,
  _ctx: { toHead: (p: V3) => V3; L: FaceLayout },
): ClothingSet {
  const { s, y, j, dims: D } = an;
  const noise = new Noise(o.seed * 7 + 3);
  const wear = clamp(o.wear, 0, 1);
  const garments: Garment[] = [];
  // textured garments: the texture carries the color, vertex colors add a light tint, wear and occlusion
  const tint = (c: RGB): RGB => (o.textured ? mixColor([1, 1, 1], c, 0.3) : c);
  const U = an.len.upperArm;
  const F = an.len.forearm;
  const dL = an.armDir;
  const shL = j.upperarm_l;
  /** Distance along the (mirrored) arm from the shoulder joint, and radial distance from its axis. */
  const armCoord = (x: number, yy: number, z: number): [number, number] => {
    const ax = Math.abs(x);
    const px = ax - shL[0];
    const py = yy - shL[1];
    const pz = z - shL[2];
    const t = px * dL[0] + py * dL[1];
    const rx = px - dL[0] * t;
    const ry = py - dL[1] * t;
    return [t, Math.hypot(rx, ry, pz)];
  };

  // ------------------------------------------------------------------ top
  let neckCut = y.neck - 0.045 * s;
  let armCut = 0;
  {
    const top = o.top;
    const hoodie = top === 'hoodie';
    const base = tint(hexToRgb(o.topColor));
    const loose = hoodie ? 1 : top === 'sweater' ? 0.8 : 0.5;
    const easeT = (0.008 + 0.005 * loose) * s;
    const easeA = (0.006 + 0.006 * loose) * s;
    const sleeveEnd = top === 'tshirt' ? U * 0.46 : U + F - 0.008 * s;
    armCut = top === 'tshirt' ? sleeveEnd - 0.04 * s : U + F - 0.045 * s;
    const hemY =
      top === 'tshirt' ? y.hipJoint + 0.01 * s : hoodie ? y.crotch + 0.075 * s : y.hipJoint + 0.004 * s;
    const cuffLen = top === 'tshirt' ? 0 : 0.05 * s;
    // fabric hangs straight from the chest instead of clinging to the waist
    const hang = sdf.ellipsoid(
      [D.chestW * (0.97 + 0.07 * loose), (y.chest - hemY) * 0.78, D.chestD * (0.98 + 0.1 * loose)],
      [0, hemY + (y.chest - hemY) * 0.42, 0.006 * s],
    );
    // fabric bridges the hollows of the chest instead of wrapping the pectorals
    const chestFill = sdf.ellipsoid(
      [D.chestW * 0.9, 0.11 * s, D.chestD * 0.95],
      [0, y.chest + 0.05 * s, 0.004 * s],
    );
    const torsoC = cloth.torso
      .round(easeT)
      .smoothUnion(hang, 0.05 * s)
      .smoothUnion(chestFill.round(easeT), 0.04 * s);
    const sleeves = cloth.arms.map((a) => a.round(easeA));
    let shell = sdf.smoothUnionAll([torsoC, ...sleeves], 0.02 * s);
    const neckR = D.neckR + (hoodie ? 0.014 : 0.008) * s;
    // soft (hemmed) edges at the hem, cuffs and neckline
    shell = shell.smoothIntersect(
      mask(
        (x, yy, z) => {
          const [t] = armCoord(x, yy, z);
          const onArm = t > 0.02 * s && Math.abs(x) > D.shoulderHalf * 0.8 ? t - sleeveEnd : -1;
          const neck =
            neckR -
            Math.hypot(x, z + 0.02 * s - (yy - y.neck) * 0.25) -
            Math.max(0, y.neck - 0.02 * s - yy) * 2;
          return Math.max(
            hemY + 0.0025 * s * Math.sin(x * 41 + z * 29) - yy,
            onArm,
            yy > y.neck - 0.04 * s ? neck : -1,
            yy - (y.neck + 0.05 * s),
          );
        },
        [-1.2 * s, hemY - 0.02, -0.3 * s],
        [1.2 * s, y.neck + 0.08 * s, 0.3 * s],
      ),
      0.005 * s,
    );
    // folds: sleeves bunch at the cuffs and crease at the elbows; the body drapes in vertical folds from the
    // chest, pulls diagonally from the armpits and compresses above the hem band
    const cA = Math.cos((an.armAngle * Math.PI) / 180);
    const sA = Math.sin((an.armAngle * Math.PI) / 180);
    shell = shell.displaceBy(
      ([x, yy, z]) => {
        const ax = Math.abs(x);
        const [t] = armCoord(x, yy, z);
        const armW =
          smoothstep(0.02 * s, 0.07 * s, t) * smoothstep(D.shoulderHalf * 0.75, D.shoulderHalf, ax);
        let d = 0;
        const n1 = noise.noise3(x * 13, yy * 13, z * 13);
        if (armW > 0) {
          // angle around the arm (0 = up/outside, pi/2 = front)
          const rx = ax - shL[0];
          const ry = yy - shL[1];
          const phi = Math.atan2(z - shL[2], rx * sA + ry * cA);
          let da = 0;
          if (top !== 'tshirt') {
            const near = smoothstep(U + F * 0.3, U + F - cuffLen, t);
            const ring = Math.sin(
              (t / (0.028 * s)) * Math.PI * 2 + 1.7 * Math.sin(phi * 2 + n1 * 2) + n1 * 2.4,
            );
            da += 0.0048 * s * near * ring * (0.55 + 0.45 * noise.noise3(x * 31, yy * 31, z * 31));
            const el = Math.exp(-(((t - U) / (0.055 * s)) ** 2));
            da +=
              0.0034 *
              s *
              el *
              Math.sin(((t - U) / s) * 150 + phi * 3) *
              (0.45 + 0.55 * Math.max(0, Math.sin(phi)));
            da +=
              0.0014 *
              s *
              Math.sin(phi * 3 + (t / s) * 22 + n1) *
              smoothstep(0.05 * s, 0.14 * s, t) *
              (1 - smoothstep(U * 0.8, U, t));
            // ribbed cuff, snug at the wrist
            const cuff = smoothstep(U + F - cuffLen - 0.01 * s, U + F - cuffLen, t);
            da += cuff * (-0.006 * s + 0.0006 * s * Math.sin(phi * 38));
          } else {
            // short sleeve: a soft hem fold and a little flare
            da += 0.0015 * s * Math.sin(phi * 4 + n1 * 2) * smoothstep(sleeveEnd - 0.08 * s, sleeveEnd, t);
          }
          d += da * armW;
        }
        if (armW < 1) {
          let dt = 0;
          const az = Math.atan2(x, z);
          // vertical drape below the chest
          const low = smoothstep(y.chest - 0.05 * s, y.waist - 0.04 * s, yy);
          dt +=
            0.0038 *
            s *
            low *
            Math.sin(az * 7 + noise.noise3(x * 6, yy * 2.5, z * 6) * 3) *
            (0.45 + 0.55 * n1);
          // diagonal pull from the armpits toward the chest
          const ap = Math.hypot(ax - (D.shoulderHalf - 0.03 * s), yy - (y.shoulder - 0.12 * s));
          dt +=
            0.002 * s * Math.exp(-((ap / (0.06 * s)) ** 2)) * Math.sin(((yy + ax * 1.3) / s) * 90 + n1 * 3.5);
          // looser, slightly flared lower body above the hem band
          if (top !== 'tshirt') dt += 0.004 * s * smoothstep(y.waist, hemY + 0.07 * s, yy);
          // horizontal compression folds at the lower back and sides
          const back = z < 0 ? 1 : 0.35;
          dt +=
            0.0024 *
            s *
            back *
            smoothstep(y.waist + 0.06 * s, hemY + 0.07 * s, yy) *
            Math.sin((yy / s) * 160 + n1 * 2.5 + az);
          // hem band: snug and ribbed
          if (top !== 'tshirt') {
            const band = smoothstep(hemY + 0.065 * s, hemY + 0.05 * s, yy);
            dt += band * (-0.003 * s + 0.0006 * s * Math.sin(az * 90));
          }
          d += dt * (1 - armW);
        }
        return d;
      },
      0.0075 * s,
      2.4,
    );
    const parts: Sdf[] = [shell];
    if (hoodie) {
      // hood lying on the upper back: a soft sack hanging from a thick rim around the neckline, with the
      // opening dipping to a V at the front where the drawstrings come out
      const hy = y.neck;
      const rimPts: V3[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const front = Math.max(0, Math.cos(a));
        rimPts.push([
          Math.sin(a) * (D.neckR + 0.03 * s),
          hy -
            0.008 * s * Math.abs(Math.sin(a)) -
            0.045 * s * front ** 3 +
            0.022 * s * Math.max(0, -Math.cos(a)),
          -0.02 * s + Math.cos(a) * (D.neckR + 0.028 * s) + 0.012 * s * front,
        ]);
      }
      // thick bunched fabric around the back of the neck, thinner toward the front V
      const rim = sdf.tube(rimPts, (t) => (0.01 + 0.016 * Math.max(0, -Math.cos(t * Math.PI * 2)) ** 2) * s);
      // teardrop sack: wide under the rim, narrowing to the hood's tip between the shoulder blades
      const sack = sdf.smoothUnionAll(
        [
          sdf
            .ellipsoid([0.09 * s, 0.065 * s, 0.024 * s], [0, 0, 0])
            .rotate([-18, 0, 0])
            .translate([0, hy - 0.04 * s, -D.chestD - 0.028 * s]),
          sdf
            .ellipsoid([0.05 * s, 0.055 * s, 0.022 * s], [0, 0, 0])
            .rotate([-8, 0, 0])
            .translate([0, hy - 0.11 * s, -D.chestD - 0.028 * s]),
        ],
        0.04 * s,
      );
      const sides = [1, -1].map((sd) =>
        sdf.ellipsoid([0.035 * s, 0.06 * s, 0.03 * s], [sd * 0.08 * s, hy - 0.02 * s, -0.065 * s]),
      );
      let hood = sdf.smoothUnionAll([rim, sack, ...sides], 0.03 * s);
      hood = hood.displaceBy(([x, yy, z]) => {
        // center seam groove and soft crumples
        const seam = z < -0.08 * s ? -0.0025 * s * Math.exp(-((x / (0.006 * s)) ** 2)) : 0;
        return (
          seam +
          0.005 * s * noise.noise3(x * 13, yy * 13, z * 13) +
          0.002 * s * noise.noise3(x * 40, yy * 40, z * 40)
        );
      }, 0.0075 * s);
      parts.push(hood);
      // kangaroo pocket
      const py = y.waist - 0.035 * s;
      const pocket = sdf
        .box([0.23 * s, 0.13 * s, 0.05 * s], [0, py, 0], 0.02 * s)
        .intersect(torsoC.round(0.004 * s))
        .intersect(
          mask((_x, _y, z) => 0.02 * s - z, [-0.2 * s, py - 0.1 * s, 0], [0.2 * s, py + 0.1 * s, 0.3 * s]),
        );
      parts.push(pocket);
    } else {
      // ribbed collar band
      const collar = sdf
        .torus(D.neckR + 0.01 * s, 0.007 * s, [0, 0, 0])
        .rotate([-12, 0, 0])
        .translate([0, y.neck - 0.006 * s, -0.014 * s]);
      parts.push(collar);
    }
    let shape = sdf.smoothUnionAll(parts, 0.03 * s);
    const faded = mixColor(base, o.textured ? [1, 1, 1] : [0.78, 0.78, 0.76], 0.15 + 0.15 * wear);
    shape = shape.colorBy(([x, yy, z]) => {
      const [t] = armCoord(x, yy, z);
      const onArm = Math.abs(x) > D.shoulderHalf * 0.9 && t > 0.05 * s;
      let c: RGB = [...base];
      const n = noise.fbm(x * 9, yy * 9, z * 9, 3);
      let fade = 0.35 + 0.5 * n;
      if (onArm) fade += 0.5 * Math.exp(-(((t - U) / (0.06 * s)) ** 2)) * (z < 0 ? 1 : 0.4);
      else fade += 0.35 * smoothstep(y.chest - 0.05 * s, y.chest + 0.1 * s, yy) * (z > 0 ? 1 : 0.6);
      c = mixColor(c, faded, clamp(fade * (0.22 + 0.33 * wear), 0, 0.7));
      const band =
        (onArm && top !== 'tshirt' && t > U + F - cuffLen - 0.006 * s) ||
        (!onArm && top !== 'tshirt' && yy < hemY + 0.058 * s) ||
        (!hoodie && yy > y.neck - 0.02 * s && !onArm);
      if (band) c = shade(c, 0.9);
      if (!onArm && Math.abs(Math.abs(x) - D.shoulderHalf * 0.95) < 0.003 * s && yy > y.chest)
        c = shade(c, 0.86);
      if (hoodie && !onArm && z > 0) {
        const py = y.waist - 0.035 * s;
        const edge = Math.abs(Math.max(Math.abs(x) - 0.105 * s, Math.abs(yy - py) - 0.055 * s));
        if (edge < 0.003 * s) c = shade(c, 0.82);
      }
      const grime =
        wear *
        0.22 *
        (smoothstep(hemY + 0.15 * s, hemY, yy) + (onArm ? smoothstep(U + F * 0.6, U + F, t) : 0));
      c = mixColor(c, [0.3, 0.27, 0.23], clamp(grime * (0.6 + 0.4 * n), 0, 0.3));
      return shade(c, 0.97 + 0.06 * noise.noise3(x * 90, yy * 90, z * 90));
    });
    garments.push({
      name: top,
      shape,
      material: { name: top, color: '#ffffff', roughness: 0.93 },
      triangles: top === 'tshirt' ? 4000 : 6200,
      uv: true,
    });
    if (hoodie) {
      const cords: Sdf[] = [];
      for (const sd of [1, -1]) {
        const x0 = sd * 0.022 * s;
        const z0 = D.chestD + 0.03 * s;
        cords.push(
          sdf.chain(
            [
              [x0, y.neck - 0.05 * s, z0 - 0.012 * s],
              [x0 * 1.3, y.neck - 0.12 * s, z0 + 0.008 * s],
              [x0 * 1.5 + sd * 0.004 * s, y.neck - 0.21 * s, z0 + 0.012 * s],
            ],
            [0.0035 * s, 0.0033 * s, 0.004 * s],
          ),
        );
      }
      garments.push({
        name: 'drawstrings',
        shape: sdf.unionAll(cords).color(mixColor(hexToRgb(o.topColor), [0.85, 0.84, 0.8], 0.3)),
        material: { name: 'cord', color: '#ffffff', roughness: 0.85 },
        triangles: 600,
        cell: 0.002 * s,
      });
    }
  }

  // ------------------------------------------------------------------ bottom
  let legTop = 0;
  let legBottom = 0;
  const shoes = o.shoes;
  const shoeTop = shoes === 'boots' ? 0.145 * s : shoes === 'barefoot' ? 0 : y.ankle + 0.005 * s;
  {
    const bottom = o.bottom;
    const base = tint(hexToRgb(o.bottomColor));
    const waistY = y.hipJoint + (bottom === 'shorts' ? 0.085 : 0.075) * s;
    const hemY = bottom === 'shorts' ? y.knee + 0.07 * s : shoes === 'boots' ? 0.06 * s : 0.035 * s;
    const legR = (t: number) => {
      // t = 0 at the hip .. 1 at the ankle
      const thigh = D.thighR * 1.02 + 0.012 * s;
      const knee = D.kneeR + (bottom === 'trousers' ? 0.026 : 0.02) * s;
      const hem =
        (bottom === 'shorts' ? D.thighR + 0.018 * s : 0.056 * s) + (bottom === 'trousers' ? 0.006 * s : 0);
      return t < 0.5
        ? thigh + (knee - thigh) * smoothstep(0, 0.5, t)
        : knee + (hem - knee) * smoothstep(0.5, 1, t);
    };
    const legs: Sdf[] = [];
    for (const sd of [1, -1]) {
      const hx = D.hipHalf * sd;
      const top: V3 = [hx * 1.05, y.hipJoint, -0.006 * s];
      const bot: V3 = [hx * 1.02, hemY - 0.01 * s, 0.004 * s];
      const pts: V3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push([
          top[0] + (bot[0] - top[0]) * t,
          top[1] + (bot[1] - top[1]) * t,
          top[2] + (bot[2] - top[2]) * t,
        ]);
      }
      const len = y.hipJoint - y.ankle;
      legs.push(
        sdf.chain(pts, (u) => legR(clamp((u * (top[1] - bot[1])) / len, 0, 1)), {
          curve: false,
          smooth: 0.01 * s,
        }),
      );
    }
    const pelvis = cloth.torso
      .round((o.top === 'tshirt' ? 0.01 : 0.005) * s)
      .intersect(
        mask(
          (_x, yy) => Math.max(yy - waistY, y.crotch - 0.02 * s - yy),
          [-0.4 * s, y.crotch - 0.05 * s, -0.3 * s],
          [0.4 * s, waistY + 0.01, 0.3 * s],
        ),
      );
    let shape = sdf
      .smoothUnionAll([pelvis, ...legs], 0.035 * s)
      .intersect(
        mask(
          (x, yy, z) => Math.max(yy - waistY, hemY + 0.002 * s * Math.sin(x * 43 + z * 31) - yy),
          [-0.5 * s, hemY - 0.01, -0.3 * s],
          [0.5 * s, waistY + 0.01, 0.3 * s],
        ),
      );
    shape = shape.displaceBy(
      ([x, yy, z]) => {
        const lx = Math.abs(x) - D.hipHalf;
        let d = 0;
        // knee creases and ankle stacking
        const kneeZone = Math.exp(-(((yy - y.knee - 0.01 * s) / (0.045 * s)) ** 2));
        const kn = noise.noise3(x * 25, yy * 12, z * 25);
        d +=
          0.003 *
          s *
          kneeZone *
          Math.sin((yy / (0.022 * s)) * Math.PI * 2 + kn * 3) *
          (z < 0 ? 1 : 0.25) *
          (0.5 + 0.5 * kn);
        if (bottom !== 'shorts') {
          const stack = smoothstep(0.22 * s, hemY + 0.01 * s, yy);
          const sn = noise.noise3(x * 35, yy * 10, z * 35);
          d +=
            0.0042 *
            s *
            stack *
            (0.55 + 0.45 * sn) *
            Math.sin((yy / (0.03 * s)) * Math.PI * 2 + sn * 3.5 + x * 40);
        }
        // crotch / hip pull wrinkles
        const crotch =
          Math.exp(-(((yy - y.crotch) / (0.06 * s)) ** 2)) * smoothstep(0.08 * s, 0.0, Math.abs(lx));
        d += 0.003 * s * crotch * Math.sin((x * 3 + yy) * 160);
        // trouser front crease
        if (bottom === 'trousers' && z > 0 && yy < y.crotch)
          d += 0.0025 * s * (1 - smoothstep(0, 0.012 * s, Math.abs(lx)));
        // waistband
        d += 0.004 * s * smoothstep(waistY - 0.045 * s, waistY - 0.035 * s, yy);
        return d;
      },
      0.009 * s,
      2.2,
    );
    const faded = mixColor(
      base,
      bottom === 'jeans' ? [0.5, 0.57, 0.67] : [0.72, 0.71, 0.67],
      0.2 + 0.15 * wear,
    );
    shape = shape.colorBy(([x, yy, z]) => {
      let c: RGB = [...base];
      const lx = Math.abs(x) - D.hipHalf;
      const n = noise.fbm(x * 7 + 11, yy * 7, z * 7, 3);
      let f = 0.3 + 0.4 * n;
      if (bottom === 'jeans') {
        // fading on the thigh fronts, knees and seat; whiskers near the crotch
        f += 0.55 * (z > 0 ? 1 : 0.2) * Math.exp(-(((yy - (y.knee + 0.2 * s)) / (0.16 * s)) ** 2));
        f += 0.45 * Math.exp(-(((yy - y.knee) / (0.05 * s)) ** 2)) * (z > 0 ? 1 : 0.3);
        f += 0.3 * (z < 0 ? 1 : 0) * Math.exp(-(((yy - (y.hipJoint - 0.04 * s)) / (0.07 * s)) ** 2));
        const whisk = Math.exp(-(((yy - (y.crotch + 0.01 * s)) / (0.03 * s)) ** 2)) * (z > 0 ? 1 : 0);
        if (!o.textured) f += 0.22 * whisk * Math.max(0, Math.sin((yy - Math.abs(lx) * 0.5) * 420));
        // seams: outer leg seam and yoke
        if (Math.abs(Math.abs(x) - (D.hipHalf + D.thighR * 0.9)) < 0.003 * s && yy < y.hipJoint) f -= 0.4;
      }
      c = mixColor(c, faded, clamp(f * (0.35 + 0.35 * wear), 0, 0.85));
      // waistband and hem slightly darker
      if (yy > waistY - 0.035 * s) c = shade(c, 0.86);
      if (yy < hemY + 0.02 * s) c = shade(c, 0.9);
      const grime = wear * 0.3 * smoothstep(hemY + 0.25 * s, hemY, yy);
      c = mixColor(c, [0.32, 0.29, 0.25], clamp(grime * (0.5 + 0.5 * n), 0, 0.3));
      return shade(c, 0.97 + 0.06 * noise.noise3(x * 80, yy * 80, z * 80));
    });
    garments.push({
      name: bottom,
      shape,
      material: { name: bottom, color: '#ffffff', roughness: bottom === 'jeans' ? 0.9 : 0.88 },
      triangles: bottom === 'shorts' ? 2400 : 3800,
      uv: true,
    });
    if (bottom === 'shorts') {
      legTop = hemY + 0.04 * s;
      legBottom = shoes === 'barefoot' ? 0 : shoeTop + (shoes === 'sneakers' ? 0.035 : 0.0) * s - 0.015 * s;
    }
    if (o.top === 'hoodie' || bottom === 'jeans') {
      // a leather belt (mostly under the hoodie)
      const belt = cloth.all
        .round(0.0075 * s)
        .intersect(
          mask(
            (_x, yy) => Math.abs(yy - (waistY - 0.018 * s)) - 0.017 * s,
            [-0.4 * s, waistY - 0.05 * s, -0.3 * s],
            [0.4 * s, waistY + 0.01 * s, 0.3 * s],
          ),
        )
        .union(
          sdf
            .box([0.045 * s, 0.036 * s, 0.008 * s], [0, waistY - 0.018 * s, D.pelvisD + 0.01 * s], 0.003 * s)
            .color('#6f6452'),
        )
        .colorBy((p, b) =>
          p[2] > D.pelvisD + 0.008 * s && Math.abs(p[0]) < 0.024 * s
            ? b
            : shade(hexToRgb('#3a2a1f'), 0.95 + 0.1 * noise.noise3(p[0] * 60, p[1] * 60, p[2] * 60)),
        );
      garments.push({
        name: 'belt',
        shape: belt,
        material: { name: 'belt', color: '#ffffff', roughness: 0.55 },
        triangles: 900,
        uv: true,
        cell: 0.004 * s,
      });
    }
  }

  // ------------------------------------------------------------------ shoes
  if (shoes !== 'barefoot') {
    const base = tint(hexToRgb(o.shoeColor));
    const soleC: RGB = shoes === 'sneakers' ? [0.9, 0.89, 0.86] : [0.12, 0.1, 0.09];
    const soleH = (shoes === 'boots' ? 0.03 : shoes === 'sneakers' ? 0.028 : 0.018) * s;
    const pair: Sdf[] = [];
    for (const sd of [1, -1]) {
      const a = sd > 0 ? j.foot_l : j.foot_r;
      const x = a[0];
      const L = an.len.foot;
      const heelZ = -0.058 * s * (L / (0.267 * s));
      const w = D.footW;
      const upper = sdf
        .smoothUnionAll(
          [
            sdf.ellipsoid([w * 0.95, 0.045 * s, 0.06 * s], [x, 0.05 * s, heelZ + 0.05 * s]),
            sdf.ellipsoid(
              [w * 1.12, 0.036 * s, 0.085 * s],
              [x + 0.006 * s * sd, 0.045 * s, heelZ + L * 0.52],
            ),
            sdf.ellipsoid([w * 1.05, 0.03 * s, 0.05 * s], [x + 0.01 * s * sd, 0.04 * s, heelZ + L * 0.83]),
            sdf.capsule(
              [x, 0.05 * s, -0.01 * s],
              [x, shoeTop, -0.006 * s],
              an.dims.ankleR + (shoes === 'boots' ? 0.018 : 0.012) * s,
            ),
          ],
          0.03 * s,
        )
        .cutAbove(shoeTop + 0.004 * s, 0.006 * s);
      const sole = sdf
        .smoothUnionAll(
          [
            sdf.ellipsoid([w * 1.02, soleH, 0.065 * s], [x, soleH * 0.5, heelZ + 0.055 * s]),
            sdf.ellipsoid([w * 1.2, soleH, L * 0.36], [x + 0.008 * s * sd, soleH * 0.5, heelZ + L * 0.6]),
          ],
          0.02 * s,
        )
        .intersect(sdf.box([0.3 * s, soleH * 2, 0.5 * s], [x, soleH, heelZ + L * 0.5]));
      let shoe = upper.smoothUnion(sole, 0.006 * s).cutBelow(0, 0.003 * s);
      if (shoes === 'sneakers') {
        // sock cuff above the shoe
        const sock = sdf
          .capsule(
            [x, shoeTop - 0.02 * s, -0.008 * s],
            [x, shoeTop + 0.04 * s, -0.004 * s],
            an.dims.ankleR + 0.006 * s,
          )
          .color('#cfccc4');
        shoe = shoe.union(sock);
      }
      pair.push(shoe);
    }
    let shape = sdf.unionAll(pair);
    shape = shape.colorBy(([x, yy, z], b) => {
      if (shoes === 'sneakers' && yy > shoeTop - 0.004 * s && b[0] > 0.7 && b[1] > 0.7) return b;
      if (yy < soleH * 1.05) return shade(soleC, yy < soleH * 0.35 ? 0.8 : 1);
      let c: RGB = [...base];
      const n = noise.fbm(x * 20, yy * 20, z * 20, 2);
      // leather creases and scuffs, darker toe cap stitching
      c = shade(c, 0.9 + 0.2 * n);
      const lx = Math.abs(x) - D.hipHalf;
      if (z > 0.02 * s && Math.abs(lx) < 0.018 * s && yy > 0.05 * s) {
        // laces across the instep
        const lace = Math.abs(Math.sin((z / (0.012 * s)) * Math.PI));
        if (lace > 0.75) c = shoes === 'boots' ? [0.18, 0.13, 0.09] : [0.88, 0.87, 0.84];
      }
      const scuff = wear * 0.35 * smoothstep(0.02 * s, 0.0, yy - soleH) + wear * 0.2 * Math.max(0, n);
      return mixColor(c, [0.45, 0.42, 0.38], clamp(scuff, 0, 0.35));
    });
    garments.push({
      name: shoes,
      shape,
      material: { name: shoes, color: '#ffffff', roughness: shoes === 'sneakers' ? 0.75 : 0.5 },
      triangles: 2200,
      uv: true,
      cell: 0.0045 * s,
    });
  }

  if (o.top === 'hoodie' || o.top === 'sweater') neckCut = y.neck - 0.13 * s;
  return { garments, neckCut, armCut, legTop, legBottom, barefoot: shoes === 'barefoot' };
}
