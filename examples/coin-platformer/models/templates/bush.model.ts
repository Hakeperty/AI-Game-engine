import { defineModel, icosphere, mixColor, model, Noise, PolyMesh, p, sdf, type V3 } from 'aige/model';

/**
 * Round leafy bush: a cluster of warped metaball clumps with two-tone leaf patches, darker inside/bottom and
 * baked ambient occlusion. Optional berries or flowers. Flat on y = 0.
 */
export default defineModel({
  name: 'bush',
  description:
    'Leafy shrub made of soft, lumpy foliage clumps with optional berries or flowers. Sits on y = 0.',
  params: {
    height: p.number(0.9, { min: 0.1, max: 10 }),
    width: p.number(1.3, { min: 0.1, max: 20, description: 'Approximate width (m)' }),
    leaves: p.color('#2f7f28'),
    leaves2: p.color('#7dbb45', { description: 'Second leaf tone' }),
    clumps: p.int(9, { min: 3, max: 24 }),
    extras: p.choice(['none', 'berries', 'flowers'], 'berries'),
    extraColor: p.color('#d6283a'),
  },
  build({ height, width, leaves, leaves2, clumps, extras, extraColor }, { rng, seed }) {
    // designed 1 m tall, 1.4 m wide; scaled to height/width at the end
    const balls: { center: V3; radius: number }[] = [{ center: [0, 0.42, 0], radius: 0.36 }];
    for (let i = 1; i < clumps; i++) {
      // golden-angle spiral over a dome
      const f = (i + 0.5) / clumps;
      const up = 0.15 + 0.8 * f;
      const a = i * 2.39996 + rng.range(-0.25, 0.25);
      const r = 0.44 * Math.sqrt(1 - up * up) + 0.06;
      balls.push({
        center: [Math.cos(a) * r, 0.2 + up * 0.52 + rng.range(-0.05, 0.05), Math.sin(a) * r],
        radius: rng.range(0.22, 0.3) * (1.05 - up * 0.2),
      });
    }
    const dark = mixColor(leaves, '#0d2410', 0.55);
    const cells = new Noise(seed + 5);
    const foliage = sdf
      .smoothUnionAll(
        balls.map((b) => sdf.sphere(b.radius, b.center)),
        0.12,
      )
      .displaceBy(([x, y, z]) => 0.05 * (0.55 - cells.worley(x * 10, y * 10, z * 10)), 0.035)
      .warp(0.035, 3, seed)
      .cutBelow(0.02, 0.05)
      .colorByNoise([leaves, leaves2], 3.5, seed + 2, 2.5)
      .colorBy(([x, y, z], base) => {
        const bump = 0.55 - cells.worley(x * 10, y * 10, z * 10);
        return mixColor(mixColor(dark, base, Math.min(1, 0.2 + y * 1.1)), leaves2, Math.max(0, bump) * 0.5);
      });
    const sx = width / 1.4;
    const sy = height / 1.0;
    const body = foliage
      .mesh({ resolution: 72, decimate: 12000, ao: 0.8 })
      .scale([sx, sy, sx])
      .placeOnGround(0)
      .material({ roughness: 0.9 });
    const parts: Record<string, PolyMesh> = { foliage: body };
    if (extras !== 'none') {
      // put berries/flowers on the outer surface, pointing outward
      const dots: PolyMesh[] = [];
      const count = 26;
      const probe = foliage;
      for (let i = 0; i < count; i++) {
        const dir: V3 = rng.direction();
        if (dir[1] < -0.1) dir[1] = -dir[1] * 0.3;
        const c: V3 = [0, 0.45, 0];
        let t = 0.2;
        for (
          let k = 0;
          k < 40 && probe.distance([c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t]) < 0;
          k++
        )
          t += 0.03;
        const pos: V3 = [
          c[0] + dir[0] * (t - 0.025),
          c[1] + dir[1] * (t - 0.025) - 0.02,
          c[2] + dir[2] * (t - 0.025),
        ];
        if (pos[1] < 0.12) continue;
        if (extras === 'berries') {
          dots.push(
            icosphere({ radius: rng.range(0.025, 0.035), detail: 2 })
              .translate(pos)
              .color(extraColor),
          );
        } else {
          const petals = icosphere({ radius: 0.03, detail: 1 })
            .scale([1, 0.35, 1])
            .translate([0.035, 0, 0])
            .radial(5)
            .color(extraColor)
            .merge(icosphere({ radius: 0.022, detail: 1 }).color('#ffd23a'));
          const yaw = (Math.atan2(dir[0], dir[2]) * 180) / Math.PI;
          const pitch = 90 - (Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180) / Math.PI;
          dots.push(petals.rotate([pitch, 0, 0]).rotate([0, yaw, 0]).translate(pos));
        }
      }
      if (dots.length)
        parts[extras] = PolyMesh.merge(...dots)
          .scale([sx, sy, sx])
          .material({ roughness: extras === 'berries' ? 0.25 : 0.6 });
    }
    return model(parts).setCollider({
      shape: 'sphere',
      radius: 0.55 * Math.max(sx, sy),
      offset: [0, 0.45 * sy, 0],
    });
  },
});
