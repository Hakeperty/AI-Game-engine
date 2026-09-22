import {
  applyMat3,
  type ColorInput,
  clamp,
  lerp1,
  mixColor,
  type RGB,
  rotationMatrix,
  toRgb,
  type V3,
} from './math.ts';
import { Noise } from './noise.ts';
import { PolyMesh } from './polymesh.ts';

type Field = (x: number, y: number, z: number) => number;
type ColorField = (x: number, y: number, z: number) => RGB;
interface Box3 {
  min: V3;
  max: V3;
}

const expand = (b: Box3, d: number): Box3 => ({
  min: [b.min[0] - d, b.min[1] - d, b.min[2] - d],
  max: [b.max[0] + d, b.max[1] + d, b.max[2] + d],
});
const unionBox = (a: Box3, b: Box3): Box3 => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});
const intersectBox = (a: Box3, b: Box3): Box3 => ({
  min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])],
  max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])],
});

/**
 * Signed distance field (negative inside). Combine shapes with (smooth) booleans, then call .mesh().
 * Each shape can carry a color; unions keep the color of the nearest surface (blended in smooth unions).
 * Example: sdf.sphere(0.5).smoothUnion(sdf.sphere(0.35, [0, 0.6, 0]), 0.2).color('#6cc24a').mesh({ resolution: 48 })
 */
export class Sdf {
  readonly f: Field;
  readonly c: ColorField | null;
  readonly bounds: Box3;

  constructor(f: Field, bounds: Box3, c: ColorField | null = null) {
    this.f = f;
    this.bounds = bounds;
    this.c = c;
  }

  distance(p: V3): number {
    return this.f(p[0], p[1], p[2]);
  }

  /** Solid color for this shape. */
  color(c: ColorInput): Sdf {
    const rgb = toRgb(c);
    return new Sdf(this.f, this.bounds, () => rgb);
  }

  /** Color from a function of position (e.g. gradients, spots). */
  colorBy(fn: (p: V3) => ColorInput): Sdf {
    return new Sdf(this.f, this.bounds, (x, y, z) => toRgb(fn([x, y, z])));
  }

  union(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'union', 0), this);
  }

  subtract(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'subtract', 0), this);
  }

  intersect(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'intersect', 0), this);
  }

  /** Union with a smooth blend of radius k (meters) — the key to organic "clay" shapes. */
  smoothUnion(other: Sdf, k = 0.1): Sdf {
    return this.combine(other, 'union', k);
  }

  smoothSubtract(other: Sdf, k = 0.1): Sdf {
    return this.combine(other, 'subtract', k);
  }

  smoothIntersect(other: Sdf, k = 0.1): Sdf {
    return this.combine(other, 'intersect', k);
  }

  private combine(o: Sdf, op: 'union' | 'subtract' | 'intersect', k: number): Sdf {
    const fa = this.f;
    const fb = o.f;
    const ca = this.c;
    const cb = o.c;
    const white: RGB = [1, 1, 1];
    let f: Field;
    let bounds: Box3;
    if (op === 'union') {
      bounds = expand(unionBox(this.bounds, o.bounds), k);
      f =
        k > 0
          ? (x, y, z) => {
              const a = fa(x, y, z);
              const b = fb(x, y, z);
              const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
              return lerp1(b, a, h) - k * h * (1 - h);
            }
          : (x, y, z) => Math.min(fa(x, y, z), fb(x, y, z));
    } else if (op === 'subtract') {
      bounds = this.bounds;
      f =
        k > 0
          ? (x, y, z) => {
              const a = fa(x, y, z);
              const b = -fb(x, y, z);
              const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
              return lerp1(a, b, h) + k * h * (1 - h);
            }
          : (x, y, z) => Math.max(fa(x, y, z), -fb(x, y, z));
    } else {
      bounds = intersectBox(this.bounds, o.bounds);
      f =
        k > 0
          ? (x, y, z) => {
              const a = fa(x, y, z);
              const b = fb(x, y, z);
              const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
              return lerp1(b, a, h) + k * h * (1 - h);
            }
          : (x, y, z) => Math.max(fa(x, y, z), fb(x, y, z));
    }
    let c: ColorField | null = null;
    if (ca || cb) {
      const colA = ca ?? (() => white);
      const colB = cb ?? (() => white);
      if (op === 'subtract')
        c = (x, y, z) => (Math.abs(fa(x, y, z)) <= Math.abs(fb(x, y, z)) ? colA(x, y, z) : colB(x, y, z));
      else if (k > 0) {
        c = (x, y, z) => {
          const a = fa(x, y, z);
          const b = fb(x, y, z);
          const t = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
          return mixColor(colA(x, y, z), colB(x, y, z), t);
        };
      } else c = (x, y, z) => (fa(x, y, z) <= fb(x, y, z) ? colA(x, y, z) : colB(x, y, z));
    }
    return new Sdf(f, bounds, c);
  }

  translate(v: V3): Sdf {
    const { f, c } = this;
    return new Sdf(
      (x, y, z) => f(x - v[0], y - v[1], z - v[2]),
      {
        min: [this.bounds.min[0] + v[0], this.bounds.min[1] + v[1], this.bounds.min[2] + v[2]],
        max: [this.bounds.max[0] + v[0], this.bounds.max[1] + v[1], this.bounds.max[2] + v[2]],
      },
      c ? (x, y, z) => c(x - v[0], y - v[1], z - v[2]) : null,
    );
  }

  /** Rotate by Euler degrees (XYZ) around the origin. */
  rotate(deg: V3): Sdf {
    const r = rotationMatrix(deg);
    // inverse rotation = transpose
    const inv = [r[0]!, r[3]!, r[6]!, r[1]!, r[4]!, r[7]!, r[2]!, r[5]!, r[8]!];
    const { f, c } = this;
    const corners: V3[] = [];
    for (const x of [this.bounds.min[0], this.bounds.max[0]])
      for (const y of [this.bounds.min[1], this.bounds.max[1]])
        for (const z of [this.bounds.min[2], this.bounds.max[2]]) corners.push(applyMat3(r, [x, y, z]));
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of corners)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, p[a]!);
        max[a] = Math.max(max[a]!, p[a]!);
      }
    const tf = (x: number, y: number, z: number): V3 => applyMat3(inv, [x, y, z]);
    return new Sdf(
      (x, y, z) => {
        const p = tf(x, y, z);
        return f(p[0], p[1], p[2]);
      },
      { min, max },
      c
        ? (x, y, z) => {
            const p = tf(x, y, z);
            return c(p[0], p[1], p[2]);
          }
        : null,
    );
  }

  /** Uniform scale around the origin. */
  scale(s: number): Sdf {
    const { f, c } = this;
    return new Sdf(
      (x, y, z) => f(x / s, y / s, z / s) * s,
      { min: this.bounds.min.map((v) => v * s) as V3, max: this.bounds.max.map((v) => v * s) as V3 },
      c ? (x, y, z) => c(x / s, y / s, z / s) : null,
    );
  }

  /** Grows (positive) or shrinks the shape; also rounds sharp edges. */
  round(r: number): Sdf {
    const { f } = this;
    return new Sdf((x, y, z) => f(x, y, z) - r, expand(this.bounds, Math.max(0, r)), this.c);
  }

  /** Hollow shell of the given thickness. */
  shell(thickness: number): Sdf {
    const { f } = this;
    return new Sdf((x, y, z) => Math.abs(f(x, y, z)) - thickness / 2, expand(this.bounds, thickness), this.c);
  }

  /** Bumpy surface from fractal noise (rocks, terrain lumps, clay). */
  displace(amount = 0.05, scale = 3, seed = 1, octaves = 3): Sdf {
    const n = new Noise(seed);
    const { f } = this;
    return new Sdf(
      (x, y, z) => f(x, y, z) + amount * n.fbm(x * scale, y * scale, z * scale, octaves),
      expand(this.bounds, Math.abs(amount)),
      this.c,
    );
  }

  /** Mirror across the YZ plane (symmetry on X): whatever is at +x also appears at -x. */
  mirrorX(): Sdf {
    const { f, c } = this;
    const b = this.bounds;
    const m = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
    return new Sdf(
      (x, y, z) => f(Math.abs(x), y, z),
      { min: [-m, b.min[1], b.min[2]], max: [m, b.max[1], b.max[2]] },
      c ? (x, y, z) => c(Math.abs(x), y, z) : null,
    );
  }

  /** Meshes the field with surface nets. resolution = cells along the longest side (16..160). */
  mesh(opts: { resolution?: number; padding?: number } = {}): PolyMesh {
    return surfaceNets(this, opts.resolution ?? 48, opts.padding ?? 0.02);
  }
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const box3 = (c: V3, h: V3): Box3 => ({
  min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
  max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
});

export const sdf = {
  sphere(radius = 0.5, center: V3 = [0, 0, 0]): Sdf {
    const [cx, cy, cz] = center;
    return new Sdf(
      (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - radius,
      box3(center, [radius, radius, radius]),
    );
  },

  /** Ellipsoid with radii [rx, ry, rz] (approximate distance). */
  ellipsoid(radii: V3, center: V3 = [0, 0, 0]): Sdf {
    const [cx, cy, cz] = center;
    const [a, b, c] = radii;
    return new Sdf(
      (x, y, z) => {
        const px = (x - cx) / a;
        const py = (y - cy) / b;
        const pz = (z - cz) / c;
        const k0 = Math.hypot(px, py, pz);
        const k1 = Math.hypot(px / a, py / b, pz / c);
        return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c);
      },
      box3(center, radii),
    );
  },

  /** Box with full size [x, y, z]; `round` rounds its edges. */
  box(size: V3 | number = 1, center: V3 = [0, 0, 0], round = 0): Sdf {
    const s: V3 = typeof size === 'number' ? [size, size, size] : size;
    const h: V3 = [s[0] / 2 - round, s[1] / 2 - round, s[2] / 2 - round];
    const [cx, cy, cz] = center;
    return new Sdf(
      (x, y, z) => {
        const qx = Math.abs(x - cx) - h[0];
        const qy = Math.abs(y - cy) - h[1];
        const qz = Math.abs(z - cz) - h[2];
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
        return outside + Math.min(Math.max(qx, qy, qz), 0) - round;
      },
      box3(center, [s[0] / 2, s[1] / 2, s[2] / 2]),
    );
  },

  /** Capsule (rounded line segment) from a to b. Perfect for limbs, horns, tails. */
  capsule(a: V3, b: V3, radius = 0.1, radiusB?: number): Sdf {
    const rb = radiusB ?? radius;
    const ba: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const bb = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2] || 1e-12;
    const rmax = Math.max(radius, rb);
    return new Sdf(
      (x, y, z) => {
        const px = x - a[0];
        const py = y - a[1];
        const pz = z - a[2];
        const t = clamp((px * ba[0] + py * ba[1] + pz * ba[2]) / bb, 0, 1);
        return Math.hypot(px - ba[0] * t, py - ba[1] * t, pz - ba[2] * t) - lerp1(radius, rb, t);
      },
      {
        min: [Math.min(a[0], b[0]) - rmax, Math.min(a[1], b[1]) - rmax, Math.min(a[2], b[2]) - rmax],
        max: [Math.max(a[0], b[0]) + rmax, Math.max(a[1], b[1]) + rmax, Math.max(a[2], b[2]) + rmax],
      },
    );
  },

  /** Cylinder along Y. */
  cylinder(radius = 0.5, height = 1, center: V3 = [0, 0, 0], round = 0): Sdf {
    const [cx, cy, cz] = center;
    const r = radius - round;
    const h = height / 2 - round;
    return new Sdf(
      (x, y, z) => {
        const dx = Math.hypot(x - cx, z - cz) - r;
        const dy = Math.abs(y - cy) - h;
        return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - round;
      },
      box3(center, [radius, height / 2, radius]),
    );
  },

  /** Torus in the XZ plane. */
  torus(radius = 0.5, tube = 0.15, center: V3 = [0, 0, 0]): Sdf {
    const [cx, cy, cz] = center;
    return new Sdf(
      (x, y, z) => Math.hypot(Math.hypot(x - cx, z - cz) - radius, y - cy) - tube,
      box3(center, [radius + tube, tube, radius + tube]),
    );
  },

  /** Cone along Y with the tip at the top (approximate distance). */
  cone(radius = 0.5, height = 1, center: V3 = [0, 0, 0]): Sdf {
    const [cx, cy, cz] = center;
    const len = Math.hypot(radius, height);
    return new Sdf(
      (x, y, z) => {
        const q = Math.hypot(x - cx, z - cz);
        const py = y - cy + height / 2;
        const side = (q * height + (py - height) * radius) / len;
        return Math.max(side, -py, py - height);
      },
      box3(center, [radius, height / 2, radius]),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// Surface nets
// ---------------------------------------------------------------------------------------------

function surfaceNets(shape: Sdf, resolution: number, padding: number): PolyMesh {
  const res = Math.max(8, Math.min(200, Math.round(resolution)));
  const b = expand(shape.bounds, padding);
  const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const cell = Math.max(size[0], size[1], size[2]) / res;
  // one extra cell of margin on every side so the surface is always closed
  const origin: V3 = [b.min[0] - cell, b.min[1] - cell, b.min[2] - cell];
  const nx = Math.ceil(size[0] / cell) + 2;
  const ny = Math.ceil(size[1] / cell) + 2;
  const nz = Math.ceil(size[2] / cell) + 2;
  const sx = nx + 1;
  const sy = ny + 1;
  const field = new Float32Array(sx * sy * (nz + 1));
  const gi = (i: number, j: number, k: number) => i + sx * (j + sy * k);
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++)
        field[gi(i, j, k)] = shape.f(origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell);

  const mesh = new PolyMesh();
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const ci = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const cornerOffsets: V3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges: [number, number][] = [
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
  const vals = new Float32Array(8);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const o = cornerOffsets[c]!;
          vals[c] = field[gi(i + o[0], j + o[1], k + o[2])]!;
          if (vals[c]! < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let px = 0;
        let py = 0;
        let pz = 0;
        let n = 0;
        for (const [a, bb] of edges) {
          const va = vals[a]!;
          const vb = vals[bb]!;
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const oa = cornerOffsets[a]!;
          const ob = cornerOffsets[bb]!;
          px += oa[0] + (ob[0] - oa[0]) * t;
          py += oa[1] + (ob[1] - oa[1]) * t;
          pz += oa[2] + (ob[2] - oa[2]) * t;
          n++;
        }
        let p: V3 = [
          origin[0] + (i + px / n) * cell,
          origin[1] + (j + py / n) * cell,
          origin[2] + (k + pz / n) * cell,
        ];
        p = project(shape.f, p, cell);
        cellVert[ci(i, j, k)] = mesh.p.length;
        mesh.p.push(p);
      }

  // Quads across every grid edge with a sign change.
  const addQuad = (cells: [number, number, number][], flip: boolean) => {
    const idx: number[] = [];
    for (const [a, b2, c] of cells) {
      if (a < 0 || b2 < 0 || c < 0 || a >= nx || b2 >= ny || c >= nz) return;
      const v = cellVert[ci(a, b2, c)]!;
      if (v < 0) return;
      idx.push(v);
    }
    mesh.f.push({ v: flip ? idx.reverse() : idx, uv: null, c: null, g: 'surface', m: 0, sm: true });
  };
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = field[gi(i, j, k)]! < 0;
        const b2 = field[gi(i + 1, j, k)]! < 0;
        if (a === b2) continue;
        addQuad(
          [
            [i, j - 1, k - 1],
            [i, j, k - 1],
            [i, j, k],
            [i, j - 1, k],
          ],
          !a,
        );
      }
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = field[gi(i, j, k)]! < 0;
        const b2 = field[gi(i, j + 1, k)]! < 0;
        if (a === b2) continue;
        addQuad(
          [
            [i - 1, j, k - 1],
            [i - 1, j, k],
            [i, j, k],
            [i, j, k - 1],
          ],
          !a,
        );
      }
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = field[gi(i, j, k)]! < 0;
        const b2 = field[gi(i, j, k + 1)]! < 0;
        if (a === b2) continue;
        addQuad(
          [
            [i - 1, j - 1, k],
            [i, j - 1, k],
            [i, j, k],
            [i - 1, j, k],
          ],
          !a,
        );
      }

  if (shape.c) {
    const col = shape.c;
    for (const f of mesh.f)
      f.c = f.v.map((v) => {
        const p = mesh.p[v]!;
        return col(p[0], p[1], p[2]);
      });
  }
  return mesh;
}

/** Newton step toward the zero level set for crisper surfaces. */
function project(f: Field, p: V3, cell: number): V3 {
  let q: V3 = p;
  const e = cell * 0.05;
  for (let it = 0; it < 2; it++) {
    const d = f(q[0], q[1], q[2]);
    const gx = (f(q[0] + e, q[1], q[2]) - f(q[0] - e, q[1], q[2])) / (2 * e);
    const gy = (f(q[0], q[1] + e, q[2]) - f(q[0], q[1] - e, q[2])) / (2 * e);
    const gz = (f(q[0], q[1], q[2] + e) - f(q[0], q[1], q[2] - e)) / (2 * e);
    const g2 = gx * gx + gy * gy + gz * gz;
    if (g2 < 1e-12) break;
    const step: V3 = [(d * gx) / g2, (d * gy) / g2, (d * gz) / g2];
    // don't move more than half a cell (keeps topology stable)
    const sl = Math.hypot(step[0], step[1], step[2]);
    const s = sl > cell * 0.5 ? (cell * 0.5) / sl : 1;
    q = [q[0] - step[0] * s, q[1] - step[1] * s, q[2] - step[2] * s];
  }
  return q;
}

export type { Box3 };
export { toRgb as colorToRgb };
