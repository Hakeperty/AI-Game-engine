import { box, cylinder, defineModel, model, PolyMesh, p, sphere } from 'aige/model';

/**
 * A planked wooden door. The origin is the HINGE edge at the floor: the door extends to +X (width),
 * up to `height`, and is centered on z. Rotate the entity around Y to swing it (the Door component does).
 * Parts: door (meter UVs), braces, hardware.
 */
export default defineModel({
  name: 'door',
  description:
    'Planked cabin door; origin at the hinge edge on the floor, extends to +X (parts: door, braces, hardware).',
  params: {
    width: p.number(0.9, { min: 0.4, max: 2 }),
    height: p.number(2.02, { min: 1, max: 3 }),
    thickness: p.number(0.045, { min: 0.02, max: 0.12 }),
    planks: p.int(5, { min: 2, max: 10 }),
    wear: p.number(0.6, { min: 0, max: 1 }),
  },
  build({ width, height, thickness, planks, wear }, { rng }) {
    const pw = width / planks;
    const boards: PolyMesh[] = [];
    for (let i = 0; i < planks; i++) {
      const h = height - rng.range(0, 0.015) * wear;
      boards.push(
        box({
          size: [pw - 0.006, h, thickness],
          center: [pw * (i + 0.5), h / 2 + 0.005, rng.range(-0.002, 0.002)],
        }).jitter(0.0025 * wear, rng.int(1, 9999)),
      );
    }
    const t = thickness;
    const braceZ = -t / 2 - 0.012;
    const rail = (y: number) => box({ size: [width - 0.06, 0.11, 0.025], center: [width / 2, y, braceZ] });
    const diag = box({ size: [0.1, Math.hypot(width - 0.1, height * 0.5), 0.025], center: [0, 0, 0] })
      .rotate([0, 0, (Math.atan2(width - 0.1, height * 0.5) * 180) / Math.PI])
      .translate([width / 2, height * 0.5, braceZ]);
    const hardware = PolyMesh.merge(
      // hinges
      box({ size: [0.2, 0.035, 0.006], center: [0.1, height * 0.82, t / 2 + 0.003] }),
      box({ size: [0.2, 0.035, 0.006], center: [0.1, height * 0.18, t / 2 + 0.003] }),
      // ring pull + keyhole plate on the front (+Z), latch knob on the back
      box({ size: [0.05, 0.12, 0.008], center: [width - 0.1, height * 0.48, t / 2 + 0.004] }),
      cylinder({ radius: 0.012, height: 0.05, segments: 8 })
        .rotate([90, 0, 0])
        .translate([width - 0.1, height * 0.5, t / 2 + 0.03]),
      sphere({ radius: 0.028, segments: 12, rings: 8, center: [width - 0.1, height * 0.5, t / 2 + 0.055] }),
      sphere({ radius: 0.028, segments: 12, rings: 8, center: [width - 0.1, height * 0.5, -t / 2 - 0.05] }),
    );
    return model({
      door: PolyMesh.merge(...boards)
        .uvBox(1)
        .material({ color: '#6a4d33', roughness: 0.9 }),
      braces: PolyMesh.merge(rail(height * 0.2), rail(height * 0.8), diag)
        .uvBox(1)
        .material({ color: '#5a4029', roughness: 0.9 }),
      hardware: hardware.material({ color: '#3b3632', metalness: 0.85, roughness: 0.6 }),
    }).setCollider({ shape: 'box', size: [width, height, t + 0.04], offset: [width / 2, height / 2, 0] });
  },
});
