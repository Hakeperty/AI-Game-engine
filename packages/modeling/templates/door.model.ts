import { box, defineModel, model, p, roundedBox, sphere } from 'aige/model';

/** Wooden door in a stone frame. Front faces +Z, base at y = 0. The door part pivots at its left edge. */
export default defineModel({
  name: 'door',
  description: 'Paneled wooden door with a frame and a brass knob. Base at y = 0, hinge on the left (-X).',
  params: {
    width: p.number(1.2, { min: 0.3, max: 10 }),
    height: p.number(2.2, { min: 0.5, max: 20 }),
    wood: p.color('#8a5a33'),
    frame: p.color('#9a9a9a'),
  },
  build({ width: w, height: h, wood, frame }) {
    const f = w * 0.12;
    const d = w * 0.18;
    const frameMesh = box({ size: [f, h + f, d], center: [-w / 2 - f / 2, (h + f) / 2, 0] })
      .merge(box({ size: [f, h + f, d], center: [w / 2 + f / 2, (h + f) / 2, 0] }))
      .merge(box({ size: [w + 2 * f, f, d], center: [0, h + f / 2, 0] }))
      .material({ color: frame, roughness: 0.95 });
    const panel = roundedBox({ size: [w, h, d * 0.5], radius: w * 0.02, segments: 1 })
      .inset('front', w * 0.1)
      .extrude('front', -w * 0.03)
      .translate([0, h / 2, 0])
      .material({ color: wood, roughness: 0.75 });
    const knob = sphere({ radius: w * 0.05, segments: 16, rings: 10 })
      .translate([w * 0.35, h * 0.48, d * 0.3])
      .material({ color: '#d4a93a', metalness: 1, roughness: 0.3 });
    return model({ frame: frameMesh, door: panel.merge(knob) })
      .socket('hinge', [-w / 2, 0, 0])
      .setCollider({ shape: 'box', size: [w, h, d * 0.5], offset: [0, h / 2, 0] });
  },
});
