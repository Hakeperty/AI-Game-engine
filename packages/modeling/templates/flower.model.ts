import { curves, defineModel, icosphere, mixColor, model, Noise, p, plants, PolyMesh, tube, type V3 } from 'aige/model';

/**
 * Garden flower: curved stem with leaves, a ring of soft petals (daisy, tulip or poppy) and a bumpy center.
 * The bloom faces +Z and up. Stem base at y = 0.
 */
export default defineModel({
  name: 'flower',
  description: 'Single flower (daisy, tulip or poppy) with curved stem, leaves, petals and seed center. Base on y = 0.',
  params: {
    height: p.number(0.6, { min: 0.05, max: 10 }),
    style: p.choice(['daisy', 'tulip', 'poppy'], 'daisy'),
    petals: p.int(14, { min: 3, max: 32, description: 'Petal count (daisy)' }),
    petalColor: p.color('#ffffff'),
    centerColor: p.color('#f2b705'),
    stemColor: p.color('#4c8a2e'),
  },
  build({ height, style, petals, petalColor, centerColor, stemColor }, { rng, seed }) {
    const lean = rng.range(-0.05, 0.05);
    const stemPts: V3[] = [
      [0, 0, 0],
      [lean, 0.35, 0.02],
      [lean * 1.5, 0.7, 0.06],
      [lean, 0.93, 0.1],
    ];
    const path = curves.catmullRom(stemPts, 8);
    const stem = tube(path, 0.014, { segments: 8, scale: (t) => 1.15 - 0.35 * t });
    const leafMesh = plants.leaf({ length: 0.24, width: 0.07, curl: 0.06, shape: 'blade' });
    const leaves = [0.16, 0.32].map((y, i) =>
      leafMesh
        .rotate([-40, 0, 0])
        .rotate([0, (i % 2 ? -1 : 1) * 90 + rng.range(-25, 25), 0])
        .translate([lean * y, y, 0.01]),
    );
    const green = PolyMesh.merge(stem, ...leaves).gradient('y', mixColor(stemColor, '#1d3a10', 0.3), mixColor(stemColor, '#a8d45a', 0.3));

    // bloom built facing +Y at the origin, then tilted toward +Z
    const daisy = style === 'daisy';
    const tulip = style === 'tulip';
    const pl = daisy ? 0.17 : tulip ? 0.17 : 0.17;
    const pw = daisy ? 0.045 : tulip ? 0.12 : 0.18;
    const count = daisy ? petals : tulip ? 6 : 5;
    const cup = tulip ? 64 : style === 'poppy' ? 24 : 6;
    const petal = plants.leaf({
      length: pl,
      width: pw,
      shape: daisy ? 'leaf' : 'round',
      curl: tulip ? -0.035 : style === 'poppy' ? -0.012 : 0.015,
      fold: pw * 0.08,
      segments: [9, 4],
    });
    const heads: PolyMesh[] = [];
    for (let i = 0; i < count; i++) {
      const inner = tulip && i % 2 === 1;
      heads.push(
        petal
          .scale(inner ? 0.92 : 1)
          .rotate([-cup - rng.range(-4, 4) + (inner ? 6 : 0), 0, 0])
          .translate([0, 0, tulip ? 0.006 : 0.018])
          .rotate([0, (i / count) * 360 + rng.range(-3, 3) + (tulip ? 30 * (i % 2) : 0), 0]),
      );
    }
    const tint = new Noise(seed);
    const innerColor = daisy ? mixColor(petalColor, '#fff4c2', 0.35) : mixColor(petalColor, '#2a0f10', 0.55);
    const petalMesh = PolyMesh.merge(...heads).colorBy((q) => {
      const t = Math.min(1, Math.hypot(q[0], q[1] * 0.5, q[2]) / (pl * 0.9));
      const n = tint.fbm(q[0] * 30, q[1] * 30, q[2] * 30, 2) * 0.08;
      return mixColor(innerColor, petalColor, Math.min(1, Math.max(0, t * 1.5 - 0.15 + n)));
    });
    const centerR = daisy ? 0.05 : tulip ? 0.024 : 0.04;
    const center = icosphere({ radius: centerR, detail: 3 })
      .scale([1, daisy ? 0.55 : 0.8, 1])
      .displace({ amount: centerR * 0.12, scale: 90, seed })
      .translate([0, tulip ? 0.02 : 0.01, 0])
      .gradient('y', mixColor(centerColor, '#4a2a00', 0.5), centerColor);
    const tilt = tulip ? 8 : 40;
    const top = path[path.length - 1]!;
    const place = (m: PolyMesh) => m.rotate([tilt, 0, 0]).translate(top);
    const total = top[1] + (tulip ? 0.16 : 0.09);
    const s = height / total;
    return model({
      stem: green.scale(s).material({ roughness: 0.6 }),
      petals: place(petalMesh).scale(s).material({ roughness: 0.5 }),
      center: place(center).scale(s).material({ roughness: 0.85 }),
    })
      .socket('bloom', [top[0] * s, top[1] * s, top[2] * s])
      .setCollider({ shape: 'cylinder', radius: 0.08 * s, height: height, offset: [0, height / 2, 0] });
  },
});
