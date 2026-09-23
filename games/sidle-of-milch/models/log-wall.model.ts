import { box, cylinder, defineModel, model, PolyMesh, p } from 'aige/model';

/**
 * Wall of stacked, weathered logs running along X (centered at x = 0), standing on y = 0.
 * One optional opening: a framed window, or a door/doorway gap with a frame and a header log.
 * Parts: logs (meter UVs, for a scanned wood material), chink (dark chinking), frame, glass.
 * Use a 'mesh' Collider on the entity so doorways stay walkable.
 */
export default defineModel({
  name: 'log-wall',
  description:
    'Weathered log wall along X with an optional window or doorway (parts: logs, chink, frame, glass). Base at y = 0.',
  params: {
    length: p.number(4, { min: 0.3, max: 14 }),
    height: p.number(2.7, { min: 0.2, max: 4 }),
    logRadius: p.number(0.14, { min: 0.06, max: 0.25 }),
    opening: p.choice(['none', 'window', 'door'], 'none', {
      description: "'door' leaves a framed gap for a Door entity",
    }),
    openingX: p.number(0, { min: -6, max: 6, description: 'Center of the opening along the wall' }),
    openingWidth: p.number(1, { min: 0.3, max: 3 }),
    openingHeight: p.number(0.9, {
      min: 0.3,
      max: 2.4,
      description: 'Window height, or door height (≈2.05)',
    }),
    sill: p.number(0.95, { min: 0.2, max: 2, description: 'Window sill height' }),
    overhang: p.number(0.15, { min: 0, max: 0.4, description: 'Log ends sticking out past the wall ends' }),
    wood: p.color('#6e5238'),
  },
  build(
    { length, height, logRadius: r, opening, openingX, openingWidth, openingHeight, sill, overhang, wood },
    { rng },
  ) {
    const logs: PolyMesh[] = [];
    const chink: PolyMesh[] = [];
    const rows = Math.max(1, Math.round(height / (r * 1.8)));
    const step = height / rows;
    const x0 = -length / 2 - overhang;
    const x1 = length / 2 + overhang;
    const ox0 = openingX - openingWidth / 2;
    const ox1 = openingX + openingWidth / 2;
    const bottom = opening === 'door' ? 0 : sill;
    const top = opening === 'door' ? openingHeight : sill + openingHeight;
    const log = (a: number, b: number, y: number) => {
      const len = b - a;
      if (len < 0.06) return;
      const rr = r * rng.range(0.92, 1.06);
      const shade = rng.range(0.82, 1.1);
      const c = wood.match(/\w\w/g)!.map((h) => Math.min(255, Math.round(Number.parseInt(h, 16) * shade)));
      logs.push(
        cylinder({ radius: rr, height: len, segments: 14 })
          .rotate([0, 0, 90])
          .translate([(a + b) / 2, y, rng.range(-0.012, 0.012)])
          .jitter(rr * 0.04, rng.int(1, 99999))
          .color(`#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`),
      );
    };
    const cut = (y: number, halfBand: number) =>
      opening !== 'none' && y + halfBand > bottom && y - halfBand < top;
    for (let i = 0; i < rows; i++) {
      const y = step * (i + 0.5);
      if (cut(y, step * 0.3)) {
        log(x0, ox0, y);
        log(ox1, x1, y);
      } else log(x0, x1, y);
      if (i > 0) {
        const cy = step * i;
        const bar = (a: number, b: number) =>
          b - a > 0.05 &&
          chink.push(box({ size: [b - a, step * 0.4, r * 1.35], center: [(a + b) / 2, cy, 0] }));
        if (cut(cy, 0)) {
          bar(-length / 2, ox0);
          bar(ox1, length / 2);
        } else bar(-length / 2, length / 2);
      }
    }
    const parts: Record<string, PolyMesh> = {
      logs: PolyMesh.merge(...logs)
        .uvBox(1)
        .material({ roughness: 0.95 }),
      chink: PolyMesh.merge(...chink).material({ color: '#2e241b', roughness: 1 }),
    };
    if (opening !== 'none') {
      const t = 0.08;
      const d = r * 2.2;
      const cy = (bottom + top) / 2;
      const h = top - bottom;
      const pieces = [
        box({ size: [openingWidth + t * 2, t, d], center: [openingX, top + t / 2, 0] }),
        box({ size: [t, h, d], center: [ox0 - t / 2, cy, 0] }),
        box({ size: [t, h, d], center: [ox1 + t / 2, cy, 0] }),
      ];
      if (opening === 'window') {
        pieces.push(
          box({
            size: [openingWidth + t * 2.6, t * 0.8, d + 0.06],
            center: [openingX, bottom - t * 0.4, 0.03],
          }),
          box({ size: [0.035, h, 0.045], center: [openingX, cy, 0] }),
          box({ size: [openingWidth, 0.035, 0.045], center: [openingX, cy, 0] }),
        );
        parts.glass = box({ size: [openingWidth, h, 0.008], center: [openingX, cy, 0] }).material({
          color: '#8f9ea6',
          roughness: 0.2,
          opacity: 0.3,
          doubleSided: true,
        });
      }
      parts.frame = PolyMesh.merge(...pieces)
        .jitter(0.003, rng.int(1, 9999))
        .uvBox(1)
        .material({ color: '#4a3827', roughness: 0.9 });
    }
    return model(parts).setCollider({
      shape: 'box',
      size: [length, height, r * 2],
      offset: [0, height / 2, 0],
    });
  },
});
