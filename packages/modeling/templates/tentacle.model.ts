import { defineModel, mixColor, model, p, type Sdf, sdf, type V3 } from 'aige/model';

/**
 * Curling tentacle rising from the ground: tapered spline with a spiral tip, rows of suction cups on the inner
 * side, two-tone skin with spots. Base on y = 0, curls toward +Z.
 */
export default defineModel({
  name: 'tentacle',
  description:
    'Octopus/kraken tentacle rising from the ground and curling at the tip, with suction cups. Base on y = 0.',
  params: {
    height: p.number(1.5, { min: 0.1, max: 20 }),
    curl: p.number(1, { min: 0, max: 2, description: 'How much the tip spirals' }),
    color: p.color('#8e3fb8'),
    suckers: p.color('#f2b3c8'),
    spots: p.boolean(true),
    thickness: p.number(1, { min: 0.5, max: 2 }),
  },
  build({ height, curl, color, suckers, spots, thickness }, { rng, seed }) {
    const N = 26;
    const len = 2.2;
    const ds = len / N;
    const pts: V3[] = [[0, 0, 0]];
    const inner: V3[] = [[0, 0, 1]];
    const sway = rng.range(-0.25, 0.25);
    let pos: V3 = [0, 0, 0];
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const th = curl * 1.9 * Math.PI * t ** 2.4 - 0.15;
      const dir: V3 = [Math.sin(t * Math.PI) * sway * 0.3, Math.cos(th), Math.sin(th)];
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      pos = [pos[0] + (dir[0] / l) * ds, pos[1] + (dir[1] / l) * ds, pos[2] + (dir[2] / l) * ds];
      pts.push(pos);
      inner.push([0, -Math.sin(th), Math.cos(th)]); // side facing the curl
    }
    const rBase = 0.2 * thickness;
    const radius = (t: number) => rBase * (1 - 0.93 * t ** 0.85) + 0.008;
    const arm = sdf.chain(pts, radius, { samples: 4 });
    const flare = sdf.roundCone([0, -0.06, 0], [0, 0.18, 0], rBase * 1.25, rBase * 0.95);
    // suction cups on the inner side, two staggered rows
    const cups: Sdf[] = [];
    const holes: Sdf[] = [];
    for (let i = 4; i < N - 1; i++) {
      const r = radius(i / N);
      const cr = r * 0.36;
      const n = inner[i]!;
      const pt = pts[i]!;
      for (const row of [-1, 1]) {
        if ((i + (row > 0 ? 1 : 0)) % 2) continue;
        const c: V3 = [pt[0] + row * r * 0.42, pt[1] + n[1] * r * 0.9, pt[2] + n[2] * r * 0.9];
        cups.push(sdf.sphere(cr, c));
        holes.push(sdf.sphere(cr * 0.55, [c[0], c[1] + n[1] * cr * 0.7, c[2] + n[2] * cr * 0.7]));
      }
    }
    const dark = mixColor(color, '#1a0822', 0.5);
    let skin: Sdf = sdf
      .smoothUnionAll([arm, flare], 0.12)
      .gradient('y', dark, mixColor(color, '#ff9ad0', 0.15), [0, 1.2]);
    if (spots)
      skin = skin.colorSpots(mixColor(color, '#2a0a35', 0.55), {
        scale: 7,
        size: 0.28,
        seed,
        softness: 0.05,
      });
    const shape = skin
      .smoothUnion(sdf.unionAll(cups).color(suckers), 0.012)
      .smoothSubtract(sdf.unionAll(holes).color(mixColor(suckers, '#6a2040', 0.5)), 0.01)
      .cutBelow(0, 0.02);
    const s = height / Math.max(0.1, shape.bounds.max[1]);
    const mesh = shape
      .mesh({ resolution: 120, decimate: 18000, ao: 0.6 })
      .scale(s)
      .material({ roughness: 0.4 });
    const tip = pts[N]!;
    return model({ tentacle: mesh })
      .socket('tip', [tip[0] * s, tip[1] * s, tip[2] * s])
      .setCollider({ shape: 'capsule', radius: rBase * s, height, offset: [0, height / 2, 0] });
  },
});
