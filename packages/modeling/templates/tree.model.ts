import { cone, cylinder, defineModel, icosphere, model, PolyMesh, p } from 'aige/model';

/** Stylized low-poly tree: round (deciduous) or pine. Base at y = 0. */
export default defineModel({
  name: 'tree',
  description:
    'Low-poly tree. style "round" = leafy blobs, "pine" = stacked cones. Change seed for variation.',
  params: {
    height: p.number(3, { min: 0.5, max: 30 }),
    style: p.choice(['round', 'pine'], 'round'),
    leaves: p.color('#4f9d3a'),
    bark: p.color('#6b4a2f'),
  },
  build({ height, style, leaves, bark }, { rng }) {
    const trunkH = height * (style === 'pine' ? 0.3 : 0.45);
    const trunk = cylinder({ radius: height * 0.06, radiusTop: height * 0.04, height: trunkH, segments: 8 })
      .translate([0, trunkH / 2, 0])
      .material({ color: bark, roughness: 0.95, flatShading: true });
    const foliage: PolyMesh[] = [];
    if (style === 'pine') {
      for (let i = 0; i < 3; i++) {
        const r = height * (0.32 - i * 0.07);
        const h = height * 0.38;
        foliage.push(
          cone({ radius: r, height: h, segments: 9 }).translate([
            0,
            trunkH + i * height * 0.2 + h / 2 - height * 0.05,
            0,
          ]),
        );
      }
    } else {
      const blobs = 4;
      for (let i = 0; i < blobs; i++) {
        const r = height * rng.range(0.16, 0.24);
        const a = (i / blobs) * Math.PI * 2 + rng.range(0, 1);
        const off = i === 0 ? 0 : height * 0.13;
        foliage.push(
          icosphere({ radius: r, detail: 1 })
            .displace({ amount: r * 0.15, scale: 2, seed: rng.int(1, 999) })
            .translate([
              Math.cos(a) * off,
              trunkH + height * (i === 0 ? 0.28 : rng.range(0.12, 0.3)),
              Math.sin(a) * off,
            ]),
        );
      }
    }
    const crown = PolyMesh.merge(...foliage)
      .gradient('y', '#2f6b25', leaves)
      .material({ roughness: 0.9, flatShading: true });
    return model({ trunk, crown }).setCollider({
      shape: 'cylinder',
      radius: height * 0.06,
      height: trunkH,
      offset: [0, trunkH / 2, 0],
    });
  },
});
