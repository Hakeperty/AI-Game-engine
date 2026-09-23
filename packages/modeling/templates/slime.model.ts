import { defineModel, eye, mixColor, model, p, sdf, type Sdf, type V3 } from 'aige/model';

/**
 * Glossy slime monster: a squashy drop with a flat, rounded base, little puddle drips, shiny eyes and a smile
 * carved into the goo. Faces +Z, sits on y = 0.
 */
export default defineModel({
  name: 'slime',
  description: 'Glossy cartoon slime (drop or round blob) with puddle drips, eyes and a carved mouth. Faces +Z, sits on y = 0.',
  params: {
    height: p.number(0.8, { min: 0.1, max: 10 }),
    color: p.color('#2fb34f'),
    shape: p.choice(['drop', 'round'], 'drop'),
    mood: p.choice(['happy', 'surprised', 'grumpy'], 'happy'),
    drips: p.int(5, { min: 0, max: 10, description: 'Puddle drips around the base' }),
  },
  build({ height, color, shape, mood, drips }, { rng }) {
    const dark = mixColor(color, '#0b2a1a', 0.45);
    const light = mixColor(color, '#ffffff', 0.35);
    // designed 1 m wide, ~0.85 m tall
    const parts: Sdf[] = [sdf.ellipsoid([0.5, 0.4, 0.46], [0, 0.34, 0])];
    if (shape === 'drop') parts.push(sdf.roundCone([0, 0.5, -0.02], [0.06, 0.86, -0.1], 0.2, 0.035));
    for (let i = 0; i < drips; i++) {
      const a = (i / Math.max(1, drips)) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = rng.range(0.42, 0.5);
      const s = rng.range(0.07, 0.12);
      parts.push(sdf.ellipsoid([s * 1.4, s * 0.45, s * 1.4], [Math.cos(a) * r, 0.03, Math.sin(a) * r]));
    }
    let goo: Sdf = sdf.smoothUnionAll(parts, 0.12).cutBelow(0, 0.06);
    goo = goo
      .gradient('y', dark, light, [0, 0.85])
      .colorByNoise([color, mixColor(color, light, 0.5)], 3, 7, 1.5)
      .colorBy(([, y], base) => mixColor(base, dark, Math.max(0, 1 - y / 0.25) * 0.6));
    // mouth: a curved groove carved into the front (points sit on the body surface)
    const onSurface = (x: number, y: number): V3 => {
      const q = 1 - (x / 0.5) ** 2 - ((y - 0.34) / 0.4) ** 2;
      return [x, y, 0.46 * Math.sqrt(Math.max(0, q)) + 0.004];
    };
    const mouthY = 0.3;
    const curve = mood === 'happy' ? -0.055 : mood === 'grumpy' ? 0.04 : 0;
    const mouthPts: V3[] =
      mood === 'surprised'
        ? [onSurface(0, mouthY + 0.015), onSurface(0, mouthY - 0.015)]
        : [-0.13, -0.065, 0, 0.065, 0.13].map((x) => onSurface(x, mouthY + curve * (1 - (x / 0.13) ** 2)));
    const mouth = sdf.chain(mouthPts, mood === 'surprised' ? 0.055 : 0.03).color('#123d24');
    goo = goo.smoothSubtract(mouth, 0.015);
    const s = height / 0.86;
    const body = goo.mesh({ resolution: 80, decimate: 14000, ao: 0.4 }).scale(s).material({ roughness: 0.12, metalness: 0 });
    const eyeY = 0.5;
    const eyes = [-1, 1].map((side) =>
      eye({ radius: 0.085, irisSize: 0, pupilSize: 0.62, pupil: '#101410', segments: 18 })
        .scale([1, mood === 'grumpy' ? 0.7 : 1.15, 1])
        .rotate([mood === 'grumpy' ? 8 : -4, side * 14, side * (mood === 'grumpy' ? -18 : 0)])
        .translate([side * 0.15, eyeY, 0.38])
        .scale(s),
    );
    return model({ body, eyes: eyes[0]!.merge(eyes[1]!).material({ roughness: 0.1 }) })
      .socket('top', [0, 0.86 * s, 0])
      .setCollider({ shape: 'sphere', radius: 0.45 * s, offset: [0, 0.4 * s, 0] });
  },
});
