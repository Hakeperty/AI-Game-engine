import { box, cylinder, defineModel, model, PolyMesh, p } from 'aige/model';

/**
 * Wall of stacked, weathered logs. The wall runs along X, centered at x = 0, and stands on y = 0.
 * An optional window cuts a framed opening with a dirty glass pane. Doorways are made by leaving gaps
 * between wall pieces and adding a short 'log-wall' header above them.
 */
export default defineModel({
  name: 'log-wall',
  description: 'Weathered log wall segment (along X, base at y = 0) with an optional window.',
  params: {
    length: p.number(4, { min: 0.3, max: 12 }),
    height: p.number(2.6, { min: 0.2, max: 4 }),
    logRadius: p.number(0.13, { min: 0.06, max: 0.25 }),
    window: p.boolean(false),
    windowWidth: p.number(1, { min: 0.3, max: 3 }),
    windowHeight: p.number(0.9, { min: 0.3, max: 2 }),
    sill: p.number(0.95, { min: 0.2, max: 2 }),
    overhang: p.number(0.12, { min: 0, max: 0.4, description: 'Log ends sticking out past the wall ends' }),
    wood: p.color('#6e5238'),
  },
  build(
    { length, height, logRadius: r, window: hasWindow, windowWidth, windowHeight, sill, overhang, wood },
    { rng },
  ) {
    const logs: PolyMesh[] = [];
    const chink: PolyMesh[] = [];
    const rows = Math.max(1, Math.round(height / (r * 1.85)));
    const step = height / rows;
    const x0 = -length / 2 - overhang;
    const x1 = length / 2 + overhang;
    const winX0 = -windowWidth / 2;
    const winX1 = windowWidth / 2;
    const log = (a: number, b: number, y: number) => {
      const len = b - a;
      if (len < 0.05) return;
      const rr = r * rng.range(0.9, 1.08);
      const shade = rng.range(0.78, 1.12);
      const c = wood.match(/\w\w/g)!.map((h) => Math.min(255, Math.round(Number.parseInt(h, 16) * shade)));
      const color = `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      logs.push(
        cylinder({ radius: rr, height: len, segments: 10 })
          .rotate([0, 0, 90])
          .translate([(a + b) / 2, y, rng.range(-0.01, 0.01)])
          .jitter(rr * 0.05, rng.int(1, 9999))
          .color(color),
      );
    };
    for (let i = 0; i < rows; i++) {
      const y = step * (i + 0.5);
      const inWindow = hasWindow && y > sill - step * 0.3 && y < sill + windowHeight + step * 0.3;
      if (inWindow) {
        log(x0, winX0, y);
        log(winX1, x1, y);
      } else log(x0, x1, y);
      // dark chinking between rows
      if (i > 0)
        chink.push(box({ size: [length, step * 0.35, r * 1.3], center: [0, step * i, 0] }).color('#3b2c20'));
    }
    const parts: Record<string, PolyMesh> = {
      logs: PolyMesh.merge(...logs, ...chink).material({ roughness: 0.95 }),
    };
    if (hasWindow) {
      const t = 0.07;
      const d = r * 2.3;
      const cy = sill + windowHeight / 2;
      const frame = PolyMesh.merge(
        box({ size: [windowWidth + t * 2, t, d], center: [0, sill - t / 2, 0] }),
        box({ size: [windowWidth + t * 2, t, d], center: [0, sill + windowHeight + t / 2, 0] }),
        box({ size: [t, windowHeight, d], center: [winX0 - t / 2, cy, 0] }),
        box({ size: [t, windowHeight, d], center: [winX1 + t / 2, cy, 0] }),
        box({ size: [0.035, windowHeight, 0.04], center: [0, cy, 0] }),
        box({ size: [windowWidth, 0.035, 0.04], center: [0, cy, 0] }),
      ).material({ color: '#4a3827', roughness: 0.9 });
      parts.frame = frame;
      parts.glass = box({ size: [windowWidth, windowHeight, 0.01], center: [0, cy, 0] }).material({
        color: '#a9b7bf',
        roughness: 0.15,
        metalness: 0,
        opacity: 0.28,
        doubleSided: true,
      });
    }
    return model(parts).setCollider({
      shape: 'box',
      size: [length, height, r * 2],
      offset: [0, height / 2, 0],
    });
  },
});
