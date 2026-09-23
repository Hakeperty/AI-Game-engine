import { defineModel, lathe, mixColor, model, type PolyMesh, p, type Sdf, sdf, smoothstep } from 'aige/model';

/**
 * Saguaro-style cactus: ribbed trunk with bent arms, darker rib valleys, tiny spine dots and an optional flower
 * on top. Optional terracotta pot. Base on y = 0.
 */
export default defineModel({
  name: 'cactus',
  description: 'Ribbed saguaro cactus with arms, spines, optional flower and pot. Base on y = 0.',
  params: {
    height: p.number(1.4, { min: 0.1, max: 12 }),
    arms: p.int(2, { min: 0, max: 4 }),
    color: p.color('#3f8f3a'),
    ribs: p.int(12, { min: 5, max: 24 }),
    flower: p.boolean(true),
    flowerColor: p.color('#ff5fa2'),
    pot: p.boolean(false),
  },
  build({ height, arms, color, ribs, flower, flowerColor, pot }, { rng, seed }) {
    const R = 0.15;
    const H = 1.1;
    // rib profile around a vertical axis: +1 on ridges, -1 in valleys
    const rib = (cx: number, cz: number, n: number) => (x: number, z: number) =>
      Math.abs(Math.cos((n / 2) * Math.atan2(z - cz, x - cx))) * 2 - 1;
    const trunkRib = rib(0, 0, ribs);
    const parts: Sdf[] = [
      sdf
        .chain(
          [
            [0, -0.05, 0],
            [0, H * 0.5, 0],
            [rng.range(-0.02, 0.02), H - R, 0],
          ],
          [R * 1.05, R, R * 0.92],
        )
        .displaceBy(([x, , z]) => 0.012 * trunkRib(x, z), 0.012),
    ];
    const armDefs = [
      { side: 1, y: 0.42, out: 0.33, up: 0.34 },
      { side: -1, y: 0.58, out: 0.3, up: 0.26 },
      { side: 1, y: 0.72, out: 0.26, up: 0.18 },
      { side: -1, y: 0.3, out: 0.3, up: 0.3 },
    ].slice(0, arms);
    armDefs.forEach((a, i) => {
      const yaw = rng.range(-25, 25) + (i >= 2 ? 90 : 0);
      const ax = a.side * a.out;
      const r = R * rng.range(0.62, 0.72);
      const armRib = rib(ax, 0, Math.max(6, ribs - 2));
      parts.push(
        sdf
          .chain(
            [
              [0, a.y, 0],
              [ax * 0.7, a.y + 0.02, 0],
              [ax, a.y + 0.1, 0],
              [ax, a.y + 0.1 + a.up, 0],
            ],
            [r, r, r * 0.97, r * 0.9],
          )
          .displaceBy(([x, y, z]) => 0.009 * armRib(x, z) * smoothstep(a.y + 0.08, a.y + 0.16, y), 0.009)
          .rotate([0, yaw, 0]),
      );
    });
    const dark = mixColor(color, '#0f2a12', 0.5);
    const light = mixColor(color, '#b8d86a', 0.35);
    let cactus: Sdf = sdf
      .smoothUnionAll(parts, 0.06)
      .cutBelow(0, 0.01)
      .colorBy(([x, y, z]) => {
        const r = trunkRib(x, z);
        const base = mixColor(dark, color, smoothstep(0, 0.35, y));
        return r > 0 ? mixColor(base, light, r * 0.35) : mixColor(base, dark, -r * 0.3);
      })
      .colorSpots('#f4f0d8', { scale: 26, size: 0.12, seed, softness: 0.03 });
    if (flower) {
      const petals: Sdf[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        petals.push(
          sdf.ellipsoid([0.045, 0.02, 0.028], [Math.cos(a) * 0.045, H + 0.005, Math.sin(a) * 0.045]),
        );
      }
      const bloom = sdf
        .unionAll(petals)
        .color(flowerColor)
        .union(sdf.sphere(0.022, [0, H + 0.02, 0]).color('#ffd23a'));
      cactus = cactus.smoothUnion(bloom, 0.015);
    }
    const potH = pot ? 0.29 : 0;
    const total = H + (flower ? 0.04 : 0) + potH;
    const s = height / total;
    const out: Record<string, PolyMesh> = {
      cactus: cactus
        .mesh({ resolution: 100, decimate: 16000, ao: 0.6 })
        .translate([0, potH * 0.9, 0])
        .scale(s)
        .material({ roughness: 0.7 }),
    };
    if (pot) {
      out.pot = lathe(
        [
          [0, 0],
          [0.2, 0],
          [0.24, 0.24],
          [0.27, 0.25],
          [0.27, 0.31],
          [0.22, 0.31],
          [0.21, 0.27],
          [0, 0.27],
        ],
        { segments: 40 },
      )
        .gradient('y', '#8a4a2a', '#c8693a')
        .scale(s)
        .material({ roughness: 0.85 });
    }
    return model(out).setCollider({
      shape: 'cylinder',
      radius: R * s * 1.2,
      height,
      offset: [0, height / 2, 0],
    });
  },
});
