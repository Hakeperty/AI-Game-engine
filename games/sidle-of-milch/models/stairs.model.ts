import { box, defineModel, model, PolyMesh, p } from 'aige/model';

/**
 * Old wooden stairs rising toward +Z: the bottom step starts at z = 0, the top landing edge is at
 * z = run, y = rise. Centered on x. Parts: treads, risers, stringers, rail.
 * Walkable collision: add a child entity with a rotated box Collider as a ramp (see STORY build notes).
 */
export default defineModel({
  name: 'stairs',
  description:
    'Old wooden stairs rising toward +Z from z = 0 to z = run, y = rise (parts: treads, risers, stringers, rail).',
  params: {
    width: p.number(0.95, { min: 0.5, max: 3 }),
    rise: p.number(3, { min: 0.3, max: 6 }),
    run: p.number(3.8, { min: 0.5, max: 10 }),
    steps: p.int(15, { min: 2, max: 40 }),
    rail: p.boolean(true),
    wear: p.number(0.5, { min: 0, max: 1 }),
  },
  build({ width, rise, run, steps, rail, wear }, { rng }) {
    const h = rise / steps;
    const d = run / steps;
    const treads: PolyMesh[] = [];
    const risers: PolyMesh[] = [];
    for (let i = 0; i < steps; i++) {
      const y = h * (i + 1);
      const z = d * i;
      const sag = rng.range(0, 0.008) * wear;
      treads.push(
        box({ size: [width, 0.035, d + 0.03], center: [0, y - 0.0175 - sag, z + d / 2] })
          .rotate([rng.range(-0.6, 0.6) * wear, 0, rng.range(-0.8, 0.8) * wear], [0, y, z + d / 2])
          .jitter(0.002 * wear, rng.int(1, 9999)),
      );
      risers.push(box({ size: [width - 0.02, h - 0.03, 0.02], center: [0, y - h / 2 - 0.015, z + 0.01] }));
    }
    // two sloped stringers
    const len = Math.hypot(rise, run);
    const angle = (Math.atan2(rise, run) * 180) / Math.PI;
    const stringer = (x: number) =>
      box({ size: [0.05, 0.26, len + 0.2], center: [0, 0, 0] })
        .rotate([-angle, 0, 0])
        .translate([x, rise / 2 - 0.05, run / 2]);
    const parts: Record<string, PolyMesh> = {
      treads: PolyMesh.merge(...treads)
        .uvBox(1)
        .material({ roughness: 0.9 }),
      risers: PolyMesh.merge(...risers)
        .uvBox(1)
        .material({ color: '#3f2f22', roughness: 0.95 }),
      stringers: PolyMesh.merge(stringer(-width / 2 - 0.025), stringer(width / 2 + 0.025))
        .uvBox(1)
        .material({ color: '#4a3726', roughness: 0.95 }),
    };
    if (rail) {
      const posts: PolyMesh[] = [];
      for (let i = 0; i <= steps; i += 3) {
        const z = Math.min(run, d * i + d / 2);
        const y = h * Math.min(steps, i + 1);
        posts.push(box({ size: [0.05, 0.9, 0.05], center: [-width / 2 - 0.03, y + 0.45, z] }));
      }
      const handrail = box({ size: [0.06, 0.05, len + 0.1], center: [0, 0, 0] })
        .rotate([-angle, 0, 0])
        .translate([-width / 2 - 0.03, rise / 2 + 0.92, run / 2]);
      parts.rail = PolyMesh.merge(...posts, handrail)
        .jitter(0.002, 7)
        .uvBox(1)
        .material({ color: '#4d3a28', roughness: 0.85 });
    }
    return model(parts).setCollider({
      shape: 'box',
      size: [width, rise, run],
      offset: [0, rise / 2, run / 2],
    });
  },
});
