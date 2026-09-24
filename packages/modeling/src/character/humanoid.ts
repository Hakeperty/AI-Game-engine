/**
 * humanoid(): realistic, skinned, animated human characters.
 *
 * Builds an anatomical body and head from signed distance fields at the proportions of the requested
 * height/age/sex/build, dresses it in layered garments and sculpted hair, meshes only the visible skin (face,
 * hands, bare limbs) at high resolution, computes automatic skin weights for every part, and attaches the AIGE
 * humanoid skeleton plus the built-in clip library as glTF animations. Output follows the skeleton convention
 * in @aige/core (faces +Z, feet on y = 0, bind A-pose with arms 40 degrees down, identity bind rotations).
 */
import { HUMANOID_ARM_ANGLE } from '@aige/core';
import { hexToRgb, mixColor, type RGB, smoothstep, type V3 } from '../math.ts';
import { Model } from '../model.ts';
import { Noise } from '../noise.ts';
import type { PolyMesh } from '../polymesh.ts';
import { defineModel, p } from '../recipe.ts';
import { Sdf } from '../sdf.ts';
import type { SdfMeshOptions } from '../sdf-mesh.ts';
import { validateMesh } from '../validate.ts';
import { type Age, type Anatomy, computeAnatomy, type HeadShape, type Sex } from './anatomy.ts';
import { builtinAnimations, builtinClipAliases } from './animation.ts';
import { bodySdfs, fingerChains, handToModel, thumbChain } from './body.ts';
import { type BottomKind, type ClothingSet, dressUp, type ShoesKind, type TopKind } from './clothing.ts';
import { type HairStyle, hairSdf } from './hair.ts';
import {
  childFaceWarp,
  eyeballs,
  faceColor,
  faceLayout,
  type HeadOptions,
  headFrame,
  headSdf,
} from './head.ts';
import { computeSkin, type WeightBone } from './skinning.ts';

export type HumanoidPreset = 'young_man' | 'boy' | 'woman' | 'none';

export interface HumanoidOptions {
  /** Start from a ready-made character; any other option overrides the preset. */
  preset?: HumanoidPreset;
  /** Height in meters (crown to floor). */
  height?: number;
  age?: Age;
  sex?: Sex;
  /** 0 = very slim .. 1 = heavy. */
  build?: number;
  /** 0 = soft .. 1 = athletic. */
  muscle?: number;
  headShape?: HeadShape;
  /** Skin tone (sRGB hex). */
  skin?: string;
  /** Iris color. */
  eyes?: string;
  hair?: HairStyle;
  hairColor?: string;
  top?: TopKind;
  topColor?: string;
  bottom?: BottomKind;
  bottomColor?: string;
  shoes?: ShoesKind;
  shoeColor?: string;
  /** 0 = new clothes .. 1 = worn, faded and dirty. */
  wear?: number;
  /** Facial stubble shadow 0..1 (adult/teen males). */
  stubble?: number;
  /** Built-in clips to include as animations: 'all' (default), 'none' or a list of names. */
  clips?: 'all' | 'none' | string[];
  /** Garments get meter-scale UVs and neutral vertex tints for scanned fabric textures (game materials). */
  textured?: boolean;
  /** Mesh detail. 'medium' is ~20-28k triangles. */
  detail?: 'low' | 'medium' | 'high';
  seed?: number;
}

type Resolved = Required<Omit<HumanoidOptions, 'preset'>>;

const BASE: Resolved = {
  height: 1.75,
  age: 'adult',
  sex: 'male',
  build: 0.45,
  muscle: 0.4,
  headShape: 'oval',
  skin: '#c49680',
  eyes: '#5b4632',
  hair: 'short',
  hairColor: '#2e241d',
  top: 'tshirt',
  topColor: '#5d6b78',
  bottom: 'jeans',
  bottomColor: '#2e3647',
  shoes: 'sneakers',
  shoeColor: '#b9b5ac',
  wear: 0.3,
  stubble: 0,
  clips: 'all',
  textured: false,
  detail: 'medium',
  seed: 1,
};

/** Ready-made characters; any other option overrides them. */
export const HUMANOID_PRESETS: Record<Exclude<HumanoidPreset, 'none'>, Partial<Resolved>> = {
  // 18, slim, messy dark hair, worn grey hoodie, dark jeans, boots
  young_man: {
    height: 1.78,
    age: 'teen',
    sex: 'male',
    build: 0.22,
    muscle: 0.35,
    headShape: 'oval',
    skin: '#c99d86',
    eyes: '#56636b',
    hair: 'messy',
    hairColor: '#221b17',
    top: 'hoodie',
    topColor: '#7a7c7e',
    bottom: 'jeans',
    bottomColor: '#2a3140',
    shoes: 'boots',
    shoeColor: '#4a3627',
    wear: 0.65,
    stubble: 0.18,
  },
  // about 10, t-shirt, shorts, sneakers
  boy: {
    height: 1.4,
    age: 'child',
    sex: 'male',
    build: 0.4,
    muscle: 0.25,
    headShape: 'round',
    skin: '#cfa288',
    eyes: '#5e4430',
    hair: 'short',
    hairColor: '#4d3625',
    top: 'tshirt',
    topColor: '#56697a',
    bottom: 'shorts',
    bottomColor: '#6c6754',
    shoes: 'sneakers',
    shoeColor: '#bdb8ad',
    wear: 0.3,
    stubble: 0,
  },
  // an adult woman (sweater, trousers)
  woman: {
    height: 1.7,
    age: 'adult',
    sex: 'female',
    build: 0.42,
    muscle: 0.3,
    headShape: 'oval',
    skin: '#c79a81',
    eyes: '#4d5a47',
    hair: 'shoulder',
    hairColor: '#3a2b21',
    top: 'sweater',
    topColor: '#7b6757',
    bottom: 'trousers',
    bottomColor: '#3b3c41',
    shoes: 'shoes',
    shoeColor: '#30271f',
    wear: 0.35,
    stubble: 0,
  },
};

export function resolveHumanoidOptions(o: HumanoidOptions = {}): Resolved {
  const preset = o.preset && o.preset !== 'none' ? HUMANOID_PRESETS[o.preset] : {};
  const out = { ...BASE, ...preset } as Resolved;
  for (const [k, v] of Object.entries(o)) if (k !== 'preset' && v !== undefined) (out as any)[k] = v;
  return out;
}

const DETAIL = {
  low: { head: 0.0028, hand: 0.0032, limb: 0.006, cloth: 0.012, hair: 0.005, tri: 0.55 },
  medium: { head: 0.0015, hand: 0.0022, limb: 0.0045, cloth: 0.0085, hair: 0.0034, tri: 1 },
  high: { head: 0.0014, hand: 0.0016, limb: 0.0032, cloth: 0.0062, hair: 0.0025, tri: 1.8 },
};

/**
 * Restricts an SDF to a region given as a signed function (negative inside) with explicit bounds. The region is
 * also closed a little inside its bounds so the mesh never touches the grid edge (stays watertight).
 */
function region(shape: Sdf, inside: (x: number, y: number, z: number) => number, min: V3, max: V3): Sdf {
  const e = 0.004;
  const mask = new Sdf(
    (x, y, z) =>
      Math.max(
        inside(x, y, z),
        min[0] + e - x,
        x - max[0] + e,
        min[1] + e - y,
        y - max[1] + e,
        min[2] + e - z,
        z - max[2] + e,
      ),
    { min, max },
  );
  return shape.intersect(mask);
}

const resFor = (s: Sdf, cell: number) => {
  const b = s.bounds;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  return Math.max(24, Math.min(240, Math.round(size / cell)));
};

/** Weight segments and radii for the AIGE humanoid skeleton of an anatomy. */
export function humanoidWeightBones(an: Anatomy): WeightBone[] {
  const { j, s, dims: D, hh } = an;
  const idx = new Map(an.joints.map((jt, i) => [jt.name, i]));
  const out: WeightBone[] = [];
  const bone = (name: string, segs: [V3, V3][], radius: number, side: -1 | 0 | 1 = 0, explicit = false) => {
    const index = idx.get(name);
    if (index !== undefined) out.push({ name, index, segs, radius, side, ...(explicit ? { explicit } : {}) });
  };
  const k = D.handScale;
  const g = s * an.w;
  bone(
    'hips',
    [
      [j.hips, j.spine],
      [j.thigh_l, j.thigh_r],
    ],
    D.pelvisW * 0.78,
  );
  bone('spine', [[j.spine, j.chest]], D.waistW * 0.86);
  bone('chest', [[j.chest, [0, j.neck[1] - 0.03 * s, j.neck[2]]]], D.chestW * 0.86);
  bone('neck', [[j.neck, j.head]], D.neckR * 0.95);
  bone('head', [[j.head, [0, j.head[1] + 0.62 * hh, j.head[2] + 0.02 * s]]], 0.075 * (hh / 0.232));
  bone('jaw', [[j.jaw, [0, an.y.chin, 0.07 * s]]], 0.03 * s, 0, true);
  for (const side of [1, -1] as const) {
    const t = side > 0 ? 'l' : 'r';
    const J = (n: string) => j[`${n}_${t}` as keyof typeof j];
    bone(`shoulder_${t}`, [[J('shoulder'), J('upperarm')]], 0.048 * g);
    bone(`upperarm_${t}`, [[J('upperarm'), J('forearm')]], D.upperArmR);
    bone(`forearm_${t}`, [[J('forearm'), J('hand')]], D.forearmR * 0.92);
    const fingers = fingerChains(k);
    bone(
      `hand_${t}`,
      [
        [J('hand'), J('fingers')],
        ...fingers.map((f) => [J('hand'), handToModel(an, side, f.pts[0]!)] as [V3, V3]),
      ],
      0.02 * k,
    );
    bone(
      `fingers_${t}`,
      fingers.map((f) => [handToModel(an, side, f.pts[0]!), handToModel(an, side, f.pts[1]!)] as [V3, V3]),
      0.0105 * k,
    );
    bone(
      `fingertips_${t}`,
      fingers.map((f) => [handToModel(an, side, f.pts[1]!), handToModel(an, side, f.pts[3]!)] as [V3, V3]),
      0.0095 * k,
    );
    const th = thumbChain(k).pts.map((p) => handToModel(an, side, p));
    bone(
      `thumb_${t}`,
      [
        [th[0]!, th[1]!],
        [th[1]!, th[3]!],
      ],
      0.012 * k,
    );
    bone(`thigh_${t}`, [[J('thigh'), J('shin')]], D.thighR * 0.9, side);
    bone(`shin_${t}`, [[J('shin'), J('foot')]], D.calfR * 0.95, side);
    const foot = J('foot');
    const toe = J('toe');
    const heel: V3 = [foot[0], 0.03 * s, -0.045 * s];
    bone(
      `foot_${t}`,
      [
        [foot, toe],
        [foot, heel],
      ],
      0.034 * s,
      side,
    );
    bone(`toe_${t}`, [[toe, [toe[0], 0.018 * s, an.len.foot * 0.78]]], 0.022 * s, side);
  }
  return out;
}

/** Builds a skinned, animated, dressed human character. See HumanoidOptions and HUMANOID_PRESETS. */
export function humanoid(options: HumanoidOptions = {}): Model {
  const o = resolveHumanoidOptions(options);
  const an = computeAnatomy({
    height: o.height,
    age: o.age,
    sex: o.sex,
    build: o.build,
    muscle: o.muscle,
    headShape: o.headShape,
  });
  const q = DETAIL[o.detail] ?? DETAIL.medium;
  const s = an.s;
  const hopts: HeadOptions = { shape: o.headShape, maturity: an.maturity, fem: an.fem };
  const frame = headFrame(an);
  const L = faceLayout(hopts);
  const fw = childFaceWarp(an.maturity, L.eyeL[1]);
  // world -> head design space (undoing the child face warp so colors and weights line up with features)
  const toHead = (p: V3): V3 =>
    fw.unwarp([
      (p[0] - frame.origin[0]) / frame.scale,
      (p[1] - frame.origin[1]) / frame.scale,
      (p[2] - frame.origin[2]) / frame.scale,
    ]);
  const skinRgb = hexToRgb(o.skin);
  const hairRgb = hexToRgb(o.hairColor);
  const browRgb: RGB = mixColor(hairRgb, [0.12, 0.09, 0.07], 0.25);
  const lipsRgb: RGB = mixColor(skinRgb, [0.62, 0.34, 0.33], 0.42);
  const face = faceColor(L, hopts, {
    skin: skinRgb,
    brow: browRgb,
    lips: lipsRgb,
    stubble: an.fem < 0.5 && an.maturity > 0.5 ? o.stubble : 0,
  });
  const noise = new Noise(o.seed + 17);

  const head = fw.warp(headSdf(hopts, L)).scale(frame.scale).translate(frame.origin);
  const { body, cloth } = bodySdfs(an);
  const fc: RGB = [1, 1, 1];
  const skinSdf = body.smoothUnion(head, 0.009 * s).colorBy((p) => {
    const hp = toHead(p);
    // subtle mottling
    const n = 1 + 0.035 * noise.fbm(p[0] * 18, p[1] * 18, p[2] * 18, 2);
    let c: RGB = [skinRgb[0] * n, skinRgb[1] * n, skinRgb[2] * n];
    if (hp[1] > -0.06) {
      face(hp, fc);
      const t = smoothstep(-0.06, -0.02, hp[1]);
      c = [c[0] + (fc[0] * n - c[0]) * t, c[1] + (fc[1] * n - c[1]) * t, c[2] + (fc[2] * n - c[2]) * t];
      // the mouth line reads as an opening when the jaw drops
      // the mouth slit reads as the dark inside of the mouth when the jaw drops
      if (
        Math.abs(hp[1] - L.mouthY) < (hp[2] < L.lipZ - 0.002 ? 0.0022 : 0.0008) &&
        hp[2] > L.lipZ - 0.014 &&
        Math.abs(hp[0]) < 0.018
      )
        c = [c[0] * 0.55, c[1] * 0.42, c[2] * 0.42];
    }
    return c;
  });

  // --- garments decide which skin is visible
  const clothes: ClothingSet = dressUp(an, cloth, o, { toHead, L });

  const model = new Model();
  model.skeleton = {
    joints: an.joints.map((j) => ({ name: j.name, parent: j.parent, position: [...j.position] as V3 })),
  };
  const bones = humanoidWeightBones(an);
  const skinMat = { name: 'skin', color: '#ffffff', roughness: 0.52, metalness: 0 };
  const jawOverride = (p: V3): [string, number][] | null => {
    const hp = toHead(p);
    if (hp[1] > L.mouthY + 0.004 || hp[1] < -0.05) return null;
    const below = smoothstep(L.mouthY + 0.0015, L.mouthY - 0.004, hp[1]);
    const front = smoothstep(-0.028, 0.012, hp[2]);
    const neckFade = smoothstep(-0.045, -0.004, hp[1]);
    const w = below * front * neckFade * (Math.abs(hp[0]) > 0.062 ? 0.6 : 1);
    return w > 0.01 ? [['jaw', w]] : null;
  };

  // head + neck
  const neckCut = clothes.neckCut;
  const headRegion = region(
    skinSdf,
    (_x, y) => neckCut - y,
    [-0.14 * s, neckCut - 0.01, -0.16 * s],
    [0.14 * s, an.H + 0.02, 0.17 * s],
  );
  const headMesh = meshSolid(headRegion, {
    resolution: resFor(headRegion, q.head),
    ao: { strength: 0.5, radius: 0.01 * s },
    smooth: 1,
  }).material(skinMat);
  model.add(decimated(headMesh, 8500 * q.tri), 'skin_head');
  // arms (from the sleeve end to the fingertips)
  const armMeshes: PolyMesh[] = [];
  for (const side of [1, -1] as const) {
    const t0 = clothes.armCut;
    const d: V3 = [an.armDir[0] * side, an.armDir[1], 0];
    const sh: V3 = [an.j.upperarm_l[0] * side, an.j.upperarm_l[1], an.j.upperarm_l[2]];
    const reach = an.len.upperArm + an.len.forearm + an.len.hand + 0.03 * s;
    const a: V3 = [sh[0] + d[0] * t0, sh[1] + d[1] * t0, sh[2]];
    const b: V3 = [sh[0] + d[0] * reach, sh[1] + d[1] * reach, sh[2]];
    const m = 0.075 * s;
    const armRegion = region(
      skinSdf,
      (x, y, z) => t0 - ((x - sh[0]) * d[0] + (y - sh[1]) * d[1] + (z - sh[2]) * d[2]),
      [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, -m],
      [Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, m + 0.02 * s],
    );
    const bare = t0 < an.len.upperArm + an.len.forearm * 0.5;
    const mesh = meshSolid(armRegion, {
      resolution: resFor(armRegion, bare ? q.limb * 0.7 : q.hand),
      ao: { strength: 0.6, radius: 0.01 * s },
      smooth: 1,
    }).material(skinMat);
    armMeshes.push(decimated(mesh, (bare ? 2800 : 1800) * q.tri));
  }
  model.add(armMeshes[0]!.merge(armMeshes[1]!), 'skin_arms');
  // bare legs (shorts)
  if (clothes.legTop > clothes.legBottom + 0.02) {
    const legRegion = region(
      skinSdf,
      (_x, y) => Math.max(y - clothes.legTop, clothes.legBottom - y),
      [-0.25 * s, clothes.legBottom - 0.01, -0.14 * s],
      [0.25 * s, clothes.legTop + 0.01, 0.14 * s],
    );
    const legs = meshSolid(legRegion, {
      resolution: resFor(legRegion, q.limb),
      ao: { strength: 0.5 },
      smooth: 1,
    }).material(skinMat);
    model.add(decimated(legs, 3000 * q.tri), 'skin_legs');
  }
  // eyes
  model.add(
    eyeballs(L, hexToRgb(o.eyes), frame.scale, frame.origin).material({
      name: 'eyes',
      color: '#ffffff',
      roughness: 0.08,
    }),
    'eyes',
  );
  // hair
  if (o.hair !== 'none') {
    const hair = hairSdf(o.hair, L, hopts, hairRgb, o.seed).scale(frame.scale).translate(frame.origin);
    const hm = meshSolid(hair, {
      resolution: resFor(hair, q.hair),
      ao: { strength: 0.9, radius: 0.012 * s },
      smooth: 2,
    });
    model.add(
      decimated(hm, 4800 * q.tri).material({ name: 'hair', color: '#ffffff', roughness: 0.72 }),
      'hair',
    );
  }
  // garments
  for (const g of clothes.garments) {
    // cap anything that reaches the shape's bounds so every garment stays watertight
    const shape = region(g.shape, () => -1, g.shape.bounds.min, g.shape.bounds.max);
    const res = resFor(shape, g.cell ?? q.cloth);
    const mesh = meshSolid(shape, { resolution: res, ao: { strength: 0.75, radius: 0.03 * s }, smooth: 2 });
    const dm = decimated(mesh, g.triangles * q.tri);
    model.add((g.uv ? dm.uvBox(1) : dm).material(g.material), g.name);
  }

  // skin weights
  for (const part of model.parts) {
    if (part.name === 'eyes') part.skin = computeSkin(part.mesh, bones, { rigid: 'head' });
    else if (part.name === 'hair')
      part.skin = computeSkin(part.mesh, bones, { only: ['head', 'neck', 'chest'] });
    else if (part.name === 'skin_head') part.skin = computeSkin(part.mesh, bones, { override: jawOverride });
    else part.skin = computeSkin(part.mesh, bones);
  }

  // sockets follow bones
  const k = an.dims.handScale;
  for (const side of [1, -1] as const) {
    const t = side > 0 ? 'l' : 'r';
    const palm = handToModel(an, side, [0.075 * k, -0.02 * k, 0.005 * k]);
    model.socket(`hand_${t}`, palm, [0, 0, side * -HUMANOID_ARM_ANGLE], `hand_${t}`);
  }
  model.socket('head', [0, an.H + 0.01, 0], [0, 0, 0], 'head');
  model.socket(
    'eyes',
    [0, frame.origin[1] + L.eyeL[1] * frame.scale, frame.origin[2] + (L.eyeL[2] + 0.02) * frame.scale],
    [0, 0, 0],
    'head',
  );
  model.socket('belt', [0.05 * s, an.y.hipJoint + 0.07 * s, an.dims.pelvisD + 0.012 * s], [0, 0, 0], 'hips');
  model.socket('back', [0, an.y.chest + 0.05 * s, -an.dims.chestD - 0.05 * s], [0, 0, 0], 'chest');
  model.setCollider({
    shape: 'capsule',
    radius: 0.2 * s * Math.max(0.85, an.w),
    height: an.H,
    offset: [0, an.H / 2, 0],
  });
  // organic surfaces: smooth normals everywhere (decimated faces meet at steeper angles than 40 degrees)
  model.smoothAngle = 85;
  model.animations = builtinAnimations(model.skeleton, o.clips);
  if (model.animations.length) model.clipAliases = builtinClipAliases();
  return model;
}

/** Meshes an SDF; if a rare surface-nets hole appears, retries on slightly different grids. */
function meshSolid(shape: Sdf, opts: SdfMeshOptions & { resolution: number }): PolyMesh {
  let m = shape.mesh(opts);
  for (const k of [0.86, 0.73]) {
    if (validateMesh(m).watertight) break;
    m = shape.mesh({ ...opts, resolution: Math.round(opts.resolution * k) });
  }
  return m;
}

function decimated(mesh: PolyMesh, target: number): PolyMesh {
  const t = Math.round(target);
  return mesh.triangleCount > t * 1.05 ? mesh.decimate(t) : mesh;
}

const HAIR_STYLES = ['messy', 'short', 'buzz', 'shoulder', 'bun', 'none'] as const;
const TOPS = ['hoodie', 'tshirt', 'sweater'] as const;
const BOTTOMS = ['jeans', 'shorts', 'trousers'] as const;
const SHOES = ['boots', 'sneakers', 'shoes', 'barefoot'] as const;

/**
 * A model recipe for a humanoid whose parameter defaults are a preset's values (templates: human, young_man,
 * boy, woman). Every parameter maps 1:1 to HumanoidOptions.
 */
export function humanoidRecipe(preset: HumanoidPreset = 'none') {
  const d = resolveHumanoidOptions({ preset });
  const who =
    preset === 'young_man'
      ? 'Young man (18, slim, messy dark hair, worn grey hoodie, dark jeans, boots)'
      : preset === 'boy'
        ? 'Boy (about 10, t-shirt, shorts, sneakers)'
        : preset === 'woman'
          ? 'Woman (adult, sweater, trousers)'
          : 'a realistic human';
  return defineModel({
    name: preset === 'none' ? 'human' : preset,
    description: `Skinned, animated character: ${who}. Faces +Z, feet on y = 0, AIGE humanoid skeleton (hips, spine, chest, neck, head, jaw, arms, fingers, legs, toes) and the built-in clips as animations. Sockets: hand_r, hand_l, head, eyes, belt, back.`,
    params: {
      height: p.number(d.height, { min: 0.9, max: 2.2, description: 'Standing height (m)' }),
      age: p.choice(['adult', 'teen', 'child'], d.age),
      sex: p.choice(['male', 'female'], d.sex),
      build: p.number(d.build, { min: 0, max: 1, description: '0 slim .. 1 heavy' }),
      muscle: p.number(d.muscle, { min: 0, max: 1 }),
      headShape: p.choice(['oval', 'round', 'long', 'square'], d.headShape),
      skin: p.color(d.skin),
      eyes: p.color(d.eyes),
      hair: p.choice(HAIR_STYLES, d.hair),
      hairColor: p.color(d.hairColor),
      top: p.choice(TOPS, d.top),
      topColor: p.color(d.topColor),
      bottom: p.choice(BOTTOMS, d.bottom),
      bottomColor: p.color(d.bottomColor),
      shoes: p.choice(SHOES, d.shoes),
      shoeColor: p.color(d.shoeColor),
      wear: p.number(d.wear, { min: 0, max: 1, description: 'Clothes: 0 new .. 1 worn and dirty' }),
      stubble: p.number(d.stubble, { min: 0, max: 1 }),
      clips: p.choice(['all', 'none'], 'all', { description: 'Include the built-in clips as animations' }),
      textured: p.boolean(d.textured, {
        description: 'Garment UVs + neutral tints for scanned fabric materials',
      }),
      detail: p.choice(['low', 'medium', 'high'], d.detail),
    },
    build(v) {
      return humanoid({
        ...v,
        age: v.age as Age,
        sex: v.sex as Sex,
        headShape: v.headShape as HeadShape,
        hair: v.hair as HairStyle,
        top: v.top as TopKind,
        bottom: v.bottom as BottomKind,
        shoes: v.shoes as ShoesKind,
        clips: v.clips as 'all' | 'none',
        detail: v.detail as 'low' | 'medium' | 'high',
        seed: v.seed,
      });
    },
  });
}
