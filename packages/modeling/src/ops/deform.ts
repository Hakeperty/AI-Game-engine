import {
  AXIS_INDEX,
  type Axis,
  add,
  clamp,
  lerp1,
  mul,
  normalize,
  Random,
  rotateAxis,
  type V2,
  type V3,
} from '../math.ts';
import { Noise } from '../noise.ts';
import { type FaceSelector, PolyMesh } from '../polymesh.ts';
import { vertexNormals } from './topology.ts';

function selectedVertices(mesh: PolyMesh, sel?: FaceSelector): Set<number> | null {
  if (!sel || sel === 'all') return null;
  const set = new Set<number>();
  for (const i of mesh.select(sel)) for (const v of mesh.f[i]!.v) set.add(v);
  return set;
}

/**
 * Pushes vertices along their normals by fractal noise. Great for rocks, terrain, organic shapes.
 * amount: max offset in meters; scale: noise frequency (higher = more detail).
 */
export function displace(
  mesh: PolyMesh,
  opts: {
    amount?: number;
    scale?: number;
    octaves?: number;
    seed?: number;
    sel?: FaceSelector;
    ridged?: boolean;
  } = {},
): PolyMesh {
  const amount = opts.amount ?? 0.1;
  const scale = opts.scale ?? 2;
  const noise = new Noise(opts.seed ?? 1);
  const normals = vertexNormals(mesh);
  const only = selectedVertices(mesh, opts.sel);
  return mesh.mapPositions((p, i) => {
    if (only && !only.has(i)) return p;
    const n = opts.ridged
      ? noise.ridged(p[0] * scale, p[1] * scale, p[2] * scale, opts.octaves ?? 4) * 2 - 0.5
      : noise.fbm(p[0] * scale, p[1] * scale, p[2] * scale, opts.octaves ?? 4);
    return add(p, mul(normals[i]!, n * amount));
  });
}

/** Moves each vertex by a small random offset (low-poly "hand made" look). */
export function jitter(mesh: PolyMesh, amount = 0.02, seed = 1): PolyMesh {
  const rng = new Random(seed);
  const moved = new Map<string, V3>();
  return mesh.mapPositions((p) => {
    // identical positions move identically so seams stay closed
    const key = p.map((v) => v.toFixed(5)).join(',');
    let off = moved.get(key);
    if (!off) {
      off = [rng.range(-amount, amount), rng.range(-amount, amount), rng.range(-amount, amount)];
      moved.set(key, off);
    }
    return add(p, off);
  });
}

/** Moves vertices along their normals by a constant distance (fatten / thin). */
export function inflate(mesh: PolyMesh, distance: number): PolyMesh {
  const normals = vertexNormals(mesh);
  return mesh.mapPositions((p, i) => add(p, mul(normals[i]!, distance)));
}

/** Twists around an axis: `degrees` of rotation per meter along that axis. */
export function twist(mesh: PolyMesh, degreesPerUnit: number, axis: Axis = 'y'): PolyMesh {
  const a = AXIS_INDEX[axis];
  const dir: V3 = [0, 0, 0];
  dir[a] = 1;
  return mesh.mapPositions((p) => rotateAxis(p, dir, (p[a] * degreesPerUnit * Math.PI) / 180));
}

/** Scales cross-sections linearly along an axis, from `start` scale at the min to `end` at the max. */
export function taper(mesh: PolyMesh, start: number, end: number, axis: Axis = 'y'): PolyMesh {
  const a = AXIS_INDEX[axis];
  const b = mesh.bounds();
  const lo = b.min[a];
  const hi = b.max[a];
  const c = b.center;
  return mesh.mapPositions((p) => {
    const t = clamp((p[a] - lo) / (hi - lo || 1), 0, 1);
    const s = lerp1(start, end, t);
    const out: V3 = [c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s, c[2] + (p[2] - c[2]) * s];
    out[a] = p[a];
    return out;
  });
}

/** Bends the mesh around the Z axis as it extends along Y; `degrees` is the total bend over the height. */
export function bend(mesh: PolyMesh, degrees: number): PolyMesh {
  if (Math.abs(degrees) < 1e-6) return mesh.clone();
  const b = mesh.bounds();
  const h = b.size[1] || 1;
  const theta = (degrees * Math.PI) / 180;
  const radius = h / theta;
  return mesh.mapPositions((p) => {
    const t = (p[1] - b.min[1]) / h;
    const ang = t * theta;
    const r = radius - p[0];
    return [radius - r * Math.cos(ang), b.min[1] + r * Math.sin(ang), p[2]];
  });
}

/** Blends every vertex toward a sphere of the mesh's average radius (0..1). */
export function spherize(mesh: PolyMesh, amount = 1): PolyMesh {
  const c = mesh.bounds().center;
  const radii = mesh.p.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  const r = radii.reduce((s, x) => s + x, 0) / (radii.length || 1);
  return mesh.mapPositions((p) => {
    const d = normalize([p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    const target: V3 = [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r];
    return [lerp1(p[0], target[0], amount), lerp1(p[1], target[1], amount), lerp1(p[2], target[2], amount)];
  });
}

// ---------------------------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------------------------

/** `count` copies, each offset by `offset` from the previous one. */
export function arrayLinear(mesh: PolyMesh, count: number, offset: V3): PolyMesh {
  const copies: PolyMesh[] = [];
  for (let i = 0; i < count; i++) copies.push(mesh.translate(mul(offset, i)));
  return PolyMesh.merge(...copies);
}

/** `count` copies rotated evenly around an axis through the origin (e.g. petals, spokes, fence posts). */
export function arrayRadial(
  mesh: PolyMesh,
  count: number,
  opts: { axis?: Axis; angle?: number } = {},
): PolyMesh {
  const axis = opts.axis ?? 'y';
  const total = opts.angle ?? 360;
  const step = Math.abs(total - 360) < 1e-6 ? total / count : total / Math.max(1, count - 1);
  const copies: PolyMesh[] = [];
  for (let i = 0; i < count; i++) {
    const deg: V3 = [0, 0, 0];
    deg[AXIS_INDEX[axis]] = step * i;
    copies.push(mesh.rotate(deg));
  }
  return PolyMesh.merge(...copies);
}

/** One copy of `mesh` at every point (optionally with per-point rotation and scale). */
export function scatter(
  mesh: PolyMesh,
  points: { position: V3; rotation?: V3; scale?: number | V3 }[],
): PolyMesh {
  return PolyMesh.merge(
    ...points.map((pt) =>
      mesh
        .scale(pt.scale ?? 1)
        .rotate(pt.rotation ?? [0, 0, 0])
        .translate(pt.position),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// UV projection
// ---------------------------------------------------------------------------------------------

/** Box (triplanar) projection: each face gets UVs from the plane most aligned with its normal. */
export function uvBox(mesh: PolyMesh, scale = 1, sel: FaceSelector = 'all'): PolyMesh {
  const m = mesh.clone();
  for (const i of m.select(sel)) {
    const n = m.faceNormal(i);
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    const f = m.f[i]!;
    f.uv = f.v.map((k) => {
      const p = m.p[k]!;
      if (ax >= ay && ax >= az) return [(n[0] > 0 ? -p[2] : p[2]) * scale, p[1] * scale] as V2;
      if (ay >= az) return [p[0] * scale, (n[1] > 0 ? -p[2] : p[2]) * scale] as V2;
      return [(n[2] > 0 ? p[0] : -p[0]) * scale, p[1] * scale] as V2;
    });
  }
  return m;
}

/** Planar projection along an axis (e.g. 'y' for ground/terrain). */
export function uvPlanar(mesh: PolyMesh, axis: Axis = 'y', scale = 1, sel: FaceSelector = 'all'): PolyMesh {
  const a = AXIS_INDEX[axis];
  const [u, v] = a === 0 ? [2, 1] : a === 1 ? [0, 2] : [0, 1];
  const m = mesh.clone();
  for (const i of m.select(sel)) {
    const f = m.f[i]!;
    f.uv = f.v.map((k) => [m.p[k]![u]! * scale, m.p[k]![v]! * scale] as V2);
  }
  return m;
}

/** Cylindrical projection around Y. */
export function uvCylindrical(mesh: PolyMesh, scale = 1, sel: FaceSelector = 'all'): PolyMesh {
  const m = mesh.clone();
  for (const i of m.select(sel)) {
    const f = m.f[i]!;
    const us = f.v.map((k) => Math.atan2(m.p[k]![0], m.p[k]![2]) / (2 * Math.PI) + 0.5);
    // fix the seam: keep all corners of a face on the same side
    const maxU = Math.max(...us);
    const fixed = us.map((u) => (maxU - u > 0.5 ? u + 1 : u));
    f.uv = f.v.map((k, j) => [fixed[j]! * scale, m.p[k]![1] * scale] as V2);
  }
  return m;
}

/** Spherical projection around the mesh center. */
export function uvSpherical(mesh: PolyMesh, sel: FaceSelector = 'all'): PolyMesh {
  const c = mesh.bounds().center;
  const m = mesh.clone();
  for (const i of m.select(sel)) {
    const f = m.f[i]!;
    const coords = f.v.map((k) => {
      const d = normalize([m.p[k]![0] - c[0], m.p[k]![1] - c[1], m.p[k]![2] - c[2]]);
      return [
        Math.atan2(d[0], d[2]) / (2 * Math.PI) + 0.5,
        Math.asin(clamp(d[1], -1, 1)) / Math.PI + 0.5,
      ] as V2;
    });
    const maxU = Math.max(...coords.map((x) => x[0]));
    f.uv = coords.map(([u, v]) => [maxU - u > 0.5 ? u + 1 : u, v] as V2);
  }
  return m;
}
