import { ShapeUtils, Vector2 } from 'three';
import { add, cross, dot, len, mul, normalize, rotateAxis, sub, type V2, type V3 } from '../math.ts';
import { type Face, PolyMesh } from '../polymesh.ts';
import { shapes } from '../primitives.ts';
import { inset } from './topology.ts';

/**
 * Extrudes a 2D outline (points [x, z] seen from above, any winding) upward along +Y.
 * Faces: 'top', 'bottom', 'side' (+ 'rim' when beveled). Optional holes (also [x, z] outlines).
 * Example: extrudeShape(shapes.star(5, 1, 0.45), { depth: 0.3, bevel: 0.05 })
 */
export function extrudeShape(
  outline: V2[],
  opts: { depth?: number; holes?: V2[][]; bevel?: number; y?: number } = {},
): PolyMesh {
  const depth = opts.depth ?? 1;
  const y0 = opts.y ?? 0;
  const bevel = Math.max(0, Math.min(opts.bevel ?? 0, depth * 0.49));
  const contour = shapes.ccw(outline);
  const holes = (opts.holes ?? []).map((h) => shapes.ccw(h).reverse());
  const m = new PolyMesh();
  const loops = [contour, ...holes];
  const bottomIdx: number[][] = [];
  const topIdx: number[][] = [];
  const topY = y0 + depth - bevel;
  for (const loop of loops) {
    bottomIdx.push(loop.map(([x, z]) => m.p.push([x, y0, -z]) - 1));
    topIdx.push(loop.map(([x, z]) => m.p.push([x, topY, -z]) - 1));
  }
  // side walls
  loops.forEach((loop, li) => {
    let u = 0;
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      const a = bottomIdx[li]![i]!;
      const b = bottomIdx[li]![j]!;
      const c = topIdx[li]![j]!;
      const d = topIdx[li]![i]!;
      const el = Math.hypot(loop[j]![0] - loop[i]![0], loop[j]![1] - loop[i]![1]);
      m.f.push({
        v: [a, b, c, d],
        uv: [
          [u, 0],
          [u + el, 0],
          [u + el, depth - bevel],
          [u, depth - bevel],
        ],
        c: null,
        g: 'side',
        m: 0,
        sm: false,
      });
      u += el;
    }
  });
  // caps
  const capUv = (k: number): V2 => [m.p[k]![0], -m.p[k]![2]];
  if (holes.length === 0) {
    m.f.push({ v: [...topIdx[0]!], uv: topIdx[0]!.map(capUv), c: null, g: 'top', m: 0, sm: false });
    const bot = [...bottomIdx[0]!].reverse();
    m.f.push({ v: bot, uv: bot.map(capUv), c: null, g: 'bottom', m: 0, sm: false });
  } else {
    const tris = ShapeUtils.triangulateShape(
      contour.map((p) => new Vector2(p[0], p[1])),
      holes.map((h) => h.map((p) => new Vector2(p[0], p[1]))),
    );
    const flatTop = topIdx.flat();
    const flatBottom = bottomIdx.flat();
    for (const t of tris) {
      const top = [flatTop[t[0]!]!, flatTop[t[1]!]!, flatTop[t[2]!]!];
      const bottom = [flatBottom[t[2]!]!, flatBottom[t[1]!]!, flatBottom[t[0]!]!];
      m.f.push({ v: top, uv: top.map(capUv), c: null, g: 'top', m: 0, sm: false });
      m.f.push({ v: bottom, uv: bottom.map(capUv), c: null, g: 'bottom', m: 0, sm: false });
    }
    // make sure caps face up/down
    for (const f of m.f) {
      if (f.g !== 'top' && f.g !== 'bottom') continue;
      const n = polyN(m, f);
      if ((f.g === 'top' && n[1] < 0) || (f.g === 'bottom' && n[1] > 0)) {
        f.v.reverse();
        f.uv?.reverse();
      }
    }
  }
  if (bevel <= 0) return m;
  // Chamfer: inset the top by `bevel` and raise the inner face by `bevel`.
  const beveled = inset(m, 'top', bevel, { rimGroup: 'rim' });
  const raise = new Set<number>();
  for (const f of beveled.f) if (f.g === 'top') for (const v of f.v) raise.add(v);
  return beveled.mapPositions((p, i) => (raise.has(i) ? [p[0], p[1] + bevel, p[2]] : p));
}

function polyN(m: PolyMesh, f: Face): V3 {
  const pts = f.v.map((k) => m.p[k]!);
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/**
 * Sweeps a closed 2D cross-section along a 3D path (pipes, rails, tentacles, trunks, handles).
 * scale: number or function of t in [0,1] (e.g. t => 1 - t for a point); twist: total degrees.
 * Example: sweep(shapes.circle(0.1, 12), curves.catmullRom([[0,0,0],[0,1,0.5],[0,2,0]]), { scale: t => 1 - 0.7*t })
 */
export function sweep(
  profile: V2[],
  path: V3[],
  opts: { closed?: boolean; caps?: boolean; scale?: number | ((t: number) => number); twist?: number } = {},
): PolyMesh {
  const closed = opts.closed ?? false;
  const n = path.length;
  if (n < 2) throw new Error('sweep: path needs at least 2 points');
  const prof = shapes.ccw(profile);
  const tangents: V3[] = path.map((_, i) => {
    const a = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const b = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    return normalize(sub(b, a));
  });
  // Parallel-transport frames (no sudden flips).
  const t0 = tangents[0]!;
  let normal = normalize(cross(t0, Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const frames: { N: V3; B: V3 }[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i]!;
    if (i > 0) {
      const prev = tangents[i - 1]!;
      const axis = cross(prev, t);
      const s = len(axis);
      if (s > 1e-8) normal = rotateAxis(normal, axis, Math.atan2(s, dot(prev, t)));
    }
    normal = normalize(sub(normal, mul(t, dot(normal, t))));
    frames.push({ N: normal, B: normalize(cross(t, normal)) });
  }
  const total = path.reduce((s, p, i) => (i === 0 ? 0 : s + len(sub(p, path[i - 1]!))), 0) || 1;
  const m = new PolyMesh();
  const rings: number[][] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += len(sub(path[i]!, path[i - 1]!));
    const t = acc / total;
    const s = typeof opts.scale === 'function' ? opts.scale(t) : (opts.scale ?? 1);
    const tw = ((opts.twist ?? 0) * t * Math.PI) / 180;
    const { N, B } = frames[i]!;
    const ring: number[] = [];
    for (const [x, y] of prof) {
      const cx = (x * Math.cos(tw) - y * Math.sin(tw)) * s;
      const cy = (x * Math.sin(tw) + y * Math.cos(tw)) * s;
      ring.push(m.p.push(add(path[i]!, add(mul(N, cx), mul(B, cy)))) - 1);
    }
    rings.push(ring);
  }
  const segs = closed ? n : n - 1;
  const k = prof.length;
  for (let i = 0; i < segs; i++) {
    const r0 = rings[i]!;
    const r1 = rings[(i + 1) % n]!;
    for (let j = 0; j < k; j++) {
      const j1 = (j + 1) % k;
      m.f.push({
        v: [r0[j]!, r0[j1]!, r1[j1]!, r1[j]!],
        uv: [
          [j / k, i / segs],
          [(j + 1) / k, i / segs],
          [(j + 1) / k, (i + 1) / segs],
          [j / k, (i + 1) / segs],
        ],
        c: null,
        g: 'side',
        m: 0,
        sm: true,
      });
    }
  }
  if (!closed && opts.caps !== false) {
    m.f.push({ v: [...rings[0]!].reverse(), uv: null, c: null, g: 'start', m: 0, sm: true });
    m.f.push({ v: [...rings[n - 1]!], uv: null, c: null, g: 'end', m: 0, sm: true });
  }
  // Orientation check: side faces must point away from the path.
  const f0 = m.f[0]!;
  const c0 = f0.v.reduce((a, v) => add(a, m.p[v]!), [0, 0, 0] as V3).map((x) => x / 4) as V3;
  const outward = sub(c0, path[0]!);
  return dot(polyN(m, f0), outward) < 0 ? m.flip() : m;
}

/** Tube of constant (or varying) radius along a path. */
export function tube(
  path: V3[],
  radius = 0.1,
  opts: {
    segments?: number;
    closed?: boolean;
    caps?: boolean;
    scale?: number | ((t: number) => number);
  } = {},
): PolyMesh {
  return sweep(shapes.circle(radius, opts.segments ?? 12), path, opts);
}

export const curves = {
  /** Smooth curve through the given points. */
  catmullRom(points: V3[], samplesPerSpan = 8, closed = false): V3[] {
    const n = points.length;
    if (n < 2) return points.map((p) => [...p] as V3);
    const out: V3[] = [];
    const spans = closed ? n : n - 1;
    const get = (i: number) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]!;
    for (let i = 0; i < spans; i++) {
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      for (let s = 0; s < samplesPerSpan; s++) {
        const t = s / samplesPerSpan;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push(
          [0, 1, 2].map(
            (a) =>
              0.5 *
              (2 * p1[a]! +
                (-p0[a]! + p2[a]!) * t +
                (2 * p0[a]! - 5 * p1[a]! + 4 * p2[a]! - p3[a]!) * t2 +
                (-p0[a]! + 3 * p1[a]! - 3 * p2[a]! + p3[a]!) * t3),
          ) as V3,
        );
      }
    }
    if (!closed) out.push([...points[n - 1]!] as V3);
    return out;
  },
  /** Arc in the XZ plane (y = 0). */
  arc(radius = 1, startDeg = 0, endDeg = 180, samples = 16): V3[] {
    return Array.from({ length: samples + 1 }, (_, i) => {
      const a = ((startDeg + ((endDeg - startDeg) * i) / samples) * Math.PI) / 180;
      return [radius * Math.cos(a), 0, radius * Math.sin(a)] as V3;
    });
  },
  /** Helix rising along +Y. */
  helix(radius = 0.5, height = 2, turns = 3, samples = 64): V3[] {
    return Array.from({ length: samples + 1 }, (_, i) => {
      const t = i / samples;
      const a = t * turns * Math.PI * 2;
      return [radius * Math.cos(a), t * height, radius * Math.sin(a)] as V3;
    });
  },
  line(from: V3, to: V3, samples = 1): V3[] {
    return Array.from({ length: samples + 1 }, (_, i) => {
      const t = i / samples;
      return [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ] as V3;
    });
  },
};
