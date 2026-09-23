import { defineModel, icosphere, p } from 'aige/model';

/** Low-poly boulder: displaced icosphere with flat shading. Rests on y = 0. */
export default defineModel({
  name: 'rock',
  description: 'Faceted rock or boulder. Change seed for a different shape.',
  params: {
    size: p.number(1, { min: 0.05, max: 20 }),
    lumpiness: p.number(0.25, { min: 0, max: 0.6 }),
    color: p.color('#8a8f94'),
  },
  build({ size, lumpiness, color }, { rng, seed }) {
    const r = size / 2;
    return icosphere({ radius: r, detail: 2 })
      .scale([rng.range(0.9, 1.3), rng.range(0.55, 0.8), rng.range(0.8, 1.1)])
      .displace({ amount: r * lumpiness, scale: 1.6 / size, seed })
      .jitter(r * 0.03, seed)
      .gradient('y', '#555a60', color)
      .material({ roughness: 0.95, flatShading: true })
      .placeOnGround(-r * 0.08);
  },
});
