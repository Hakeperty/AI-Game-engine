import { box, cylinder, defineModel, model, p, sphere } from 'aige/model';

/** Goal flag: pole with a golden ball and a waving cloth. Base at y = 0. */
export default defineModel({
  name: 'flag',
  description: 'Waving flag on a pole (level goal / checkpoint). The cloth points toward +X.',
  params: {
    height: p.number(3, { min: 0.5, max: 20 }),
    cloth: p.color('#e53935'),
    pole: p.color('#d9d9d9'),
    waves: p.number(1.5, { min: 0, max: 4 }),
  },
  build({ height: h, cloth, pole, waves }) {
    const poleMesh = cylinder({ radius: h * 0.018, height: h, segments: 12 })
      .translate([0, h / 2, 0])
      .material({ color: pole, metalness: 0.8, roughness: 0.35 });
    const ball = sphere({ radius: h * 0.035, segments: 16, rings: 10 })
      .translate([0, h + h * 0.03, 0])
      .material({ color: '#ffc83d', metalness: 1, roughness: 0.25 });
    const w = h * 0.45;
    const fh = h * 0.28;
    const flag = box({ size: [w, fh, h * 0.01] })
      .subdivide(3, { smooth: false })
      .translate([w / 2 + h * 0.018, h - fh / 2 - h * 0.04, 0])
      // wave along X: amplitude grows away from the pole
      .mapPositions(([x, y, z]) => [x, y, z + Math.sin((x / w) * Math.PI * waves) * (x / w) * h * 0.04])
      .material({ color: cloth, roughness: 0.8, doubleSided: true });
    return model({ pole: poleMesh.merge(ball), flag })
      .socket('top', [0, h * 1.07, 0])
      .setCollider({ shape: 'cylinder', radius: h * 0.05, height: h, offset: [0, h / 2, 0] });
  },
});
