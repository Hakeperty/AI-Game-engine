import { box, cylinder, defineModel, model, PolyMesh, p } from 'aige/model';

/**
 * A floor/ceiling slab with meter UVs (give it a scanned floor material), top surface at y = 0.
 * With `beams`, rough log joists hang under it (a ceiling seen from the room below).
 * Parts: slab, beams.
 */
export default defineModel({
  name: 'slab',
  description:
    'Floor/ceiling slab with meter UVs, top at y = 0, optional log joists underneath (parts: slab, beams).',
  params: {
    width: p.number(4, { min: 0.2, max: 30 }),
    depth: p.number(4, { min: 0.2, max: 30 }),
    thickness: p.number(0.12, { min: 0.02, max: 1 }),
    beams: p.boolean(false),
    beamSpacing: p.number(0.9, { min: 0.3, max: 3 }),
    beamRadius: p.number(0.1, { min: 0.04, max: 0.3 }),
  },
  build({ width, depth, thickness, beams, beamSpacing, beamRadius }, { rng }) {
    const parts: Record<string, PolyMesh> = {
      slab: box({ size: [width, thickness, depth], center: [0, -thickness / 2, 0] })
        .uvBox(1)
        .material({ roughness: 0.9 }),
    };
    if (beams) {
      const n = Math.max(1, Math.floor(depth / beamSpacing));
      const logs: PolyMesh[] = [];
      for (let i = 0; i < n; i++) {
        const z = -depth / 2 + (depth / n) * (i + 0.5);
        const rr = beamRadius * rng.range(0.9, 1.1);
        logs.push(
          cylinder({ radius: rr, height: width, segments: 12 })
            .rotate([0, 0, 90])
            .translate([0, -thickness - rr * 0.85, z])
            .jitter(rr * 0.05, rng.int(1, 9999)),
        );
      }
      parts.beams = PolyMesh.merge(...logs)
        .uvBox(1)
        .material({ color: '#5b4330', roughness: 0.95 });
    }
    return model(parts).setCollider({
      shape: 'box',
      size: [width, thickness, depth],
      offset: [0, -thickness / 2, 0],
    });
  },
});
