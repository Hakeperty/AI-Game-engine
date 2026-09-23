import { defineModel, eye, mixColor, model, p, type PolyMesh, sdf, type Sdf, type V3 } from 'aige/model';

/**
 * Snake or worm lying in an S-curve: one smooth tapered SDF chain with a raised head, diamond back pattern,
 * light belly and forked tongue. style 'worm' gives a chubby segmented cartoon earthworm.
 * Head faces +Z, lies on y = 0.
 */
export default defineModel({
  name: 'snake',
  description:
    'Slithering snake (or segmented cartoon worm) on the ground in an S-curve with raised head. Faces +Z, on y = 0.',
  params: {
    length: p.number(1.6, { min: 0.1, max: 20, description: 'Length along the ground (m)' }),
    style: p.choice(['snake', 'worm'], 'snake'),
    color: p.color('#4d9a34'),
    pattern: p.color('#e2c43a'),
    belly: p.color('#efe7b8'),
    wiggles: p.number(1.5, { min: 0, max: 4, description: 'S-curve waves along the body' }),
    thickness: p.number(1, { min: 0.5, max: 2 }),
  },
  build({ length, style, color, pattern, belly, wiggles, thickness }, { rng }) {
    const worm = style === 'worm';
    const L = 1.6; // designed length, scaled at the end
    const r0 = (worm ? 0.085 : 0.06) * thickness;
    const n = 18;
    const amp = worm ? 0.12 : 0.18;
    const phase = rng.range(0, Math.PI * 2);
    const spineX = (t: number) => Math.sin(t * wiggles * Math.PI * 2 + phase) * amp * (0.35 + t * 0.65);
    const pts: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n; // 0 = head, 1 = tail
      const r = worm ? r0 * (1 - 0.35 * t ** 2) : r0 * (t < 0.08 ? 0.9 : 1 - 0.85 * ((t - 0.08) / 0.92) ** 1.4);
      const lift = worm ? 0 : Math.max(0, 0.16 - t) * 0.9; // raise the head
      pts.push([spineX(t), r * 0.92 + lift, L * 0.5 - t * L]);
      radii.push(r);
    }
    const head = pts[0]!;
    let body: Sdf = sdf.chain(pts, radii, { samples: 5 });
    if (worm) {
      // segment rings: shallow grooves along the body
      body = body.displaceBy(([, , z]) => -0.006 * Math.abs(Math.sin(z * 55)) ** 0.5, 0.006);
    } else {
      body = body.smoothUnion(
        sdf.ellipsoid([0.075 * thickness, 0.05 * thickness, 0.1 * thickness], [head[0], head[1] + 0.01, head[2] + 0.06]),
        0.05,
      );
    }
    const dark = mixColor(color, '#10200a', 0.45);
    let skin: Sdf;
    if (worm) {
      skin = body
        .color(color)
        .colorBy(([, , z], base) => mixColor(base, mixColor(color, '#ffffff', 0.3), Math.abs(Math.sin(z * 55)) ** 8 * 0.6))
        .colorBy(([, , z], base) => (Math.abs(z - (head[2] - 0.45)) < 0.07 ? mixColor(base, '#b8405a', 0.45) : base));
    } else {
      // diamonds along the spine
      skin = body.color(color).colorBy(([x, , z], base) => {
        const t = (L * 0.5 - z) / L;
        if (t < 0.06) return base;
        const u = (((z * 9) % 1) + 1) % 1;
        const d = Math.abs(u - 0.5) * 2 + Math.abs(x - spineX(t)) * 14;
        return d < 0.8 ? (d < 0.55 ? pattern : dark) : base;
      });
    }
    skin = skin.colorByNormal(belly, '-y', 0.35, 0.4).cutBelow(0.002, 0.004);
    const s = length / L;
    const mesh = skin.mesh({ resolution: 150, decimate: 16000, ao: 0.35 }).scale(s).placeOnGround(0);
    const drop = -(0.002 * s); // cutBelow offset removed by placeOnGround
    const eyeR = worm ? 0.035 : 0.022;
    const eyes = [-1, 1].map((side) =>
      eye({
        radius: eyeR,
        iris: worm ? '#1a1a1a' : '#e8c020',
        irisSize: worm ? 0.75 : 0.85,
        pupilSize: worm ? 0.5 : 0.3,
        segments: 14,
      })
        .scale(worm ? 1 : [0.6, 1, 1])
        .rotate([0, side * (worm ? 30 : 55), 0])
        .translate([
          head[0] + side * (worm ? 0.04 : 0.05) * thickness,
          head[1] + (worm ? 0.05 : 0.035) * thickness,
          head[2] + (worm ? 0.06 : 0.1) * thickness,
        ])
        .scale(s)
        .translate([0, drop, 0]),
    );
    const parts: Record<string, PolyMesh> = {
      body: mesh.material({ roughness: worm ? 0.35 : 0.45 }),
      eyes: eyes[0]!.merge(eyes[1]!).material({ roughness: 0.1 }),
    };
    if (!worm) {
      const tip: V3 = [head[0], head[1] - 0.005, head[2] + 0.16 * thickness];
      const fork = (dx: number) =>
        sdf.roundCone([tip[0], tip[1], tip[2] + 0.04], [tip[0] + dx, tip[1] + 0.005, tip[2] + 0.075], 0.0045, 0.0025);
      parts.tongue = sdf
        .roundCone([tip[0], tip[1], tip[2] - 0.04], [tip[0], tip[1], tip[2] + 0.04], 0.006, 0.0045)
        .union(fork(0.016), fork(-0.016))
        .color('#d0213a')
        .mesh({ resolution: 48 })
        .scale(s)
        .translate([0, drop, 0])
        .material({ roughness: 0.3 });
    }
    return model(parts)
      .socket('head', [head[0] * s, head[1] * s, (head[2] + 0.1) * s])
      .setCollider({ shape: 'capsule', radius: r0 * s, height: L * s, offset: [0, r0 * s, 0] });
  },
});
