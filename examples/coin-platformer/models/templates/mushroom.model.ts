import { defineModel, mixColor, model, p, sdf, type Sdf, smoothstep } from 'aige/model';

/**
 * Storybook mushroom: curved stem with a bulb, domed cap with a rolled rim, gill ridges underneath and optional
 * spots. `count` > 1 adds smaller mushrooms around it. Base flat on y = 0.
 */
export default defineModel({
  name: 'mushroom',
  description: 'Toadstool / forest mushroom (or a small cluster) with spotted domed cap and gills. Base on y = 0.',
  params: {
    height: p.number(0.6, { min: 0.05, max: 10 }),
    cap: p.color('#c41e1a'),
    stem: p.color('#f1e8d6'),
    spots: p.boolean(true),
    spotColor: p.color('#fff8ec'),
    style: p.choice(['toadstool', 'porcini', 'tall'], 'toadstool'),
    count: p.int(1, { min: 1, max: 5, description: 'Mushrooms in the cluster' }),
  },
  build({ height, cap, stem, spots, spotColor, style, count }, { rng, seed }) {
    const one = (h: number, lean: number, yaw: number, sd: number): Sdf => {
      const capR = style === 'porcini' ? 0.36 : style === 'tall' ? 0.22 : 0.32;
      const capH = style === 'porcini' ? 0.2 : style === 'tall' ? 0.2 : 0.2;
      const stemH = style === 'tall' ? 0.62 : style === 'porcini' ? 0.36 : 0.46;
      const stemR = style === 'porcini' ? 0.13 : 0.075;
      const top = stemH;
      const stalk = sdf
        .chain(
          [
            [0, 0, 0],
            [lean * 0.3, top * 0.45, 0],
            [lean, top, 0],
          ],
          [stemR * (style === 'porcini' ? 1.35 : 1.45), stemR, stemR * 0.9],
        )
        .color(stem)
        .colorByNoise([stem, mixColor(stem, '#b89a70', 0.35)], 9, sd, 1.2);
      // gills: radial ridges on the underside
      const gills = (x: number, y: number, z: number) => {
        const r = Math.hypot(x - lean, z);
        const ring = smoothstep(stemR * 1.5, stemR * 2.2, r) * (1 - smoothstep(capR * 0.72, capR * 0.86, r));
        return 0.005 * Math.cos(44 * Math.atan2(z, x - lean)) * ring * (1 - smoothstep(top - 0.02, top + 0.03, y));
      };
      let dome: Sdf = sdf
        .ellipsoid([capR, capH, capR], [lean, top + 0.02, 0])
        .smoothSubtract(sdf.ellipsoid([capR * 0.86, capH * 0.45, capR * 0.86], [lean, top - 0.035, 0]), 0.03)
        .cutBelow(top - 0.05, 0.02)
        .displaceBy(([x, y, z]) => gills(x, y, z), 0.005)
        .color(cap)
        .colorByNormal(mixColor(stem, '#c9a57a', 0.3), '-y', 0.25, 0.3);
      if (spots && style !== 'porcini')
        dome = dome.colorSpots(spotColor, { scale: 11, size: 0.3, seed: sd, softness: 0.04 });
      if (style === 'porcini')
        dome = dome.gradient('y', mixColor(cap, '#3a2210', 0.2), mixColor(cap, '#f0c080', 0.15), [top, top + capH]);
      const m = stalk.smoothUnion(dome, 0.03);
      return m.rotate([0, yaw, 0]).scale(h);
    };
    const shapes: Sdf[] = [one(1, rng.range(-0.04, 0.04), rng.range(0, 360), seed)];
    for (let i = 1; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const d = rng.range(0.36, 0.46);
      const sc = rng.range(0.4, 0.65);
      shapes.push(
        one(sc, rng.range(0.03, 0.08), (a * 180) / Math.PI + 90, seed + i)
          .rotate([rng.range(-12, 12), 0, rng.range(-12, 12)])
          .translate([Math.cos(a) * d, 0, Math.sin(a) * d]),
      );
    }
    const all = sdf.unionAll(shapes).cutBelow(0, 0.01);
    const b = all.bounds;
    const s = height / Math.max(0.1, b.max[1]);
    const mesh = all.mesh({ resolution: count > 1 ? 96 : 84, decimate: 14000, ao: 0.6 }).scale(s).material({ roughness: 0.6 });
    return model({ mushroom: mesh }).setCollider({
      shape: 'cylinder',
      radius: 0.3 * s,
      height: b.max[1] * s,
      offset: [0, (b.max[1] * s) / 2, 0],
    });
  },
});
