import { cone, defineModel, model, PolyMesh, p, roundedBox } from 'aige/model';

/** Spike trap: a metal base plate with a grid of sharp cones. Base at y = 0. */
export default defineModel({
  name: 'spike',
  description:
    'Hazard: grid of metal spikes on a plate. Use a trigger collider and damage the player on touch.',
  params: {
    size: p.number(1, { min: 0.2, max: 10, description: 'Plate width/depth' }),
    count: p.int(3, { min: 1, max: 8, description: 'Spikes per side' }),
    spikeHeight: p.number(0.5, { min: 0.05, max: 5 }),
    color: p.color('#b8bec6'),
  },
  build({ size, count, spikeHeight, color }) {
    const plateH = size * 0.08;
    const plate = roundedBox({ size: [size, plateH, size], radius: plateH * 0.3, segments: 1 })
      .translate([0, plateH / 2, 0])
      .material({ color: '#555b63', metalness: 0.7, roughness: 0.6 });
    const cell = size / count;
    const spikes: PolyMesh[] = [];
    for (let i = 0; i < count; i++)
      for (let j = 0; j < count; j++) {
        spikes.push(
          cone({ radius: cell * 0.32, height: spikeHeight, segments: 8 }).translate([
            -size / 2 + cell * (i + 0.5),
            plateH + spikeHeight / 2,
            -size / 2 + cell * (j + 0.5),
          ]),
        );
      }
    const spikeMesh = PolyMesh.merge(...spikes).material({
      color,
      metalness: 1,
      roughness: 0.25,
      flatShading: true,
    });
    return model({ plate, spikes: spikeMesh }).setCollider({
      shape: 'box',
      size: [size, plateH + spikeHeight * 0.8, size],
      offset: [0, (plateH + spikeHeight * 0.8) / 2, 0],
    });
  },
});
