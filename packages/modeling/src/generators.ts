/**
 * Organic generators: terrain heightfields and plants (seeded branching, tubes, leaves, trees).
 * Everything is deterministic for a given seed.
 */
import {
  add,
  type ColorInput,
  clamp,
  cross,
  lerp1,
  mixColor,
  mul,
  normalize,
  type RGB,
  Random,
  rotateAxis,
  smoothstep,
  sub,
  toRgb,
  type V2,
  type V3,
} from './math.ts';
import { Noise } from './noise.ts';
import { curves, sweep } from './ops/sweep.ts';
import { type Face, PolyMesh } from './polymesh.ts';
import { icosphere, sphere } from './primitives.ts';
import { sdf } from './sdf.ts';

// ---------------------------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------------------------

export interface TerrainNoise {
  /** Hills across the terrain (default 2.5). */
  scale?: number;
  octaves?: number;
  seed?: number;
  /** 0..1 blend toward ridged mountains (default 0.3). */
  ridged?: number;
  /** Domain warp 0..1 for twisty, natural valleys (default 0.3). */
  warp?: number;
  /** > 1 flattens lowlands and sharpens peaks (default 1.5). */
  exponent?: number;
}

export interface TerrainPalette {
  sand?: ColorInput;
  grass?: ColorInput;
  /** Second grass tone mixed in with noise. */
  grass2?: ColorInput;
  rock?: ColorInput;
  snow?: ColorInput;
  /** Side walls of a slab. */
  dirt?: ColorInput;
  /** Snow starts at this fraction of the height (default 0.8; > 1 = no snow). */
  snowLine?: number;
  /** Slopes steeper than this (degrees) turn to rock (default 38). */
  rockSlope?: number;
}

export interface TerrainOptions {
  /** Size in meters: number or [x, z] (default 20). */
  size?: number | V2;
  /** Grid segments on the longest side, or [x, z] (default 96). */
  resolution?: number | V2;
  /** Height amplitude in meters (default 3), or an explicit height function (x, z) => y. */
  height?: number | ((x: number, z: number) => number);
  noise?: TerrainNoise;
  /** Shortcut for noise.seed. */
  seed?: number;
  /**
   * Island: land in the middle falls off below sea level (y = 0) at the edges. true or the radius (0..1) where
   * the falloff starts (default 0.5).
   */
  island?: boolean | number;
  /** Sea level for beach colors (default 0 for islands, none otherwise). */
  seaLevel?: number;
  /** Closed solid with side walls and a flat bottom; number = depth below the lowest point (default 1). */
  slab?: boolean | number;
  /** Vertex colors by height and slope: true (default), false, or a palette. */
  colors?: boolean | TerrainPalette;
  /** Texture repeats per meter for the planar UVs (default 0.25). */
  uvScale?: number;
}

const DEFAULT_PALETTE = {
  sand: '#d9c48f',
  grass: '#5d9a3c',
  grass2: '#7fae48',
  rock: '#7d7468',
  snow: '#f2f4f7',
  dirt: '#6b5138',
  snowLine: 0.8,
  rockSlope: 38,
};

/**
 * The height function a terrain() with the same options uses: (x, z) => y. Handy for placing trees and rocks on
 * the surface: const h = terrainHeight(opts); tree.translate([x, h(x, z), z]).
 */
export function terrainHeight(opts: TerrainOptions = {}): (x: number, z: number) => number {
  const [sx, sz] = typeof opts.size === 'number' || opts.size === undefined ? [opts.size ?? 20, opts.size ?? 20] : opts.size;
  if (typeof opts.height === 'function') return opts.height;
  const H = opts.height ?? 3;
  const no = opts.noise ?? {};
  const seed = no.seed ?? opts.seed ?? 1;
  const noise = new Noise(seed);
  const scale = no.scale ?? 2.5;
  const octaves = no.octaves ?? 5;
  const ridged = clamp(no.ridged ?? 0.3, 0, 1);
  const warp = no.warp ?? 0.3;
  const exponent = no.exponent ?? 1.5;
  const island = opts.island === true ? 0.5 : typeof opts.island === 'number' ? clamp(opts.island, 0, 0.95) : null;
  const L = Math.max(sx, sz);
  return (x, z) => {
    let u = (x / L) * scale;
    let v = (z / L) * scale;
    if (warp) {
      const wu = noise.fbm(u * 0.8 + 11.3, 3.7, v * 0.8, 3);
      const wv = noise.fbm(u * 0.8, 17.9, v * 0.8 + 5.1, 3);
      u += wu * warp * 1.5;
      v += wv * warp * 1.5;
    }
    let t = clamp(0.5 + noise.fbm(u, 0.37, v, octaves) * 0.9, 0, 1);
    if (ridged > 0) t = lerp1(t, clamp(noise.ridged(u * 0.7 + 3.1, 1.3, v * 0.7, octaves) * 1.2, 0, 1), ridged);
    t = t ** exponent;
    if (island === null) return H * t;
    const r = Math.hypot(x / (sx / 2), z / (sz / 2));
    const mask = 1 - smoothstep(island, 1, r + noise.fbm(x * 0.15, 9.1, z * 0.15, 2) * 0.15);
    return H * (0.18 + 0.82 * t) * mask - H * 0.25 * (1 - mask);
  };
}

/**
 * Heightfield terrain usable as a game level: seeded noise hills (or your own height function), optional island
 * falloff, vertex colors by height and slope (sand, grass, rock, snow) and planar UVs.
 * Open surface by default (group 'top'); slab: true makes a closed solid with 'side' and 'bottom' faces.
 * Centered on x/z = 0; y = height. Example: terrain({ size: 40, height: 6, island: true, seed: 3 })
 */
export function terrain(opts: TerrainOptions = {}): PolyMesh {
  const [sx, sz] = typeof opts.size === 'number' || opts.size === undefined ? [opts.size ?? 20, opts.size ?? 20] : opts.size;
  let nx: number;
  let nz: number;
  if (Array.isArray(opts.resolution)) [nx, nz] = opts.resolution;
  else {
    const r = opts.resolution ?? 96;
    nx = sx >= sz ? r : Math.max(2, Math.round((r * sx) / sz));
    nz = sz >= sx ? r : Math.max(2, Math.round((r * sz) / sx));
  }
  nx = Math.max(1, Math.min(512, Math.round(nx)));
  nz = Math.max(1, Math.min(512, Math.round(nz)));
  const hf = terrainHeight(opts);
  const H = typeof opts.height === 'number' ? opts.height : 3;
  const uvScale = opts.uvScale ?? 0.25;
  const m = new PolyMesh();
  const idx = (i: number, k: number) => i + (nx + 1) * k;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k <= nz; k++)
    for (let i = 0; i <= nx; i++) {
      const x = -sx / 2 + (sx * i) / nx;
      const z = -sz / 2 + (sz * k) / nz;
      const y = hf(x, z);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      m.p.push([x, y, z]);
    }
  // vertex normals from central differences
  const dxs = sx / nx;
  const dzs = sz / nz;
  const slopeCos = new Float64Array((nx + 1) * (nz + 1));
  for (let k = 0; k <= nz; k++)
    for (let i = 0; i <= nx; i++) {
      const hl = m.p[idx(Math.max(0, i - 1), k)]![1];
      const hr = m.p[idx(Math.min(nx, i + 1), k)]![1];
      const hd = m.p[idx(i, Math.max(0, k - 1))]![1];
      const hu = m.p[idx(i, Math.min(nz, k + 1))]![1];
      const gx = (hr - hl) / (dxs * (i > 0 && i < nx ? 2 : 1));
      const gz = (hu - hd) / (dzs * (k > 0 && k < nz ? 2 : 1));
      slopeCos[idx(i, k)] = 1 / Math.hypot(gx, 1, gz);
    }
  const palette = opts.colors === false ? null : { ...DEFAULT_PALETTE, ...(typeof opts.colors === 'object' ? opts.colors : {}) };
  const sea = opts.seaLevel ?? (opts.island ? 0 : undefined);
  const range = typeof opts.height === 'number' || opts.height === undefined ? H : Math.max(1e-6, maxY - minY);
  const base = typeof opts.height === 'function' ? minY : 0;
  const noise = new Noise((opts.noise?.seed ?? opts.seed ?? 1) + 101);
  let vcol: RGB[] | null = null;
  if (palette) {
    const sand = toRgb(palette.sand);
    const grass = toRgb(palette.grass);
    const grass2 = toRgb(palette.grass2);
    const rock = toRgb(palette.rock);
    const snow = toRgb(palette.snow);
    const rockCos = Math.cos((palette.rockSlope * Math.PI) / 180);
    vcol = m.p.map((p, vi) => {
      const [x, y, z] = p;
      const n = noise.fbm(x * 0.35, 0.5, z * 0.35, 3);
      const h = (y - base) / range + n * 0.04;
      let c: RGB = mixColor(grass, grass2, smoothstep(-0.2, 0.3, noise.fbm(x * 0.12, 4.2, z * 0.12, 3)));
      if (sea !== undefined) {
        const above = y - sea + n * range * 0.02;
        c = mixColor(sand, c, smoothstep(range * 0.03, range * 0.07, above));
        if (above < 0) c = mixColor(c, [c[0] * 0.75, c[1] * 0.78, c[2] * 0.8], smoothstep(0, -range * 0.1, above));
      }
      const sc = slopeCos[vi]!;
      const rockT = Math.max(smoothstep(rockCos + 0.06, rockCos - 0.06, sc), smoothstep(palette.snowLine - 0.25, palette.snowLine - 0.1, h) * 0.8);
      c = mixColor(c, mixColor(rock, [rock[0] * 0.8, rock[1] * 0.8, rock[2] * 0.8], clamp(0.5 + n * 2, 0, 1)), rockT);
      const snowT = smoothstep(palette.snowLine - 0.03, palette.snowLine + 0.03, h) * smoothstep(rockCos - 0.15, rockCos + 0.1, sc);
      c = mixColor(c, snow, snowT);
      return c;
    });
  }
  const uvOf = (v: number): V2 => [m.p[v]![0] * uvScale, m.p[v]![2] * uvScale];
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      const v = [idx(i, k), idx(i, k + 1), idx(i + 1, k + 1), idx(i + 1, k)];
      m.f.push({ v, uv: v.map(uvOf), c: vcol ? v.map((q) => vcol![q]!) : null, g: 'top', m: 0, sm: true });
    }
  if (!opts.slab) return m;
  const depth = typeof opts.slab === 'number' ? opts.slab : Math.max(1, H * 0.3);
  const bottomY = minY - depth;
  const dirt = toRgb(palette?.dirt ?? DEFAULT_PALETTE.dirt);
  const dark: RGB = [dirt[0] * 0.6, dirt[1] * 0.6, dirt[2] * 0.6];
  // border loop, counter-clockwise seen from above (+y): -z edge, +x edge, +z edge, -x edge
  const loop: number[] = [];
  for (let i = 0; i < nx; i++) loop.push(idx(i, 0));
  for (let k = 0; k < nz; k++) loop.push(idx(nx, k));
  for (let i = nx; i > 0; i--) loop.push(idx(i, nz));
  for (let k = nz; k > 0; k--) loop.push(idx(0, k));
  const bottom = loop.map((v) => m.p.push([m.p[v]![0], bottomY, m.p[v]![2]]) - 1);
  let u = 0;
  for (let q = 0; q < loop.length; q++) {
    const a = loop[q]!;
    const b = loop[(q + 1) % loop.length]!;
    const ba = bottom[q]!;
    const bb = bottom[(q + 1) % loop.length]!;
    const el = Math.hypot(m.p[b]![0] - m.p[a]![0], m.p[b]![2] - m.p[a]![2]);
    const topCol = (v: number): RGB => (vcol ? mixColor(vcol[v]!, dirt, 0.6) : dirt);
    const face: Face = {
      v: [a, b, bb, ba],
      uv: [
        [u * uvScale, m.p[a]![1] * uvScale],
        [(u + el) * uvScale, m.p[b]![1] * uvScale],
        [(u + el) * uvScale, bottomY * uvScale],
        [u * uvScale, bottomY * uvScale],
      ],
      c: palette ? [topCol(a), topCol(b), dark, dark] : null,
      g: 'side',
      m: 0,
      sm: false,
    };
    m.f.push(face);
    u += el;
  }
  const bot = [...bottom];
  m.f.push({ v: bot, uv: bot.map(uvOf), c: palette ? bot.map(() => dark) : null, g: 'bottom', m: 0, sm: false });
  // outward winding: bottom faces down, walls face away from the center
  if (m.faceNormal(m.f.length - 1)[1] > 0) reverseFace(m.f[m.f.length - 1]!);
  for (const f of m.f) {
    if (f.g !== 'side') continue;
    const i = m.f.indexOf(f);
    const c = m.faceCenter(i);
    if (dot2(m.faceNormal(i), c) < 0) reverseFace(f);
  }
  return m;
}

const dot2 = (n: V3, c: V3) => n[0] * c[0] + n[2] * c[2];

function reverseFace(f: Face) {
  f.v.reverse();
  f.uv?.reverse();
  f.c?.reverse();
}

// ---------------------------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------------------------

/** One branch: a path of points with a radius per point. depth 0 = trunk. */
export interface Branch {
  path: V3[];
  radius: number[];
  depth: number;
  /** true when this branch has no children (where leaves go). */
  tip: boolean;
}

export interface BranchOptions {
  seed?: number;
  /** Branching depth: 0 = trunk only (default 3). */
  levels?: number;
  /** Trunk length in meters (default 2). */
  length?: number;
  /** Trunk base radius (default 6% of the length). */
  radius?: number;
  /** Children per branch: count or [min, max] (default [2, 4]). */
  children?: number | V2;
  /** Angle between a child and its parent in degrees (default 35). */
  angle?: number;
  /** Child length relative to its parent (default 0.65). */
  lengthRatio?: number;
  /** Child base radius relative to the parent radius where it attaches (default 0.7). */
  radiusRatio?: number;
  /** Tip radius relative to the base radius of each branch (default 0.45). */
  taper?: number;
  /** 0..1 random bending along each branch (default 0.3). */
  gnarl?: number;
  /** -1..1 tendency to grow up (default 0.25); negative droops like a willow. */
  upward?: number;
  /** Where children attach along the parent, as fractions (default [0.35, 1]). */
  spread?: V2;
  /** Path points per branch (default 6). */
  segments?: number;
  start?: V3;
  direction?: V3;
}

/**
 * L-system-lite branching: grows a seeded tree skeleton of curvy branches. Feed it to plants.branchMesh() for wood
 * and use the tips (branch.tip) for leaves. Example: plants.branches({ levels: 3, length: 2.5, seed })
 */
function branches(opts: BranchOptions = {}): Branch[] {
  const rng = new Random(opts.seed ?? 1);
  const levels = Math.max(0, Math.min(6, Math.round(opts.levels ?? 3)));
  const length = opts.length ?? 2;
  const r0 = opts.radius ?? length * 0.06;
  const [cmin, cmax] = typeof opts.children === 'number' ? [opts.children, opts.children] : (opts.children ?? [2, 4]);
  const angle = ((opts.angle ?? 35) * Math.PI) / 180;
  const lengthRatio = opts.lengthRatio ?? 0.65;
  const radiusRatio = opts.radiusRatio ?? 0.7;
  const taper = opts.taper ?? 0.45;
  const gnarl = opts.gnarl ?? 0.3;
  const upward = opts.upward ?? 0.25;
  const [s0, s1] = opts.spread ?? [0.35, 1];
  const segs = Math.max(2, Math.round(opts.segments ?? 6));
  const out: Branch[] = [];
  const rand3 = (): V3 => rng.direction();
  const grow = (start: V3, dir0: V3, len: number, rad: number, depth: number) => {
    const path: V3[] = [start];
    const radius: number[] = [rad];
    let d = normalize(dir0);
    let p = start;
    const step = len / segs;
    for (let s = 1; s <= segs; s++) {
      const wob = rand3();
      d = normalize(add(add(d, mul(wob, gnarl * 0.45)), [0, upward * 0.25, 0]));
      p = add(p, mul(d, step));
      path.push(p);
      radius.push(rad * lerp1(1, taper, s / segs));
    }
    const branch: Branch = { path, radius, depth, tip: depth >= levels };
    out.push(branch);
    if (depth >= levels) return;
    const count = rng.int(Math.round(cmin), Math.round(cmax));
    const phase = rng.range(0, Math.PI * 2);
    for (let c = 0; c < count; c++) {
      const t = lerp1(s0, s1, count === 1 ? 1 : (c + rng.range(0.2, 0.8)) / count);
      const f = t * segs;
      const i = Math.min(segs - 1, Math.floor(f));
      const fr = f - i;
      const at = add(path[i]!, mul(sub(path[i + 1]!, path[i]!), fr));
      const tan = normalize(sub(path[i + 1]!, path[i]!));
      const pr = lerp1(radius[i]!, radius[i + 1]!, fr);
      // perpendicular axis rotated around the tangent by a golden-angle spiral
      const ref: V3 = Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const perp = rotateAxis(normalize(cross(tan, ref)), tan, phase + c * 2.39996 + rng.range(-0.3, 0.3));
      const a = angle * rng.range(0.75, 1.25);
      const dir = normalize(add(mul(tan, Math.cos(a)), mul(perp, Math.sin(a))));
      const childLen = len * lengthRatio * rng.range(0.8, 1.15) * (t === 1 ? 1 : lerp1(1.1, 0.8, t));
      grow(at, dir, childLen, Math.min(pr * 0.95, pr * radiusRatio * 1.2), depth + 1);
    }
  };
  grow(opts.start ?? [0, 0, 0], opts.direction ?? [0, 1, 0], length, r0, 0);
  return out;
}

/**
 * Wood mesh for branches: smooth tapered tubes along each path (closed ends). sides = tube segments for the
 * trunk (thinner branches get fewer). Group 'bark', cylindrical-ish UVs.
 */
function branchMesh(list: Branch[], opts: { sides?: number; minSides?: number; smoothness?: number } = {}): PolyMesh {
  const sides = Math.max(3, Math.round(opts.sides ?? 10));
  const minSides = Math.max(3, Math.round(opts.minSides ?? 5));
  const spp = Math.max(1, Math.round(opts.smoothness ?? 3));
  const parts: PolyMesh[] = [];
  for (const b of list) {
    const n = Math.max(minSides, sides - 2 * b.depth);
    const path = curves.catmullRom(b.path, spp);
    const r0 = b.radius[0]!;
    const rs = b.radius;
    const scale = (t: number) => {
      const f = t * (rs.length - 1);
      const i = Math.min(rs.length - 2, Math.floor(f));
      return lerp1(rs[i]!, rs[i + 1]!, f - i) / r0;
    };
    const ring: V2[] = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [Math.cos(a) * r0, Math.sin(a) * r0];
    });
    parts.push(sweep(ring, path, { scale }).group('bark'));
  }
  return PolyMesh.merge(...parts);
}

export interface LeafOptions {
  /** Leaf length along +Z (default 0.3). */
  length?: number;
  /** Max width (default 40% of the length). */
  width?: number;
  /** Downward curl along the length in meters at the tip (default 15% of the length). */
  curl?: number;
  /** V-fold along the mid rib (default 10% of the width). */
  fold?: number;
  /** Blade thickness at the rib (default 1.5% of the length). */
  thickness?: number;
  /** 'leaf' (pointed), 'round' (petal), 'blade' (grass/long leaf). */
  shape?: 'leaf' | 'round' | 'blade';
  /** Segments along / across (default [8, 4]). */
  segments?: V2;
}

/**
 * A single leaf or petal as a thin closed solid, stem at the origin, growing along +Z, top facing +Y.
 * Orient copies with rotate/translate or plants.leaves().
 */
function leaf(opts: LeafOptions = {}): PolyMesh {
  const L = opts.length ?? 0.3;
  const W = opts.width ?? L * 0.4;
  const curl = opts.curl ?? L * 0.15;
  const fold = opts.fold ?? W * 0.1;
  const thick = opts.thickness ?? L * 0.015;
  const shape = opts.shape ?? 'leaf';
  const [na, nc] = opts.segments ?? [8, 4];
  const rows = Math.max(3, Math.round(na));
  const cols = Math.max(1, Math.round(nc));
  const widthAt = (t: number) => {
    if (shape === 'round') return W * Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)))) * (t < 0.15 ? t / 0.15 : 1) * 0.5;
    if (shape === 'blade') return W * 0.5 * (1 - t ** 3) * Math.min(1, t * 8);
    return W * 0.5 * Math.sin(Math.PI * t) ** 0.75 * (1 - 0.25 * t);
  };
  const m = new PolyMesh();
  const base = m.p.push([0, 0, 0]) - 1;
  const tip = m.p.push([0, -curl, L]) - 1;
  const top: number[][] = [];
  const bot: number[][] = [];
  for (let i = 1; i < rows; i++) {
    const t = i / rows;
    const w = widthAt(t);
    const yc = -curl * t * t;
    const z = L * t;
    const rowT: number[] = [];
    const rowB: number[] = [];
    for (let j = -cols; j <= cols; j++) {
      const u = j / cols;
      const x = u * w;
      const y = yc + fold * Math.abs(u) - fold * 0.5 * u * u;
      const th = thick * (1 - u * u) * Math.sin(Math.PI * t);
      const vt = m.p.push([x, y + th / 2, z]) - 1;
      rowT.push(vt);
      rowB.push(Math.abs(j) === cols ? vt : m.p.push([x, y - th / 2, z]) - 1);
    }
    top.push(rowT);
    bot.push(rowB);
  }
  const face = (v: number[], g: string): Face => ({ v, uv: null, c: null, g, m: 0, sm: true });
  const w2 = 2 * cols;
  for (let j = 0; j < w2; j++) {
    m.f.push(face([base, top[0]![j + 1]!, top[0]![j]!], 'leaf'));
    m.f.push(face([base, bot[0]![j]!, bot[0]![j + 1]!], 'leaf'));
    const lt = top[top.length - 1]!;
    const lb = bot[bot.length - 1]!;
    m.f.push(face([tip, lt[j]!, lt[j + 1]!], 'leaf'));
    m.f.push(face([tip, lb[j + 1]!, lb[j]!], 'leaf'));
  }
  for (let i = 0; i + 1 < top.length; i++)
    for (let j = 0; j < w2; j++) {
      m.f.push(face([top[i]![j]!, top[i]![j + 1]!, top[i + 1]![j + 1]!, top[i + 1]![j]!], 'leaf'));
      m.f.push(face([bot[i]![j]!, bot[i + 1]![j]!, bot[i + 1]![j + 1]!, bot[i]![j + 1]!], 'leaf'));
    }
  // outward orientation check (top faces up)
  const ti = m.f.findIndex((f) => f.v.length === 4);
  if (ti >= 0 && m.faceNormal(ti)[1] < 0) return m.flip();
  return m;
}

/**
 * Scatters copies of a leaf mesh around points: each copy points away from its center with random roll and
 * size. Example: plants.leaves(tips, plants.leaf({ length: 0.25 }), { count: 6, seed })
 */
function leaves(
  points: V3[],
  leafMesh: PolyMesh,
  opts: { count?: number; spread?: number; size?: V2; seed?: number; droop?: number; outward?: V3[] } = {},
): PolyMesh {
  const rng = new Random(opts.seed ?? 1);
  const count = Math.max(1, Math.round(opts.count ?? 6));
  const spread = opts.spread ?? 0.15;
  const [smin, smax] = opts.size ?? [0.8, 1.2];
  const droop = opts.droop ?? 0.3;
  const parts: PolyMesh[] = [];
  points.forEach((pt, pi) => {
    for (let c = 0; c < count; c++) {
      let dir = rng.direction();
      const out = opts.outward?.[pi];
      if (out) dir = normalize(add(dir, mul(normalize(out), 1.2)));
      dir = normalize(add(dir, [0, -droop, 0]));
      const yaw = (Math.atan2(dir[0], dir[2]) * 180) / Math.PI;
      const pitch = (-Math.asin(clamp(dir[1], -1, 1)) * 180) / Math.PI;
      const s = rng.range(smin, smax);
      const off = mul(rng.direction(), spread * rng.next());
      parts.push(
        leafMesh
          .scale(s)
          .rotate([0, 0, rng.range(-40, 40)])
          .rotate([pitch, 0, 0])
          .rotate([0, yaw, 0])
          .translate(add(pt, off)),
      );
    }
  });
  return PolyMesh.merge(...parts);
}

export interface TreeOptions extends BranchOptions {
  /** Canopy style: 'cloud' (smooth SDF blobs), 'blobs' (low-poly clumps), 'leaves' (individual leaves), 'none'. */
  foliage?: 'cloud' | 'blobs' | 'leaves' | 'none';
  /** Size of a leaf clump (or leaf length for 'leaves'); default 22% of the trunk length. */
  leafSize?: number;
  leafColor?: ColorInput;
  /** Second leaf tone for noise variation. */
  leafColor2?: ColorInput;
  barkColor?: ColorInput;
  /** Leaves per tip for 'leaves' (default 8). */
  leafCount?: number;
  /** Tube sides of the trunk (default 10). */
  sides?: number;
}

/**
 * Complete seeded tree: curvy branching wood plus foliage at the branch tips.
 * Returns { wood, leaves } meshes (vertex colored) ready for model({ ... }).
 * Example: const { wood, leaves } = plants.tree({ length: 2, levels: 3, foliage: 'cloud', seed })
 */
function tree(opts: TreeOptions = {}): { wood: PolyMesh; leaves: PolyMesh } {
  const list = branches(opts);
  const length = opts.length ?? 2;
  const bark = toRgb(opts.barkColor ?? '#6b4a2f');
  const barkDark: RGB = [bark[0] * 0.7, bark[1] * 0.7, bark[2] * 0.7];
  const wood = branchMesh(list, { sides: opts.sides ?? 10 }).gradient('y', barkDark, bark);
  const leafColor = toRgb(opts.leafColor ?? '#4f9d3a');
  const leafColor2 = toRgb(opts.leafColor2 ?? mixColor(leafColor, '#c8d44a', 0.35));
  const size = opts.leafSize ?? length * 0.22;
  const foliage = opts.foliage ?? 'cloud';
  const tips = list.filter((b) => b.tip).map((b) => b.path[b.path.length - 1]!);
  const tipDirs = list.filter((b) => b.tip).map((b) => normalize(sub(b.path[b.path.length - 1]!, b.path[b.path.length - 2]!)));
  const rng = new Random((opts.seed ?? 1) + 7);
  let leavesMesh = new PolyMesh();
  if (foliage === 'cloud' && tips.length) {
    // soft leaf clumps at the tips, smooth-unioned, with a scalloped "leafy" surface
    const dark: RGB = [leafColor[0] * 0.5, leafColor[1] * 0.58, leafColor[2] * 0.5];
    const lo = Math.min(...tips.map((t) => t[1]));
    const hi = Math.max(...tips.map((t) => t[1]));
    const cells = new Noise((opts.seed ?? 1) + 5);
    const f = 3.2 / size;
    const clumps = tips.map((t, i) => sdf.sphere(size * rng.range(0.7, 1.05), add(t, mul(tipDirs[i]!, size * 0.3))));
    const canopy = sdf
      .smoothUnionAll(clumps, size * 0.35)
      .displaceBy(([x, y, z]) => size * 0.13 * (0.55 - cells.worley(x * f, y * f, z * f)), size * 0.1, 1.5)
      .warp(size * 0.08, 1.5 / size, opts.seed ?? 1)
      .colorByNoise([leafColor, leafColor2], 1.2 / size, (opts.seed ?? 1) + 3, 2.5)
      .colorBy(([x, y, z], base) => {
        const bump = 0.55 - cells.worley(x * f, y * f, z * f);
        const shade = mixColor(dark, base, smoothstep(lo - size, hi + size * 0.5, y));
        return mixColor(shade, leafColor2, Math.max(0, bump) * 0.45);
      });
    const detail = Math.round(clamp(52 + tips.length * 0.5, 52, 76));
    leavesMesh = canopy.mesh({ resolution: detail, ao: 0.7, decimate: Math.min(14000, 3000 + tips.length * 400) });
  } else if (foliage === 'blobs' && tips.length) {
    const parts = tips.map((t, i) =>
      icosphere({ radius: size * rng.range(0.75, 1.1), detail: 1 })
        .scale([1, rng.range(0.7, 0.9), 1])
        .displace({ amount: size * 0.18, scale: 1.8 / size, seed: rng.int(1, 9999) })
        .translate(add(t, mul(tipDirs[i]!, size * 0.3))),
    );
    const merged = PolyMesh.merge(...parts);
    const bb = merged.bounds();
    leavesMesh = merged.colorBy((p) => mixColor(mixColor(leafColor, [leafColor[0] * 0.55, leafColor[1] * 0.6, leafColor[2] * 0.55], 0.5), leafColor2, smoothstep(bb.min[1], bb.max[1], p[1])));
  } else if (foliage === 'leaves' && tips.length) {
    const lm = leaf({ length: size * 0.6, segments: tips.length > 30 ? [4, 1] : [6, 2] });
    const tint = new Noise((opts.seed ?? 1) + 3);
    leavesMesh = leaves(tips, lm, {
      count: opts.leafCount ?? Math.round(clamp(240 / tips.length, 3, 10)),
      spread: size * 0.35,
      seed: (opts.seed ?? 1) + 11,
      outward: tipDirs,
    }).colorBy((p) => mixColor(leafColor, leafColor2, clamp(0.5 + tint.fbm(p[0] * 3, p[1] * 3, p[2] * 3, 2) * 2, 0, 1)));
  }
  return { wood, leaves: leavesMesh };
}

// ---------------------------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------------------------

export interface EyeOptions {
  /** Eyeball radius in meters (default 0.1). */
  radius?: number;
  sclera?: ColorInput;
  iris?: ColorInput;
  pupil?: ColorInput;
  /** Iris radius relative to the eyeball (default 0.62; 0 = no iris, just a pupil). */
  irisSize?: number;
  /** Pupil radius relative to the eyeball (default 0.36). */
  pupilSize?: number;
  /** Small white catch-light that makes eyes look alive (default true). */
  highlight?: boolean;
  /** Tube segments of the eyeball (default 20). */
  segments?: number;
}

/**
 * A crisp cartoon eye (eyeball + iris + pupil + catch-light) as one vertex-colored mesh, centered at the origin
 * and looking along +Z. Place it with rotate/translate; push it slightly into the head so it sits in a socket.
 * Example: eye({ radius: 0.08, iris: '#3b7dd8' }).translate([0.12, 1.1, 0.4])
 */
export function eye(opts: EyeOptions = {}): PolyMesh {
  const r = opts.radius ?? 0.1;
  const seg = Math.max(8, Math.round(opts.segments ?? 20));
  const ball = sphere({ radius: r, segments: seg, rings: Math.round(seg * 0.65) }).color(opts.sclera ?? '#ffffff');
  const parts: PolyMesh[] = [ball];
  const irisR = r * (opts.irisSize ?? 0.62);
  const pupilR = r * (opts.pupilSize ?? 0.36);
  // flattened discs that hug the front of the eyeball
  const disc = (radius: number, depth: number, color: ColorInput, z: number) =>
    sphere({ radius: 1, segments: Math.max(10, Math.round(seg * 0.7)), rings: Math.max(6, Math.round(seg * 0.4)) })
      .scale([radius, radius, depth])
      .translate([0, 0, z])
      .color(color);
  if (irisR > 0) {
    const zi = Math.sqrt(Math.max(0, r * r - irisR * irisR));
    parts.push(disc(irisR, r * 0.2, opts.iris ?? '#5b3a1e', zi + r * 0.04));
  }
  const zp = Math.sqrt(Math.max(0, r * r - pupilR * pupilR));
  parts.push(disc(pupilR, r * 0.2, opts.pupil ?? '#141414', zp + r * 0.09));
  if (opts.highlight !== false) {
    const hr = r * 0.16;
    const dir = normalize([-0.35, 0.45, 0.82]);
    parts.push(
      sphere({ radius: hr, segments: 10, rings: 6 })
        .scale([1, 1, 0.5])
        .translate(mul(dir, r * 1.02))
        .color('#ffffff'),
    );
  }
  return PolyMesh.merge(...parts).group('eye');
}

/** Plant helpers: seeded branching skeletons, wood tubes, leaves and whole trees. */
export const plants = { branches, branchMesh, leaf, leaves, tree };
