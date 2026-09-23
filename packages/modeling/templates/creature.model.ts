import { defineModel, eye, model, p, type Sdf, sdf, type V3 } from 'aige/model';

/**
 * Cute quadruped critter sculpted from SDF chains: round body, big head with snout, tapered legs, fluffy tail,
 * ears and glossy cartoon eyes. Light belly and muzzle, optional spots. Faces +Z, paws flat on y = 0.
 */
export default defineModel({
  name: 'creature',
  description:
    'Cute four-legged critter (fox/dog/cat-like) built from smooth SDF chains, with ears, tail and cartoon eyes. Faces +Z, stands on y = 0.',
  params: {
    height: p.number(0.9, { min: 0.1, max: 10, description: 'Height to the ear tips (m)' }),
    fur: p.color('#cf5f17'),
    belly: p.color('#fbe9cf'),
    iris: p.color('#4a2f1b'),
    ears: p.choice(['pointy', 'round', 'floppy'], 'pointy'),
    tail: p.choice(['fluffy', 'thin', 'none'], 'fluffy'),
    spots: p.boolean(false, { description: 'Dark spots on the fur' }),
    legLength: p.number(1, { min: 0.5, max: 2, description: 'Leg length multiplier' }),
    chubby: p.number(1, { min: 0.7, max: 1.5, description: 'Body roundness' }),
  },
  build({ height, fur, belly, iris, ears, tail, spots, legLength, chubby }, { rng, seed }) {
    const L = legLength;
    const lift = (L - 1) * 0.16; // longer legs raise the body
    const Y = (y: number) => y + lift;
    const legTop = Y(0.34);

    // Body and head (designed at ~0.9 m tall, scaled at the end).
    let body: Sdf = sdf
      .ellipsoid([0.2 * chubby, 0.18 * chubby, 0.3], [0, Y(0.37), -0.03])
      .color(fur)
      .colorByNormal(belly, '-y', 0.25, 0.5);
    if (spots) body = body.colorSpots('#5a3a22', { scale: 9, size: 0.3, seed, softness: 0.05 });
    const head = sdf
      .sphere(0.19, [0, Y(0.6), 0.25])
      .color(fur)
      .colorByNormal(belly, '-y', 0.35, 0.5);
    const cheeks = sdf
      .ellipsoid([0.17, 0.12, 0.13], [0, Y(0.53), 0.3])
      .color(fur)
      .colorByNormal(belly, '-y', 0.1, 0.6);
    const snout = sdf.ellipsoid([0.085, 0.065, 0.09], [0, Y(0.535), 0.42]).color(belly);
    const nose = sdf.ellipsoid([0.035, 0.025, 0.022], [0, Y(0.57), 0.505]).color('#2a1d17');

    // Legs: tapered chains with a slight knee, paws flattened by the ground cut below.
    const legs: Sdf[] = [];
    for (const side of [-1, 1]) {
      const fx = side * 0.1;
      const bx = side * 0.115;
      legs.push(
        sdf
          .chain(
            [
              [fx, legTop, 0.12],
              [fx * 1.05, Y(0.34) - 0.17 * L, 0.135],
              [fx * 1.08, 0.05, 0.14],
            ],
            [0.075, 0.058, 0.052],
          )
          .color(fur),
        sdf
          .chain(
            [
              [bx, legTop + 0.03, -0.18],
              [bx * 1.12, Y(0.34) - 0.13 * L, -0.24],
              [bx * 1.05, 0.05, -0.19],
            ],
            [0.1, 0.064, 0.054],
          )
          .color(fur),
      );
      for (const z of [0.165, -0.165]) {
        legs.push(
          sdf.ellipsoid([0.062, 0.045, 0.078], [side * (z > 0 ? 0.108 : 0.121), 0.04, z]).color(belly),
        );
      }
    }

    // Ears
    const earParts: Sdf[] = [];
    for (const side of [-1, 1]) {
      let ear: Sdf;
      if (ears === 'round') {
        ear = sdf.ellipsoid([0.065, 0.065, 0.03], [0, 0.04, 0]);
      } else if (ears === 'floppy') {
        ear = sdf
          .chain(
            [
              [0, 0, 0],
              [0.04, -0.02, 0.01],
              [0.07, -0.12, 0.02],
            ],
            [0.045, 0.05, 0.035],
          )
          .stretch([1, 1, 0.5]);
      } else {
        ear = sdf.roundCone([0, 0, 0], [0, 0.15, 0], 0.068, 0.014).stretch([1, 1, 0.45]);
      }
      const inner = ear.color(fur).colorByNormal('#f2b8a0', '+z', 0.5, 0.4);
      const tilt: V3 = ears === 'floppy' ? [10, side * 10, side * 5] : [-12, side * -8, side * -22];
      earParts.push(
        inner
          .rotate(tilt)
          .scale(1)
          .translate([side * (ears === 'floppy' ? 0.15 : 0.11), Y(ears === 'floppy' ? 0.7 : 0.72), 0.2]),
      );
    }

    // Tail
    const tailParts: Sdf[] = [];
    if (tail !== 'none') {
      const wag = rng.range(-0.06, 0.06);
      const pts: V3[] = [
        [0, Y(0.4), -0.28],
        [wag, Y(0.44), -0.43],
        [wag * 2, Y(0.58), -0.52],
        [wag * 2.5, Y(0.72), -0.48],
      ];
      const r =
        tail === 'fluffy'
          ? (t: number) => 0.035 + 0.065 * Math.sin(Math.PI * Math.min(1, t * 1.1)) ** 0.8 + 0.01
          : (t: number) => 0.04 * (1 - t) + 0.012;
      tailParts.push(
        sdf
          .chain(pts, r)
          .color(fur)
          .colorBy(([, y], base) => (y > Y(0.66) ? belly : base)),
      );
    }

    const shape = sdf
      .smoothUnionAll([body, head, cheeks, ...legs, ...tailParts], 0.07)
      .smoothUnion(snout, 0.05)
      .smoothUnion(nose, 0.015)
      .smoothUnion(sdf.unionAll(earParts), 0.035)
      .cutBelow(0, 0.01);
    const s = height / (Y(0.86) + 0.02);
    const furMesh = shape
      .mesh({ resolution: 88, decimate: 16000, ao: 0.55 })
      .scale(s)
      .material({ roughness: 0.75 });

    const eyes = [-1, 1].map((side) =>
      eye({ radius: 0.052, iris, irisSize: 0.66, pupilSize: 0.38, segments: 18 })
        .rotate([-6, side * 16, 0])
        .translate([side * 0.083, Y(0.635), 0.395])
        .scale(s),
    );
    return model({
      body: furMesh,
      eyes: eyes[0]!.merge(eyes[1]!).material({ roughness: 0.15 }),
    })
      .socket('head', [0, Y(0.8) * s, 0.25 * s])
      .socket('mouth', [0, Y(0.5) * s, 0.48 * s])
      .setCollider({ shape: 'capsule', radius: 0.2 * s, height: 0.9 * s, offset: [0, Y(0.4) * s, 0] });
  },
});
