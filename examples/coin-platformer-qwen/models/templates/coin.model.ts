import { defineModel, extrudeShape, lathe, model, p, shapes } from 'aige/model';

/** Gold coin standing upright (faces +Z) with a raised rim and an embossed star. */
export default defineModel({
  name: 'coin',
  description: 'Collectible coin with rim and star emboss. Stands upright facing +Z, centered at the origin.',
  params: {
    radius: p.number(0.4, { min: 0.05, max: 3, description: 'Coin radius in meters' }),
    thickness: p.number(0.08, { min: 0.01, max: 0.5 }),
    color: p.color('#ffc83d'),
    emboss: p.choice(['star', 'none'], 'star'),
  },
  build({ radius: r, thickness: t, color, emboss }) {
    const h = t / 2;
    // Profile of [radius, height] points from bottom to top, revolved around Y: rim + recessed faces.
    const body = lathe(
      [
        [0, -h * 0.7],
        [r * 0.78, -h * 0.7],
        [r * 0.82, -h],
        [r * 0.97, -h],
        [r, -h * 0.6],
        [r, h * 0.6],
        [r * 0.97, h],
        [r * 0.82, h],
        [r * 0.78, h * 0.7],
        [0, h * 0.7],
      ],
      { segments: 40 },
    )
      .rotate([90, 0, 0])
      .material({ color, metalness: 1, roughness: 0.3 });
    let coin = body;
    if (emboss === 'star') {
      const star = extrudeShape(shapes.star(5, r * 0.5, r * 0.22), { depth: h * 0.5, bevel: h * 0.15 })
        .rotate([90, 0, 0])
        .material({ color, metalness: 1, roughness: 0.22 });
      // extrudeShape grows along +Y; rotated 90° about X it grows toward +Z (front). Mirror it for the back.
      coin = coin.merge(
        star.translate([0, 0, h * 0.65]),
        star.rotate([0, 180, 0]).translate([0, 0, -h * 0.65]),
      );
    }
    return model({ coin }).setCollider({ shape: 'sphere', radius: r });
  },
});
