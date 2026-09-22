import { defineModel, p, roundedBox } from 'aige/model';

const SIDES = ['front', 'back', 'left', 'right', 'top', 'bottom'];

/** Wooden crate: chamfered box with recessed panels on every side. */
export default defineModel({
  name: 'crate',
  description: 'Wooden crate with a frame and recessed panels. Base sits at y = 0.',
  params: {
    size: p.number(1, { min: 0.1, max: 10 }),
    wood: p.color('#b07a45'),
    frame: p.color('#7a4f2a'),
  },
  build({ size: s, wood, frame }) {
    return roundedBox({ size: s, radius: s * 0.04, segments: 1 })
      .color(frame)
      .inset(SIDES, s * 0.1)
      .extrude(SIDES, -s * 0.04, { individual: true, sideGroup: 'panelWall' })
      .color(wood, SIDES)
      .material({ roughness: 0.85 })
      .placeOnGround();
  },
});
