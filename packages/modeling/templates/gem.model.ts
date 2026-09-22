import { defineModel, lathe, p } from 'aige/model';

/** Faceted gem (brilliant cut) with flat shading and a soft glow. */
export default defineModel({
  name: 'gem',
  description: 'Faceted crystal gem: pointed bottom, flat crown on top. Rests on y = 0.',
  params: {
    size: p.number(0.5, { min: 0.05, max: 5, description: 'Width in meters' }),
    facets: p.int(8, { min: 4, max: 16 }),
    color: p.color('#36c5f0'),
    glow: p.number(0.35, { min: 0, max: 3 }),
  },
  build({ size, facets, color, glow }) {
    const r = size / 2;
    return lathe(
      [
        [0, -r * 1.1],
        [r, 0],
        [r * 0.62, r * 0.45],
        [0, r * 0.45],
      ],
      { segments: facets },
    )
      .placeOnGround()
      .material({
        color,
        roughness: 0.08,
        metalness: 0.1,
        emissive: color,
        emissiveIntensity: glow,
        flatShading: true,
      });
  },
});
