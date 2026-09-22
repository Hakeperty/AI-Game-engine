import { add, normalize, type V2, type V3 } from './math.ts';
import { type Face, PolyMesh } from './polymesh.ts';

type Size3 = number | V3;
const size3 = (s: Size3): V3 => (typeof s === 'number' ? [s, s, s] : s);

function face(v: number[], uv: V2[] | null, g: string, sm = true): Face {
  return { v, uv, c: null, g, m: 0, sm };
}

/**
 * Axis-aligned box centered at `center`. Faces: 'top', 'bottom', 'front' (+z), 'back' (-z), 'right' (+x), 'left' (-x).
 * Vertices are shared, so subdivide() rounds it into a smooth blob.
 */
export function box(opts: { size?: Size3; center?: V3 } = {}): PolyMesh {
  const [sx, sy, sz] = size3(opts.size ?? 1);
  const c = opts.center ?? [0, 0, 0];
  const x = sx / 2;
  const y = sy / 2;
  const z = sz / 2;
  const p: V3[] = [
    [-x, -y, -z],
    [x, -y, -z],
    [x, y, -z],
    [-x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ].map((v) => add(v as V3, c));
  const uv: V2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const m = new PolyMesh();
  m.p = p;
  m.f = [
    face([4, 5, 6, 7], uv, 'front'),
    face([1, 0, 3, 2], uv, 'back'),
    face([5, 1, 2, 6], uv, 'right'),
    face([0, 4, 7, 3], uv, 'left'),
    face([7, 6, 2, 3], uv, 'top'),
    face([0, 1, 5, 4], uv, 'bottom'),
  ];
  return m;
}

/**
 * Box with beveled edges. segments = 1 gives a clean chamfer (45° edges); higher values give rounded edges.
 * `radius` is clamped to half the smallest side.
 */
export function roundedBox(
  opts: { size?: Size3; radius?: number; segments?: number; center?: V3 } = {},
): PolyMesh {
  const size = size3(opts.size ?? 1);
  const r = Math.min(opts.radius ?? 0.1, ...size.map((s) => s / 2 - 1e-4));
  const segs = Math.max(1, Math.round(opts.segments ?? 3));
  const center = opts.center ?? [0, 0, 0];
  if (r <= 0) return box({ size, center });
  if (segs === 1) return chamferBox(size, r, center);
  const h = size.map((s) => s / 2) as V3;
  // Per-axis grid coordinates: dense near the edges, one span across the flat middle.
  const coords = h.map((hh) => {
    const list: number[] = [];
    for (let i = 0; i <= segs; i++) list.push(-hh + (r * i) / segs);
    for (let i = 0; i <= segs; i++) list.push(hh - r + (r * i) / segs);
    return list;
  }) as [number[], number[], number[]];
  const m = new PolyMesh();
  const index = new Map<string, number>();
  const vert = (q: V3): number => {
    const key = q.map((v) => v.toFixed(6)).join(',');
    let i = index.get(key);
    if (i === undefined) {
      const inner = q.map((v, a) => Math.max(-(h[a]! - r), Math.min(h[a]! - r, v))) as V3;
      const d = normalize([q[0] - inner[0], q[1] - inner[1], q[2] - inner[2]]);
      i = m.p.length;
      m.p.push(add([inner[0] + d[0] * r, inner[1] + d[1] * r, inner[2] + d[2] * r], center));
      index.set(key, i);
    }
    return i;
  };
  // Build each of the 6 faces as a grid on the box surface, then project.
  const faces: { axis: 0 | 1 | 2; sign: 1 | -1; u: 0 | 1 | 2; v: 0 | 1 | 2; group: string }[] = [
    { axis: 2, sign: 1, u: 0, v: 1, group: 'front' },
    { axis: 2, sign: -1, u: 0, v: 1, group: 'back' },
    { axis: 0, sign: 1, u: 2, v: 1, group: 'right' },
    { axis: 0, sign: -1, u: 2, v: 1, group: 'left' },
    { axis: 1, sign: 1, u: 0, v: 2, group: 'top' },
    { axis: 1, sign: -1, u: 0, v: 2, group: 'bottom' },
  ];
  for (const fd of faces) {
    const us = coords[fd.u];
    const vs = coords[fd.v];
    for (let i = 0; i + 1 < us.length; i++) {
      if (us[i] === us[i + 1]) continue;
      for (let j = 0; j + 1 < vs.length; j++) {
        if (vs[j] === vs[j + 1]) continue;
        const corner = (a: number, b: number): V3 => {
          const q: V3 = [0, 0, 0];
          q[fd.axis] = fd.sign * h[fd.axis];
          q[fd.u] = us[a]!;
          q[fd.v] = vs[b]!;
          return q;
        };
        const quad = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)];
        const idx = quad.map(vert);
        const uvs: V2[] = quad.map((q) => [
          (q[fd.u] + h[fd.u]) / (2 * h[fd.u]),
          (q[fd.v] + h[fd.v]) / (2 * h[fd.v]),
        ]);
        // Orient outward (the projected quad's normal must point along the face axis).
        if (polygonNormalOf(m, idx)[fd.axis] * fd.sign < 0) {
          idx.reverse();
          uvs.reverse();
        }
        // Faces fully inside the flat middle keep the side name; bevel strips are 'bevel'.
        const flat = quad.every(
          (q) => Math.abs(q[fd.u]) <= h[fd.u] - r + 1e-9 && Math.abs(q[fd.v]) <= h[fd.v] - r + 1e-9,
        );
        m.f.push(face(idx, uvs, flat ? fd.group : 'bevel'));
      }
    }
  }
  return m.weld(1e-7);
}

function chamferBox(size: V3, b: number, center: V3): PolyMesh {
  const [x, y, z] = size.map((s) => s / 2) as V3;
  const m = new PolyMesh();
  // For each corner (sx, sy, sz), three vertices: on the x-face, y-face, z-face.
  const vid = new Map<string, number>();
  const v = (sx: number, sy: number, sz: number, onAxis: 0 | 1 | 2): number => {
    const key = `${sx}${sy}${sz}${onAxis}`;
    let i = vid.get(key);
    if (i === undefined) {
      const p: V3 = [sx * (x - b), sy * (y - b), sz * (z - b)];
      p[onAxis] = [sx * x, sy * y, sz * z][onAxis]!;
      i = m.p.length;
      m.p.push(add(p, center));
      vid.set(key, i);
    }
    return i;
  };
  const S = [-1, 1];
  const quadUv: V2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const push = (idx: number[], g: string) => {
    // orient outward using the polygon normal vs. centroid direction
    const pts = idx.map((i) => m.p[i]!);
    const c = pts.reduce((a, p) => add(a, p), [0, 0, 0] as V3).map((k) => k / pts.length) as V3;
    const n = [0, 0, 0] as V3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const bb = pts[(i + 1) % pts.length]!;
      n[0] += (a[1] - bb[1]) * (a[2] + bb[2]);
      n[1] += (a[2] - bb[2]) * (a[0] + bb[0]);
      n[2] += (a[0] - bb[0]) * (a[1] + bb[1]);
    }
    const out = n[0] * (c[0] - center[0]) + n[1] * (c[1] - center[1]) + n[2] * (c[2] - center[2]) >= 0;
    const ordered = out ? idx : [...idx].reverse();
    m.f.push(face(ordered, idx.length === 4 ? quadUv : null, g));
  };
  // Main faces
  for (const s of S) {
    push([v(s, -1, -1, 0), v(s, 1, -1, 0), v(s, 1, 1, 0), v(s, -1, 1, 0)], s > 0 ? 'right' : 'left');
    push([v(-1, s, -1, 1), v(1, s, -1, 1), v(1, s, 1, 1), v(-1, s, 1, 1)], s > 0 ? 'top' : 'bottom');
    push([v(-1, -1, s, 2), v(1, -1, s, 2), v(1, 1, s, 2), v(-1, 1, s, 2)], s > 0 ? 'front' : 'back');
  }
  // Edge bevels (12)
  for (const a of S)
    for (const c of S) {
      push([v(-1, a, c, 1), v(1, a, c, 1), v(1, a, c, 2), v(-1, a, c, 2)], 'bevel'); // x-aligned edges
      push([v(a, -1, c, 0), v(a, 1, c, 0), v(a, 1, c, 2), v(a, -1, c, 2)], 'bevel'); // y-aligned
      push([v(a, c, -1, 0), v(a, c, 1, 0), v(a, c, 1, 1), v(a, c, -1, 1)], 'bevel'); // z-aligned
    }
  // Corner triangles (8)
  for (const a of S)
    for (const bb of S) for (const c of S) push([v(a, bb, c, 0), v(a, bb, c, 1), v(a, bb, c, 2)], 'bevel');
  return m;
}

/** Flat grid in the XZ plane facing +Y. size = [width (x), depth (z)]. Group 'top'. */
export function plane(opts: { size?: number | V2; segments?: number | V2; center?: V3 } = {}): PolyMesh {
  const [w, d] = typeof opts.size === 'number' ? [opts.size, opts.size] : (opts.size ?? [1, 1]);
  const [nx, nz] =
    typeof opts.segments === 'number' ? [opts.segments, opts.segments] : (opts.segments ?? [1, 1]);
  const c = opts.center ?? [0, 0, 0];
  const m = new PolyMesh();
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) m.p.push([c[0] - w / 2 + (w * i) / nx, c[1], c[2] - d / 2 + (d * j) / nz]);
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const uv: V2[] = [
        [i / nx, 1 - (j + 1) / nz],
        [(i + 1) / nx, 1 - (j + 1) / nz],
        [(i + 1) / nx, 1 - j / nz],
        [i / nx, 1 - j / nz],
      ];
      m.f.push(face([at(i, j + 1), at(i + 1, j + 1), at(i + 1, j), at(i, j)], uv, 'top'));
    }
  return m;
}

/**
 * Surface of revolution around the Y axis. `profile` is a list of [radius, height] points from bottom to top.
 * Points with radius 0 become poles. Faces point outward when the profile goes upward.
 */
export function lathe(
  profile: V2[],
  opts: { segments?: number; angle?: number; group?: string } = {},
): PolyMesh {
  const segs = Math.max(3, Math.round(opts.segments ?? 32));
  const angle = ((opts.angle ?? 360) * Math.PI) / 180;
  const closed = Math.abs(angle - Math.PI * 2) < 1e-6;
  const cols = closed ? segs : segs + 1;
  const group = opts.group ?? 'side';
  const m = new PolyMesh();
  // cumulative profile length for v coordinate
  const lengths = [0];
  for (let j = 1; j < profile.length; j++) {
    const a = profile[j - 1]!;
    const b = profile[j]!;
    lengths.push(lengths[j - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[lengths.length - 1] || 1;
  const ring: number[][] = [];
  for (let j = 0; j < profile.length; j++) {
    const [r, y] = profile[j]!;
    if (Math.abs(r) < 1e-9) {
      const idx = m.p.length;
      m.p.push([0, y, 0]);
      ring.push(new Array(cols).fill(idx));
      continue;
    }
    const row: number[] = [];
    for (let i = 0; i < cols; i++) {
      const t = (angle * i) / segs;
      row.push(m.p.length);
      m.p.push([r * Math.sin(t), y, r * Math.cos(t)]);
    }
    ring.push(row);
  }
  for (let j = 0; j + 1 < profile.length; j++) {
    for (let i = 0; i < segs; i++) {
      const i1 = closed ? (i + 1) % segs : i + 1;
      const a = ring[j]![i]!;
      const b = ring[j]![i1]!;
      const c = ring[j + 1]![i1]!;
      const d = ring[j + 1]![i]!;
      const u0 = i / segs;
      const u1 = (i + 1) / segs;
      const v0 = lengths[j]! / total;
      const v1 = lengths[j + 1]! / total;
      const quad = [a, b, c, d];
      const uv: V2[] = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      // collapse degenerate corners at poles into triangles
      const keep = quad.map((q, k) => quad.indexOf(q) === k);
      const vv = quad.filter((_, k) => keep[k]);
      if (vv.length < 3) continue;
      m.f.push(
        face(
          vv,
          uv.filter((_, k) => keep[k]),
          group,
        ),
      );
    }
  }
  // Orient: if the result is closed and inside-out, flip it.
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  if (closed && Math.abs(first[0]) < 1e-9 && Math.abs(last[0]) < 1e-9 && m.volume() < 0) return m.flip();
  return m;
}

/** Cylinder along Y centered at the origin. radiusTop defaults to radius. Groups: 'side', 'top', 'bottom'. */
export function cylinder(
  opts: {
    radius?: number;
    radiusTop?: number;
    height?: number;
    segments?: number;
    heightSegments?: number;
    caps?: boolean;
    center?: V3;
  } = {},
): PolyMesh {
  const r0 = opts.radius ?? 0.5;
  const r1 = opts.radiusTop ?? r0;
  const h = opts.height ?? 1;
  const segs = Math.max(3, Math.round(opts.segments ?? 24));
  const hs = Math.max(1, Math.round(opts.heightSegments ?? 1));
  const profile: V2[] = [];
  for (let j = 0; j <= hs; j++) profile.push([r0 + ((r1 - r0) * j) / hs, -h / 2 + (h * j) / hs]);
  let m = lathe(profile, { segments: segs });
  if (opts.caps !== false) m = capRings(m, segs, profile);
  return opts.center ? m.translate(opts.center) : m;
}

/** Adds n-gon caps to the first and last rings of a closed lathe (skipping rows that are poles). */
function capRings(m: PolyMesh, segs: number, profile: V2[]): PolyMesh {
  const out = m.clone();
  const isPole = (row: number) => Math.abs(profile[row]![0]) < 1e-9;
  const ringStart = (row: number) => {
    let s = 0;
    for (let j = 0; j < row; j++) s += isPole(j) ? 1 : segs;
    return s;
  };
  const rows = profile.length;
  const bottom = !isPole(0);
  const top = !isPole(rows - 1);
  const cap = (row: number, g: string, up: boolean) => {
    const start = ringStart(row);
    const idx = Array.from({ length: segs }, (_, i) => start + i);
    const verts = up ? idx : [...idx].reverse();
    const uv: V2[] = verts.map((k) => {
      const p = out.p[k]!;
      const r = Math.hypot(p[0], p[2]) || 1;
      return [0.5 + (0.5 * p[0]) / r, 0.5 + ((up ? -0.5 : 0.5) * p[2]) / r];
    });
    out.f.push({ v: verts, uv, c: null, g, m: 0, sm: true });
  };
  // Lathe orders ring vertices counter-clockwise when viewed from below (+sin, +cos) -> from above it is clockwise.
  if (bottom) cap(0, 'bottom', true);
  if (top) cap(rows - 1, 'top', false);
  // Correct orientation using the normal of the cap vs. Y.
  for (const f of out.f) {
    if (f.g !== 'top' && f.g !== 'bottom') continue;
    const n = polygonNormalOf(out, f.v);
    if ((f.g === 'top' && n[1] < 0) || (f.g === 'bottom' && n[1] > 0)) {
      f.v.reverse();
      f.uv?.reverse();
    }
  }
  return out;
}

function polygonNormalOf(m: PolyMesh, v: number[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < v.length; i++) {
    const a = m.p[v[i]!]!;
    const b = m.p[v[(i + 1) % v.length]!]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Cone along Y with the apex at the top. Groups: 'side', 'bottom'. */
export function cone(
  opts: { radius?: number; height?: number; segments?: number; center?: V3 } = {},
): PolyMesh {
  const r = opts.radius ?? 0.5;
  const h = opts.height ?? 1;
  const segs = Math.max(3, Math.round(opts.segments ?? 24));
  const profile: V2[] = [
    [r, -h / 2],
    [0, h / 2],
  ];
  const m = capRings(lathe(profile, { segments: segs }), segs, profile);
  return opts.center ? m.translate(opts.center) : m;
}

/** UV sphere. Group 'surface'. */
export function sphere(
  opts: { radius?: number; segments?: number; rings?: number; center?: V3 } = {},
): PolyMesh {
  const r = opts.radius ?? 0.5;
  const segs = Math.max(3, Math.round(opts.segments ?? 32));
  const rings = Math.max(2, Math.round(opts.rings ?? 16));
  const profile: V2[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = Math.PI * (j / rings) - Math.PI / 2;
    profile.push([Math.abs(j === 0 || j === rings ? 0 : r * Math.cos(t)), r * Math.sin(t)]);
  }
  const m = lathe(profile, { segments: segs, group: 'surface' });
  return opts.center ? m.translate(opts.center) : m;
}

/** Geodesic sphere (evenly distributed triangles; nice for rocks and planets). detail 0..5. */
export function icosphere(opts: { radius?: number; detail?: number; center?: V3 } = {}): PolyMesh {
  const r = opts.radius ?? 0.5;
  const detail = Math.max(0, Math.min(6, Math.round(opts.detail ?? 2)));
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => normalize(v as V3));
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const mid = new Map<string, number>();
    const midpoint = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mid.get(key);
      if (i === undefined) {
        const pa = verts[a]!;
        const pb = verts[b]!;
        i = verts.length;
        verts = [...verts, normalize([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2])];
        mid.set(key, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces as [number, number, number][]) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const m = PolyMesh.fromPolygons(
    verts.map((v) => [v[0] * r, v[1] * r, v[2] * r]),
    faces,
    'surface',
  );
  return opts.center ? m.translate(opts.center) : m;
}

/** Torus lying flat in the XZ plane. Group 'surface'. */
export function torus(
  opts: { radius?: number; tube?: number; segments?: number; tubeSegments?: number; center?: V3 } = {},
): PolyMesh {
  const R = opts.radius ?? 0.5;
  const tube = opts.tube ?? 0.15;
  const ts = Math.max(3, Math.round(opts.tubeSegments ?? 16));
  const profile: V2[] = [];
  for (let j = 0; j <= ts; j++) {
    const a = (Math.PI * 2 * j) / ts - Math.PI / 2;
    profile.push([R + tube * Math.cos(a), tube * Math.sin(a)]);
  }
  profile[profile.length - 1] = profile[0]!;
  let m = lathe(profile, { segments: opts.segments ?? 48, group: 'surface' }).weld();
  if (m.volume() < 0) m = m.flip();
  return opts.center ? m.translate(opts.center) : m;
}

/** Capsule along Y. `height` is the total height including the hemispherical caps. */
export function capsule(
  opts: { radius?: number; height?: number; segments?: number; rings?: number; center?: V3 } = {},
): PolyMesh {
  const r = opts.radius ?? 0.5;
  const h = Math.max(opts.height ?? 2, 2 * r);
  const rings = Math.max(2, Math.round(opts.rings ?? 8));
  const half = h / 2 - r;
  const profile: V2[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = -Math.PI / 2 + (Math.PI / 2) * (j / rings);
    profile.push([j === 0 ? 0 : r * Math.cos(t), -half + r * Math.sin(t)]);
  }
  for (let j = 0; j <= rings; j++) {
    const t = (Math.PI / 2) * (j / rings);
    profile.push([j === rings ? 0 : r * Math.cos(t), half + r * Math.sin(t)]);
  }
  const m = lathe(profile, { segments: opts.segments ?? 24, group: 'surface' }).weld();
  return opts.center ? m.translate(opts.center) : m;
}

// ---------------------------------------------------------------------------------------------
// 2D shapes (for extrudeShape / sweep). Points are [x, y] counter-clockwise.
// ---------------------------------------------------------------------------------------------

export const shapes = {
  circle(radius = 0.5, segments = 32): V2[] {
    return Array.from({ length: segments }, (_, i) => {
      const a = (Math.PI * 2 * i) / segments;
      return [radius * Math.cos(a), radius * Math.sin(a)] as V2;
    });
  },
  polygon(sides = 6, radius = 0.5): V2[] {
    return shapes.circle(radius, sides);
  },
  rect(width = 1, height = 1, cornerRadius = 0, cornerSegments = 4): V2[] {
    const w = width / 2;
    const h = height / 2;
    const r = Math.min(cornerRadius, w, h);
    if (r <= 0)
      return [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ];
    const pts: V2[] = [];
    const corners: [number, number, number][] = [
      [w - r, -h + r, -90],
      [w - r, h - r, 0],
      [-w + r, h - r, 90],
      [-w + r, -h + r, 180],
    ];
    for (const [cx, cy, start] of corners) {
      for (let i = 0; i <= cornerSegments; i++) {
        const a = ((start + (90 * i) / cornerSegments) * Math.PI) / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    return pts;
  },
  star(points = 5, outer = 0.5, inner = 0.22): V2[] {
    const out: V2[] = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = Math.PI / 2 + (Math.PI * i) / points;
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return out;
  },
  /** Ensures counter-clockwise winding. */
  ccw(pts: V2[]): V2[] {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    return area < 0 ? [...pts].reverse() : pts;
  },
};
