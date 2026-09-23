import {
  box,
  defineModel,
  icosphere,
  mixColor,
  model,
  p,
  plants,
  type PolyMesh,
  Random,
  terrain,
  terrainHeight,
  type TerrainOptions,
} from 'aige/model';

/**
 * Small island diorama: noise heightfield with a sandy beach, grassy hills and rocky peaks as a closed slab,
 * a translucent sea plane at y = 0, plus seeded trees and boulders placed on the surface. Centered on the origin.
 */
export default defineModel({
  name: 'island-terrain',
  description:
    'Island terrain slab (beach, grass, rock, snow bands) with sea plane, trees and rocks. Usable as a level; sea level y = 0.',
  params: {
    size: p.number(9, { min: 2, max: 400, description: 'Island width (m)' }),
    height: p.number(1.8, { min: 0.2, max: 80, description: 'Peak height (m)' }),
    resolution: p.int(80, { min: 16, max: 256, description: 'Grid segments' }),
    trees: p.int(6, { min: 0, max: 40 }),
    rocks: p.int(5, { min: 0, max: 40 }),
    water: p.boolean(true),
    waterColor: p.color('#2e8fd0'),
    snow: p.boolean(false, { description: 'Snowy peaks' }),
  },
  build({ size, height, resolution, trees, rocks, water, waterColor, snow }, { seed }) {
    const opts: TerrainOptions = {
      size,
      height,
      resolution,
      seed,
      island: 0.45,
      slab: height * 0.35,
      noise: { scale: 2.2, ridged: 0.35, warp: 0.35, exponent: 1.35 },
      colors: { snowLine: snow ? 0.72 : 2 },
    };
    const land = terrain(opts).material({ roughness: 0.95 });
    const h = terrainHeight(opts);
    const rng = new Random(seed + 17);
    const s = size / 9; // props are designed for a 9 m island
    const props: PolyMesh[] = [];
    const woods: PolyMesh[] = [];
    const place = (minH: number, maxH: number): [number, number, number] | null => {
      for (let tries = 0; tries < 40; tries++) {
        const x = rng.range(-size * 0.4, size * 0.4);
        const z = rng.range(-size * 0.4, size * 0.4);
        const y = h(x, z);
        const slope = Math.abs(h(x + 0.05 * s, z) - y) + Math.abs(h(x, z + 0.05 * s) - y);
        if (y > minH && y < maxH && slope < 0.03 * s) return [x, y, z];
      }
      return null;
    };
    for (let i = 0; i < trees; i++) {
      const at = place(height * 0.12, height * 0.7);
      if (!at) continue;
      const t = plants.tree({
        seed: seed * 31 + i,
        length: rng.range(0.5, 0.75) * s,
        levels: 2,
        children: [2, 3],
        foliage: 'blobs',
        leafSize: 0.28 * s,
        leafColor: mixColor('#3f8f32', '#6aa83a', rng.next()),
        sides: 6,
      });
      woods.push(t.wood.translate([at[0], at[1] - 0.03 * s, at[2]]));
      props.push(t.leaves.translate([at[0], at[1] - 0.03 * s, at[2]]));
    }
    const stones: PolyMesh[] = [];
    for (let i = 0; i < rocks; i++) {
      const at = place(0.02 * height, height * 0.9);
      if (!at) continue;
      const r = rng.range(0.1, 0.22) * s;
      stones.push(
        icosphere({ radius: r, detail: 1 })
          .scale([rng.range(0.9, 1.3), rng.range(0.55, 0.8), 1])
          .displace({ amount: r * 0.25, scale: 1.5 / r, seed: seed + i })
          .rotate([0, rng.range(0, 360), 0])
          .translate([at[0], at[1] + r * 0.1, at[2]])
          .gradient('y', '#5b5e62', '#9a9ea3'),
      );
    }
    const parts: Record<string, PolyMesh> = { land };
    if (woods.length) parts.trunks = woods[0]!.merge(...woods.slice(1)).material({ roughness: 0.9 });
    if (props.length) parts.foliage = props[0]!.merge(...props.slice(1)).material({ roughness: 0.85, flatShading: true });
    if (stones.length) parts.rocks = stones[0]!.merge(...stones.slice(1)).material({ roughness: 0.95, flatShading: true });
    if (water) {
      parts.water = box({ size: [size * 1.02, 0.02 * s, size * 1.02], center: [0, -0.012 * s, 0] }).material({
        color: waterColor,
        roughness: 0.08,
        metalness: 0.1,
        opacity: 0.72,
      });
    }
    return model(parts).setCollider({ shape: 'mesh' });
  },
});
