import {
  AXIS_INDEX,
  type Axis,
  type ColorInput,
  clamp,
  DEG,
  lerp1,
  parseDirection,
  type RGB,
  rotationMatrix,
  smoothstep,
  toRgb,
  type V3,
} from './math.ts';
import { Noise } from './noise.ts';
import { curves } from './ops/sweep.ts';
import type { PolyMesh } from './polymesh.ts';
import { meshSdf, type SdfMeshOptions } from './sdf-mesh.ts';

type Field = (x: number, y: number, z: number) => number;
type ColorField = (x: number, y: number, z: number) => RGB;
/** Distance + color in one pass: returns the distance and writes the sRGB color into `out`. */
type ColorEval = (x: number, y: number, z: number, out: RGB) => number;
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

/** Squared distance from a point to a box (0 inside) as a fast closure. */
function boxDist2(b: Box3): Field {
  const x0 = b.min[0];
  const y0 = b.min[1];
  const z0 = b.min[2];
  const x1 = b.max[0];
  const y1 = b.max[1];
  const z1 = b.max[2];
  return (x, y, z) => {
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
    return dx * dx + dy * dy + dz * dz;
  };
}

const WHITE: RGB = [1, 1, 1];

/** Distance+color evaluator for any shape (uncolored shapes are white). */
function colorEval(s: Sdf): ColorEval {
  if (s.dc) return s.dc;
  const f = s.f;
  return (x, y, z, out) => {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return f(x, y, z);
  };
}

const mk = (f: Field, bounds: Box3, dc: ColorEval | null, lip: number): Sdf =>
  new Sdf(f, bounds, null, lip, dc);

/** Wraps a domain transform q = T(p): field and colors are evaluated at T(p). */
function domain(
  src: Sdf,
  map: (x: number, y: number, z: number, q: Float64Array) => void,
  bounds: Box3,
  lip: number,
): Sdf {
  const q = new Float64Array(3);
  const f = src.f;
  const dcs = src.dc;
  return mk(
    (x, y, z) => {
      map(x, y, z, q);
      return f(q[0]!, q[1]!, q[2]!);
    },
    bounds,
    dcs
      ? (x, y, z, out) => {
          map(x, y, z, q);
          return dcs(q[0]!, q[1]!, q[2]!, out);
        }
      : null,
    lip,
  );
}

/** Bounds of a forward-mapped box, sampled on a grid over the box surface plus a safety margin. */
function mappedBounds(b: Box3, fwd: (p: V3) => V3, margin: number, steps = 12): Box3 {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++)
      for (let k = 0; k <= steps; k++) {
        if (i > 0 && i < steps && j > 0 && j < steps && k > 0 && k < steps) continue;
        const p = fwd([
          lerp1(b.min[0], b.max[0], i / steps),
          lerp1(b.min[1], b.max[1], j / steps),
          lerp1(b.min[2], b.max[2], k / steps),
        ]);
        for (let a = 0; a < 3; a++) {
          if (p[a]! < min[a]!) min[a] = p[a]!;
          if (p[a]! > max[a]!) max[a] = p[a]!;
        }
      }
  return expand({ min, max }, margin);
}

/**
 * Signed distance field (negative inside). Combine shapes with (smooth) booleans, then call .mesh().
 * Each shape can carry a color; unions keep the color of the nearest surface (blended in smooth unions).
 * Example: sdf.sphere(0.5).smoothUnion(sdf.sphere(0.35, [0, 0.6, 0]), 0.2).color('#6cc24a').mesh()
 */
export class Sdf {
  readonly f: Field;
  readonly bounds: Box3;
  /**
   * Lipschitz bound of the field (1 for exact distances). Warps, twists and bends raise it; the mesher uses it
   * to skip empty space safely.
   */
  readonly lip: number;
  /** Fused distance + color evaluator (null when the shape has no color). */
  readonly dc: ColorEval | null;

  constructor(f: Field, bounds: Box3, c: ColorField | null = null, lip = 1, dc: ColorEval | null = null) {
    this.f = f;
    this.bounds = bounds;
    this.lip = lip;
    if (dc) this.dc = dc;
    else if (c)
      this.dc = (x, y, z, out) => {
        const col = c(x, y, z);
        out[0] = col[0];
        out[1] = col[1];
        out[2] = col[2];
        return f(x, y, z);
      };
    else this.dc = null;
  }

  /** Color field (null when uncolored). */
  get c(): ColorField | null {
    const dc = this.dc;
    if (!dc) return null;
    return (x, y, z) => {
      const out: RGB = [1, 1, 1];
      dc(x, y, z, out);
      return out;
    };
  }

  distance(p: V3): number {
    return this.f(p[0], p[1], p[2]);
  }

  /** Color at a point (white when uncolored). */
  colorAt(p: V3): RGB {
    const out: RGB = [1, 1, 1];
    this.dc?.(p[0], p[1], p[2], out);
    return out;
  }

  // ------------------------------------------------------------------ colors

  /** Solid color for this shape. */
  color(c: ColorInput): Sdf {
    const [r, g, b] = toRgb(c);
    const f = this.f;
    return mk(
      f,
      this.bounds,
      (x, y, z, out) => {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        return f(x, y, z);
      },
      this.lip,
    );
  }

  /** Color from a function of position (and the current color), e.g. gradients or custom patterns. */
  colorBy(fn: (p: V3, base: RGB) => ColorInput): Sdf {
    const base = colorEval(this);
    return mk(
      this.f,
      this.bounds,
      (x, y, z, out) => {
        const d = base(x, y, z, out);
        const c = toRgb(fn([x, y, z], [out[0], out[1], out[2]]));
        out[0] = c[0];
        out[1] = c[1];
        out[2] = c[2];
        return d;
      },
      this.lip,
    );
  }

  /**
   * Natural patches/marbling between `colors` from 3D noise. 2 colors = patches, more = layered bands.
   * scale = features per meter; sharpness 1 (soft) .. 10 (crisp edges).
   * Example: body.colorByNoise(['#6b8f3a', '#4c6b28'], 5, seed)
   */
  colorByNoise(colors: ColorInput[], scale = 4, seed = 1, sharpness = 3): Sdf {
    if (colors.length === 0) return this;
    const pal = colors.map(toRgb);
    const n = new Noise(seed);
    return this.paint((x, y, z, out) => {
      const v = n.fbm(x * scale, y * scale, z * scale, 3);
      const t = clamp(0.5 + v * sharpness, 0, 1);
      paletteAt(pal, t, out);
    });
  }

  /**
   * Round spots of `color` over the current color (Worley noise): ladybugs, mushrooms, giraffes, fawns.
   * scale = spots per meter, size = spot size 0..1, softness = edge blur 0..0.5.
   */
  colorSpots(
    color: ColorInput,
    opts: { scale?: number; size?: number; seed?: number; softness?: number } = {},
  ): Sdf {
    const c = toRgb(color);
    const scale = opts.scale ?? 6;
    const size = opts.size ?? 0.35;
    const soft = Math.max(0.005, opts.softness ?? 0.06);
    const n = new Noise(opts.seed ?? 1);
    return this.overlay((x, y, z) => {
      const d = n.worley(x * scale, y * scale, z * scale);
      return 1 - smoothstep(size - soft, size + soft, d);
    }, c);
  }

  /**
   * Stripes along a direction (tiger, bee, candy, fish bands). colors repeat every `width` meters each;
   * `wobble` bends the stripes with noise (0..1).
   */
  stripes(
    colors: ColorInput[],
    opts: { direction?: string | V3; width?: number; wobble?: number; seed?: number; softness?: number } = {},
  ): Sdf {
    if (colors.length === 0) return this;
    const pal = colors.map(toRgb);
    const dir = parseDirection(opts.direction ?? 'y');
    const width = Math.max(1e-4, opts.width ?? 0.1);
    const wobble = opts.wobble ?? 0;
    const soft = clamp(opts.softness ?? 0.15, 0.001, 0.5);
    const n = new Noise(opts.seed ?? 1);
    const k = pal.length;
    return this.paint((x, y, z, out) => {
      let u = (x * dir[0] + y * dir[1] + z * dir[2]) / width;
      if (wobble) u += wobble * 1.5 * n.fbm(x * 3, y * 3, z * 3, 2);
      const i = Math.floor(u);
      const fr = u - i;
      const a = pal[((i % k) + k) % k]!;
      const b = pal[(((i + 1) % k) + k) % k]!;
      const t = smoothstep(1 - soft, 1, fr);
      out[0] = lerp1(a[0], b[0], t);
      out[1] = lerp1(a[1], b[1], t);
      out[2] = lerp1(a[2], b[2], t);
    });
  }

  /** Color gradient along an axis (or direction) between two colors; range defaults to the shape bounds. */
  gradient(axis: Axis | V3, from: ColorInput, to: ColorInput, range?: [number, number]): Sdf {
    const a = toRgb(from);
    const b = toRgb(to);
    const dir: V3 = typeof axis === 'string' ? parseDirection(axis) : parseDirection(axis);
    let lo = Infinity;
    let hi = -Infinity;
    if (range) [lo, hi] = range;
    else
      for (const x of [this.bounds.min[0], this.bounds.max[0]])
        for (const y of [this.bounds.min[1], this.bounds.max[1]])
          for (const z of [this.bounds.min[2], this.bounds.max[2]]) {
            const v = x * dir[0] + y * dir[1] + z * dir[2];
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
    const span = hi - lo || 1;
    return this.paint((x, y, z, out) => {
      const t = clamp((x * dir[0] + y * dir[1] + z * dir[2] - lo) / span, 0, 1);
      out[0] = lerp1(a[0], b[0], t);
      out[1] = lerp1(a[1], b[1], t);
      out[2] = lerp1(a[2], b[2], t);
    });
  }

  /**
   * Blends `color` onto surfaces facing `direction` (default '-y' = belly/underside; '+y' = back/top).
   * threshold: -1..1 (how far around the shape the color reaches: lower = more), softness = transition width.
   * Example: body.color('#c77d3a').colorByNormal('#f3e2c0', '-y', 0.1)   // light belly
   */
  colorByNormal(color: ColorInput, direction: string | V3 = '-y', threshold = 0.2, softness = 0.4): Sdf {
    const c = toRgb(color);
    const d = parseDirection(direction);
    const f = this.f;
    const b = this.bounds;
    const h = Math.max(1e-4, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 2e-3);
    return this.overlay((x, y, z) => {
      const f0 = f(x + h, y - h, z - h);
      const f1 = f(x - h, y - h, z + h);
      const f2 = f(x - h, y + h, z - h);
      const f3 = f(x + h, y + h, z + h);
      const gx = f0 - f1 - f2 + f3;
      const gy = -f0 - f1 + f2 + f3;
      const gz = -f0 + f1 - f2 + f3;
      const l = Math.hypot(gx, gy, gz) || 1;
      const dd = (gx * d[0] + gy * d[1] + gz * d[2]) / l;
      return smoothstep(threshold - softness / 2, threshold + softness / 2, dd);
    }, c);
  }

  /** Replaces the color with a painter (x, y, z, out) => void. */
  private paint(fn: (x: number, y: number, z: number, out: RGB) => void): Sdf {
    const f = this.f;
    return mk(
      f,
      this.bounds,
      (x, y, z, out) => {
        fn(x, y, z, out);
        return f(x, y, z);
      },
      this.lip,
    );
  }

  /** Blends `color` over the current color with weight fn(x, y, z) in [0, 1]. */
  private overlay(weight: (x: number, y: number, z: number) => number, color: RGB): Sdf {
    const base = colorEval(this);
    return mk(
      this.f,
      this.bounds,
      (x, y, z, out) => {
        const d = base(x, y, z, out);
        const t = weight(x, y, z);
        if (t > 0) {
          out[0] = lerp1(out[0], color[0], t);
          out[1] = lerp1(out[1], color[1], t);
          out[2] = lerp1(out[2], color[2], t);
        }
        return d;
      },
      this.lip,
    );
  }

  // ------------------------------------------------------------------ booleans

  union(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'union', 0), this);
  }

  subtract(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'subtract', 0), this);
  }

  intersect(...others: Sdf[]): Sdf {
    return others.reduce<Sdf>((a, b) => a.combine(b, 'intersect', 0), this);
  }

  /** Union with a smooth blend of radius k (meters): the key to organic "clay" shapes. */
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
    const lip = Math.max(this.lip, o.lip);
    const dA = boxDist2(this.bounds);
    const dB = boxDist2(o.bounds);
    const colored = this.dc !== null || o.dc !== null;
    const ca = colorEval(this);
    const cb = colorEval(o);
    const ta: RGB = [1, 1, 1];
    const tb: RGB = [1, 1, 1];
    const copy = (out: RGB, src: RGB) => {
      out[0] = src[0];
      out[1] = src[1];
      out[2] = src[2];
    };
    if (op === 'union') {
      const bounds = expand(unionBox(this.bounds, o.bounds), k);
      // Skipping a child is exact: outside its box its distance is >= the box distance.
      const smin = (a: number, b: number) => {
        if (k <= 0) return a < b ? a : b;
        const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
        return b + (a - b) * h - k * h * (1 - h);
      };
      const f: Field = (x, y, z) => {
        const qa = dA(x, y, z);
        const qb = dB(x, y, z);
        if (qa <= qb) {
          const a = fa(x, y, z);
          const t = a + k;
          if (qb > 0 && (t <= 0 || qb >= t * t)) return a;
          return smin(a, fb(x, y, z));
        }
        const b = fb(x, y, z);
        const t = b + k;
        if (qa > 0 && (t <= 0 || qa >= t * t)) return b;
        return smin(fa(x, y, z), b);
      };
      const dc: ColorEval | null = colored
        ? (x, y, z, out) => {
            const qa = dA(x, y, z);
            const qb = dB(x, y, z);
            let a: number;
            let b: number;
            if (qa <= qb) {
              a = ca(x, y, z, ta);
              const t = a + k;
              if (qb > 0 && (t <= 0 || qb >= t * t)) {
                copy(out, ta);
                return a;
              }
              b = cb(x, y, z, tb);
            } else {
              b = cb(x, y, z, tb);
              const t = b + k;
              if (qa > 0 && (t <= 0 || qa >= t * t)) {
                copy(out, tb);
                return b;
              }
              a = ca(x, y, z, ta);
            }
            if (k > 0) {
              const w = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
              out[0] = lerp1(ta[0], tb[0], w);
              out[1] = lerp1(ta[1], tb[1], w);
              out[2] = lerp1(ta[2], tb[2], w);
            } else copy(out, a <= b ? ta : tb);
            return smin(a, b);
          }
        : null;
      return mk(f, bounds, dc, lip);
    }
    if (op === 'subtract') {
      // smooth max(a, -b): h -> 1 where the cutter dominates
      const smax = (a: number, nb: number) => {
        if (k <= 0) return a > nb ? a : nb;
        const h = clamp(0.5 + (0.5 * (nb - a)) / k, 0, 1);
        return a + (nb - a) * h + k * h * (1 - h);
      };
      const f: Field = (x, y, z) => {
        const a = fa(x, y, z);
        const qb = dB(x, y, z);
        const t = k - a;
        if (qb > 0 && (t <= 0 || qb >= t * t)) return a;
        return smax(a, -fb(x, y, z));
      };
      const dc: ColorEval | null = colored
        ? (x, y, z, out) => {
            const a = ca(x, y, z, ta);
            const qb = dB(x, y, z);
            const t = k - a;
            if (qb > 0 && (t <= 0 || qb >= t * t)) {
              copy(out, ta);
              return a;
            }
            const b = cb(x, y, z, tb);
            if (k > 0) {
              const w = clamp(0.5 + (0.5 * (Math.abs(a) - Math.abs(b))) / k, 0, 1);
              out[0] = lerp1(ta[0], tb[0], w);
              out[1] = lerp1(ta[1], tb[1], w);
              out[2] = lerp1(ta[2], tb[2], w);
            } else copy(out, Math.abs(a) <= Math.abs(b) ? ta : tb);
            return smax(a, -b);
          }
        : null;
      return mk(f, this.bounds, dc, lip);
    }
    const smaxI = (a: number, b: number) => {
      if (k <= 0) return a > b ? a : b;
      const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
      return b + (a - b) * h + k * h * (1 - h);
    };
    const f: Field = (x, y, z) => smaxI(fa(x, y, z), fb(x, y, z));
    const dc: ColorEval | null = colored
      ? (x, y, z, out) => {
          const a = ca(x, y, z, ta);
          const b = cb(x, y, z, tb);
          if (k > 0) {
            const w = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
            out[0] = lerp1(tb[0], ta[0], w);
            out[1] = lerp1(tb[1], ta[1], w);
            out[2] = lerp1(tb[2], ta[2], w);
          } else copy(out, a >= b ? ta : tb);
          return smaxI(a, b);
        }
      : null;
    return mk(f, intersectBox(this.bounds, o.bounds), dc, lip);
  }

  // ------------------------------------------------------------------ transforms

  translate(v: V3): Sdf {
    const [ox, oy, oz] = v;
    const { f, dc } = this;
    return mk(
      (x, y, z) => f(x - ox, y - oy, z - oz),
      {
        min: [this.bounds.min[0] + ox, this.bounds.min[1] + oy, this.bounds.min[2] + oz],
        max: [this.bounds.max[0] + ox, this.bounds.max[1] + oy, this.bounds.max[2] + oz],
      },
      dc ? (x, y, z, out) => dc(x - ox, y - oy, z - oz, out) : null,
      this.lip,
    );
  }

  /** Rotate by Euler degrees (XYZ) around the origin (or `pivot`). */
  rotate(deg: V3, pivot: V3 = [0, 0, 0]): Sdf {
    const r = rotationMatrix(deg);
    const [px, py, pz] = pivot;
    // inverse rotation = transpose
    const m0 = r[0]!;
    const m1 = r[3]!;
    const m2 = r[6]!;
    const m3 = r[1]!;
    const m4 = r[4]!;
    const m5 = r[7]!;
    const m6 = r[2]!;
    const m7 = r[5]!;
    const m8 = r[8]!;
    const fwd = (p: V3): V3 => {
      const x = p[0] - px;
      const y = p[1] - py;
      const z = p[2] - pz;
      return [
        r[0]! * x + r[1]! * y + r[2]! * z + px,
        r[3]! * x + r[4]! * y + r[5]! * z + py,
        r[6]! * x + r[7]! * y + r[8]! * z + pz,
      ];
    };
    return domain(
      this,
      (x, y, z, q) => {
        const dx = x - px;
        const dy = y - py;
        const dz = z - pz;
        q[0] = m0 * dx + m1 * dy + m2 * dz + px;
        q[1] = m3 * dx + m4 * dy + m5 * dz + py;
        q[2] = m6 * dx + m7 * dy + m8 * dz + pz;
      },
      mappedBounds(this.bounds, fwd, 0, 1),
      this.lip,
    );
  }

  /** Uniform scale around the origin. */
  scale(s: number): Sdf {
    const { f, dc } = this;
    const lo = this.bounds.min.map((v) => v * s) as V3;
    const hi = this.bounds.max.map((v) => v * s) as V3;
    return mk(
      (x, y, z) => f(x / s, y / s, z / s) * s,
      {
        min: [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])],
        max: [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])],
      },
      dc ? (x, y, z, out) => dc(x / s, y / s, z / s, out) * s : null,
      this.lip,
    );
  }

  /** Non-uniform scale around the origin, e.g. [1, 0.6, 1.2] squashes and stretches (distance stays a bound). */
  stretch(s: V3): Sdf {
    const [sx, sy, sz] = s.map((v) => Math.max(1e-6, Math.abs(v))) as V3;
    const k = Math.min(sx, sy, sz);
    const { f, dc } = this;
    return mk(
      (x, y, z) => f(x / sx, y / sy, z / sz) * k,
      {
        min: [this.bounds.min[0] * sx, this.bounds.min[1] * sy, this.bounds.min[2] * sz],
        max: [this.bounds.max[0] * sx, this.bounds.max[1] * sy, this.bounds.max[2] * sz],
      },
      dc ? (x, y, z, out) => dc(x / sx, y / sy, z / sz, out) * k : null,
      this.lip,
    );
  }

  /** Grows (positive) or shrinks the shape; also rounds sharp edges. */
  round(r: number): Sdf {
    const { f, dc } = this;
    return mk(
      (x, y, z) => f(x, y, z) - r,
      expand(this.bounds, Math.max(0, r)),
      dc ? (x, y, z, out) => dc(x, y, z, out) - r : null,
      this.lip,
    );
  }

  /** Hollow shell of the given total thickness, centered on the surface. */
  shell(thickness: number): Sdf {
    const { f, dc } = this;
    const t = thickness / 2;
    return mk(
      (x, y, z) => Math.abs(f(x, y, z)) - t,
      expand(this.bounds, thickness),
      dc ? (x, y, z, out) => Math.abs(dc(x, y, z, out)) - t : null,
      this.lip,
    );
  }

  /** Hollows the shape out, keeping its outer surface: walls `thickness` thick (cut it open to see inside). */
  onion(thickness: number): Sdf {
    const { f, dc } = this;
    return mk(
      (x, y, z) => {
        const d = f(x, y, z);
        return Math.max(d, -d - thickness);
      },
      this.bounds,
      dc
        ? (x, y, z, out) => {
            const d = dc(x, y, z, out);
            return Math.max(d, -d - thickness);
          }
        : null,
      this.lip,
    );
  }

  /** Bumpy surface from fractal noise (rocks, terrain lumps, clay). */
  displace(amount = 0.05, scale = 3, seed = 1, octaves = 3): Sdf {
    const n = new Noise(seed);
    const { f, dc } = this;
    return mk(
      (x, y, z) => f(x, y, z) + amount * n.fbm(x * scale, y * scale, z * scale, octaves),
      expand(this.bounds, Math.abs(amount) * 1.2),
      dc
        ? (x, y, z, out) => dc(x, y, z, out) + amount * n.fbm(x * scale, y * scale, z * scale, octaves)
        : null,
      this.lip + Math.abs(amount) * scale * 3,
    );
  }

  /**
   * Custom displacement: adds fn(p) meters outward (negative = inward) at every point. maxAmount must bound |fn|
   * (keeps bounds and meshing correct). Great for ribs, rings, scales and grooves.
   * Example (cactus ribs): trunk.displaceBy(([x, , z]) => 0.015 * Math.cos(12 * Math.atan2(x, z)), 0.015)
   */
  displaceBy(fn: (p: V3) => number, maxAmount: number, lipschitz = 2): Sdf {
    const { f, dc } = this;
    const p: V3 = [0, 0, 0];
    const off = (x: number, y: number, z: number) => {
      p[0] = x;
      p[1] = y;
      p[2] = z;
      return fn(p);
    };
    return mk(
      (x, y, z) => f(x, y, z) - off(x, y, z),
      expand(this.bounds, Math.abs(maxAmount)),
      dc ? (x, y, z, out) => dc(x, y, z, out) - off(x, y, z) : null,
      this.lip + Math.max(0, lipschitz - 1),
    );
  }

  /**
   * Noise domain warping: bends the whole shape irregularly for natural, hand-made forms (rocks, roots, blobs,
   * bark, creatures that should not look perfectly symmetric). amount in meters, scale = warps per meter.
   */
  warp(amount = 0.05, scale = 2, seed = 1): Sdf {
    const n = new Noise(seed);
    const a = amount;
    const s = scale;
    return domain(
      this,
      (x, y, z, q) => {
        const X = x * s;
        const Y = y * s;
        const Z = z * s;
        q[0] = x + a * n.fbm(X, Y, Z, 2);
        q[1] = y + a * n.fbm(X + 31.7, Y + 11.3, Z + 5.1, 2);
        q[2] = z + a * n.fbm(X + 7.9, Y + 47.2, Z + 23.3, 2);
      },
      expand(this.bounds, Math.abs(a) * 1.2),
      this.lip * (1 + Math.abs(a) * s * 3),
    );
  }

  /**
   * Twists around an axis: `degreesPerMeter` of rotation per meter along it (horns, shells, drill-like stems).
   */
  twist(degreesPerMeter: number, axis: Axis = 'y'): Sdf {
    const k = degreesPerMeter * DEG;
    const ai = AXIS_INDEX[axis];
    const u = (ai + 1) % 3;
    const v = (ai + 2) % 3;
    const b = this.bounds;
    let R = 0;
    for (const cu of [b.min[u]!, b.max[u]!])
      for (const cv of [b.min[v]!, b.max[v]!]) R = Math.max(R, Math.hypot(cu, cv));
    const bounds: Box3 = { min: [0, 0, 0], max: [0, 0, 0] };
    bounds.min[ai] = b.min[ai]!;
    bounds.max[ai] = b.max[ai]!;
    bounds.min[u] = -R;
    bounds.max[u] = R;
    bounds.min[v] = -R;
    bounds.max[v] = R;
    const lip = this.lip * Math.min(6, Math.sqrt(1 + (k * R) ** 2));
    return domain(
      this,
      (x, y, z, q) => {
        q[0] = x;
        q[1] = y;
        q[2] = z;
        const a = -k * q[ai]!;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const pu = q[u]!;
        const pv = q[v]!;
        q[u] = c * pu - s * pv;
        q[v] = s * pu + c * pv;
      },
      bounds,
      lip,
    );
  }

  /**
   * Bends the shape as it extends along +Y, curving toward +X (negative = toward -X), by `degreesPerMeter`.
   * Build tails, horns, stems and tentacles straight up the Y axis, bend, then rotate/translate into place.
   */
  bend(degreesPerMeter: number): Sdf {
    const k = degreesPerMeter * DEG;
    if (Math.abs(k) < 1e-9) return this;
    const sg = Math.sign(k);
    const R = 1 / Math.abs(k);
    const b = this.bounds;
    const maxX = Math.max(sg * b.min[0], sg * b.max[0]);
    const fwd = (p: V3): V3 => {
      const xs = sg * p[0];
      const r = R - xs;
      const th = p[1] / R;
      return [sg * (R - r * Math.cos(th)), r * Math.sin(th), p[2]];
    };
    const steps = 24;
    const dth = (b.max[1] - b.min[1]) / R / steps;
    const margin = (R + Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]))) * (1 - Math.cos(dth / 2)) + 1e-4;
    const lip = this.lip * (maxX < R * 0.9 ? Math.max(1, R / (R - Math.max(0, maxX))) : 4);
    return domain(
      this,
      (x, y, z, q) => {
        const dx = R - sg * x;
        const r = Math.hypot(dx, y);
        q[0] = sg * (R - r);
        q[1] = Math.atan2(y, dx) * R;
        q[2] = z;
      },
      mappedBounds(b, fwd, margin, steps),
      Math.min(6, lip),
    );
  }

  /** Stretches the shape by inserting a straight section of half-length h per axis (pill from a sphere). */
  elongate(h: V3): Sdf {
    const [hx, hy, hz] = h.map((v) => Math.abs(v)) as V3;
    return domain(
      this,
      (x, y, z, q) => {
        q[0] = x - clamp(x, -hx, hx);
        q[1] = y - clamp(y, -hy, hy);
        q[2] = z - clamp(z, -hz, hz);
      },
      {
        min: [this.bounds.min[0] - hx, this.bounds.min[1] - hy, this.bounds.min[2] - hz],
        max: [this.bounds.max[0] + hx, this.bounds.max[1] + hy, this.bounds.max[2] + hz],
      },
      this.lip,
    );
  }

  /** Removes everything below y (flat bottoms that stand on the ground). k > 0 rounds the cut edge. */
  cutBelow(y: number, k = 0): Sdf {
    return this.halfCut(y, -1, k);
  }

  /** Removes everything above y. k > 0 rounds the cut edge. */
  cutAbove(y: number, k = 0): Sdf {
    return this.halfCut(y, 1, k);
  }

  private halfCut(y0: number, side: 1 | -1, k: number): Sdf {
    const { f, dc } = this;
    const smax = (a: number, b: number) => {
      if (k <= 0) return a > b ? a : b;
      const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
      return b + (a - b) * h + k * h * (1 - h);
    };
    const bounds: Box3 = { min: [...this.bounds.min], max: [...this.bounds.max] };
    if (side < 0) bounds.min[1] = Math.min(bounds.max[1], Math.max(bounds.min[1], y0));
    else bounds.max[1] = Math.max(bounds.min[1], Math.min(bounds.max[1], y0));
    return mk(
      (x, y, z) => smax(f(x, y, z), side * (y - y0)),
      bounds,
      dc ? (x, y, z, out) => smax(dc(x, y, z, out), side * (y - y0)) : null,
      Math.max(1, this.lip),
    );
  }

  /** Mirror across the YZ plane (symmetry on X): whatever is at +x also appears at -x. */
  mirrorX(): Sdf {
    return this.mirror('x');
  }

  /** Mirror symmetry across the plane through the origin perpendicular to `axis`. */
  mirror(axis: Axis = 'x'): Sdf {
    const a = AXIS_INDEX[axis];
    const b = this.bounds;
    const m = Math.max(Math.abs(b.min[a]!), Math.abs(b.max[a]!));
    const bounds: Box3 = { min: [...b.min], max: [...b.max] };
    bounds.min[a] = -m;
    bounds.max[a] = m;
    return domain(
      this,
      (x, y, z, q) => {
        q[0] = x;
        q[1] = y;
        q[2] = z;
        q[a] = Math.abs(q[a]!);
      },
      bounds,
      this.lip,
    );
  }

  /**
   * Meshes the field into a watertight, manifold mesh.
   * Options: detail 'low'|'medium'|'high'|'ultra' or resolution (cells on the longest side), smooth (Taubin
   * iterations, default 2), decimate (target triangles or ratio), ao (bake ambient occlusion into colors).
   * Example: shape.mesh({ detail: 'high', decimate: 8000, ao: true })
   */
  mesh(opts: SdfMeshOptions = {}): PolyMesh {
    return meshSdf(this, opts);
  }
}

function paletteAt(pal: RGB[], t: number, out: RGB) {
  if (pal.length === 1) {
    out[0] = pal[0]![0];
    out[1] = pal[0]![1];
    out[2] = pal[0]![2];
    return;
  }
  const u = t * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(u));
  const fr = smoothstep(0, 1, u - i);
  const a = pal[i]!;
  const b = pal[i + 1]!;
  out[0] = lerp1(a[0], b[0], fr);
  out[1] = lerp1(a[1], b[1], fr);
  out[2] = lerp1(a[2], b[2], fr);
}

// ---------------------------------------------------------------------------------------------
// Round-cone chains (limbs, tails, tentacles, worms, branches)
// ---------------------------------------------------------------------------------------------

interface Segs {
  n: number;
  /** per segment: ax ay az bax bay baz l2 rr a2 il2 r1 r2 cx cy cz R mode */
  d: Float64Array;
}
const SEG = 17;

function buildSegs(pts: V3[], rs: number[]): Segs {
  const n = Math.max(1, pts.length - 1);
  const d = new Float64Array(n * SEG);
  for (let s = 0; s < n; s++) {
    const a = pts[s]!;
    const b = pts[Math.min(s + 1, pts.length - 1)]!;
    const r1 = Math.max(1e-5, rs[s]!);
    const r2 = Math.max(1e-5, rs[Math.min(s + 1, rs.length - 1)]!);
    const bax = b[0] - a[0];
    const bay = b[1] - a[1];
    const baz = b[2] - a[2];
    const l2 = bax * bax + bay * bay + baz * baz;
    const rr = r1 - r2;
    const a2 = l2 - rr * rr;
    const o = s * SEG;
    d[o] = a[0];
    d[o + 1] = a[1];
    d[o + 2] = a[2];
    d[o + 3] = bax;
    d[o + 4] = bay;
    d[o + 5] = baz;
    d[o + 6] = l2;
    d[o + 7] = rr;
    d[o + 8] = a2;
    d[o + 9] = l2 > 1e-18 ? 1 / l2 : 0;
    d[o + 10] = r1;
    d[o + 11] = r2;
    d[o + 12] = a[0] + bax / 2;
    d[o + 13] = a[1] + bay / 2;
    d[o + 14] = a[2] + baz / 2;
    d[o + 15] = Math.sqrt(l2) / 2 + Math.max(r1, r2);
    // mode 0: round cone, 1: sphere at a (r1), 2: sphere at b (r2)
    d[o + 16] = l2 < 1e-14 || a2 <= 1e-12 ? (r1 >= r2 ? 1 : 2) : 0;
  }
  return { n, d };
}

function segDist(d: Float64Array, o: number, px: number, py: number, pz: number): number {
  const mode = d[o + 16]!;
  if (mode !== 0) {
    const bx = mode === 1 ? 0 : d[o + 3]!;
    const by = mode === 1 ? 0 : d[o + 4]!;
    const bz = mode === 1 ? 0 : d[o + 5]!;
    return (
      Math.hypot(px - d[o]! - bx, py - d[o + 1]! - by, pz - d[o + 2]! - bz) -
      (mode === 1 ? d[o + 10]! : d[o + 11]!)
    );
  }
  const pax = px - d[o]!;
  const pay = py - d[o + 1]!;
  const paz = pz - d[o + 2]!;
  const bax = d[o + 3]!;
  const bay = d[o + 4]!;
  const baz = d[o + 5]!;
  const l2 = d[o + 6]!;
  const rr = d[o + 7]!;
  const a2 = d[o + 8]!;
  const il2 = d[o + 9]!;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const qx = pax * l2 - bax * y;
  const qy = pay * l2 - bay * y;
  const qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - d[o + 11]!;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - d[o + 10]!;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - d[o + 10]!;
}

function chainSdf(pts: V3[], rs: number[], k: number): Sdf {
  if (pts.length === 1) return sdf.sphere(rs[0]!, pts[0]!);
  const segs = buildSegs(pts, rs);
  const { n, d } = segs;
  const lb = new Float64Array(n);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  pts.forEach((p, i) => {
    const r = rs[i]!;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, p[a]! - r);
      max[a] = Math.max(max[a]!, p[a]! + r);
    }
  });
  if (n === 1) {
    return new Sdf((x, y, z) => segDist(d, 0, x, y, z), { min, max });
  }
  const f: Field = (x, y, z) => {
    // first candidate: the segment whose bounding sphere is nearest (cheap heuristic, no square roots)
    let bi = 0;
    let bv = Infinity;
    for (let s = 0; s < n; s++) {
      const o = s * SEG;
      const dx = x - d[o + 12]!;
      const dy = y - d[o + 13]!;
      const dz = z - d[o + 14]!;
      const R = d[o + 15]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      lb[s] = d2;
      const v = d2 - R * R;
      if (v < bv) {
        bv = v;
        bi = s;
      }
    }
    let best = segDist(d, bi * SEG, x, y, z);
    for (let s = 0; s < n; s++) {
      if (s === bi) continue;
      // skip when (distance to bounding sphere) >= best + k
      const t = best + k + d[s * SEG + 15]!;
      if (t <= 0 || lb[s]! >= t * t) continue;
      const v = segDist(d, s * SEG, x, y, z);
      if (k > 0) {
        const h = clamp(0.5 + (0.5 * (v - best)) / k, 0, 1);
        best = v + (best - v) * h - k * h * (1 - h);
      } else if (v < best) best = v;
    }
    return best;
  };
  return new Sdf(f, expand({ min, max }, k));
}

function cubicInterp(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function arcFractions(pts: V3[]): number[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    acc.push(acc[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = acc[acc.length - 1]! || 1;
  return acc.map((v) => v / total);
}

export type RadiusInput = number | number[] | ((t: number) => number);

export interface Metaball {
  center: V3;
  /** Size of the ball when alone (meters). */
  radius: number;
  /** Negative strength carves (anti-ball). Default 1. */
  strength?: number;
  color?: ColorInput;
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
    const ia = 1 / a;
    const ib = 1 / b;
    const ic = 1 / c;
    const rmin = Math.min(a, b, c);
    return new Sdf(
      (x, y, z) => {
        const px = (x - cx) * ia;
        const py = (y - cy) * ib;
        const pz = (z - cz) * ic;
        const k0 = Math.sqrt(px * px + py * py + pz * pz);
        const qx = px * ia;
        const qy = py * ib;
        const qz = pz * ic;
        const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
        return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -rmin;
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
        const ox = qx > 0 ? qx : 0;
        const oy = qy > 0 ? qy : 0;
        const oz = qz > 0 ? qz : 0;
        const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
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

  /**
   * Exact tapered capsule: sphere of radius ra at a, rb at b, joined by a tangent cone. Better than capsule()
   * when the radii differ a lot (claws, horns, snouts, fingers, cones with round tips).
   */
  roundCone(a: V3, b: V3, ra = 0.1, rb = 0.05): Sdf {
    return chainSdf([a, b], [ra, rb], 0);
  },

  /**
   * Smooth tapered tube through points: limbs, tails, snakes, worms, tentacles, horns, branches, necks.
   * radii: one radius, one per point, or a function of t (0 at the first point .. 1 at the last).
   * curve (default true for 3+ points) runs a smooth spline through the points; curve: false joins straight
   * segments, blended with `smooth` (meters) at the joints.
   * Example: sdf.chain([[0,0.2,0],[0.1,0.5,0.1],[0,0.9,0.3]], t => 0.12 - 0.08 * t)
   */
  chain(
    points: V3[],
    radii: RadiusInput = 0.1,
    opts: { smooth?: number; curve?: boolean; samples?: number } = {},
  ): Sdf {
    if (points.length === 0) throw new Error('sdf.chain needs at least one point.');
    const n = points.length;
    const curve = opts.curve ?? n > 2;
    let pts: V3[] = points.map((p) => [p[0], p[1], p[2]] as V3);
    let rs: number[];
    if (curve && n > 2) {
      const spp = Math.max(2, Math.round(opts.samples ?? 8));
      pts = curves.catmullRom(points, spp);
      if (Array.isArray(radii)) {
        const r = (i: number) => radii[Math.max(0, Math.min(n - 1, Math.min(i, radii.length - 1)))]!;
        const rmin = Math.min(...radii.slice(0, n));
        rs = pts.map((_, s) => {
          const span = Math.min(n - 2, Math.floor(s / spp));
          const t = s / spp - span;
          return Math.max(rmin * 0.5, cubicInterp(r(span - 1), r(span), r(span + 1), r(span + 2), t));
        });
      } else rs = [];
    } else rs = Array.isArray(radii) ? pts.map((_, i) => radii[Math.min(i, radii.length - 1)]!) : [];
    if (typeof radii === 'number') rs = pts.map(() => radii);
    else if (typeof radii === 'function') rs = arcFractions(pts).map((t) => radii(t));
    return chainSdf(pts, rs, curve && n > 2 ? 0 : Math.max(0, opts.smooth ?? 0));
  },

  /** Tube along a polyline path (e.g. curves.helix / curves.catmullRom output); radius may vary with t 0..1. */
  tube(path: V3[], radius: number | ((t: number) => number) = 0.05): Sdf {
    if (path.length === 0) throw new Error('sdf.tube needs a path with at least one point.');
    const rs = typeof radius === 'number' ? path.map(() => radius) : arcFractions(path).map((t) => radius(t));
    return chainSdf(path, rs, 0);
  },

  /**
   * Classic metaballs: blobs that melt together when close (slime, goo, clouds, cells, lava lamp).
   * Each ball's radius is its size when alone; higher `threshold` (0..1) merges blobs sooner.
   * Balls may carry colors (blended by influence). Example: sdf.metaballs([{ center: [0,0.3,0], radius: 0.3 }, [[0.3,0.2,0], 0.2]])
   */
  metaballs(balls: (Metaball | [V3, number])[], threshold = 0.5): Sdf {
    if (balls.length === 0) throw new Error('sdf.metaballs needs at least one ball.');
    const T = clamp(threshold, 0.05, 0.95);
    const list = balls.map((b) => (Array.isArray(b) ? { center: b[0], radius: b[1] } : b));
    const n = list.length;
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const cz = new Float64Array(n);
    const invR2 = new Float64Array(n);
    const R = new Float64Array(n);
    const st = new Float64Array(n);
    let G = 0;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    list.forEach((b, i) => {
      const s = b.strength ?? 1;
      const reach = s > T ? Math.sqrt(1 - Math.cbrt(T / s)) : 0.5;
      const Ri = Math.max(1e-4, b.radius / reach);
      cx[i] = b.center[0];
      cy[i] = b.center[1];
      cz[i] = b.center[2];
      R[i] = Ri;
      invR2[i] = 1 / (Ri * Ri);
      st[i] = s;
      G = Math.max(G, (1.72 * Math.abs(s)) / Ri);
      if (s > 0)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, b.center[a]! - Ri);
          max[a] = Math.max(max[a]!, b.center[a]! + Ri);
        }
    });
    const iG = 1 / G;
    const field = (x: number, y: number, z: number, w: Float64Array | null): number => {
      let F = 0;
      let inside = false;
      let dI = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = x - cx[i]!;
        const dy = y - cy[i]!;
        const dz = z - cz[i]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        const u = d2 * invR2[i]!;
        if (u < 1) {
          const q = 1 - u;
          const c = st[i]! * q * q * q;
          F += c;
          if (w) w[i] = c;
          if (st[i]! > 0) inside = true;
        } else {
          if (w) w[i] = 0;
          if (!inside && st[i]! > 0) {
            const dd = Math.sqrt(d2) - R[i]!;
            if (dd < dI) dI = dd;
          }
        }
      }
      return (T - F) * iG + (inside || dI === Infinity ? 0 : Math.max(0, dI));
    };
    const colored = list.some((b) => b.color !== undefined);
    const cols = list.map((b) => (b.color !== undefined ? toRgb(b.color) : WHITE));
    const w = new Float64Array(n);
    return new Sdf(
      (x, y, z) => field(x, y, z, null),
      { min, max },
      null,
      2,
      colored
        ? (x, y, z, out) => {
            const d = field(x, y, z, w);
            let r = 0;
            let g = 0;
            let b = 0;
            let tw = 0;
            for (let i = 0; i < n; i++) {
              const wi = w[i]!;
              if (wi <= 0) continue;
              r += cols[i]![0] * wi;
              g += cols[i]![1] * wi;
              b += cols[i]![2] * wi;
              tw += wi;
            }
            if (tw > 0) {
              out[0] = r / tw;
              out[1] = g / tw;
              out[2] = b / tw;
            } else {
              let bi = 0;
              let bd = Infinity;
              for (let i = 0; i < n; i++) {
                const dd = Math.hypot(x - cx[i]!, y - cy[i]!, z - cz[i]!) - R[i]!;
                if (dd < bd) {
                  bd = dd;
                  bi = i;
                }
              }
              out[0] = cols[bi]![0];
              out[1] = cols[bi]![1];
              out[2] = cols[bi]![2];
            }
            return d;
          }
        : null,
    );
  },

  /**
   * Smooth union of many shapes at once (faster than chaining .smoothUnion for big creatures: far-away parts
   * are skipped). Put the largest shape (the body) first.
   */
  smoothUnionAll(shapes: Sdf[], k = 0.1): Sdf {
    if (shapes.length === 0) throw new Error('sdf.smoothUnionAll needs at least one shape.');
    if (shapes.length === 1) return shapes[0]!;
    const n = shapes.length;
    const fs = shapes.map((s) => s.f);
    const boxes = shapes.map((s) => boxDist2(s.bounds));
    const lip = Math.max(...shapes.map((s) => s.lip));
    let bounds = shapes[0]!.bounds;
    for (const s of shapes) bounds = unionBox(bounds, s.bounds);
    bounds = expand(bounds, k);
    const colored = shapes.some((s) => s.dc);
    const cs = shapes.map(colorEval);
    const tmp: RGB = [1, 1, 1];
    const f: Field = (x, y, z) => {
      let acc = Infinity;
      for (let i = 0; i < n; i++) {
        if (acc !== Infinity) {
          const q = boxes[i]!(x, y, z);
          const t = acc + k;
          if (q > 0 && (t <= 0 || q >= t * t)) continue;
        }
        const d = fs[i]!(x, y, z);
        if (acc === Infinity) acc = d;
        else if (k > 0) {
          const h = clamp(0.5 + (0.5 * (d - acc)) / k, 0, 1);
          acc = d + (acc - d) * h - k * h * (1 - h);
        } else if (d < acc) acc = d;
      }
      return acc;
    };
    const dc: ColorEval | null = colored
      ? (x, y, z, out) => {
          let acc = Infinity;
          for (let i = 0; i < n; i++) {
            if (acc !== Infinity) {
              const q = boxes[i]!(x, y, z);
              const t = acc + k;
              if (q > 0 && (t <= 0 || q >= t * t)) continue;
            }
            const d = cs[i]!(x, y, z, tmp);
            if (acc === Infinity) {
              acc = d;
              out[0] = tmp[0];
              out[1] = tmp[1];
              out[2] = tmp[2];
              continue;
            }
            if (k > 0) {
              const w = clamp(0.5 + (0.5 * (acc - d)) / k, 0, 1);
              out[0] = lerp1(out[0], tmp[0], w);
              out[1] = lerp1(out[1], tmp[1], w);
              out[2] = lerp1(out[2], tmp[2], w);
              const h = clamp(0.5 + (0.5 * (d - acc)) / k, 0, 1);
              acc = d + (acc - d) * h - k * h * (1 - h);
            } else if (d < acc) {
              acc = d;
              out[0] = tmp[0];
              out[1] = tmp[1];
              out[2] = tmp[2];
            }
          }
          return acc;
        }
      : null;
    return mk(f, bounds, dc, lip);
  },

  /** Plain union of many shapes (see smoothUnionAll). */
  unionAll(shapes: Sdf[]): Sdf {
    return sdf.smoothUnionAll(shapes, 0);
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

export type { Box3, SdfMeshOptions };
export { toRgb as colorToRgb };
