import { defineModel, model, p, sdf } from 'aige/model';

/**
 * Cute blob character sculpted with signed distance fields: squashy body, feet, arms, eyes with pupils.
 * Faces +Z, feet on y = 0. Great as a player or NPC.
 */
export default defineModel({
  name: 'blob-character',
  description: 'Round blob creature with feet, little arms and big eyes. Faces +Z, stands on y = 0.',
  params: {
    height: p.number(1.2, { min: 0.2, max: 10 }),
    body: p.color('#6cc24a'),
    belly: p.color('#d9f2b4'),
    eyes: p.color('#ffffff'),
    pupils: p.color('#1d1d1f'),
    resolution: p.int(56, { min: 24, max: 120, description: 'SDF mesh detail' }),
  },
  build({ height, body, belly, eyes, pupils, resolution }) {
    const s = height / 1.2; // design at 1.2 m, then scale
    const torso = sdf
      .ellipsoid([0.48, 0.5, 0.44], [0, 0.62, 0])
      .colorBy(([, y, z]) => (z > 0.2 && y < 0.7 ? belly : body));
    const feet = sdf
      .ellipsoid([0.15, 0.09, 0.2], [0.2, 0.09, 0.05])
      .union(sdf.ellipsoid([0.15, 0.09, 0.2], [-0.2, 0.09, 0.05]))
      .color(body);
    const arms = sdf
      .capsule([0.42, 0.62, 0], [0.58, 0.45, 0.08], 0.08)
      .union(sdf.capsule([-0.42, 0.62, 0], [-0.58, 0.45, 0.08], 0.08))
      .color(body);
    const eyeWhites = sdf
      .sphere(0.12, [0.16, 0.86, 0.36])
      .union(sdf.sphere(0.12, [-0.16, 0.86, 0.36]))
      .color(eyes);
    const pupilDots = sdf
      .sphere(0.055, [0.16, 0.87, 0.47])
      .union(sdf.sphere(0.055, [-0.16, 0.87, 0.47]))
      .color(pupils);
    const creature = torso
      .smoothUnion(feet, 0.08)
      .smoothUnion(arms, 0.06)
      .union(eyeWhites)
      .union(pupilDots)
      .mesh({ resolution })
      .scale(s)
      .material({ roughness: 0.55 });
    return model({ body: creature })
      .socket('head', [0, 1.12 * s, 0])
      .socket('hand', [0.6 * s, 0.45 * s, 0.1 * s])
      .setCollider({ shape: 'capsule', radius: 0.45 * s, height: 1.12 * s, offset: [0, 0.56 * s, 0] });
  },
});
