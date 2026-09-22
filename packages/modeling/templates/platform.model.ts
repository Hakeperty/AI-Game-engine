import { defineModel, model, p, roundedBox } from 'aige/model';

/** Floating platform block: dirt body with a grass top and chamfered edges. Top surface at y = 0. */
export default defineModel({
  name: 'platform',
  description: 'Platformer block with grass on top. The walkable top is at y = 0; the body hangs below it.',
  params: {
    width: p.number(4, { min: 0.2, max: 50 }),
    depth: p.number(4, { min: 0.2, max: 50 }),
    height: p.number(1, { min: 0.1, max: 20 }),
    grass: p.color('#62b04e'),
    dirt: p.color('#8b5a33'),
  },
  build({ width, depth, height, grass, dirt }) {
    const bevel = Math.min(width, depth, height) * 0.12;
    const block = roundedBox({ size: [width, height, depth], radius: bevel, segments: 1 })
      .translate([0, -height / 2, 0])
      .gradient('y', '#5e3b20', dirt, { range: [-height, 0] })
      .color(grass, { normal: '+y', minDot: 0.5 })
      .material({ roughness: 0.9 });
    return model({ platform: block }).setCollider({
      shape: 'box',
      size: [width, height, depth],
      offset: [0, -height / 2, 0],
    });
  },
});
