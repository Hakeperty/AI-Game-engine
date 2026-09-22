import { cylinder, defineModel, model, p, sdf } from 'aige/model';

/** Wall/ground torch with a glowing flame. Base at y = 0. Pair it with a point Light at the 'flame' socket. */
export default defineModel({
  name: 'torch',
  description: 'Wooden torch with an emissive flame. Add a point Light at the flame socket for real light.',
  params: {
    height: p.number(1, { min: 0.2, max: 10 }),
    flame: p.color('#ffb020'),
    wood: p.color('#6b4a2f'),
  },
  build({ height: h, flame, wood }) {
    const handle = cylinder({ radius: h * 0.035, radiusTop: h * 0.05, height: h * 0.75, segments: 10 })
      .translate([0, h * 0.375, 0])
      .material({ color: wood, roughness: 0.9 });
    const cup = cylinder({ radius: h * 0.08, radiusTop: h * 0.1, height: h * 0.08, segments: 12 })
      .translate([0, h * 0.78, 0])
      .material({ color: '#444444', metalness: 0.8, roughness: 0.5 });
    const fire = sdf
      .sphere(0.09, [0, 0.9, 0])
      .smoothUnion(sdf.cone(0.07, 0.22, [0, 1.02, 0]), 0.06)
      .displace(0.01, 12, 3)
      .mesh({ resolution: 32 })
      .scale(h)
      .material({ color: flame, emissive: flame, emissiveIntensity: 3, roughness: 1 });
    return model({ handle: handle.merge(cup), flame: fire })
      .socket('flame', [0, h * 0.95, 0])
      .setCollider({ shape: 'cylinder', radius: h * 0.06, height: h * 0.8, offset: [0, h * 0.4, 0] });
  },
});
