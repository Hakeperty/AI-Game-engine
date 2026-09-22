import { ShapeUtils, Vector2 } from 'three';
import {
  DEFAULT_MATERIAL,
  type MaterialInput,
  type MaterialSpec,
  material,
  materialKey,
} from './material.ts';
import {
  AXIS_INDEX,
  type Axis,
  add,
  applyMat3,
  type ColorInput,
  clamp,
  cross,
  dot,
  len,
  mixColor,
  normalize,
  parseDirection,
  type RGB,
  rotationMatrix,
  sub,
  toRgb,
  type V2,
  type V3,
} from './math.ts';

export interface Face {
  /** Vertex indices, counter-clockwise when seen from outside. */
  v: number[];
  /** Per-corner UVs (same length as v) or null. */
  uv: V2[] | null;
  /** Per-corner sRGB colors (same length as v) or null. */
  c: RGB[] | null;
  /** Face group name used by selectors ('top', 'side', ...). */
  g: string;
  /** Material slot index into PolyMesh.materials. */
  m: number;
  /** Smooth shaded (normals averaged with neighbours below the auto-smooth angle). */
  sm: boolean;
}

export interface FaceInfo {
  index: number;
  center: V3;
  normal: V3;
  area: number;
  group: string;
  material: number;
}

export interface Bounds {
  min: V3;
  max: V3;
  size: V3;
  center: V3;
}

/**
 * Face selector:
 * - 'all' | group name | list of group names
 * - { group, normal: '+y' | [x,y,z], minDot (default 0.7), within: {min,max}, above, below }
 * - (face) => boolean
 */
export type FaceSelector =
  | string
  | string[]
  | {
      group?: string | string[];
      normal?: string | V3;
      minDot?: number;
      within?: { min: V3; max: V3 };
      above?: number;
      below?: number;
      where?: (f: FaceInfo) => boolean;
    }
  | ((f: FaceInfo) => boolean);

export class PolyMesh {
  p: V3[] = [];
  f: Face[] = [];
  materials: MaterialSpec[] = [DEFAULT_MATERIAL];

  static fromPolygons(positions: V3[], polygons: number[][], group = ''): PolyMesh {
    const m = new PolyMesh();
    m.p = positions.map((v) => [v[0], v[1], v[2]]);
    m.f = polygons.map((v) => ({ v: [...v], uv: null, c: null, g: group, m: 0, sm: true }));
    return m;
  }

  /** Combines several meshes into one (materials are merged by value). */
  static merge(...meshes: PolyMesh[]): PolyMesh {
    const out = new PolyMesh();
    out.materials = [];
    const matIndex = new Map<string, number>();
    for (const mesh of meshes) {
      const offset = out.p.length;
      for (const v of mesh.p) out.p.push([v[0], v[1], v[2]]);
      const remap = mesh.materials.map((mat) => {
        const key = materialKey(mat);
        let i = matIndex.get(key);
        if (i === undefined) {
          i = out.materials.length;
          out.materials.push(mat);
          matIndex.set(key, i);
        }
        return i;
      });
      for (const face of mesh.f)
        out.f.push({ ...cloneFace(face), v: face.v.map((i) => i + offset), m: remap[face.m] ?? 0 });
    }
    if (out.materials.length === 0) out.materials = [DEFAULT_MATERIAL];
    return out;
  }

  clone(): PolyMesh {
    const m = new PolyMesh();
    m.p = this.p.map((v) => [v[0], v[1], v[2]]);
    m.f = this.f.map(cloneFace);
    m.materials = [...this.materials];
    return m;
  }

  /** A new empty mesh with the same materials. */
  empty(): PolyMesh {
    const m = new PolyMesh();
    m.materials = [...this.materials];
    return m;
  }

  get vertexCount(): number {
    return this.p.length;
  }

  get faceCount(): number {
    return this.f.length;
  }

  get triangleCount(): number {
    return this.f.reduce((n, f) => n + Math.max(0, f.v.length - 2), 0);
  }

  // ------------------------------------------------------------------ face geometry

  /** Newell normal: robust for concave and slightly non-planar polygons. */
  faceNormal(i: number): V3 {
    return polygonNormal(this.f[i]!.v.map((k) => this.p[k]!));
  }

  faceCenter(i: number): V3 {
    const f = this.f[i]!;
    const c: V3 = [0, 0, 0];
    for (const k of f.v) {
      const p = this.p[k]!;
      c[0] += p[0];
      c[1] += p[1];
      c[2] += p[2];
    }
    return [c[0] / f.v.length, c[1] / f.v.length, c[2] / f.v.length];
  }

  faceArea(i: number): number {
    return polygonArea(this.f[i]!.v.map((k) => this.p[k]!));
  }

  faceInfo(i: number): FaceInfo {
    const f = this.f[i]!;
    return {
      index: i,
      center: this.faceCenter(i),
      normal: this.faceNormal(i),
      area: this.faceArea(i),
      group: f.g,
      material: f.m,
    };
  }

  /** Indices of faces matching the selector. */
  select(sel: FaceSelector = 'all'): number[] {
    const out: number[] = [];
    if (sel === 'all') return this.f.map((_, i) => i);
    let test: (i: number) => boolean;
    if (typeof sel === 'string') test = (i) => this.f[i]!.g === sel;
    else if (Array.isArray(sel)) {
      const set = new Set(sel);
      test = (i) => set.has(this.f[i]!.g);
    } else if (typeof sel === 'function') test = (i) => sel(this.faceInfo(i));
    else {
      const groups =
        sel.group === undefined ? null : new Set(Array.isArray(sel.group) ? sel.group : [sel.group]);
      const dir = sel.normal === undefined ? null : parseDirection(sel.normal);
      const minDot = sel.minDot ?? 0.7;
      test = (i) => {
        if (groups && !groups.has(this.f[i]!.g)) return false;
        if (dir && dot(this.faceNormal(i), dir) < minDot) return false;
        if (sel.within || sel.above !== undefined || sel.below !== undefined || sel.where) {
          const info = this.faceInfo(i);
          const c = info.center;
          if (sel.within) {
            const { min, max } = sel.within;
            if (
              c[0] < min[0] ||
              c[1] < min[1] ||
              c[2] < min[2] ||
              c[0] > max[0] ||
              c[1] > max[1] ||
              c[2] > max[2]
            )
              return false;
          }
          if (sel.above !== undefined && c[1] < sel.above) return false;
          if (sel.below !== undefined && c[1] > sel.below) return false;
          if (sel.where && !sel.where(info)) return false;
        }
        return true;
      };
    }
    for (let i = 0; i < this.f.length; i++) if (test(i)) out.push(i);
    return out;
  }

  /** Names of all face groups present in the mesh. */
  groups(): string[] {
    return [...new Set(this.f.map((f) => f.g).filter(Boolean))];
  }

  bounds(): Bounds {
    if (this.p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const used = new Set<number>();
    for (const f of this.f) for (const k of f.v) used.add(k);
    for (const k of used) {
      const v = this.p[k]!;
      for (let a = 0; a < 3; a++) {
        if (v[a]! < min[a]!) min[a] = v[a]!;
        if (v[a]! > max[a]!) max[a] = v[a]!;
      }
    }
    const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return { min, max, size, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  }

  // ------------------------------------------------------------------ transforms (return new meshes)

  mapPositions(fn: (p: V3, index: number) => V3): PolyMesh {
    const m = this.clone();
    m.p = m.p.map((v, i) => {
      const r = fn([v[0], v[1], v[2]], i);
      return [r[0], r[1], r[2]];
    });
    return m;
  }

  translate(offset: V3): PolyMesh {
    return this.mapPositions((v) => add(v, offset));
  }

  /** Rotate by Euler degrees [x, y, z] (XYZ order) around `pivot` (default origin). */
  rotate(deg: V3, pivot: V3 = [0, 0, 0]): PolyMesh {
    const r = rotationMatrix(deg);
    return this.mapPositions((v) => add(applyMat3(r, sub(v, pivot)), pivot));
  }

  /** Uniform or per-axis scale around `pivot` (default origin). Negative scales flip winding automatically. */
  scale(s: number | V3, pivot: V3 = [0, 0, 0]): PolyMesh {
    const k: V3 = typeof s === 'number' ? [s, s, s] : s;
    const m = this.mapPositions((v) => [
      (v[0] - pivot[0]) * k[0] + pivot[0],
      (v[1] - pivot[1]) * k[1] + pivot[1],
      (v[2] - pivot[2]) * k[2] + pivot[2],
    ]);
    return k[0] * k[1] * k[2] < 0 ? m.flip() : m;
  }

  /** Moves the mesh so its bounds center (or chosen axes) is at `target`. */
  center(target: V3 = [0, 0, 0], axes: Axis[] = ['x', 'y', 'z']): PolyMesh {
    const c = this.bounds().center;
    const off: V3 = [0, 0, 0];
    for (const a of axes) off[AXIS_INDEX[a]] = target[AXIS_INDEX[a]] - c[AXIS_INDEX[a]];
    return this.translate(off);
  }

  /** Moves the mesh so its lowest point sits at y = `y` (keeps x/z). */
  placeOnGround(y = 0): PolyMesh {
    return this.translate([0, y - this.bounds().min[1], 0]);
  }

  /** Mirrored copy across the plane through the origin perpendicular to `axis` (winding fixed). */
  flipAxis(axis: Axis): PolyMesh {
    const s: V3 = [1, 1, 1];
    s[AXIS_INDEX[axis]] = -1;
    return this.scale(s);
  }

  /** Symmetry: this mesh plus its mirror image across `axis`, welded at the seam. */
  mirror(axis: Axis = 'x'): PolyMesh {
    return PolyMesh.merge(this, this.flipAxis(axis)).weld();
  }

  /** Reverses face winding (turns the mesh inside out). */
  flip(): PolyMesh {
    const m = this.clone();
    for (const f of m.f) {
      f.v.reverse();
      f.uv?.reverse();
      f.c?.reverse();
    }
    return m;
  }

  /** Combine with other meshes. */
  merge(...others: PolyMesh[]): PolyMesh {
    return PolyMesh.merge(this, ...others);
  }

  // ------------------------------------------------------------------ attributes

  /** Assigns a group name to the selected faces. */
  group(name: string, sel: FaceSelector = 'all'): PolyMesh {
    const m = this.clone();
    for (const i of m.select(sel)) m.f[i]!.g = name;
    return m;
  }

  /** Sets a material for all (or the selected) faces. */
  material(spec: MaterialInput | MaterialSpec, sel: FaceSelector = 'all'): PolyMesh {
    const mat = material(spec as MaterialInput);
    const m = this.clone();
    const idx = sel === 'all' ? m.select('all') : m.select(sel);
    if (idx.length === m.f.length) {
      m.materials = [mat];
      for (const f of m.f) f.m = 0;
      return m;
    }
    let slot = m.materials.findIndex((x) => materialKey(x) === materialKey(mat));
    if (slot < 0) {
      slot = m.materials.length;
      m.materials.push(mat);
    }
    for (const i of idx) m.f[i]!.m = slot;
    return m;
  }

  /** Paints the selected faces with a solid vertex color. */
  color(c: ColorInput, sel: FaceSelector = 'all'): PolyMesh {
    const rgb = toRgb(c);
    const m = this.clone();
    for (const i of m.select(sel)) {
      const f = m.f[i]!;
      f.c = f.v.map(() => [rgb[0], rgb[1], rgb[2]]);
    }
    return m;
  }

  /** Vertex-color gradient along an axis between the mesh bounds (or `range`). */
  gradient(
    axis: Axis,
    from: ColorInput,
    to: ColorInput,
    opts: { range?: [number, number]; sel?: FaceSelector } = {},
  ): PolyMesh {
    const a = AXIS_INDEX[axis];
    const b = this.bounds();
    const [lo, hi] = opts.range ?? [b.min[a], b.max[a]];
    const m = this.clone();
    for (const i of m.select(opts.sel ?? 'all')) {
      const f = m.f[i]!;
      f.c = f.v.map((k) => mixColor(from, to, clamp((m.p[k]![a] - lo) / (hi - lo || 1), 0, 1)));
    }
    return m;
  }

  /** Per-corner color from a function of the vertex position and face normal. */
  colorBy(fn: (p: V3, normal: V3) => ColorInput, sel: FaceSelector = 'all'): PolyMesh {
    const m = this.clone();
    for (const i of m.select(sel)) {
      const f = m.f[i]!;
      const n = m.faceNormal(i);
      f.c = f.v.map((k) => toRgb(fn(m.p[k]!, n)));
    }
    return m;
  }

  /** Smooth (true) or flat (false) shading for all or selected faces. */
  smooth(on = true, sel: FaceSelector = 'all'): PolyMesh {
    const m = this.clone();
    for (const i of m.select(sel)) m.f[i]!.sm = on;
    return m;
  }

  flat(sel: FaceSelector = 'all'): PolyMesh {
    return this.smooth(false, sel);
  }

  // ------------------------------------------------------------------ topology

  /** Merges vertices closer than `eps`; drops faces that collapse. */
  weld(eps = 1e-5): PolyMesh {
    const m = this.clone();
    const inv = 1 / eps;
    const map = new Map<string, number>();
    const remap: number[] = [];
    const np: V3[] = [];
    for (let i = 0; i < m.p.length; i++) {
      const v = m.p[i]!;
      const key = `${Math.round(v[0] * inv)},${Math.round(v[1] * inv)},${Math.round(v[2] * inv)}`;
      let j = map.get(key);
      if (j === undefined) {
        j = np.length;
        np.push(v);
        map.set(key, j);
      }
      remap[i] = j;
    }
    m.p = np;
    const faces: Face[] = [];
    for (const f of m.f) {
      const v: number[] = [];
      const uv: V2[] = [];
      const c: RGB[] = [];
      for (let k = 0; k < f.v.length; k++) {
        const idx = remap[f.v[k]!]!;
        if (v.length && v[v.length - 1] === idx) continue;
        v.push(idx);
        if (f.uv) uv.push(f.uv[k]!);
        if (f.c) c.push(f.c[k]!);
      }
      while (v.length > 1 && v[0] === v[v.length - 1]) {
        v.pop();
        uv.pop();
        c.pop();
      }
      if (new Set(v).size < 3) continue;
      faces.push({ ...f, v, uv: f.uv ? uv : null, c: f.c ? c : null });
    }
    m.f = faces;
    return m.compact();
  }

  /** Removes unused vertices. */
  compact(): PolyMesh {
    const used = new Map<number, number>();
    const np: V3[] = [];
    for (const f of this.f) {
      for (const k of f.v) {
        if (!used.has(k)) {
          used.set(k, np.length);
          np.push(this.p[k]!);
        }
      }
    }
    const m = this.empty();
    m.p = np.map((v) => [v[0], v[1], v[2]]);
    m.f = this.f.map((f) => ({ ...cloneFace(f), v: f.v.map((k) => used.get(k)!) }));
    return m;
  }

  /** Splits every polygon into triangles (ear clipping for concave polygons). */
  triangulate(): PolyMesh {
    const m = this.empty();
    m.p = this.p.map((v) => [v[0], v[1], v[2]]);
    for (const f of this.f) {
      if (f.v.length === 3) {
        m.f.push(cloneFace(f));
        continue;
      }
      for (const tri of triangulatePolygon(f.v.map((k) => this.p[k]!))) {
        m.f.push({
          v: tri.map((t) => f.v[t]!),
          uv: f.uv ? tri.map((t) => f.uv![t]!) : null,
          c: f.c ? tri.map((t) => f.c![t]!) : null,
          g: f.g,
          m: f.m,
          sm: f.sm,
        });
      }
    }
    return m;
  }

  /** Signed volume (positive for closed, outward-facing meshes). */
  volume(): number {
    let vol = 0;
    for (const f of this.f) {
      const a = this.p[f.v[0]!]!;
      for (let k = 1; k + 1 < f.v.length; k++) {
        const b = this.p[f.v[k]!]!;
        const c = this.p[f.v[k + 1]!]!;
        vol += dot(a, cross(b, c)) / 6;
      }
    }
    return vol;
  }

  surfaceArea(): number {
    let a = 0;
    for (let i = 0; i < this.f.length; i++) a += this.faceArea(i);
    return a;
  }
}

export function cloneFace(f: Face): Face {
  return {
    v: [...f.v],
    uv: f.uv ? f.uv.map((u) => [u[0], u[1]]) : null,
    c: f.c ? f.c.map((c) => [c[0], c[1], c[2]]) : null,
    g: f.g,
    m: f.m,
    sm: f.sm,
  };
}

export function polygonNormal(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}

export function polygonArea(pts: V3[]): number {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const c = cross(pts[i]!, pts[(i + 1) % pts.length]!);
    n[0] += c[0];
    n[1] += c[1];
    n[2] += c[2];
  }
  return len(n) / 2;
}

/** Triangulates a (possibly concave) planar polygon; returns corner-index triples. */
export function triangulatePolygon(pts: V3[]): number[][] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const normal = polygonNormal(pts);
  if (n === 4) {
    // Split along the shorter diagonal, unless that produces a fold (concave quad).
    const d02 = len(sub(pts[0]!, pts[2]!));
    const d13 = len(sub(pts[1]!, pts[3]!));
    const a: number[][] = [
      [0, 1, 2],
      [0, 2, 3],
    ];
    const b: number[][] = [
      [0, 1, 3],
      [1, 2, 3],
    ];
    const ok = (tris: number[][]) => tris.every((t) => dot(polygonNormal(t.map((i) => pts[i]!)), normal) > 0);
    if (d02 <= d13) return ok(a) ? a : b;
    return ok(b) ? b : a;
  }
  // Project onto the dominant plane and use three's earcut.
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  let u: 0 | 1 | 2 = 0;
  let v: 0 | 1 | 2 = 1;
  if (ax >= ay && ax >= az) {
    u = 1;
    v = 2;
  } else if (ay >= az) {
    u = 2;
    v = 0;
  }
  const flip = (ax >= ay && ax >= az ? normal[0] : ay >= az ? normal[1] : normal[2]) < 0;
  const contour = pts.map((p) => new Vector2(flip ? p[v] : p[u], flip ? p[u] : p[v]));
  const tris = ShapeUtils.triangulateShape(contour, []);
  // earcut output winding follows the 2D contour; re-orient to match the polygon normal.
  return tris.map((t) => {
    const tri = [t[0]!, t[1]!, t[2]!];
    return dot(polygonNormal(tri.map((i) => pts[i]!)), normal) < 0 ? [tri[0]!, tri[2]!, tri[1]!] : tri;
  });
}
