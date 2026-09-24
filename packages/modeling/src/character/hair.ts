/**
 * Sculpted hair for the character generator (head space, see head.ts). Hair is blocked in like a sculptor
 * would: a thin base layer over the skull cut to a natural hairline, then many flattened locks laid over it
 * like shingles, flowing away from the crown whorl and falling with gravity (a fringe over the forehead, layers
 * over the ears and the nape). Messy styles lift and scatter the locks. Colors run darker at the roots.
 */
import { clamp, Random, type RGB, smoothstep, type V3 } from '../math.ts';
import { Noise } from '../noise.ts';
import { Sdf, sdf } from '../sdf.ts';
import { type FaceLayout, type HeadOptions, skullParts } from './head.ts';

export type HairStyle = 'messy' | 'short' | 'buzz' | 'shoulder' | 'bun' | 'none';

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const BOUNDS = { min: [-0.2, -0.15, -0.2] as V3, max: [0.2, 0.35, 0.2] as V3 };

/** Ellipsoid with arbitrary orthonormal axes (approximate distance, like sdf.ellipsoid). */
function orientedEllipsoid(c: V3, ax: [V3, V3, V3], r: V3): Sdf {
  const [u, v, w] = ax;
  const [a, b, cc] = r;
  const rmax = Math.max(a, b, cc);
  const rmin = Math.min(a, b, cc);
  return new Sdf(
    (x, y, z) => {
      const dx = x - c[0];
      const dy = y - c[1];
      const dz = z - c[2];
      const px = (dx * u[0] + dy * u[1] + dz * u[2]) / a;
      const py = (dx * v[0] + dy * v[1] + dz * v[2]) / b;
      const pz = (dx * w[0] + dy * w[1] + dz * w[2]) / cc;
      const k0 = Math.sqrt(px * px + py * py + pz * pz);
      const k1 = Math.sqrt((px / a) ** 2 + (py / b) ** 2 + (pz / cc) ** 2);
      return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -rmin;
    },
    { min: [c[0] - rmax, c[1] - rmax, c[2] - rmax], max: [c[0] + rmax, c[1] + rmax, c[2] + rmax] },
  );
}

export function hairSdf(style: HairStyle, L: FaceLayout, o: HeadOptions, color: RGB, seed: number): Sdf {
  const rng = new Random(seed * 31 + 7);
  const noise = new Noise(seed * 13 + 5);
  const { c, r } = L.cranium;
  const base = style === 'buzz' ? 0.0025 : style === 'short' ? 0.006 : 0.008;
  const whorl: V3 = [0.014, 0.235, -0.05];
  const skull = sdf.smoothUnionAll(skullParts(L, o, 0.001), 0.012);
  const ear = L.earL;
  const long = style === 'shoulder';
  // hairline region (negative inside): above the forehead line, around the ears, down to the nape
  const hairline = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    const front = L.hairlineY - 0.014 * (ax / 0.05) ** 2;
    const sideburn = ear[1] + (long ? -0.01 : 0.014);
    const back = long ? -0.08 : style === 'bun' ? 0.05 : 0.048;
    const fz = smoothstep(0.02, 0.075, z);
    const side = smoothstep(-0.075, 0.0, z) * (1 - fz);
    let limit = front * fz + sideburn * side + back * (1 - fz - side);
    if (!long) {
      const de = Math.hypot((ax - ear[0]) / 0.028, (y - ear[1]) / 0.04, (z - ear[2]) / 0.03);
      if (de < 1) limit = Math.max(limit, ear[1] + 0.035 * Math.sqrt(1 - de * de) * 1.15);
    }
    return limit - y + noise.noise3(x * 50, y * 50, z * 50) * 0.004;
  };
  // the hair layer thins out toward the hairline instead of ending in a hard helmet edge
  const layer = skull.displaceBy(
    (p) => base * (0.12 + 0.88 * smoothstep(0, 0.016, -hairline(p[0], p[1], p[2]))),
    base,
    1.6,
  );
  const parts: Sdf[] = [layer.intersect(new Sdf(hairline, BOUNDS))];

  // --- locks
  const messy = style === 'messy' ? 1 : 0;
  const lockCount = style === 'buzz' ? 0 : style === 'short' ? 90 : style === 'messy' ? 120 : long ? 110 : 70;
  const skullPoint = (az: number, el: number): { p: V3; n: V3 } => {
    const d: V3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    const p: V3 = [c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]];
    // forehead and occipital bulges push the surface out: march outward to the skull surface
    let t = 0;
    for (let i = 0; i < 6; i++) t -= skull.f(p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t);
    return {
      p: [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t],
      n: norm([d[0] / r[0], d[1] / r[1], d[2] / r[2]]),
    };
  };
  /** Pushes a point to the skull surface plus `off` along the radial direction. */
  const onSurface = (q: V3, off: number): V3 => {
    const d = norm([(q[0] - c[0]) / r[0], (q[1] - c[1]) / r[1], (q[2] - c[2]) / r[2]]);
    const dir = norm([d[0] * r[0], d[1] * r[1], d[2] * r[2]]);
    let p: V3 = [q[0], q[1], q[2]];
    for (let i = 0; i < 4; i++) {
      const e = skull.f(p[0], p[1], p[2]) - off;
      p = [p[0] - dir[0] * e, p[1] - dir[1] * e, p[2] - dir[2] * e];
    }
    return p;
  };
  const addLock = (p0: V3, n: V3, flowIn: V3, len: number, width: number, thick: number, lift: number) => {
    // a lock is marched along the scalp in the flow direction, hugging the head and lifting off at the tip
    const steps = 4;
    const pts: V3[] = [];
    const radii: number[] = [];
    let p = onSurface(p0, base + thick * 0.3);
    let f = flowIn;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push(p);
      radii.push(Math.max(0.003, width * 0.5 * (1 - 0.7 * t ** 1.4)));
      const nn = norm([(p[0] - c[0]) / r[0] ** 2, (p[1] - c[1]) / r[1] ** 2, (p[2] - c[2]) / r[2] ** 2]);
      const fn = dot(f, nn);
      const tan: V3 = [f[0] - nn[0] * fn, f[1] - nn[1] * fn, f[2] - nn[2] * fn];
      // degenerate (flow along the normal, e.g. straight down on the crown): comb away from the whorl
      f =
        Math.hypot(tan[0], tan[1], tan[2]) > 0.25
          ? norm(tan)
          : norm([p[0] - whorl[0], 0, p[2] - whorl[2] + 1e-3]);
      const q: V3 = [p[0] + f[0] * (len / steps), p[1] + f[1] * (len / steps), p[2] + f[2] * (len / steps)];
      p = onSurface(q, base + thick * 0.3 + lift * 0.02 * t * t + 0.0015 * t);
      // fringe tips stay above the eyebrows
      if (p[2] > 0.05 && p[1] < L.browY + 0.012) p[1] = L.browY + 0.012;
    }
    void n;
    // flatten: thin round chain under a slightly wider flattened body
    parts.push(
      sdf.chain(
        pts,
        radii.map((x) => Math.min(x, thick * 0.6)),
        { curve: false, smooth: 0.002 },
      ),
    );
    const mid = pts[1]!;
    const side = norm(cross(f, norm([mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]])));
    const up = norm(cross(side, f));
    const ctr = pts[1]!;
    parts.push(orientedEllipsoid(ctr, [f, up, side], [len * 0.32, thick * 0.5, width * 0.5]));
  };
  for (let i = 0; i < lockCount; i++) {
    const az = rng.range(-Math.PI, Math.PI);
    const el = rng.range(long ? -0.35 : -0.1, 1.45);
    const { p, n } = skullPoint(az, el);
    if (hairline(p[0], p[1], p[2]) > -0.006) continue;
    const away = norm([p[0] - whorl[0], (p[1] - whorl[1]) * 0.25, p[2] - whorl[2]]);
    const front = p[2] > 0.035;
    const gravity = long ? 1.2 : front ? 0.55 : 0.8;
    let flow: V3 = [away[0], away[1] - gravity, away[2] + (front ? 0.5 : 0)];
    const jitter = (0.25 + 0.45 * messy) * rng.range(-1, 1);
    const ts = norm(cross(flow, n));
    flow = [flow[0] + ts[0] * jitter, flow[1] + ts[1] * jitter, flow[2] + ts[2] * jitter];
    const len = long
      ? rng.range(0.05, 0.08)
      : style === 'short'
        ? rng.range(0.028, 0.042)
        : style === 'bun'
          ? rng.range(0.05, 0.08)
          : rng.range(0.04, 0.065);
    const width = long ? rng.range(0.018, 0.028) : rng.range(0.012, 0.02) * (style === 'short' ? 0.85 : 1);
    const thick =
      style === 'short'
        ? rng.range(0.005, 0.007)
        : long
          ? rng.range(0.0045, 0.0065)
          : rng.range(0.006, 0.009);
    const lift = (style === 'short' ? 0.06 : long ? 0.015 : 0.1) + messy * rng.range(0, 0.25);
    addLock(p, n, flow, len, width, thick, lift);
  }
  // fringe: locks from the top of the forehead falling forward over the hairline
  if (style === 'messy' || style === 'short') {
    const nF = style === 'messy' ? 11 : 9;
    for (let i = 0; i < nF; i++) {
      const u = (i + rng.range(-0.35, 0.35)) / (nF - 1) - 0.5;
      const { p, n } = skullPoint(u * 1.3, 0.72 + rng.range(-0.08, 0.1));
      const flow: V3 = [u * 0.6 + rng.range(-0.25, 0.25) * (0.5 + messy), -0.55 - rng.range(0, 0.3), 0.8];
      const len = style === 'messy' ? rng.range(0.035, 0.055) : rng.range(0.028, 0.04);
      addLock(
        p,
        n,
        flow,
        len,
        rng.range(0.016, 0.024),
        rng.range(0.006, 0.008),
        0.03 + messy * rng.range(0.03, 0.1),
      );
    }
  }
  if (long) {
    // hair falling to the shoulders behind the ears and down the back, open at the face
    const curtain = sdf
      .ellipsoid([r[0] + 0.017, 0.16, r[2] + 0.014], [0, 0.07, -0.03])
      .intersect(
        new Sdf(
          (x, y, z) => Math.max(-0.075 - y, z + 0.004 - 0.55 * Math.max(0, Math.abs(x) - 0.052)),
          BOUNDS,
        ),
      )
      .displaceBy(
        ([x, y, z]) => 0.0022 * Math.sin(Math.atan2(x, z) * 38 + noise.noise3(x * 20, y * 6, z * 20) * 2),
        0.0024,
        2,
      );
    parts.push(curtain);
  }
  if (style === 'bun') parts.push(sdf.ellipsoid([0.03, 0.028, 0.028], [0, 0.18, -0.108]));
  let shell = sdf.smoothUnionAll(parts, 0.0055);
  // strand grooves combed away from the crown whorl, broken up by noise
  shell = shell.displaceBy(
    ([x, y, z]) => {
      const az = Math.atan2(x - whorl[0], z - whorl[2]);
      return (
        0.0011 * Math.sin(az * 46 + noise.noise3(x * 28, y * 28, z * 28) * 2.2) +
        0.0008 * noise.noise3(x * 70, y * 70, z * 70)
      );
    },
    0.002,
    2.2,
  );
  const hi: RGB = [color[0] * 1.25 + 0.025, color[1] * 1.22 + 0.02, color[2] * 1.18 + 0.016];
  const root: RGB = [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8];
  return shell.colorBy(([x, y, z]) => {
    const out = Math.hypot((x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2]) - 1;
    const tip = smoothstep(0.02, 0.2, out);
    const streak = 0.5 + 0.5 * noise.noise3(x * 140, y * 50, z * 140);
    const t = clamp(0.2 * tip + 0.3 * streak * (0.3 + tip), 0, 1);
    const b: RGB = [
      root[0] + (color[0] - root[0]) * tip,
      root[1] + (color[1] - root[1]) * tip,
      root[2] + (color[2] - root[2]) * tip,
    ];
    return [b[0] + (hi[0] - b[0]) * t, b[1] + (hi[1] - b[1]) * t, b[2] + (hi[2] - b[2]) * t];
  });
}
