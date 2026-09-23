import { box, defineModel, model, PolyMesh, p } from 'aige/model';

/**
 * Old, decayed floorboards: planks run along Z with uneven heights, gaps, dark rot patches and a few
 * broken, splintered boards. Top surface at y = 0.
 */
export default defineModel({
  name: 'floor-planks',
  description: 'Decayed wooden floor (planks along Z), walkable top at y = 0.',
  params: {
    width: p.number(4, { min: 0.3, max: 20 }),
    depth: p.number(4, { min: 0.3, max: 20 }),
    plank: p.number(0.16, { min: 0.06, max: 0.4, description: 'Plank width' }),
    decay: p.number(0.5, { min: 0, max: 1 }),
    wood: p.color('#5a4230'),
    dirt: p.number(0, { min: 0, max: 1, description: 'Dirt layer (upper floor)' }),
  },
  build({ width, depth, plank, decay, wood, dirt }, { rng, noise }) {
    const planks: PolyMesh[] = [];
    const n = Math.max(1, Math.round(width / plank));
    const pw = width / n;
    const t = 0.035;
    const base = wood.match(/\w\w/g)!.map((h) => Number.parseInt(h, 16) / 255);
    const hex = (c: number[]) =>
      `#${c
        .map((v) =>
          Math.round(Math.max(0, Math.min(1, v)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
    for (let i = 0; i < n; i++) {
      const x = -width / 2 + pw * (i + 0.5);
      // Each plank row is split into boards of random length.
      let z = -depth / 2;
      while (z < depth / 2 - 0.01) {
        const len = Math.min(depth / 2 - z, rng.range(1.2, 2.6));
        const shade = rng.range(0.7, 1.15);
        const broken = rng.chance(0.06 * decay);
        const drop = rng.range(-0.006, 0.004) - (broken ? 0.02 : 0);
        const color = (cx: number, cz: number) => {
          const rot = noise.fbm(cx * 1.3, 0, cz * 1.3, 3) * decay;
          const d = dirt * (0.6 + 0.4 * noise.fbm(cx * 0.8 + 9, 1, cz * 0.8, 2));
          const c = base.map((v) => v * shade * (1 - Math.max(0, rot) * 0.55));
          return hex(c.map((v, k) => v * (1 - d) + [0.33, 0.27, 0.2][k]! * d));
        };
        let board = box({ size: [pw * 0.94, t, len * 0.985], center: [x, -t / 2 + drop, z + len / 2] });
        board = board.colorBy((pt) => color(pt[0], pt[2]));
        if (broken) {
          // a splintered, sagging board
          board = board
            .jitter(0.012, rng.int(1, 9999))
            .rotate([rng.range(-3, 3), 0, rng.range(-2, 2)], [x, 0, z + len / 2]);
        }
        planks.push(board);
        z += len;
      }
    }
    // subfloor shadow so gaps look dark
    planks.push(box({ size: [width, 0.02, depth], center: [0, -t - 0.012, 0] }).color('#140e0a'));
    const floor = PolyMesh.merge(...planks).material({ roughness: 0.93 });
    return model({ floor }).setCollider({ shape: 'box', size: [width, 0.1, depth], offset: [0, -0.05, 0] });
  },
});
