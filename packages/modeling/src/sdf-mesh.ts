/**
 * SDF → mesh. Sparse, manifold-safe surface nets:
 * - the field is only evaluated in blocks near the surface (Lipschitz culling), so cost grows with surface area;
 * - every cell gets one vertex per surface sheet passing through it (face ambiguities are resolved consistently),
 *   which keeps the output edge-manifold; leftovers are fixed by retrying on a shifted grid and a final repair;
 * - vertices on smooth areas are projected onto the surface, vertices on creases are placed with a QEF so
 *   hard unions keep crisp edges;
 * - optional Taubin smoothing, color softening, SDF ambient occlusion and meshoptimizer decimation.
 */
import type { RGB, V3 } from './math.ts';
import { countNonManifoldEdges, decimate, repairManifold } from './ops/organic.ts';
import { type Face, PolyMesh } from './polymesh.ts';
import type { Sdf } from './sdf.ts';

export type SdfDetail = 'low' | 'medium' | 'high' | 'ultra';

export interface SdfMeshOptions {
  /** Cells along the longest side (16..240). Overrides `detail`. */
  resolution?: number;
  /** Preset resolution: low 40, medium 64 (default), high 100, ultra 150. */
  detail?: SdfDetail;
  /** Extra space around the bounds in meters (default: two cells). */
  padding?: number;
  /** Taubin smoothing iterations after meshing (default 2; creases are protected). 0 = off. */
  smooth?: number;
  /** Reduce triangles with meshoptimizer: > 1 = target triangle count, 0..1 = ratio. Output becomes triangles. */
  decimate?: number;
  /** Bake SDF ambient occlusion into vertex colors: true, a strength (0..1+), or { strength, radius }. */
  ao?: boolean | number | { strength?: number; radius?: number };
  /** Neighbour-averaging passes that soften jagged color borders (default 1). */
  colorSmooth?: number;
}

export const DETAIL_RESOLUTION: Record<SdfDetail, number> = { low: 40, medium: 64, high: 100, ultra: 150 };

export function meshSdf(shape: Sdf, opts: SdfMeshOptions = {}): PolyMesh {
  const res = Math.max(16, Math.min(240, Math.round(opts.resolution ?? DETAIL_RESOLUTION[opts.detail ?? 'medium'])));
  const shifts: V3[] = [
    [0, 0, 0],
    [0.37, 0.21, 0.29],
    [0.61, 0.47, 0.13],
  ];
  // Repair is cheap; a shifted grid is only tried when a pinch cannot be untangled.
  let best: { net: Net; mesh: PolyMesh; bad: number } | null = null;
  for (const shift of shifts) {
    const net = surfaceNets(shape, res, opts.padding, shift);
    let m = net.mesh;
    if (countNonManifoldEdges(m) > 0) m = repairManifold(m);
    const bad = countNonManifoldEdges(m);
    if (!best || bad < best.bad) best = { net, mesh: m, bad };
    if (bad === 0) break;
  }
  let mesh = best!.mesh;
  const { feature, cell } = best!.net;
  if (mesh.f.length === 0) return mesh;

  const adj = adjacency(mesh);
  const pos = new Float64Array(mesh.p.length * 3);
  mesh.p.forEach((p, i) => {
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
  });
  const iterations = Math.max(0, Math.round(opts.smooth ?? 2));
  if (iterations > 0) {
    const w = new Float64Array(mesh.p.length);
    for (let i = 0; i < w.length; i++) w[i] = i < feature.length && feature[i] ? 0 : 1;
    for (let it = 0; it < iterations; it++) {
      taubinPass(adj, pos, 0.5, w);
      taubinPass(adj, pos, -0.53, w);
    }
  }
  for (let i = 0; i < mesh.p.length; i++) mesh.p[i] = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];

  const aoOpt = opts.ao;
  const wantAo = aoOpt !== undefined && aoOpt !== false && aoOpt !== 0;
  if (shape.dc || wantAo) {
    const n = mesh.p.length;
    const col = new Float64Array(n * 3).fill(1);
    if (shape.dc) {
      const dc = shape.dc;
      const out: RGB = [1, 1, 1];
      for (let i = 0; i < n; i++) {
        out[0] = 1;
        out[1] = 1;
        out[2] = 1;
        dc(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, out);
        col[i * 3] = out[0];
        col[i * 3 + 1] = out[1];
        col[i * 3 + 2] = out[2];
      }
      const passes = Math.max(0, Math.round(opts.colorSmooth ?? 1));
      for (let it = 0; it < passes; it++) smoothColorsCsr(adj, col);
    }
    if (wantAo) {
      const strength = typeof aoOpt === 'number' ? aoOpt : typeof aoOpt === 'object' ? (aoOpt.strength ?? 1) : 1;
      const b = shape.bounds;
      const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const radius = (typeof aoOpt === 'object' ? aoOpt.radius : undefined) ?? Math.max(size * 0.1, cell * 3);
      const nrm = vertexNormalsFlat(mesh, pos);
      const f = shape.f;
      for (let i = 0; i < n; i++) {
        const px = pos[i * 3]!;
        const py = pos[i * 3 + 1]!;
        const pz = pos[i * 3 + 2]!;
        const nx = nrm[i * 3]!;
        const ny = nrm[i * 3 + 1]!;
        const nz = nrm[i * 3 + 2]!;
        let occ = 0;
        let sca = 1;
        let norm = 0;
        for (let s = 1; s <= 5; s++) {
          const h = (radius * s) / 5;
          const d = f(px + nx * h, py + ny * h, pz + nz * h);
          occ += (Math.max(0, h - d) / h) * sca;
          norm += sca;
          sca *= 0.8;
        }
        const ao = 1 - Math.min(0.85, (occ / norm) * 1.6 * strength);
        col[i * 3] = col[i * 3]! * ao;
        col[i * 3 + 1] = col[i * 3 + 1]! * ao;
        col[i * 3 + 2] = col[i * 3 + 2]! * ao;
      }
    }
    for (const face of mesh.f)
      face.c = face.v.map((v) => [col[v * 3]!, col[v * 3 + 1]!, col[v * 3 + 2]!] as RGB);
  }
  if (opts.decimate !== undefined && opts.decimate > 0) mesh = decimate(mesh, opts.decimate);
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

const CORNER: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];
/** Edge axis: 0 = x, 1 = y, 2 = z. */
const EDGE_AXIS = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
const FACE_CORNERS = [
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 5, 7, 6],
];
const FACE_EDGES = [
  [4, 10, 6, 8],
  [5, 11, 7, 9],
  [0, 9, 2, 8],
  [1, 11, 3, 10],
  [0, 5, 1, 4],
  [2, 7, 3, 6],
];

/** Lazily filled: labels[(config * 64 + faceBits) * 12 + edge] = component id or -1. */
const LABELS = new Int8Array(256 * 64 * 12);
const LABELS_DONE = new Uint8Array(256 * 64);
const LABEL_COUNT = new Uint8Array(256 * 64);

function labelsFor(config: number, bits: number): number {
  const key = config * 64 + bits;
  if (LABELS_DONE[key]) return key;
  const parent = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const unite = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const inside = (c: number) => (config >> c) & 1;
  const crossing = (e: number) => inside(EDGE_CORNERS[e]![0]) !== inside(EDGE_CORNERS[e]![1]);
  for (let fi = 0; fi < 6; fi++) {
    const fe = FACE_EDGES[fi]!;
    const cross = fe.filter(crossing);
    if (cross.length === 2) unite(cross[0]!, cross[1]!);
    else if (cross.length === 4) {
      if ((bits >> fi) & 1) {
        unite(fe[0]!, fe[1]!);
        unite(fe[2]!, fe[3]!);
      } else {
        unite(fe[3]!, fe[0]!);
        unite(fe[1]!, fe[2]!);
      }
    }
  }
  const ids = new Map<number, number>();
  for (let e = 0; e < 12; e++) {
    let label = -1;
    if (crossing(e)) {
      const r = find(e);
      label = ids.get(r) ?? ids.size;
      ids.set(r, label);
    }
    LABELS[key * 12 + e] = label;
  }
  LABEL_COUNT[key] = ids.size;
  LABELS_DONE[key] = 1;
  return key;
}

// ---------------------------------------------------------------------------------------------
// Surface nets
// ---------------------------------------------------------------------------------------------

interface Net {
  mesh: PolyMesh;
  /** 1 for vertices placed on a crease/corner (protected from smoothing). */
  feature: Uint8Array;
  cell: number;
}

const BLOCK = 8;

function surfaceNets(shape: Sdf, res: number, paddingOpt: number | undefined, shift: V3): Net {
  const f = shape.f;
  const b = shape.bounds;
  const ext: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const longest = Math.max(ext[0], ext[1], ext[2], 1e-6);
  const cell0 = longest / res;
  const padding = paddingOpt ?? cell0 * 2;
  const cell = (longest + 2 * padding) / res;
  const origin: V3 = [
    b.min[0] - padding - cell * (1 + shift[0]),
    b.min[1] - padding - cell * (1 + shift[1]),
    b.min[2] - padding - cell * (1 + shift[2]),
  ];
  const sx = Math.ceil((ext[0] + 2 * padding) / cell) + 4;
  const sy = Math.ceil((ext[1] + 2 * padding) / cell) + 4;
  const sz = Math.ceil((ext[2] + 2 * padding) / cell) + 4;
  const nx = sx - 1;
  const ny = sy - 1;
  const nz = sz - 1;
  const field = new Float32Array(sx * sy * sz);
  const gi = (i: number, j: number, k: number) => i + sx * (j + sy * k);

  // --- sparse evaluation in blocks
  const nbx = Math.ceil(sx / BLOCK);
  const nby = Math.ceil(sy / BLOCK);
  const nbz = Math.ceil(sz / BLOCK);
  const active = new Uint8Array(nbx * nby * nbz);
  const lip = Math.max(1, shape.lip);
  const rb = ((BLOCK - 1) / 2) * cell * Math.sqrt(3);
  const skipDist = lip * 1.15 * (rb + 1.8 * cell);
  for (let bk = 0; bk < nbz; bk++)
    for (let bj = 0; bj < nby; bj++)
      for (let bi = 0; bi < nbx; bi++) {
        const i0 = bi * BLOCK;
        const j0 = bj * BLOCK;
        const k0 = bk * BLOCK;
        const i1 = Math.min(sx, i0 + BLOCK);
        const j1 = Math.min(sy, j0 + BLOCK);
        const k1 = Math.min(sz, k0 + BLOCK);
        const d = f(
          origin[0] + ((i0 + i1 - 1) / 2) * cell,
          origin[1] + ((j0 + j1 - 1) / 2) * cell,
          origin[2] + ((k0 + k1 - 1) / 2) * cell,
        );
        const border = i0 === 0 || j0 === 0 || k0 === 0 || i1 === sx || j1 === sy || k1 === sz;
        if (Math.abs(d) > skipDist && !(border && d < 0)) {
          for (let k = k0; k < k1; k++)
            for (let j = j0; j < j1; j++) {
              const row = sx * (j + sy * k);
              for (let i = i0; i < i1; i++) field[row + i] = d;
            }
          continue;
        }
        active[bi + nbx * (bj + nby * bk)] = 1;
        for (let k = k0; k < k1; k++) {
          const z = origin[2] + k * cell;
          for (let j = j0; j < j1; j++) {
            const y = origin[1] + j * cell;
            const row = sx * (j + sy * k);
            for (let i = i0; i < i1; i++) field[row + i] = f(origin[0] + i * cell, y, z);
          }
        }
      }
  // The outermost layer is always outside, so the surface is closed even if the bounds were too small.
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) {
        if (i > 0 && j > 0 && k > 0 && i < sx - 1 && j < sy - 1 && k < sz - 1) {
          i = sx - 2; // jump to the far side of this row
          continue;
        }
        const g = gi(i, j, k);
        if (field[g]! <= 0) field[g] = cell;
      }

  // --- crossings (cached per grid edge)
  const crossIndex = new Map<number, number>();
  const cp: number[] = []; // crossing positions
  const cg: number[] = []; // crossing gradients (unnormalized)
  const h = cell * 0.1;
  const crossing = (i: number, j: number, k: number, axis: number): number => {
    const g0 = gi(i, j, k);
    const key = g0 * 3 + axis;
    const hit = crossIndex.get(key);
    if (hit !== undefined) return hit;
    const g1 = axis === 0 ? g0 + 1 : axis === 1 ? g0 + sx : g0 + sx * sy;
    const va = field[g0]!;
    const vb = field[g1]!;
    let t = va / (va - vb);
    const ax = origin[0] + i * cell;
    const ay = origin[1] + j * cell;
    const az = origin[2] + k * cell;
    const at = (tt: number, c: number) => (axis === c ? tt * cell : 0);
    let px = ax + at(t, 0);
    let py = ay + at(t, 1);
    let pz = az + at(t, 2);
    // one regula-falsi refinement against the true field
    const fv = f(px, py, pz);
    if (Math.abs(fv) > cell * 1e-4) {
      if (fv < 0 === va < 0) t = t + ((1 - t) * fv) / (fv - vb);
      else t = (t * va) / (va - fv);
      t = Math.min(1, Math.max(0, t));
      px = ax + at(t, 0);
      py = ay + at(t, 1);
      pz = az + at(t, 2);
    }
    const f0 = f(px + h, py - h, pz - h);
    const f1 = f(px - h, py - h, pz + h);
    const f2 = f(px - h, py + h, pz - h);
    const f3 = f(px + h, py + h, pz + h);
    const idx = cp.length / 3;
    cp.push(px, py, pz);
    cg.push((f0 - f1 - f2 + f3) / (4 * h), (-f0 - f1 + f2 + f3) / (4 * h), (-f0 + f1 - f2 + f3) / (4 * h));
    crossIndex.set(key, idx);
    return idx;
  };

  // --- cells: one vertex per surface component
  const cellMap = new Map<number, number>();
  const recCell: number[] = []; // packed cell index
  const recBase: number[] = [];
  const recKey: number[] = [];
  const vp: number[] = [];
  const feat: number[] = [];
  const vals = new Float64Array(8);
  const ci = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const edgeList: number[] = [];
  for (let bk = 0; bk < nbz; bk++)
    for (let bj = 0; bj < nby; bj++)
      for (let bi = 0; bi < nbx; bi++) {
        if (!active[bi + nbx * (bj + nby * bk)]) continue;
        const i1 = Math.min(nx, (bi + 1) * BLOCK);
        const j1 = Math.min(ny, (bj + 1) * BLOCK);
        const k1 = Math.min(nz, (bk + 1) * BLOCK);
        for (let k = bk * BLOCK; k < k1; k++)
          for (let j = bj * BLOCK; j < j1; j++)
            for (let i = bi * BLOCK; i < i1; i++) {
              let config = 0;
              for (let c = 0; c < 8; c++) {
                const o = CORNER[c]!;
                const v = field[gi(i + o[0], j + o[1], k + o[2])]!;
                vals[c] = v;
                if (v < 0) config |= 1 << c;
              }
              if (config === 0 || config === 255) continue;
              let bits = 0;
              for (let fi = 0; fi < 6; fi++) {
                const fc = FACE_CORNERS[fi]!;
                const s0 = (config >> fc[0]!) & 1;
                const s1 = (config >> fc[1]!) & 1;
                const s2 = (config >> fc[2]!) & 1;
                const s3 = (config >> fc[3]!) & 1;
                if (s0 === s2 && s1 === s3 && s0 !== s1) {
                  const avg = vals[fc[0]!]! + vals[fc[1]!]! + vals[fc[2]!]! + vals[fc[3]!]!;
                  if (avg < 0 === (s0 === 1)) bits |= 1 << fi;
                }
              }
              const key = labelsFor(config, bits);
              const count = LABEL_COUNT[key]!;
              const base = vp.length / 3;
              cellMap.set(ci(i, j, k), recCell.length);
              recCell.push(ci(i, j, k));
              recBase.push(base);
              recKey.push(key);
              for (let comp = 0; comp < count; comp++) {
                edgeList.length = 0;
                for (let e = 0; e < 12; e++) {
                  if (LABELS[key * 12 + e] !== comp) continue;
                  const o = CORNER[EDGE_CORNERS[e]![0]]!;
                  edgeList.push(crossing(i + o[0], j + o[1], k + o[2], EDGE_AXIS[e]!));
                }
                placeVertex(edgeList, cp, cg, f, cell, [
                  origin[0] + i * cell,
                  origin[1] + j * cell,
                  origin[2] + k * cell,
                ], vp, feat);
              }
            }
      }

  // --- quads across every crossing grid edge
  const mesh = new PolyMesh();
  const vcount = vp.length / 3;
  mesh.p = new Array(vcount);
  for (let v = 0; v < vcount; v++) mesh.p[v] = [vp[v * 3]!, vp[v * 3 + 1]!, vp[v * 3 + 2]!];
  const vertOf = (i: number, j: number, k: number, e: number): number => {
    const r = cellMap.get(ci(i, j, k));
    if (r === undefined) return -1;
    const label = LABELS[recKey[r]! * 12 + e]!;
    return label < 0 ? -1 : recBase[r]! + label;
  };
  const faces: Face[] = [];
  const quad = (a: number, b2: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b2 < 0 || c < 0 || d < 0) return;
    faces.push({ v: flip ? [d, c, b2, a] : [a, b2, c, d], uv: null, c: null, g: 'surface', m: 0, sm: true });
  };
  for (let r = 0; r < recCell.length; r++) {
    const key = recKey[r]!;
    const cidx = recCell[r]!;
    const i = cidx % nx;
    const j = Math.floor(cidx / nx) % ny;
    const k = Math.floor(cidx / (nx * ny));
    const inside = field[gi(i, j, k)]! < 0;
    if (LABELS[key * 12 + 0]! >= 0 && j > 0 && k > 0)
      quad(
        vertOf(i, j - 1, k - 1, 3),
        vertOf(i, j, k - 1, 2),
        vertOf(i, j, k, 0),
        vertOf(i, j - 1, k, 1),
        !inside,
      );
    if (LABELS[key * 12 + 4]! >= 0 && i > 0 && k > 0)
      quad(
        vertOf(i - 1, j, k - 1, 7),
        vertOf(i - 1, j, k, 5),
        vertOf(i, j, k, 4),
        vertOf(i, j, k - 1, 6),
        !inside,
      );
    if (LABELS[key * 12 + 8]! >= 0 && i > 0 && j > 0)
      quad(
        vertOf(i - 1, j - 1, k, 11),
        vertOf(i, j - 1, k, 10),
        vertOf(i, j, k, 8),
        vertOf(i - 1, j, k, 9),
        !inside,
      );
  }
  mesh.f = faces;
  return { mesh, feature: Uint8Array.from(feat), cell };
}

/** Places one vertex for a surface component from its edge crossings (projection or QEF on creases). */
function placeVertex(
  edges: number[],
  cp: number[],
  cg: number[],
  f: (x: number, y: number, z: number) => number,
  cell: number,
  cmin: V3,
  out: number[],
  feat: number[],
) {
  const n = edges.length;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let gmag = 0;
  for (const e of edges) {
    mx += cp[e * 3]!;
    my += cp[e * 3 + 1]!;
    mz += cp[e * 3 + 2]!;
    const gx = cg[e * 3]!;
    const gy = cg[e * 3 + 1]!;
    const gz = cg[e * 3 + 2]!;
    const l = Math.hypot(gx, gy, gz) || 1;
    gmag += l;
    ax += gx / l;
    ay += gy / l;
    az += gz / l;
  }
  mx /= n;
  my /= n;
  mz /= n;
  gmag /= n;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;
  let minDot = 1;
  for (const e of edges) {
    const gx = cg[e * 3]!;
    const gy = cg[e * 3 + 1]!;
    const gz = cg[e * 3 + 2]!;
    const l = Math.hypot(gx, gy, gz) || 1;
    minDot = Math.min(minDot, (gx * ax + gy * ay + gz * az) / l);
  }
  if (minDot > 0.9 || n < 2) {
    // smooth: one Newton step from the mass point along the average normal
    const d = f(mx, my, mz) / Math.max(gmag, 1e-6);
    const step = Math.max(-0.75 * cell, Math.min(0.75 * cell, d));
    out.push(mx - ax * step, my - ay * step, mz - az * step);
    feat.push(0);
    return;
  }
  // crease/corner: least squares of tangent planes, regularized toward the mass point
  let a00 = 0;
  let a01 = 0;
  let a02 = 0;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (const e of edges) {
    let gx = cg[e * 3]!;
    let gy = cg[e * 3 + 1]!;
    let gz = cg[e * 3 + 2]!;
    const l = Math.hypot(gx, gy, gz) || 1;
    gx /= l;
    gy /= l;
    gz /= l;
    const d = gx * (cp[e * 3]! - mx) + gy * (cp[e * 3 + 1]! - my) + gz * (cp[e * 3 + 2]! - mz);
    a00 += gx * gx;
    a01 += gx * gy;
    a02 += gx * gz;
    a11 += gy * gy;
    a12 += gy * gz;
    a22 += gz * gz;
    b0 += gx * d;
    b1 += gy * d;
    b2 += gz * d;
  }
  const lam = 0.05 * n;
  a00 += lam;
  a11 += lam;
  a22 += lam;
  const det =
    a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
  let x = mx;
  let y = my;
  let z = mz;
  if (Math.abs(det) > 1e-12) {
    const i00 = (a11 * a22 - a12 * a12) / det;
    const i01 = (a02 * a12 - a01 * a22) / det;
    const i02 = (a01 * a12 - a02 * a11) / det;
    const i11 = (a00 * a22 - a02 * a02) / det;
    const i12 = (a02 * a01 - a00 * a12) / det;
    const i22 = (a00 * a11 - a01 * a01) / det;
    x += i00 * b0 + i01 * b1 + i02 * b2;
    y += i01 * b0 + i11 * b1 + i12 * b2;
    z += i02 * b0 + i12 * b1 + i22 * b2;
  }
  const m = cell * 0.05;
  x = Math.max(cmin[0] - m, Math.min(cmin[0] + cell + m, x));
  y = Math.max(cmin[1] - m, Math.min(cmin[1] + cell + m, y));
  z = Math.max(cmin[2] - m, Math.min(cmin[2] + cell + m, z));
  out.push(x, y, z);
  feat.push(1);
}

// ---------------------------------------------------------------------------------------------
// Post-processing helpers (CSR adjacency on the raw net)
// ---------------------------------------------------------------------------------------------

interface Csr {
  start: Int32Array;
  list: Int32Array;
}

function adjacency(mesh: PolyMesh): Csr {
  const n = mesh.p.length;
  const deg = new Int32Array(n + 1);
  for (const f of mesh.f) for (const v of f.v) deg[v]! += 1;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i]! + deg[i]!;
  const fill = new Int32Array(n);
  const list = new Int32Array(start[n]!);
  for (const f of mesh.f) {
    const k = f.v.length;
    for (let i = 0; i < k; i++) {
      const a = f.v[i]!;
      list[start[a]! + fill[a]!] = f.v[(i + 1) % k]!;
      fill[a]! += 1;
    }
  }
  return { start, list };
}

function taubinPass(adj: Csr, pos: Float64Array, factor: number, weight: Float64Array) {
  const n = weight.length;
  const next = new Float64Array(pos);
  for (let v = 0; v < n; v++) {
    const w = weight[v]!;
    if (w <= 0) continue;
    const s = adj.start[v]!;
    const e = adj.start[v + 1]!;
    if (e === s) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let q = s; q < e; q++) {
      const o = adj.list[q]! * 3;
      x += pos[o]!;
      y += pos[o + 1]!;
      z += pos[o + 2]!;
    }
    const inv = 1 / (e - s);
    const k = factor * w;
    next[v * 3] = pos[v * 3]! + (x * inv - pos[v * 3]!) * k;
    next[v * 3 + 1] = pos[v * 3 + 1]! + (y * inv - pos[v * 3 + 1]!) * k;
    next[v * 3 + 2] = pos[v * 3 + 2]! + (z * inv - pos[v * 3 + 2]!) * k;
  }
  pos.set(next);
}

function smoothColorsCsr(adj: Csr, col: Float64Array) {
  const n = col.length / 3;
  const next = new Float64Array(col.length);
  for (let v = 0; v < n; v++) {
    const s = adj.start[v]!;
    const e = adj.start[v + 1]!;
    let r = col[v * 3]! * 2;
    let g = col[v * 3 + 1]! * 2;
    let b = col[v * 3 + 2]! * 2;
    for (let q = s; q < e; q++) {
      const o = adj.list[q]! * 3;
      r += col[o]!;
      g += col[o + 1]!;
      b += col[o + 2]!;
    }
    const inv = 1 / (e - s + 2);
    next[v * 3] = r * inv;
    next[v * 3 + 1] = g * inv;
    next[v * 3 + 2] = b * inv;
  }
  col.set(next);
}

function vertexNormalsFlat(mesh: PolyMesh, pos: Float64Array): Float64Array {
  const nrm = new Float64Array(pos.length);
  for (const f of mesh.f) {
    const k = f.v.length;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < k; i++) {
      const a = f.v[i]! * 3;
      const b = f.v[(i + 1) % k]! * 3;
      nx += (pos[a + 1]! - pos[b + 1]!) * (pos[a + 2]! + pos[b + 2]!);
      ny += (pos[a + 2]! - pos[b + 2]!) * (pos[a]! + pos[b]!);
      nz += (pos[a]! - pos[b]!) * (pos[a + 1]! + pos[b + 1]!);
    }
    for (const v of f.v) {
      nrm[v * 3] = nrm[v * 3]! + nx;
      nrm[v * 3 + 1] = nrm[v * 3 + 1]! + ny;
      nrm[v * 3 + 2] = nrm[v * 3 + 2]! + nz;
    }
  }
  for (let v = 0; v < nrm.length / 3; v++) {
    const l = Math.hypot(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!) || 1;
    nrm[v * 3] = nrm[v * 3]! / l;
    nrm[v * 3 + 1] = nrm[v * 3 + 1]! / l;
    nrm[v * 3 + 2] = nrm[v * 3 + 2]! / l;
  }
  return nrm;
}
