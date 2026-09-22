import {
  add,
  cross,
  dot,
  len,
  mul,
  normalize,
  parseDirection,
  type RGB,
  sub,
  type V2,
  type V3,
} from '../math.ts';
import { type Face, type FaceSelector, type PolyMesh, polygonNormal } from '../polymesh.ts';

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

const avg2 = (list: V2[]): V2 => {
  let u = 0;
  let v = 0;
  for (const x of list) {
    u += x[0];
    v += x[1];
  }
  return [u / list.length, v / list.length];
};
const avg3 = (list: V3[]): V3 => {
  const s: V3 = [0, 0, 0];
  for (const x of list) {
    s[0] += x[0];
    s[1] += x[1];
    s[2] += x[2];
  }
  return [s[0] / list.length, s[1] / list.length, s[2] / list.length];
};

export interface ExtrudeOptions {
  /** 'normal' (default) moves along the averaged face normal; or a direction like '+y' / [0,1,0]. */
  direction?: 'normal' | string | V3;
  /** Extrude each face separately instead of as connected regions. */
  individual?: boolean;
  /** Group name for the new side faces (default 'side'). */
  sideGroup?: string;
  /** Rename the moved faces (default: keep their group). */
  topGroup?: string;
  /** Scale the moved faces around their center (1 = no change) — e.g. 0.8 for tapered extrusions. */
  scale?: number;
}

/**
 * Extrudes the selected faces by `distance`, creating side walls.
 * Example: box().extrude('top', 0.5) makes the box taller; mesh.extrude({normal:'+y'}, 0.2, {scale: 0.8}).
 */
export function extrude(
  mesh: PolyMesh,
  sel: FaceSelector,
  distance: number,
  opts: ExtrudeOptions = {},
): PolyMesh {
  const m = mesh.clone();
  const selected = m.select(sel);
  if (selected.length === 0) return m;
  const regions = opts.individual ? selected.map((i) => [i]) : [selected];
  const fixedDir = opts.direction && opts.direction !== 'normal' ? parseDirection(opts.direction) : null;
  for (const region of regions) {
    const regionSet = new Set(region);
    // Offset per vertex: average of incident selected face normals.
    const normals = new Map<number, V3[]>();
    for (const fi of region) {
      const n = m.faceNormal(fi);
      for (const v of m.f[fi]!.v) {
        const list = normals.get(v) ?? [];
        list.push(n);
        normals.set(v, list);
      }
    }
    const regionCenter = avg3(region.map((fi) => m.faceCenter(fi)));
    const newIndex = new Map<number, number>();
    for (const [v, ns] of normals) {
      let dir: V3;
      if (fixedDir) dir = fixedDir;
      else {
        const nAvg = normalize(avg3(ns));
        // Keep side walls parallel for flat regions: scale by 1/cos to preserve distance to each plane.
        const minCos = Math.min(...ns.map((n) => dot(n, nAvg)));
        dir = mul(nAvg, 1 / Math.max(0.3, minCos));
      }
      let p = add(m.p[v]!, mul(dir, distance));
      if (opts.scale !== undefined && opts.scale !== 1) {
        const c = add(regionCenter, mul(fixedDir ?? normalize(avg3(ns)), distance));
        p = add(c, mul(sub(p, c), opts.scale));
      }
      newIndex.set(v, m.p.length);
      m.p.push(p);
    }
    // Boundary edges: directed edges of region faces whose twin is not in the region.
    const directed = new Set<string>();
    for (const fi of region) {
      const f = m.f[fi]!;
      for (let k = 0; k < f.v.length; k++) directed.add(`${f.v[k]}>${f.v[(k + 1) % f.v.length]}`);
    }
    const sides: Face[] = [];
    for (const fi of region) {
      const f = m.f[fi]!;
      for (let k = 0; k < f.v.length; k++) {
        const a = f.v[k]!;
        const b = f.v[(k + 1) % f.v.length]!;
        if (directed.has(`${b}>${a}`)) continue; // interior edge
        const edgeLen = len(sub(m.p[b]!, m.p[a]!));
        const ca: RGB | undefined = f.c?.[k];
        const cb: RGB | undefined = f.c?.[(k + 1) % f.v.length];
        sides.push({
          v: [a, b, newIndex.get(b)!, newIndex.get(a)!],
          uv: [
            [0, 0],
            [edgeLen, 0],
            [edgeLen, Math.abs(distance)],
            [0, Math.abs(distance)],
          ],
          c: ca && cb ? [ca, cb, cb, ca] : null,
          g: opts.sideGroup ?? 'side',
          m: f.m,
          sm: f.sm,
        });
      }
    }
    for (const fi of regionSet) {
      const f = m.f[fi]!;
      f.v = f.v.map((v) => newIndex.get(v)!);
      if (opts.topGroup) f.g = opts.topGroup;
    }
    // The same winding is correct for both directions: inward walls face into the hole.
    for (const s of sides) m.f.push(s);
  }
  return m.compact();
}

/**
 * Insets each selected face: shrinks it by `amount` (distance from its edges) and fills the gap with a rim of quads.
 * Combine with extrude to make panels, windows, buttons: mesh.inset('front', 0.1).extrude('front', -0.05)
 */
export function inset(
  mesh: PolyMesh,
  sel: FaceSelector,
  amount: number,
  opts: { rimGroup?: string } = {},
): PolyMesh {
  const m = mesh.clone();
  const selected = m.select(sel);
  for (const fi of selected) {
    const f = m.f[fi]!;
    const pts = f.v.map((k) => m.p[k]!);
    const n = polygonNormal(pts);
    const count = pts.length;
    const inner: number[] = [];
    for (let k = 0; k < count; k++) {
      const prev = pts[(k - 1 + count) % count]!;
      const cur = pts[k]!;
      const next = pts[(k + 1) % count]!;
      const e1 = normalize(sub(cur, prev));
      const e2 = normalize(sub(next, cur));
      const in1 = normalize(cross(n, e1));
      const in2 = normalize(cross(n, e2));
      const bis = normalize(add(in1, in2));
      const denom = Math.max(0.2, dot(bis, in1));
      inner.push(m.p.length);
      m.p.push(add(cur, mul(bis, amount / denom)));
    }
    const rim = opts.rimGroup ?? 'rim';
    const uvInner: V2[] | null = f.uv
      ? f.uv.map((u) => {
          const c = avg2(f.uv!);
          return [c[0] + (u[0] - c[0]) * 0.8, c[1] + (u[1] - c[1]) * 0.8];
        })
      : null;
    for (let k = 0; k < count; k++) {
      const k1 = (k + 1) % count;
      m.f.push({
        v: [f.v[k]!, f.v[k1]!, inner[k1]!, inner[k]!],
        uv: f.uv && uvInner ? [f.uv[k]!, f.uv[k1]!, uvInner[k1]!, uvInner[k]!] : null,
        c: f.c ? [f.c[k]!, f.c[k1]!, f.c[k1]!, f.c[k]!] : null,
        g: rim,
        m: f.m,
        sm: f.sm,
      });
    }
    f.v = inner;
    if (uvInner) f.uv = uvInner;
  }
  return m;
}

/**
 * Catmull-Clark subdivision. Each level splits every face into quads and smooths the surface
 * (a box becomes a rounded blob). Use smooth: false to only add resolution without rounding.
 */
export function subdivide(mesh: PolyMesh, levels = 1, opts: { smooth?: boolean } = {}): PolyMesh {
  let m = mesh;
  for (let l = 0; l < levels; l++) m = subdivideOnce(m, opts.smooth !== false);
  return m;
}

function subdivideOnce(mesh: PolyMesh, smooth: boolean): PolyMesh {
  const src = mesh;
  const out = src.empty();
  const facePoints: V3[] = src.f.map((_, i) => src.faceCenter(i));
  // Edge adjacency
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  src.f.forEach((f, fi) => {
    for (let k = 0; k < f.v.length; k++) {
      const a = f.v[k]!;
      const b = f.v[(k + 1) % f.v.length]!;
      const key = edgeKey(a, b);
      const e = edges.get(key) ?? { a, b, faces: [] };
      e.faces.push(fi);
      edges.set(key, e);
    }
  });
  // New vertex positions
  const vertFaces = new Map<number, number[]>();
  const vertEdges = new Map<number, string[]>();
  src.f.forEach((f, fi) => {
    for (const v of f.v) {
      const list = vertFaces.get(v) ?? [];
      list.push(fi);
      vertFaces.set(v, list);
    }
  });
  for (const [key, e] of edges) {
    for (const v of [e.a, e.b]) {
      const list = vertEdges.get(v) ?? [];
      list.push(key);
      vertEdges.set(v, list);
    }
  }
  const P = src.p;
  const vertIndex = new Map<number, number>();
  for (const [v, faces] of vertFaces) {
    let pos = P[v]!;
    if (smooth) {
      const incident = vertEdges.get(v) ?? [];
      const boundary = incident.filter((k) => edges.get(k)!.faces.length === 1);
      if (boundary.length >= 2) {
        const nbrs = boundary.map((k) => {
          const e = edges.get(k)!;
          return P[e.a === v ? e.b : e.a]!;
        });
        pos = add(mul(P[v]!, 0.75), mul(add(nbrs[0]!, nbrs[1]!), 0.125));
      } else if (boundary.length === 0) {
        const n = faces.length;
        const F = avg3(faces.map((fi) => facePoints[fi]!));
        const R = avg3(incident.map((k) => mul(add(P[edges.get(k)!.a]!, P[edges.get(k)!.b]!), 0.5)));
        pos = mul(add(add(F, mul(R, 2)), mul(P[v]!, n - 3)), 1 / n);
      }
    }
    vertIndex.set(v, out.p.length);
    out.p.push(pos);
  }
  const edgeIndex = new Map<string, number>();
  for (const [key, e] of edges) {
    let pos = mul(add(P[e.a]!, P[e.b]!), 0.5);
    if (smooth && e.faces.length === 2) {
      pos = avg3([P[e.a]!, P[e.b]!, facePoints[e.faces[0]!]!, facePoints[e.faces[1]!]!]);
    }
    edgeIndex.set(key, out.p.length);
    out.p.push(pos);
  }
  src.f.forEach((f, fi) => {
    const fp = out.p.length;
    out.p.push(facePoints[fi]!);
    const n = f.v.length;
    const fuv = f.uv ? avg2(f.uv) : null;
    const fc = f.c ? (avg3(f.c as V3[]) as RGB) : null;
    for (let k = 0; k < n; k++) {
      const prev = (k - 1 + n) % n;
      const next = (k + 1) % n;
      const v = f.v[k]!;
      const eNext = edgeIndex.get(edgeKey(v, f.v[next]!))!;
      const ePrev = edgeIndex.get(edgeKey(f.v[prev]!, v))!;
      out.f.push({
        v: [vertIndex.get(v)!, eNext, fp, ePrev],
        uv:
          f.uv && fuv ? [f.uv[k]!, avg2([f.uv[k]!, f.uv[next]!]), fuv, avg2([f.uv[prev]!, f.uv[k]!])] : null,
        c:
          f.c && fc
            ? [
                f.c[k]!,
                avg3([f.c[k]! as V3, f.c[next]! as V3]) as RGB,
                fc,
                avg3([f.c[prev]! as V3, f.c[k]! as V3]) as RGB,
              ]
            : null,
        g: f.g,
        m: f.m,
        sm: f.sm,
      });
    }
  });
  return out;
}

/** Area-weighted vertex normals. */
export function vertexNormals(mesh: PolyMesh): V3[] {
  const acc: V3[] = mesh.p.map(() => [0, 0, 0]);
  mesh.f.forEach((f, i) => {
    const n = mesh.faceNormal(i);
    const a = mesh.faceArea(i);
    for (const v of f.v) {
      const t = acc[v]!;
      t[0] += n[0] * a;
      t[1] += n[1] * a;
      t[2] += n[2] * a;
    }
  });
  return acc.map((n) => normalize(n));
}

/** Converts every face to triangles and back is lossy; this merges coplanar triangle pairs into quads. */
export function quadify(mesh: PolyMesh, angleDeg = 1): PolyMesh {
  const m = mesh.clone();
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const used = new Set<number>();
  const edgeFaces = new Map<string, number[]>();
  m.f.forEach((f, i) => {
    if (f.v.length !== 3) return;
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(f.v[k]!, f.v[(k + 1) % 3]!);
      const list = edgeFaces.get(key) ?? [];
      list.push(i);
      edgeFaces.set(key, list);
    }
  });
  const faces: Face[] = [];
  for (const [key, list] of edgeFaces) {
    if (list.length !== 2) continue;
    const [i, j] = list as [number, number];
    if (used.has(i) || used.has(j)) continue;
    const fi = m.f[i]!;
    const fj = m.f[j]!;
    if (fi.g !== fj.g || fi.m !== fj.m || fi.uv || fi.c) continue;
    if (dot(m.faceNormal(i), m.faceNormal(j)) < cosT) continue;
    const [a, b] = key.split('_').map(Number) as [number, number];
    const oi = fi.v.find((v) => v !== a && v !== b)!;
    const oj = fj.v.find((v) => v !== a && v !== b)!;
    // walk fi starting after the shared edge to build a quad preserving winding
    const k = fi.v.indexOf(oi);
    const quad = [oi, fi.v[(k + 1) % 3]!, oj, fi.v[(k + 2) % 3]!];
    faces.push({ ...fi, v: quad });
    used.add(i);
    used.add(j);
  }
  m.f.forEach((f, i) => {
    if (!used.has(i)) faces.push(f);
  });
  m.f = faces;
  return m;
}
