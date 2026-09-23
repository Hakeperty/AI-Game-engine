import { defineModel, mixColor, model, p, sdf } from 'aige/model';

/** Floating sky island: a flat grassy top at y = 0 (walkable) and a rocky, craggy underside hanging below. */
export default defineModel({
  name: 'sky-island',
  description: 'Floating island platform. Walkable top at y = 0; rock hangs below. Collider hint included.',
  params: {
    width: p.number(5, { min: 2, max: 20, description: 'Diameter of the grassy top' }),
    depth: p.number(2.6, { min: 0.6, max: 12, description: 'How far the rock hangs down' }),
    grass: p.color('#6cbf4a'),
    rock: p.color('#8d7358'),
  },
  build({ width, depth, grass, rock }, { seed, noise }) {
    const r = width / 2;
    const cap = sdf.cylinder(r, 0.6, [0, -0.3, 0], 0.18);
    const crag = sdf.roundCone([0, -0.4, 0], [0, -depth, 0], r * 0.82, r * 0.12);
    const lumps = [0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2 + seed;
      return sdf.sphere(r * 0.35, [Math.cos(a) * r * 0.45, -depth * 0.45, Math.sin(a) * r * 0.45]);
    });
    const shape = sdf
      .smoothUnionAll([cap, crag, ...lumps], r * 0.25)
      .warp(0.16 * r, 0.9 / r, seed)
      .displace(0.06 * r, 2.2 / r, seed + 1)
      .cutAbove(0, 0.03)
      .colorBy((pt) => {
        const n = noise.fbm((pt[0] * 1.6) / r, pt[1] * 1.6, (pt[2] * 1.6) / r, 3); // about -1..1
        if (pt[1] > -0.3 + n * 0.1) return mixColor(grass, '#4c9a33', 0.5 + 0.6 * n);
        const deep = Math.min(1, -pt[1] / depth);
        return mixColor(mixColor(rock, '#b09376', 0.5 + 0.5 * n), '#5a4634', deep * 0.7);
      });
    const mesh = shape.mesh({ detail: 'medium', ao: 0.6, decimate: 9000 }).material({ roughness: 0.92 });
    return model({ island: mesh }).setCollider({ shape: 'cylinder', radius: r * 0.93, height: 0.6, offset: [0, -0.3, 0] });
  },
});
