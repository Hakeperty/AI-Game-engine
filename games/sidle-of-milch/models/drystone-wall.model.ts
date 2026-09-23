import { defineModel, icosphere, model, PolyMesh, p } from 'aige/model';

/**
 * An Irish drystone field wall: irregular stones stacked without mortar in rough courses, with a row of
 * upright coping stones along the top. Runs along X (centered), base at y = 0. Meter UVs (part 'stones')
 * for a scanned rock material.
 */
export default defineModel({
  name: 'drystone-wall',
  description: 'Irish drystone field wall along X, base at y = 0 (part: stones, meter UVs).',
  params: {
    length: p.number(6, { min: 0.5, max: 30 }),
    height: p.number(1.1, { min: 0.3, max: 2 }),
    width: p.number(0.6, { min: 0.3, max: 1.2 }),
    tumble: p.number(0.15, { min: 0, max: 1, description: 'How much the wall has slumped and lost stones' }),
  },
  build({ length, height, width, tumble }, { rng }) {
    const stones: PolyMesh[] = [];
    const stone = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
      stones.push(
        icosphere({ radius: 0.5, detail: 1 })
          .scale([sx, sy, sz])
          .jitter(Math.min(sx, sy, sz) * 0.12, rng.int(1, 99999))
          .rotate([rng.range(-8, 8), rng.range(-25, 25), rng.range(-8, 8)])
          .translate([x, y, z]),
      );
    const courses = Math.max(2, Math.round((height * 0.8) / 0.22));
    const ch = (height * 0.8) / courses;
    for (let c = 0; c < courses; c++) {
      const taper = 1 - (c / courses) * 0.35; // walls batter inward toward the top
      const w = width * taper;
      let x = -length / 2 + rng.range(0, 0.15);
      while (x < length / 2) {
        const sx = rng.range(0.22, 0.45);
        if (!(tumble > 0 && c === courses - 1 && rng.chance(tumble * 0.4)))
          for (const side of [-1, 1])
            stone(
              x + sx / 2,
              ch * (c + 0.5),
              (side * w) / 4,
              sx,
              ch * rng.range(1.0, 1.35),
              w * rng.range(0.45, 0.6),
            );
        x += sx * rng.range(0.85, 1.0);
      }
    }
    // coping: flat stones set on edge along the top
    let x = -length / 2;
    while (x < length / 2) {
      const t = rng.range(0.07, 0.13);
      if (!rng.chance(tumble * 0.5))
        stones.push(
          icosphere({ radius: 0.5, detail: 1 })
            .scale([t, height * 0.25, width * 0.5])
            .jitter(0.012, rng.int(1, 9999))
            .rotate([0, rng.range(-6, 6), rng.range(-14, 14)])
            .translate([x + t / 2, height * 0.8 + height * 0.1, 0]),
        );
      x += t * rng.range(0.9, 1.1);
    }
    // a few fallen stones at the foot
    for (let i = 0; i < Math.round(length * tumble * 2); i++)
      stone(
        rng.range(-length / 2, length / 2),
        0.06,
        (rng.chance(0.5) ? 1 : -1) * rng.range(width * 0.5, width),
        0.25,
        0.14,
        0.2,
      );
    return model({
      stones: PolyMesh.merge(...stones)
        .uvBox(1)
        .material({ color: '#8b8b85', roughness: 0.95 }),
    }).setCollider({ shape: 'box', size: [length, height, width], offset: [0, height / 2, 0] });
  },
});
