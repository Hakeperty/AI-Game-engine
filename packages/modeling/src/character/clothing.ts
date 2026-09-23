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
}

/** Region mask with explicit bounds (negative inside). */
const mask = (f: (x: number, y: number, z: number) => number, min: V3, max: V3) => new Sdf(f, { min, max });

const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function dressUp(
  an: Anatomy,
  proxy: Sdf,
  o: DressOptions,
  _ctx: { toHead: (p: V3) => V3; L: FaceLayout },
): ClothingSet {
  const { s, y, j, dims: D } = an;
  const noise = new Noise(o.seed * 7 + 3);
  const wear = clamp(o.wear, 0, 1);
  const garments: Garment[] = [];
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
    const base = hexToRgb(o.topColor);
    const loose = top === 'hoodie' ? 1 : top === 'sweater' ? 0.75 : 0.45;
    const ease = (0.012 + 0.012 * loose) * s;
    const sleeveEnd = top === 'tshirt' ? U * 0.44 : U + F - 0.012 * s;
    armCut = top === 'tshirt' ? sleeveEnd - 0.045 * s : U + F - 0.05 * s;
    const hemY =
      top === 'tshirt'
        ? y.hipJoint + 0.015 * s
        : top === 'hoodie'
          ? y.crotch + 0.07 * s
          : y.hipJoint + 0.005 * s;
    // torso: proxy + a straight drape from the chest to the hem
    const drape = sdf.ellipsoid(
      [D.chestW * (1 + 0.1 * loose), (y.chest - hemY) * 0.95, D.chestD * (1 + 0.12 * loose)],
      [0, hemY + (y.chest - hemY) * 0.35, 0.004 * s],
    );
    let torso = proxy.round(ease).smoothUnion(drape, 0.06 * s);
    // cut: below the hem and at the sleeve ends; the neckline is carved out around the neck
    const neckR = D.neckR + (top === 'hoodie' ? 0.016 : 0.009) * s;
    const nx = 0;
    const neckAxisZ = -0.02 * s;
    torso = torso.intersect(
      mask(
        (x, yy, z) => {
          const [t, r] = armCoord(x, yy, z);
          const onArm = t > 0.02 * s && Math.abs(x) > D.shoulderHalf * 0.8 ? t - sleeveEnd : -1;
          const neck =
            neckR -
            Math.hypot(x - nx, z - neckAxisZ - (yy - y.neck) * 0.25) -
            Math.max(0, y.neck - 0.02 * s - yy) * 2;
          void r;
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
    );
    // folds: sleeves bunch toward the cuff and at the inner elbow, the torso drapes at the hem
    const cuffLen = top === 'tshirt' ? 0 : 0.055 * s;
    torso = torso.displaceBy(
      ([x, yy, z]) => {
        const [t] = armCoord(x, yy, z);
        const onArm = Math.abs(x) > D.shoulderHalf * 0.9 && t > 0.05 * s;
        let d = 0;
        if (onArm) {
          if (top !== 'tshirt') {
            const nearCuff = smoothstep(U + F * 0.3, U + F - cuffLen, t);
            const wobble = noise.noise3(t * 25, x * 14, z * 14) * 3.2;
            const amp = 0.5 + 0.5 * noise.noise3(x * 30 + 5, yy * 30, z * 30);
            d += 0.0042 * s * nearCuff * amp * Math.sin((t / (0.034 * s)) * Math.PI * 2 + wobble);
            // cuff: tighter band
            if (t > U + F - cuffLen - 0.012 * s)
              d -= 0.009 * s * smoothstep(U + F - cuffLen - 0.012 * s, U + F - cuffLen, t);
            // elbow creases
            const el = Math.exp(-(((t - U) / (0.05 * s)) ** 2));
            d += 0.004 * s * el * Math.sin(z * 180 + t * 90);
          }
        } else {
          // torso drape: vertical folds toward the hem, a few horizontal wrinkles at the waist
          const low = smoothstep(y.waist, hemY + 0.02 * s, yy);
          d +=
            0.0045 *
            s *
            low *
            noise.noise3(x * 16, 3.1, z * 16) *
            (0.6 + 0.4 * Math.sin(Math.atan2(x, z) * 9));
          d += 0.0025 * s * smoothstep(y.chest, y.waist, yy) * noise.noise3(x * 8, yy * 40, z * 8);
          // hem band
          if (top !== 'tshirt') d -= 0.004 * s * smoothstep(hemY + 0.07 * s, hemY + 0.05 * s, yy);
        }
        return d;
      },
      0.012 * s,
      2.2,
    );
    const parts: Sdf[] = [torso];
    if (top === 'hoodie') {
      // hood lying behind the neck: a thick roll and fabric on the upper back
      const hy = y.neck + 0.005 * s;
      const roll = sdf.tube(
        [
          [0.075 * s, hy - 0.035 * s, 0.035 * s],
          [0.095 * s, hy + 0.0 * s, -0.03 * s],
          [0.07 * s, hy + 0.02 * s, -0.085 * s],
          [0, hy + 0.025 * s, -0.105 * s],
          [-0.07 * s, hy + 0.02 * s, -0.085 * s],
          [-0.095 * s, hy + 0.0 * s, -0.03 * s],
          [-0.075 * s, hy - 0.035 * s, 0.035 * s],
        ],
        (t) => (0.028 + 0.012 * Math.sin(Math.PI * t)) * s,
      );
      const back = sdf.ellipsoid([0.12 * s, 0.1 * s, 0.035 * s], [0, hy - 0.07 * s, -D.chestD - 0.02 * s]);
      const hood = roll
        .smoothUnion(back, 0.04 * s)
        .subtract(
          sdf.capsule(
            [0, y.neck - 0.08 * s, -0.02 * s],
            [0, y.neck + 0.2 * s, 0.01 * s],
            D.neckR + 0.012 * s,
          ),
        )
        .displaceBy(([x, yy, z]) => 0.004 * s * noise.noise3(x * 25, yy * 25, z * 25), 0.004 * s);
      parts.push(hood);
      // kangaroo pocket
      const py = y.waist - 0.035 * s;
      const pocket = sdf
        .box([0.23 * s, 0.13 * s, 0.05 * s], [0, py, 0], 0.02 * s)
        .intersect(torso.round(0.006 * s))
        .intersect(
          mask((_x, _y, z) => 0.02 * s - z, [-0.2 * s, py - 0.1 * s, 0], [0.2 * s, py + 0.1 * s, 0.3 * s]),
        );
      parts.push(pocket);
    }
    if (top !== 'hoodie') {
      // ribbed collar band
      const collar = sdf
        .torus(D.neckR + 0.012 * s, 0.009 * s, [0, 0, 0])
        .rotate([-12, 0, 0])
        .translate([0, y.neck - 0.006 * s, -0.012 * s]);
      parts.push(collar);
    }
    let shape = sdf.smoothUnionAll(parts, 0.012 * s);
    // colors: worn fabric, faded where it rubs, darker bands and seams, a little dirt near the hem
    const faded = mixColor(base, [0.78, 0.78, 0.76], 0.18 + 0.2 * wear);
    const dark = shade(base, 0.82);
    shape = shape.colorBy(([x, yy, z]) => {
      const [t] = armCoord(x, yy, z);
      const onArm = Math.abs(x) > D.shoulderHalf * 0.9 && t > 0.05 * s;
      let c: RGB = [...base];
      const n = noise.fbm(x * 9, yy * 9, z * 9, 3);
      const fine = noise.noise3(x * 90, yy * 90, z * 90);
      let fade = 0.35 + 0.5 * n;
      if (onArm) fade += 0.5 * Math.exp(-(((t - U) / (0.06 * s)) ** 2)) * (z < 0 ? 1 : 0.4);
      else fade += 0.35 * smoothstep(y.chest - 0.05 * s, y.chest + 0.1 * s, yy) * (z > 0 ? 1 : 0.6);
      c = mixColor(c, faded, clamp(fade * (0.22 + 0.33 * wear), 0, 0.7));
      // ribbed bands (cuffs, hem, collar)
      const band =
        (onArm && top !== 'tshirt' && t > U + F - cuffLen - 0.008 * s) ||
        (!onArm && top !== 'tshirt' && yy < hemY + 0.06 * s) ||
        (top !== 'hoodie' && yy > y.neck - 0.02 * s && !onArm);
      if (band)
        c = mixColor(c, dark, 0.45 + 0.15 * Math.sin(onArm ? Math.atan2(z, yy) * 40 : Math.atan2(x, z) * 60));
      // shoulder seam
      if (!onArm && Math.abs(Math.abs(x) - D.shoulderHalf * 0.92) < 0.004 * s && yy > y.chest)
        c = shade(c, 0.85);
      // hoodie pocket seam and drawstring holes
      if (top === 'hoodie' && !onArm && z > 0) {
        const py = y.waist - 0.035 * s;
        const edge = Math.abs(Math.max(Math.abs(x) - 0.105 * s, Math.abs(yy - py) - 0.055 * s));
        if (edge < 0.0035 * s) c = shade(c, 0.8);
      }
      // dirt / grime toward the hem and cuffs
      const grime =
        wear *
        0.25 *
        (smoothstep(hemY + 0.15 * s, hemY, yy) + (onArm ? smoothstep(U + F * 0.6, U + F, t) : 0));
      c = mixColor(c, [0.3, 0.27, 0.23], clamp(grime * (0.6 + 0.4 * n), 0, 0.35));
      return shade(c, 0.97 + 0.06 * fine);
    });
    garments.push({
      name: top,
      shape,
      material: { name: top, color: '#ffffff', roughness: 0.93 },
      triangles: top === 'tshirt' ? 3600 : 5200,
    });
    if (top === 'hoodie') {
      // drawstrings: thin separate cords
      const cords: Sdf[] = [];
      for (const sd of [1, -1]) {
        const x0 = sd * 0.04 * s;
        const z0 = D.chestD + 0.035 * s;
        cords.push(
          sdf.chain(
            [
              [x0, y.neck - 0.035 * s, z0 - 0.01 * s],
              [x0 * 1.1, y.neck - 0.11 * s, z0 + 0.012 * s],
              [x0 * 1.2, y.neck - 0.19 * s, z0 + 0.018 * s],
            ],
            [0.0042 * s, 0.004 * s, 0.0045 * s],
          ),
        );
      }
      garments.push({
        name: 'drawstrings',
        shape: sdf.unionAll(cords).color(mixColor(base, [0.85, 0.84, 0.8], 0.35)),
        material: { name: 'cord', color: '#ffffff', roughness: 0.85 },
        triangles: 600,
        cell: 0.0022 * s,
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
    const base = hexToRgb(o.bottomColor);
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
    const pelvis = proxy
      .round((o.top === 'tshirt' ? 0.012 : 0.008) * s)
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
        f += 0.22 * whisk * Math.max(0, Math.sin((yy - Math.abs(lx) * 0.5) * 420));
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
    });
    if (bottom === 'shorts') {
      legTop = hemY + 0.04 * s;
      legBottom = shoes === 'barefoot' ? 0 : shoeTop + (shoes === 'sneakers' ? 0.035 : 0.0) * s - 0.015 * s;
    }
    if (o.top === 'hoodie' || bottom === 'jeans') {
      // a leather belt (mostly under the hoodie; Milch tucks the knife into it)
      const belt = proxy
        .round(0.011 * s)
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
        cell: 0.004 * s,
      });
    }
  }

  // ------------------------------------------------------------------ shoes
  if (shoes !== 'barefoot') {
    const base = hexToRgb(o.shoeColor);
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
      cell: 0.0045 * s,
    });
  }

  if (o.top === 'hoodie' || o.top === 'sweater') neckCut = y.neck - 0.05 * s;
  return { garments, neckCut, armCut, legTop, legBottom, barefoot: shoes === 'barefoot' };
}
