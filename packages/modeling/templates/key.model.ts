import { box, cylinder, defineModel, p, torus } from 'aige/model';

/** Old-fashioned key: ring bow, shaft and bit teeth. Lies along +X, faces +Z. */
export default defineModel({
  name: 'key',
  description:
    'Collectible key standing upright: ring at the top, teeth at the bottom. Centered at the origin.',
  params: {
    length: p.number(0.6, { min: 0.05, max: 5 }),
    color: p.color('#ffc83d'),
  },
  build({ length: L, color }) {
    const ringR = L * 0.16;
    const t = L * 0.045;
    const ring = torus({ radius: ringR, tube: t, segments: 32, tubeSegments: 10 })
      .rotate([90, 0, 0])
      .translate([0, L * 0.5 - ringR, 0]);
    const shaft = cylinder({ radius: t * 0.9, height: L * 0.72, segments: 12 }).translate([0, -L * 0.02, 0]);
    const tooth = (y: number, w: number) => box({ size: [w, t * 1.6, t * 1.6], center: [w / 2, y, 0] });
    return ring
      .merge(shaft, tooth(-L * 0.36, L * 0.18), tooth(-L * 0.26, L * 0.13), tooth(-L * 0.17, L * 0.09))
      .material({ color, metalness: 1, roughness: 0.3 });
  },
});
