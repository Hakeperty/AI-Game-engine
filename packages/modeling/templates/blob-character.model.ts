import { defineModel, eye, model, p, sdf } from 'aige/model';

/**
 * Cute blob character sculpted with signed distance fields: squashy body, feet, arms, light belly and glossy
 * cartoon eyes. Faces +Z, feet on y = 0. Great as a player or NPC.
 */
export default defineModel({
  name: 'blob-character',
  description: 'Round blob creature with feet, little arms and big eyes. Faces +Z, stands on y = 0.',
  params: {
    height: p.number(1.2, { min: 0.2, max: 10 }),
    body: p.color('#58b83a'),
    belly: p.color('#d9f2b4'),
    eyes: p.color('#ffffff'),
    pupils: p.color('#1d1d1f'),
    resolution: p.int(72, { min: 24, max: 160, description: 'SDF mesh detail' }),
  },
  build({ height, body, belly, eyes, pupils, resolution }) {
    const s = height / 1.2; // design at 1.2 m, then scale
    const torso = sdf
      .ellipsoid([0.48, 0.5, 0.44], [0, 0.62, 0])
      .color(body)
      .colorByNormal(belly, [0, -0.35, 1], 0.55, 0.25);
    const feet = sdf
      .ellipsoid([0.15, 0.09, 0.2], [0.2, 0.09, 0.05])
      .union(sdf.ellipsoid([0.15, 0.09, 0.2], [-0.2, 0.09, 0.05]))
      .color(body);
    const arms = sdf
      .chain(
        [
          [0.4, 0.66, 0],
          [0.54, 0.54, 0.04],
          [0.6, 0.44, 0.1],
        ],
        [0.09, 0.075, 0.07],
      )
      .mirrorX()
      .color(body);
    const creature = sdf
      .smoothUnionAll([torso, feet, arms], 0.07)
      .cutBelow(0, 0.02)
      .mesh({ resolution, ao: 0.5 })
      .scale(s)
      .material({ roughness: 0.55 });
    const eyeMeshes = [-1, 1].map((side) =>
      eye({ radius: 0.12, sclera: eyes, pupil: pupils, irisSize: 0, pupilSize: 0.46, segments: 22 })
        .rotate([-4, side * 14, 0])
        .translate([side * 0.16, 0.86, 0.315])
        .scale(s),
    );
    return model({ body: creature, eyes: eyeMeshes[0]!.merge(eyeMeshes[1]!).material({ roughness: 0.15 }) })
      .socket('head', [0, 1.12 * s, 0])
      .socket('hand', [0.6 * s, 0.45 * s, 0.1 * s])
      .setCollider({ shape: 'capsule', radius: 0.45 * s, height: 1.12 * s, offset: [0, 0.56 * s, 0] });
  },
});
