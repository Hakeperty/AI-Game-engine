import { defineModel, eye, mixColor, model, p, type Sdf, sdf } from 'aige/model';

/**
 * Stylized fish: smooth tapered body, forked tail, dorsal/pectoral/belly fins, dark back and light belly, with
 * optional stripes or spots. Faces +Z, rests on y = 0 (lift it for swimming).
 */
export default defineModel({
  name: 'fish',
  description:
    'Stylized fish (clownfish, trout, goldfish...) with forked tail, fins and patterns. Faces +Z, bottom on y = 0.',
  params: {
    length: p.number(0.6, { min: 0.05, max: 10 }),
    body: p.color('#f07a1a'),
    belly: p.color('#ffe3c2'),
    fins: p.color('#ff9a3d'),
    pattern: p.choice(['stripes', 'spots', 'plain'], 'stripes'),
    patternColor: p.color('#fbfbf5'),
    chubby: p.number(1, { min: 0.6, max: 1.6, description: 'Body height multiplier' }),
  },
  build({ length, body, belly, fins, pattern, patternColor, chubby }, { seed }) {
    const h = 0.19 * chubby;
    // body designed ~1 m long along z (-0.6 tail .. +0.42 nose)
    let trunk: Sdf = sdf
      .ellipsoid([0.12, h, 0.34], [0, 0, 0.08])
      .smoothUnion(sdf.roundCone([0, 0, -0.12], [0, 0, -0.42], 0.1 * chubby, 0.035), 0.12)
      .color(body)
      .colorByNormal(mixColor(body, '#3a1d08', 0.35), '+y', 0.55, 0.5)
      .colorByNormal(belly, '-y', 0.2, 0.6);
    if (pattern === 'stripes')
      trunk = trunk.colorBy(([, , z], base) => {
        const d = Math.min(...[0.28, 0.02, -0.26].map((b) => Math.abs(z - b)));
        if (d > 0.05) return base;
        return d < 0.035 ? patternColor : '#1c1c1c';
      });
    else if (pattern === 'spots')
      trunk = trunk.colorSpots(patternColor, { scale: 12, size: 0.28, seed, softness: 0.04 });
    const thin = (s: Sdf) => s.stretch([0.22, 1, 1]);
    const tail = thin(
      sdf.smoothUnionAll(
        [
          sdf.roundCone([0, 0, 0], [0, 0.2, -0.17], 0.05, 0.03),
          sdf.roundCone([0, 0, 0], [0, -0.2, -0.17], 0.05, 0.03),
          sdf.ellipsoid([0.04, 0.12, 0.08], [0, 0, -0.08]),
        ],
        0.04,
      ),
    ).translate([0, 0, -0.43]);
    const dorsal = thin(
      sdf.chain(
        [
          [0, 0, 0.14],
          [0, 0.1, 0.02],
          [0, 0.12, -0.14],
        ],
        [0.03, 0.045, 0.02],
      ),
    ).translate([0, h * 0.8, 0]);
    const bellyFin = thin(sdf.roundCone([0, 0, 0], [0, -0.09, -0.08], 0.035, 0.02)).translate([
      0,
      -h * 0.75,
      -0.14,
    ]);
    const pecs = [-1, 1].map((side) =>
      sdf
        .ellipsoid([0.08, 0.014, 0.045], [0.07, 0, 0])
        .rotate([0, side < 0 ? 180 : 0, 0])
        .rotate([0, side * 40, side * -12])
        .translate([side * 0.095, -0.05, 0.14]),
    );
    const finShape = sdf
      .unionAll([tail, dorsal, bellyFin, ...pecs])
      .color(fins)
      .colorBy(([, , z], base) =>
        mixColor(base, mixColor(fins, '#ffffff', 0.45), Math.max(0, Math.min(1, (-z - 0.5) * 6))),
      );
    const mouth = sdf.ellipsoid([0.035, 0.012, 0.04], [0, -0.03, 0.42]).color('#5a1f0e');
    const fish = trunk.smoothUnion(finShape, 0.035).smoothSubtract(mouth, 0.01);
    const s = length / 1.02;
    const raw = fish.mesh({ resolution: 96, decimate: 14000, ao: 0.4 }).scale(s);
    const lift = -raw.bounds().min[1]; // lowest point (belly fin) sits on y = 0
    const eyes = [-1, 1].map((side) =>
      eye({ radius: 0.042, iris: '#1b1b1b', irisSize: 0.7, pupilSize: 0.45, segments: 16 })
        .rotate([0, side * 72, 0])
        .translate([side * 0.083, 0.045, 0.3])
        .scale(s),
    );
    return model({
      body: raw.translate([0, lift, 0]).material({ roughness: 0.35 }),
      eyes: eyes[0]!.merge(eyes[1]!).translate([0, lift, 0]).material({ roughness: 0.1 }),
    })
      .socket('mouth', [0, lift - 0.03 * s, 0.45 * s])
      .setCollider({ shape: 'capsule', radius: h * s, height: 0.9 * s, offset: [0, lift, 0] });
  },
});
