/**
 * Organic mesh operations: volume-preserving smoothing, relaxation, sculpt brushes, baked ambient occlusion,
 * manifold repair and decimation (meshoptimizer).
 */
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { clamp, type RGB, type V2, type V3 } from '../math.ts';
import { Noise } from '../noise.ts';
import type { Face, FaceSelector, PolyMesh } from '../polymesh.ts';
import { vertexNormals } from './topology.ts';

// ---------------------------------------------------------------------------------------------
// Decimator (meshoptimizer WASM)
// ---------------------------------------------------------------------------------------------

let meshoptReady = false;
const meshoptLoading: Promise<void> = MeshoptSimplifier.ready.then(
  () => {
    meshoptReady = true;
  },
  () => {
    meshoptReady = false;
  },
);

/** Loads the mesh simplifier (called by initModeling()). */
export function initDecimator(): Promise<void> {
  return meshoptLoading;
}

export function decimatorReady(): boolean {
  return meshoptReady;
}

// ---------------------------------------------------------------------------------------------
// Shared topology helpers
// ---------------------------------------------------------------------------------------------

/**
 * Vertex topology with seams welded: vertices at the same position share one "canonical" index, so smoothing
 * never tears meshes whose faces carry duplicated corner vertices.
 */
interface Topo {
  /** canonical index for every mesh vertex */
  canon: Int32Array;
  /** canonical vertex count */
  n: number;
  /** representative mesh vertex of each canonical vertex */
  rep: Int32Array;
  /** neighbour lists (canonical) */
  nbr: number[][];
  /** canonical vertices on an open boundary */
  boundary: Uint8Array;
  closed: boolean;
}

function topology(mesh: PolyMesh, weld = true): Topo {
  const count = mesh.p.length;
  const canon = new Int32Array(count);
  const repList: number[] = [];
  if (weld) {
    const map = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const p = mesh.p[i]!;
      const key = `${p[0]},${p[1]},${p[2]}`;
      let c = map.get(key);
      if (c === undefined) {
        c = repList.length;
        repList.push(i);
        map.set(key, c);
      }
      canon[i] = c;
    }
  } else {
    for (let i = 0; i < count; i++) {
      canon[i] = i;
      repList.push(i);
    }
  }
  const n = repList.length;
  const nbr: number[][] = Array.from({ length: n }, () => []);
  const edgeCount = new Map<number, number>();
  for (const f of mesh.f) {
    const k = f.v.length;
    for (let i = 0; i < k; i++) {
      const a = canon[f.v[i]!]!;
      const b = canon[f.v[(i + 1) % k]!]!;
      if (a === b) continue;
      const key = a < b ? a * n + b : b * n + a;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      const la = nbr[a]!;
      if (!la.includes(b)) la.push(b);
      const lb = nbr[b]!;
      if (!lb.includes(a)) lb.push(a);
    }
  }
  const boundary = new Uint8Array(n);
  let closed = mesh.f.length > 0;
  for (const [key, c] of edgeCount) {
    if (c === 1) {
      closed = false;
      boundary[Math.floor(key / n)] = 1;
      boundary[key % n] = 1;
    }
  }
  return { canon, n, rep: Int32Array.from(repList), nbr, boundary, closed };
}

function canonPositions(mesh: PolyMesh, t: Topo): Float64Array {
  const pos = new Float64Array(t.n * 3);
  for (let c = 0; c < t.n; c++) {
    const p = mesh.p[t.rep[c]!]!;
    pos[c * 3] = p[0];
    pos[c * 3 + 1] = p[1];
    pos[c * 3 + 2] = p[2];
  }
  return pos;
}

function writeBack(mesh: PolyMesh, t: Topo, pos: Float64Array): PolyMesh {
  const m = mesh.clone();
  for (let i = 0; i < m.p.length; i++) {
    const c = t.canon[i]!;
    m.p[i] = [pos[c * 3]!, pos[c * 3 + 1]!, pos[c * 3 + 2]!];
  }
  return m;
}

/** Area-weighted normals per canonical vertex. */
function canonNormals(mesh: PolyMesh, t: Topo, pos: Float64Array): Float64Array {
  const nrm = new Float64Array(t.n * 3);
  for (const f of mesh.f) {
    const k = f.v.length;
    // Newell normal (area weighted)
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < k; i++) {
      const a = t.canon[f.v[i]!]! * 3;
      const b = t.canon[f.v[(i + 1) % k]!]! * 3;
      nx += (pos[a + 1]! - pos[b + 1]!) * (pos[a + 2]! + pos[b + 2]!);
      ny += (pos[a + 2]! - pos[b + 2]!) * (pos[a]! + pos[b]!);
      nz += (pos[a]! - pos[b]!) * (pos[a + 1]! + pos[b + 1]!);
    }
    for (let i = 0; i < k; i++) {
      const c = t.canon[f.v[i]!]! * 3;
      nrm[c] = nrm[c]! + nx;
      nrm[c + 1] = nrm[c + 1]! + ny;
      nrm[c + 2] = nrm[c + 2]! + nz;
    }
  }
  for (let c = 0; c < t.n; c++) {
    const l = Math.hypot(nrm[c * 3]!, nrm[c * 3 + 1]!, nrm[c * 3 + 2]!) || 1;
    nrm[c * 3] = nrm[c * 3]! / l;
    nrm[c * 3 + 1] = nrm[c * 3 + 1]! / l;
    nrm[c * 3 + 2] = nrm[c * 3 + 2]! / l;
  }
  return nrm;
}

function volumeOf(mesh: PolyMesh, t: Topo, pos: Float64Array): number {
  let vol = 0;
  for (const f of mesh.f) {
    const a = t.canon[f.v[0]!]! * 3;
    for (let k = 1; k + 1 < f.v.length; k++) {
      const b = t.canon[f.v[k]!]! * 3;
      const c = t.canon[f.v[k + 1]!]! * 3;
      vol +=
        (pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[b + 2]! * pos[c + 1]!) +
          pos[a + 1]! * (pos[b + 2]! * pos[c]! - pos[b]! * pos[c + 2]!) +
          pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[b + 1]! * pos[c]!)) /
        6;
    }
  }
  return vol;
}

function areaOf(mesh: PolyMesh, t: Topo, pos: Float64Array): number {
  let area = 0;
  for (const f of mesh.f) {
    const a = t.canon[f.v[0]!]! * 3;
    for (let k = 1; k + 1 < f.v.length; k++) {
      const b = t.canon[f.v[k]!]! * 3;
      const c = t.canon[f.v[k + 1]!]! * 3;
      const ux = pos[b]! - pos[a]!;
      const uy = pos[b + 1]! - pos[a + 1]!;
      const uz = pos[b + 2]! - pos[a + 2]!;
      const vx = pos[c]! - pos[a]!;
      const vy = pos[c + 1]! - pos[a + 1]!;
      const vz = pos[c + 2]! - pos[a + 2]!;
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
  }
  return area;
}

/** Per-canonical-vertex weight in [0, 1] from a face selector (1 = fully affected). */
function selectionWeights(mesh: PolyMesh, t: Topo, sel?: FaceSelector): Float64Array {
  const w = new Float64Array(t.n);
  if (!sel || sel === 'all') {
    w.fill(1);
    return w;
  }
  for (const i of mesh.select(sel)) for (const v of mesh.f[i]!.v) w[t.canon[v]!] = 1;
  return w;
}

function laplacianStep(t: Topo, pos: Float64Array, factor: number, weights: Float64Array, fixBoundary: boolean) {
  const next = new Float64Array(pos);
  for (let c = 0; c < t.n; c++) {
    const w = weights[c]!;
    if (w <= 0 || (fixBoundary && t.boundary[c])) continue;
    const nb = t.nbr[c]!;
    if (nb.length === 0) continue;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (const o of nb) {
      ax += pos[o * 3]!;
      ay += pos[o * 3 + 1]!;
      az += pos[o * 3 + 2]!;
    }
    const inv = 1 / nb.length;
    const s = factor * w;
    next[c * 3] = pos[c * 3]! + (ax * inv - pos[c * 3]!) * s;
    next[c * 3 + 1] = pos[c * 3 + 1]! + (ay * inv - pos[c * 3 + 1]!) * s;
    next[c * 3 + 2] = pos[c * 3 + 2]! + (az * inv - pos[c * 3 + 2]!) * s;
  }
  pos.set(next);
}

/** Moves every vertex along its normal so a closed mesh gets back to `target` volume. */
function restoreVolume(mesh: PolyMesh, t: Topo, pos: Float64Array, target: number, weights: Float64Array) {
  for (let it = 0; it < 3; it++) {
    const vol = volumeOf(mesh, t, pos);
    const area = areaOf(mesh, t, pos);
    if (area <= 0) return;
    const delta = (target - vol) / area;
    if (Math.abs(delta) < 1e-9) return;
    const nrm = canonNormals(mesh, t, pos);
    for (let c = 0; c < t.n; c++) {
      if (weights[c]! <= 0) continue;
      pos[c * 3] = pos[c * 3]! + nrm[c * 3]! * delta;
      pos[c * 3 + 1] = pos[c * 3 + 1]! + nrm[c * 3 + 1]! * delta;
      pos[c * 3 + 2] = pos[c * 3 + 2]! + nrm[c * 3 + 2]! * delta;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------------------------

export interface SmoothOptions {
  /** Taubin iterations (default 3). */
  iterations?: number;
  /** Smoothing factor per pass (default 0.5). */
  lambda?: number;
  /** Inflation factor per pass (default -0.53); Taubin's anti-shrink step. */
  mu?: number;
  /** Keep closed meshes at their original volume (default true). */
  preserveVolume?: boolean;
  /** Keep open boundary edges in place (default true). */
  preserveBoundary?: boolean;
  /** Only smooth the selected faces. */
  sel?: FaceSelector;
}

/**
 * Taubin smoothing: removes bumps and faceting without shrinking. Closed meshes keep their volume.
 * Example: sdf.sphere(0.5).displace(0.05).mesh().smoothMesh({ iterations: 5 })
 */
export function smoothMesh(mesh: PolyMesh, opts: SmoothOptions = {}): PolyMesh {
  if (mesh.f.length === 0) return mesh.clone();
  const t = topology(mesh);
  const pos = canonPositions(mesh, t);
  const weights = selectionWeights(mesh, t, opts.sel);
  const fix = opts.preserveBoundary !== false;
  const lambda = opts.lambda ?? 0.5;
  const mu = opts.mu ?? -0.53;
  const v0 = t.closed ? volumeOf(mesh, t, pos) : 0;
  const iterations = Math.max(0, Math.round(opts.iterations ?? 3));
  for (let i = 0; i < iterations; i++) {
    laplacianStep(t, pos, lambda, weights, fix);
    laplacianStep(t, pos, mu, weights, fix);
  }
  if (t.closed && opts.preserveVolume !== false && Math.abs(v0) > 1e-12) restoreVolume(mesh, t, pos, v0, weights);
  return writeBack(mesh, t, pos);
}

/**
 * Evens out vertex spacing by sliding vertices along the surface (tangential smoothing). The shape barely changes.
 * Good after sculpting or on stretched areas.
 */
export function relax(mesh: PolyMesh, opts: { iterations?: number; strength?: number; sel?: FaceSelector } = {}): PolyMesh {
  if (mesh.f.length === 0) return mesh.clone();
  const t = topology(mesh);
  const pos = canonPositions(mesh, t);
  const weights = selectionWeights(mesh, t, opts.sel);
  relaxPositions(mesh, t, pos, Math.round(opts.iterations ?? 3), opts.strength ?? 0.5, weights);
  return writeBack(mesh, t, pos);
}

function relaxPositions(
  mesh: PolyMesh,
  t: Topo,
  pos: Float64Array,
  iterations: number,
  strength: number,
  weights: Float64Array,
) {
  for (let it = 0; it < iterations; it++) {
    const nrm = canonNormals(mesh, t, pos);
    const next = new Float64Array(pos);
    for (let c = 0; c < t.n; c++) {
      const w = weights[c]! * strength;
      if (w <= 0 || t.boundary[c]) continue;
      const nb = t.nbr[c]!;
      if (nb.length === 0) continue;
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const o of nb) {
        ax += pos[o * 3]!;
        ay += pos[o * 3 + 1]!;
        az += pos[o * 3 + 2]!;
      }
      const inv = 1 / nb.length;
      let dx = ax * inv - pos[c * 3]!;
      let dy = ay * inv - pos[c * 3 + 1]!;
      let dz = az * inv - pos[c * 3 + 2]!;
      const nx = nrm[c * 3]!;
      const ny = nrm[c * 3 + 1]!;
      const nz = nrm[c * 3 + 2]!;
      const d = dx * nx + dy * ny + dz * nz;
      dx -= nx * d;
      dy -= ny * d;
      dz -= nz * d;
      next[c * 3] = pos[c * 3]! + dx * w;
      next[c * 3 + 1] = pos[c * 3 + 1]! + dy * w;
      next[c * 3 + 2] = pos[c * 3 + 2]! + dz * w;
    }
    pos.set(next);
  }
}

// ---------------------------------------------------------------------------------------------
// Sculpt brushes
// ---------------------------------------------------------------------------------------------

export type BrushMode = 'inflate' | 'grab' | 'pinch' | 'flatten' | 'smooth' | 'noise';

export interface BrushOptions {
  /** Brush center in model space. */
  center: V3;
  /** Brush radius in meters: vertices farther away are untouched. */
  radius: number;
  /**
   * inflate / noise: offset in meters at the center (negative inflate = deflate).
   * pinch / flatten / smooth: 0..1 blend. grab: multiplies `direction` (default 1).
   */
  strength?: number;
  mode?: BrushMode;
  /** grab: movement vector in meters at the brush center (e.g. [0, 0.2, 0] pulls up 20 cm). */
  direction?: V3;
  /** Falloff curve from center to radius (default 'smooth'). */
  falloff?: 'smooth' | 'linear' | 'sharp' | 'constant';
  /** noise mode: noise frequency (default 8 / radius) and seed. */
  scale?: number;
  seed?: number;
}

function falloffFn(kind: BrushOptions['falloff']): (x: number) => number {
  switch (kind) {
    case 'linear':
      return (x) => 1 - x;
    case 'sharp':
      return (x) => (1 - x) ** 3;
    case 'constant':
      return () => 1;
    default:
      return (x) => {
        const q = 1 - x * x;
        return q * q;
      };
  }
}

/**
 * Sculpt brush with smooth falloff, like ZBrush/Blender brushes, applied once at `center`.
 * Example: mesh.brush({ center: [0, 1, 0.4], radius: 0.25, mode: 'inflate', strength: 0.05 })
 *          mesh.brush({ center: [0, 1.4, 0], radius: 0.3, mode: 'grab', direction: [0, 0.2, 0] })
 */
export function brush(mesh: PolyMesh, opts: BrushOptions): PolyMesh {
  if (mesh.f.length === 0) return mesh.clone();
  const t = topology(mesh);
  const pos = canonPositions(mesh, t);
  const r = Math.max(1e-9, opts.radius);
  const [cx, cy, cz] = opts.center;
  const fall = falloffFn(opts.falloff);
  const w = new Float64Array(t.n);
  let any = false;
  for (let c = 0; c < t.n; c++) {
    const d = Math.hypot(pos[c * 3]! - cx, pos[c * 3 + 1]! - cy, pos[c * 3 + 2]! - cz) / r;
    if (d < 1) {
      w[c] = fall(d);
      any = true;
    }
  }
  if (!any) return mesh.clone();
  const mode = opts.mode ?? 'inflate';
  const strength = opts.strength ?? (mode === 'inflate' || mode === 'noise' ? r * 0.2 : mode === 'grab' ? 1 : 0.5);
  if (mode === 'smooth') {
    const weights = new Float64Array(t.n);
    for (let c = 0; c < t.n; c++) weights[c] = w[c]! * clamp(strength, 0, 1);
    for (let i = 0; i < 3; i++) laplacianStep(t, pos, 1, weights, true);
    return writeBack(mesh, t, pos);
  }
  const nrm = canonNormals(mesh, t, pos);
  if (mode === 'inflate' || mode === 'noise') {
    const noise = new Noise(opts.seed ?? 1);
    const s = opts.scale ?? 8 / r;
    for (let c = 0; c < t.n; c++) {
      if (w[c]! <= 0) continue;
      const x = pos[c * 3]!;
      const y = pos[c * 3 + 1]!;
      const z = pos[c * 3 + 2]!;
      const amt = mode === 'noise' ? noise.fbm(x * s, y * s, z * s, 3) * 2 : 1;
      const d = strength * w[c]! * amt;
      pos[c * 3] = x + nrm[c * 3]! * d;
      pos[c * 3 + 1] = y + nrm[c * 3 + 1]! * d;
      pos[c * 3 + 2] = z + nrm[c * 3 + 2]! * d;
    }
  } else if (mode === 'grab') {
    const dir = opts.direction ?? [0, r * 0.3, 0];
    for (let c = 0; c < t.n; c++) {
      const k = w[c]! * strength;
      if (k <= 0) continue;
      pos[c * 3] = pos[c * 3]! + dir[0] * k;
      pos[c * 3 + 1] = pos[c * 3 + 1]! + dir[1] * k;
      pos[c * 3 + 2] = pos[c * 3 + 2]! + dir[2] * k;
    }
  } else if (mode === 'pinch') {
    const s = clamp(strength, -1, 1);
    for (let c = 0; c < t.n; c++) {
      const k = w[c]! * s;
      if (k === 0) continue;
      let dx = cx - pos[c * 3]!;
      let dy = cy - pos[c * 3 + 1]!;
      let dz = cz - pos[c * 3 + 2]!;
      const nx = nrm[c * 3]!;
      const ny = nrm[c * 3 + 1]!;
      const nz = nrm[c * 3 + 2]!;
      const d = dx * nx + dy * ny + dz * nz;
      dx -= nx * d;
      dy -= ny * d;
      dz -= nz * d;
      pos[c * 3] = pos[c * 3]! + dx * k;
      pos[c * 3 + 1] = pos[c * 3 + 1]! + dy * k;
      pos[c * 3 + 2] = pos[c * 3 + 2]! + dz * k;
    }
  } else if (mode === 'flatten') {
    // Plane through the weighted centroid with the weighted average normal.
    let sw = 0;
    const o: V3 = [0, 0, 0];
    const n: V3 = [0, 0, 0];
    for (let c = 0; c < t.n; c++) {
      const k = w[c]!;
      if (k <= 0) continue;
      sw += k;
      for (let a = 0; a < 3; a++) {
        o[a] = o[a]! + pos[c * 3 + a]! * k;
        n[a] = n[a]! + nrm[c * 3 + a]! * k;
      }
    }
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let a = 0; a < 3; a++) {
      o[a] = o[a]! / sw;
      n[a] = n[a]! / nl;
    }
    const s = clamp(strength, 0, 1);
    for (let c = 0; c < t.n; c++) {
      const k = w[c]! * s;
      if (k <= 0) continue;
      const d =
        (pos[c * 3]! - o[0]) * n[0] + (pos[c * 3 + 1]! - o[1]) * n[1] + (pos[c * 3 + 2]! - o[2]) * n[2];
      pos[c * 3] = pos[c * 3]! - n[0] * d * k;
      pos[c * 3 + 1] = pos[c * 3 + 1]! - n[1] * d * k;
      pos[c * 3 + 2] = pos[c * 3 + 2]! - n[2] * d * k;
    }
  }
  return writeBack(mesh, t, pos);
}

// ---------------------------------------------------------------------------------------------
// Ambient occlusion
// ---------------------------------------------------------------------------------------------

export interface AOOptions {
  /** 0..1+ darkening strength (default 1). */
  strength?: number;
  /** Occlusion search radius in meters (default 12% of the mesh size). */
  radius?: number;
  /** Voxel resolution for closed meshes (default 48). */
  resolution?: number;
}

/**
 * Bakes ambient occlusion into vertex colors (multiplies existing colors). Creases, armpits and the undersides of
 * overhangs get darker, which makes vertex-colored organic models read much better. Closed meshes use a voxel
 * occupancy estimate (also catches nearby separate parts); open meshes use local concavity.
 */
export function bakeAO(mesh: PolyMesh, opts: AOOptions = {}): PolyMesh {
  if (mesh.f.length === 0) return mesh.clone();
  const t = topology(mesh);
  const pos = canonPositions(mesh, t);
  const nrm = canonNormals(mesh, t, pos);
  const b = mesh.bounds();
  const size = Math.max(...b.size) || 1;
  const radius = opts.radius ?? size * 0.12;
  const strength = opts.strength ?? 1;
  const ao = t.closed
    ? voxelAO(mesh, t, pos, nrm, radius, Math.round(opts.resolution ?? 48), b.min, b.max)
    : concavityAO(t, pos, nrm, radius);
  return applyVertexShade(mesh, t, ao, strength);
}

/** Multiplies corner colors by a per-canonical-vertex factor (1 = unchanged). */
export function applyVertexShade(mesh: PolyMesh, t: Topo, shade: Float64Array, strength: number): PolyMesh {
  const m = mesh.clone();
  for (const f of m.f) {
    f.c = f.v.map((v, k) => {
      const s = 1 - (1 - shade[t.canon[v]!]!) * strength;
      const base: RGB = f.c?.[k] ?? [1, 1, 1];
      const k2 = clamp(s, 0, 1);
      return [base[0] * k2, base[1] * k2, base[2] * k2];
    });
  }
  return m;
}

function concavityAO(t: Topo, pos: Float64Array, nrm: Float64Array, radius: number): Float64Array {
  const conc = new Float64Array(t.n);
  for (let c = 0; c < t.n; c++) {
    const nb = t.nbr[c]!;
    let s = 0;
    for (const o of nb) {
      const dx = pos[o * 3]! - pos[c * 3]!;
      const dy = pos[o * 3 + 1]! - pos[c * 3 + 1]!;
      const dz = pos[o * 3 + 2]! - pos[c * 3 + 2]!;
      const l = Math.hypot(dx, dy, dz) || 1;
      s += (dx * nrm[c * 3]! + dy * nrm[c * 3 + 1]! + dz * nrm[c * 3 + 2]!) / l;
    }
    conc[c] = nb.length ? s / nb.length : 0;
  }
  // diffuse over the surface a few times so the effect has some width
  const iters = Math.max(1, Math.min(8, Math.round(radius * 20)));
  let cur = conc;
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(t.n);
    for (let c = 0; c < t.n; c++) {
      const nb = t.nbr[c]!;
      let s = cur[c]!;
      for (const o of nb) s += cur[o]!;
      next[c] = s / (nb.length + 1);
    }
    cur = next;
  }
  const out = new Float64Array(t.n);
  for (let c = 0; c < t.n; c++) out[c] = 1 - clamp(cur[c]! * 3, 0, 0.8);
  return out;
}

function voxelAO(
  mesh: PolyMesh,
  t: Topo,
  pos: Float64Array,
  nrm: Float64Array,
  radius: number,
  resolution: number,
  bmin: V3,
  bmax: V3,
): Float64Array {
  const res = Math.max(12, Math.min(128, resolution));
  const pad = radius * 1.2;
  const min: V3 = [bmin[0] - pad, bmin[1] - pad, bmin[2] - pad];
  const size = Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) + 2 * pad;
  const h = size / res;
  const nx = Math.ceil((bmax[0] - bmin[0] + 2 * pad) / h) + 1;
  const ny = Math.ceil((bmax[1] - bmin[1] + 2 * pad) / h) + 1;
  const nz = Math.ceil((bmax[2] - bmin[2] + 2 * pad) / h) + 1;
  const occ = new Float32Array(nx * ny * nz);
  // Triangles bucketed by xz cell for column ray casting along +y.
  const tris: number[] = [];
  for (const f of mesh.f) {
    const a = t.canon[f.v[0]!]!;
    for (let k = 1; k + 1 < f.v.length; k++) tris.push(a, t.canon[f.v[k]!]!, t.canon[f.v[k + 1]!]!);
  }
  const buckets: number[][] = Array.from({ length: nx * nz }, () => []);
  for (let i = 0; i < tris.length; i += 3) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k]! * 3;
      x0 = Math.min(x0, pos[v]!);
      x1 = Math.max(x1, pos[v]!);
      z0 = Math.min(z0, pos[v + 2]!);
      z1 = Math.max(z1, pos[v + 2]!);
    }
    const i0 = Math.max(0, Math.floor((x0 - min[0]) / h - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((x1 - min[0]) / h - 0.5));
    const k0 = Math.max(0, Math.floor((z0 - min[2]) / h - 0.5));
    const k1 = Math.min(nz - 1, Math.ceil((z1 - min[2]) / h - 0.5));
    for (let kk = k0; kk <= k1; kk++) for (let ii = i0; ii <= i1; ii++) buckets[ii + nx * kk]!.push(i);
  }
  const hits: number[] = [];
  for (let kk = 0; kk < nz; kk++)
    for (let ii = 0; ii < nx; ii++) {
      // slightly irrational offsets avoid exact edge hits
      const px = min[0] + (ii + 0.5013) * h;
      const pz = min[2] + (kk + 0.4987) * h;
      hits.length = 0;
      for (const ti of buckets[ii + nx * kk]!) {
        const a = tris[ti]! * 3;
        const b = tris[ti + 1]! * 3;
        const c = tris[ti + 2]! * 3;
        const ax = pos[a]!;
        const az = pos[a + 2]!;
        const bx = pos[b]!;
        const bz = pos[b + 2]!;
        const cx = pos[c]!;
        const cz = pos[c + 2]!;
        const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(det) < 1e-18) continue;
        const u = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det;
        const v = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        hits.push(pos[a + 1]! + u * (pos[b + 1]! - pos[a + 1]!) + v * (pos[c + 1]! - pos[a + 1]!));
      }
      if (hits.length < 2) continue;
      hits.sort((x, y) => x - y);
      for (let q = 0; q + 1 < hits.length; q += 2) {
        const j0 = Math.max(0, Math.ceil((hits[q]! - min[1]) / h - 0.5));
        const j1 = Math.min(ny - 1, Math.floor((hits[q + 1]! - min[1]) / h - 0.5));
        for (let jj = j0; jj <= j1; jj++) occ[ii + nx * (jj + ny * kk)] = 1;
      }
    }
  const sample = (x: number, y: number, z: number): number => {
    const fx = (x - min[0]) / h - 0.5;
    const fy = (y - min[1]) / h - 0.5;
    const fz = (z - min[2]) / h - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 0;
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const g = (a: number, b2: number, c: number) => occ[a + nx * (b2 + ny * c)]!;
    const c00 = g(i, j, k) * (1 - tx) + g(i + 1, j, k) * tx;
    const c10 = g(i, j + 1, k) * (1 - tx) + g(i + 1, j + 1, k) * tx;
    const c01 = g(i, j, k + 1) * (1 - tx) + g(i + 1, j, k + 1) * tx;
    const c11 = g(i, j + 1, k + 1) * (1 - tx) + g(i + 1, j + 1, k + 1) * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  const out = new Float64Array(t.n);
  const dists = [0.25, 0.5, 1];
  for (let c = 0; c < t.n; c++) {
    const px = pos[c * 3]!;
    const py = pos[c * 3 + 1]!;
    const pz = pos[c * 3 + 2]!;
    const n: V3 = [nrm[c * 3]!, nrm[c * 3 + 1]!, nrm[c * 3 + 2]!];
    const tan = Math.abs(n[1]) < 0.9 ? cross3(n, [0, 1, 0]) : cross3(n, [1, 0, 0]);
    const bit = cross3(n, tan);
    let occSum = 0;
    let wSum = 0;
    for (let d = 0; d < 6; d++) {
      // normal plus a ring of 5 directions tilted 50 degrees
      let dir: V3 = n;
      if (d > 0) {
        const a = (d / 5) * Math.PI * 2;
        const ca = Math.cos(a) * 0.766;
        const sa = Math.sin(a) * 0.766;
        dir = [
          n[0] * 0.643 + tan[0] * ca + bit[0] * sa,
          n[1] * 0.643 + tan[1] * ca + bit[1] * sa,
          n[2] * 0.643 + tan[2] * ca + bit[2] * sa,
        ];
      }
      for (const s of dists) {
        const r = Math.max(h * 1.5, radius * s);
        const wgt = 1 / (1 + s);
        occSum += sample(px + dir[0] * r, py + dir[1] * r, pz + dir[2] * r) * wgt;
        wSum += wgt;
      }
    }
    out[c] = 1 - clamp((occSum / wSum) * 1.8, 0, 0.85);
  }
  // one smoothing pass to hide voxel steps
  const sm = new Float64Array(t.n);
  for (let c = 0; c < t.n; c++) {
    const nb = t.nbr[c]!;
    let s = out[c]! * 2;
    for (const o of nb) s += out[o]!;
    sm[c] = s / (nb.length + 2);
  }
  return sm;
}

function cross3(a: V3, b: V3): V3 {
  const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(c[0], c[1], c[2]) || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** Averages vertex colors with their neighbours (softens jagged color borders on dense meshes). */
export function smoothVertexColors(mesh: PolyMesh, iterations = 1): PolyMesh {
  if (iterations <= 0 || !mesh.f.some((f) => f.c)) return mesh;
  const t = topology(mesh, false);
  const col = new Float64Array(t.n * 3);
  const cnt = new Float64Array(t.n);
  for (const f of mesh.f) {
    if (!f.c) continue;
    f.v.forEach((v, k) => {
      const c = f.c![k]!;
      col[v * 3] = col[v * 3]! + c[0];
      col[v * 3 + 1] = col[v * 3 + 1]! + c[1];
      col[v * 3 + 2] = col[v * 3 + 2]! + c[2];
      cnt[v]! += 1;
    });
  }
  for (let v = 0; v < t.n; v++) {
    const k = cnt[v]! || 1;
    col[v * 3] = col[v * 3]! / k;
    col[v * 3 + 1] = col[v * 3 + 1]! / k;
    col[v * 3 + 2] = col[v * 3 + 2]! / k;
  }
  let cur = col;
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(t.n * 3);
    for (let v = 0; v < t.n; v++) {
      const nb = t.nbr[v]!;
      const self = 2;
      let r = cur[v * 3]! * self;
      let g = cur[v * 3 + 1]! * self;
      let b = cur[v * 3 + 2]! * self;
      for (const o of nb) {
        r += cur[o * 3]!;
        g += cur[o * 3 + 1]!;
        b += cur[o * 3 + 2]!;
      }
      const inv = 1 / (nb.length + self);
      next[v * 3] = r * inv;
      next[v * 3 + 1] = g * inv;
      next[v * 3 + 2] = b * inv;
    }
    cur = next;
  }
  const m = mesh.clone();
  for (const f of m.f) if (f.c) f.c = f.v.map((v) => [cur[v * 3]!, cur[v * 3 + 1]!, cur[v * 3 + 2]!] as RGB);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Manifold repair
// ---------------------------------------------------------------------------------------------

/**
 * Makes a mesh edge-manifold: edges shared by more than two faces (and "pinched" vertices where separate sheets
 * touch) are split by duplicating vertices, so every edge ends up with exactly two faces. Positions are kept
 * (duplicates are nudged apart by a hair so later welds do not re-merge them).
 */
export function repairManifold(mesh: PolyMesh): PolyMesh {
  let m = removeFins(mesh);
  for (let pass = 0; pass < 6 && countNonManifoldEdges(m) > 0; pass++) {
    const r = repairPass(m, pass % 2 === 1);
    if (r) m = r;
  }
  return m;
}

/**
 * Removes pairs of faces that use the same vertices with opposite winding (zero-volume "fins" that simplifiers
 * sometimes leave behind); they make their edges non-manifold.
 */
export function removeFins(mesh: PolyMesh): PolyMesh {
  const seen = new Map<string, number>();
  const drop = new Set<number>();
  mesh.f.forEach((f, i) => {
    const key = [...f.v].sort((a, b) => a - b).join(',');
    const j = seen.get(key);
    if (j !== undefined && !drop.has(j)) {
      drop.add(i);
      drop.add(j);
      seen.delete(key);
    } else seen.set(key, i);
  });
  if (drop.size === 0) return mesh;
  const m = mesh.clone();
  m.f = m.f.filter((_, i) => !drop.has(i));
  return m.compact();
}

function repairPass(mesh: PolyMesh, altPairing: boolean): PolyMesh | null {
  const nv = mesh.p.length;
  // directed edge occurrences
  const edgeFaces = new Map<number, number[]>(); // undirected key -> [face, dir(1 = a<b forward), ...]
  mesh.f.forEach((f, fi) => {
    const k = f.v.length;
    for (let i = 0; i < k; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % k]!;
      const key = a < b ? a * nv + b : b * nv + a;
      let list = edgeFaces.get(key);
      if (!list) {
        list = [];
        edgeFaces.set(key, list);
      }
      list.push(fi, a < b ? 1 : 0);
    }
  });
  const bad: number[] = [];
  for (const [key, list] of edgeFaces) {
    if (list.length === 4 && list[1] !== list[3]) continue;
    if (list.length > 4) bad.push(key);
  }
  // Pinched vertices also need splitting; detect them with the fan pass below even if no edge is bad.
  // Face adjacency: "linked" pairs for each edge.
  const link = new Map<number, number[]>(); // key -> linked face pairs [f0, f1, f2, f3 ...]
  for (const [key, list] of edgeFaces) {
    if (list.length === 4 && list[1] !== list[3]) {
      link.set(key, [list[0]!, list[2]!]);
    }
  }
  for (const key of bad) {
    const list = edgeFaces.get(key)!;
    const a = Math.floor(key / nv);
    const b = key % nv;
    const pa = mesh.p[a]!;
    const pb = mesh.p[b]!;
    const axis: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const ax: V3 = [axis[0] / al, axis[1] / al, axis[2] / al];
    const ref = Math.abs(ax[1]) < 0.9 ? cross3(ax, [0, 1, 0]) : cross3(ax, [1, 0, 0]);
    const ref2 = cross3(ax, ref);
    const items: { f: number; dir: number; ang: number }[] = [];
    for (let i = 0; i < list.length; i += 2) {
      const fi = list[i]!;
      const c = mesh.faceCenter(fi);
      const d: V3 = [c[0] - pa[0], c[1] - pa[1], c[2] - pa[2]];
      items.push({
        f: fi,
        dir: list[i + 1]!,
        ang: Math.atan2(d[0] * ref2[0] + d[1] * ref2[1] + d[2] * ref2[2], d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2]),
      });
    }
    items.sort((x, y) => x.ang - y.ang);
    const pairs: number[] = [];
    const fw = items.filter((it) => it.dir === 1);
    const bw = items.filter((it) => it.dir === 0);
    if (fw.length === 2 && bw.length === 2) {
      // the two possible pairings of a 4-face edge; passes alternate between them
      const [f0, f1] = fw as [(typeof items)[0], (typeof items)[0]];
      const [b0, b1] = bw as [(typeof items)[0], (typeof items)[0]];
      if (altPairing) pairs.push(f0.f, b1.f, f1.f, b0.f);
      else pairs.push(f0.f, b0.f, f1.f, b1.f);
    } else {
      // general case: pair angular neighbours with opposite winding
      const used = new Set<number>();
      const n = items.length;
      const start = altPairing ? 1 : 0;
      for (let q = 0; q < n; q++) {
        const i = (q + start) % n;
        if (used.has(i)) continue;
        for (let d = 1; d < n; d++) {
          const j = (i + d) % n;
          if (used.has(j) || items[i]!.dir === items[j]!.dir) continue;
          used.add(i);
          used.add(j);
          pairs.push(items[i]!.f, items[j]!.f);
          break;
        }
      }
    }
    link.set(key, pairs);
  }
  // Fan analysis per vertex.
  const vertFaces: number[][] = Array.from({ length: nv }, () => []);
  mesh.f.forEach((f, fi) => {
    for (const v of f.v) vertFaces[v]!.push(fi);
  });
  const faceLinks = new Map<number, number[]>(); // face -> linked faces (via any edge)
  for (const pairs of link.values()) {
    for (let i = 0; i < pairs.length; i += 2) {
      const x = pairs[i]!;
      const y = pairs[i + 1]!;
      let lx = faceLinks.get(x);
      if (!lx) faceLinks.set(x, (lx = []));
      lx.push(y);
      let ly = faceLinks.get(y);
      if (!ly) faceLinks.set(y, (ly = []));
      ly.push(x);
    }
  }
  const out = mesh.clone();
  let changed = false;
  for (let v = 0; v < nv; v++) {
    const faces = vertFaces[v]!;
    if (faces.length < 2) continue;
    const set = new Set(faces);
    const group = new Map<number, number>();
    let groups = 0;
    for (const f0 of faces) {
      if (group.has(f0)) continue;
      const stack = [f0];
      group.set(f0, groups);
      while (stack.length) {
        const f = stack.pop()!;
        for (const g of faceLinks.get(f) ?? []) {
          if (!set.has(g) || group.has(g)) continue;
          // g must share an edge with f that contains v
          if (!sharesEdgeAt(mesh.f[f]!, mesh.f[g]!, v)) continue;
          group.set(g, groups);
          stack.push(g);
        }
      }
      groups++;
    }
    if (groups < 2) continue;
    changed = true;
    const p = mesh.p[v]!;
    for (let gi = 1; gi < groups; gi++) {
      const idx = out.p.length;
      // nudge toward the fan centroid
      const c: V3 = [0, 0, 0];
      let cnt = 0;
      for (const f of faces) {
        if (group.get(f) !== gi) continue;
        const fc = mesh.faceCenter(f);
        c[0] = c[0]! + fc[0];
        c[1] = c[1]! + fc[1];
        c[2] = c[2]! + fc[2];
        cnt++;
      }
      const k = 0.02 / Math.max(1, cnt);
      out.p.push([p[0] + (c[0] - p[0] * cnt) * k, p[1] + (c[1] - p[1] * cnt) * k, p[2] + (c[2] - p[2] * cnt) * k]);
      for (const f of faces) {
        if (group.get(f) !== gi) continue;
        const face = out.f[f]!;
        face.v = face.v.map((x) => (x === v ? idx : x));
      }
    }
  }
  return changed ? out : null;
}

function sharesEdgeAt(a: Face, b: Face, v: number): boolean {
  const ia = a.v.indexOf(v);
  if (ia < 0) return false;
  const na = a.v.length;
  const prev = a.v[(ia - 1 + na) % na]!;
  const next = a.v[(ia + 1) % na]!;
  return b.v.includes(prev) || b.v.includes(next);
}

/** Counts undirected edges used by more than two faces or with inconsistent winding. */
export function countNonManifoldEdges(mesh: PolyMesh): number {
  const nv = mesh.p.length;
  const counts = new Map<number, number>();
  for (const f of mesh.f) {
    const k = f.v.length;
    for (let i = 0; i < k; i++) {
      const a = f.v[i]!;
      const b = f.v[(i + 1) % k]!;
      const key = a < b ? a * nv + b : b * nv + a;
      counts.set(key, (counts.get(key) ?? 0) + (a < b ? 1 : 1000));
    }
  }
  let bad = 0;
  for (const c of counts.values()) if (c !== 1001 && c !== 1 && c !== 1000) bad++;
  return bad;
}

// ---------------------------------------------------------------------------------------------
// Decimation
// ---------------------------------------------------------------------------------------------

export interface DecimateOptions {
  /** Maximum allowed deviation relative to the mesh size (default 1 = reach the target whatever it takes). */
  error?: number;
  /** Keep open borders (e.g. terrain edges) in place (default true). */
  lockBorder?: boolean;
}

/**
 * Reduces the triangle count with meshoptimizer's quadric simplifier while keeping colors, UVs, materials and
 * face groups. `target` > 1 is a triangle count, 0..1 is a ratio of the current count.
 * Output is triangles. Needs `await initModeling()` (the host does this for recipes).
 * Example: sdf.sphere(0.5).mesh({ detail: 'high' }).decimate(4000)
 */
export function decimate(mesh: PolyMesh, target: number, opts: DecimateOptions = {}): PolyMesh {
  if (!meshoptReady) {
    throw new Error('decimate() needs the mesh optimizer: call `await initModeling()` first.');
  }
  const tri = mesh.triangulate();
  const current = tri.f.length;
  const targetTris = target > 1 ? Math.round(target) : Math.max(4, Math.round(current * Math.max(0, target)));
  if (targetTris >= current || current < 8) return tri;
  // Edge collapses very occasionally pinch a thin feature into a non-manifold edge: retry nearby targets.
  const wasManifold = countNonManifoldEdges(tri) === 0;
  let best: PolyMesh | null = null;
  for (const k of [1, 1.03, 1.07, 0.96, 1.12]) {
    const out = simplifyOnce(tri, Math.min(current, Math.round(targetTris * k)), opts);
    if (!wasManifold || countNonManifoldEdges(out) === 0) return out;
    best ??= out;
  }
  return best!;
}

function simplifyOnce(tri: PolyMesh, targetTris: number, opts: DecimateOptions): PolyMesh {
  const current = tri.f.length;
  const hasUv = tri.f.some((f) => f.uv);
  const hasC = tri.f.some((f) => f.c);
  const stride = (hasC ? 3 : 0) + (hasUv ? 2 : 0);
  const keyMap = new Map<string, number>();
  const positions: number[] = [];
  const attrs: number[] = [];
  const srcPos: number[] = [];
  const meta: number[] = []; // face index providing g / m / sm
  const indices = new Uint32Array(current * 3);
  const r4 = (x: number) => Math.round(x * 1e4);
  tri.f.forEach((f, fi) => {
    for (let k = 0; k < 3; k++) {
      const v = f.v[k]!;
      const c = f.c?.[k];
      const uv = f.uv?.[k];
      const key = `${v}|${f.m}|${f.g}|${f.sm ? 1 : 0}|${c ? `${r4(c[0])},${r4(c[1])},${r4(c[2])}` : ''}|${uv ? `${r4(uv[0])},${r4(uv[1])}` : ''}`;
      let id = keyMap.get(key);
      if (id === undefined) {
        id = srcPos.length;
        keyMap.set(key, id);
        const p = tri.p[v]!;
        positions.push(p[0], p[1], p[2]);
        if (hasC) {
          const cc = c ?? [1, 1, 1];
          attrs.push(cc[0], cc[1], cc[2]);
        }
        if (hasUv) {
          const u = uv ?? [0, 0];
          attrs.push(u[0], u[1]);
        }
        srcPos.push(v);
        meta.push(fi);
      }
      indices[fi * 3 + k] = id;
    }
  });
  const flags: ('LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive')[] = [];
  if (opts.lockBorder !== false) flags.push('LockBorder');
  const pos = new Float32Array(positions);
  let result: Uint32Array;
  if (stride > 0) {
    const weights: number[] = [];
    if (hasC) weights.push(0.6, 0.6, 0.6);
    if (hasUv) weights.push(0.1, 0.1);
    [result] = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      pos,
      3,
      new Float32Array(attrs),
      stride,
      weights,
      null,
      targetTris * 3,
      opts.error ?? 1,
      flags,
    );
  } else {
    [result] = MeshoptSimplifier.simplify(indices, pos, 3, targetTris * 3, opts.error ?? 1, flags);
  }
  const out = tri.empty();
  out.p = tri.p.map((p) => [p[0], p[1], p[2]]);
  for (let i = 0; i + 2 < result.length; i += 3) {
    const ids = [result[i]!, result[i + 1]!, result[i + 2]!];
    const v = ids.map((id) => srcPos[id]!);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const src = tri.f[meta[ids[0]!]!]!;
    out.f.push({
      v,
      uv: hasUv && src.uv ? ids.map((id) => [attrs[id * stride + (hasC ? 3 : 0)]!, attrs[id * stride + (hasC ? 4 : 1)]!] as V2) : null,
      c: hasC && src.c ? ids.map((id) => [attrs[id * stride]!, attrs[id * stride + 1]!, attrs[id * stride + 2]!] as RGB) : null,
      g: src.g,
      m: src.m,
      sm: src.sm,
    });
  }
  const compacted = removeFins(out.compact());
  return countNonManifoldEdges(compacted) > 0 ? repairManifold(compacted) : compacted;
}

export { topology as _topology, vertexNormals };
export type { Topo };
