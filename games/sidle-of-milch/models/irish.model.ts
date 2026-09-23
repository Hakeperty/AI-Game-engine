import { box, cylinder, defineModel, lathe, model, PolyMesh, p, roundedBox, sphere, torus } from 'aige/model';

/**
 * Things you find in an old rural Irish home. Each stands on y = 0 and faces +Z unless noted.
 * Wall pieces (sacred_heart, red_lamp, brigid_cross, holy_water_font) hang flat against +Z with their
 * origin at the back (place the entity on the wall surface, at hanging height).
 * - sacred_heart: an old framed devotional picture (part 'picture' has 0..1 UVs for a painting material)
 * - red_lamp: the little red Sacred Heart lamp on a brass bracket; part 'flame' glows
 * - brigid_cross: St. Brigid's cross woven from rushes
 * - holy_water_font: a small ceramic font by the front door
 * - dresser: a tall kitchen dresser with blue-and-white delph plates, jugs and hanging cups
 * - range: a cream enamel solid-fuel range cooker with a flue pipe (part 'flue')
 * - kettle: a stovetop kettle; teapot: a brown glazed teapot
 * - turf_basket: a wicker basket of turf sods; rosary: rosary beads lying in a loop
 * - sugan_chair: a chair with a woven rope (súgán) seat
 */
const KINDS = [
  'sacred_heart',
  'red_lamp',
  'brigid_cross',
  'holy_water_font',
  'dresser',
  'range',
  'kettle',
  'teapot',
  'turf_basket',
  'rosary',
  'sugan_chair',
] as const;

export default defineModel({
  name: 'irish',
  description: `Rural Irish home details; kind: ${KINDS.join(', ')}. Wall pieces hang against +Z with the origin at their back.`,
  params: {
    kind: p.choice(KINDS, 'dresser'),
    wood: p.color('#6b4a30'),
    glow: p.number(2, { min: 0, max: 20, description: 'red_lamp flame brightness' }),
    wear: p.number(0.6, { min: 0, max: 1 }),
  },
  build({ kind, wood, glow, wear }, { rng }) {
    const woodMat = { color: wood, roughness: 0.85 };
    const brass = { color: '#b08d45', metalness: 0.9, roughness: 0.35 };
    const chrome = { color: '#c9ccd0', metalness: 1, roughness: 0.2 };
    const straw = { color: '#b49a58', roughness: 0.95 };
    const plank = (size: [number, number, number], center: [number, number, number]) =>
      box({ size, center }).jitter(0.003 * wear, rng.int(1, 99999));

    switch (kind) {
      case 'sacred_heart': {
        const [w, h, b] = [0.36, 0.46, 0.045];
        const frame = PolyMesh.merge(
          box({ size: [w + b * 2, b, 0.035], center: [0, -h / 2 - b / 2, 0.0175] }),
          box({ size: [w + b * 2, b, 0.035], center: [0, h / 2 + b / 2, 0.0175] }),
          box({ size: [b, h, 0.035], center: [-w / 2 - b / 2, 0, 0.0175] }),
          box({ size: [b, h, 0.035], center: [w / 2 + b / 2, 0, 0.0175] }),
        );
        // A darkened old print: deep reds and browns with a warm glow at the heart.
        const picture = PolyMesh.merge(box({ size: [w, h, 0.004], center: [0, 0, 0.012] })).colorBy((q) => {
          const d = Math.hypot(q[0], q[1] + 0.02);
          const glowK = Math.max(0, 1 - d / 0.09);
          const vig = 1 - Math.min(1, Math.hypot(q[0] / w, q[1] / h) * 1.4);
          const r = 0.25 + 0.55 * glowK + 0.1 * vig;
          const g = 0.12 + 0.25 * glowK + 0.06 * vig;
          const bl = 0.08 + 0.05 * vig;
          return `#${[r, g, bl]
            .map((c) =>
              Math.round(Math.min(1, c) * 255)
                .toString(16)
                .padStart(2, '0'),
            )
            .join('')}`;
        });
        return model({
          frame: frame.material({ color: '#6f5328', metalness: 0.4, roughness: 0.5 }),
          picture: picture.material({ roughness: 0.6 }),
        });
      }
      case 'red_lamp': {
        // brass wall bracket with a red glass cup and a small electric "flame"
        const bracket = PolyMesh.merge(
          box({ size: [0.06, 0.09, 0.008], center: [0, 0, 0.004] }),
          box({ size: [0.012, 0.012, 0.09], center: [0, -0.02, 0.05] }),
          cylinder({ radius: 0.035, height: 0.01, segments: 16, center: [0, -0.02, 0.1] }),
        ).material(brass);
        const cup = lathe(
          [
            [0, 0],
            [0.022, 0.002],
            [0.032, 0.04],
            [0.034, 0.075],
            [0.03, 0.075],
            [0.028, 0.045],
            [0.018, 0.008],
            [0, 0.008],
          ],
          { segments: 20 },
        )
          .translate([0, -0.015, 0.1])
          .material({
            color: '#9c0f12',
            roughness: 0.15,
            opacity: 0.75,
            emissive: '#c01010',
            emissiveIntensity: glow * 0.35,
          });
        const flame = sphere({ radius: 0.009, segments: 10, rings: 6, center: [0, 0.01, 0.1] })
          .scale([1, 1.8, 1], [0, 0.01, 0.1])
          .material({ color: '#ff5a2a', emissive: '#ff3a18', emissiveIntensity: glow });
        return model({ bracket, cup, flame }).socket('light', [0, 0.03, 0.1]);
      }
      case 'brigid_cross': {
        // Four bundles of rushes; each arm passes through the woven square at the center, offset like a pinwheel.
        const rushes: PolyMesh[] = [];
        const L = 0.2;
        for (let arm = 0; arm < 4; arm++) {
          for (let i = 0; i < 5; i++) {
            const off = (i - 2) * 0.006;
            const len = L + rng.range(-0.01, 0.01);
            const rush = cylinder({ radius: 0.003, height: len, segments: 5 })
              .rotate([0, 0, 90])
              .translate([len / 2 - 0.01, 0.024 + off, 0.004 + (arm % 2) * 0.005])
              .rotate([0, 0, arm * 90]);
            rushes.push(rush);
          }
          // binding near the end of each arm
          rushes.push(
            torus({ radius: 0.017, tube: 0.0025, segments: 12, tubeSegments: 4 })
              .rotate([0, 90, 0])
              .translate([L - 0.04, 0.024, 0.006])
              .rotate([0, 0, arm * 90]),
          );
        }
        // the woven square where the four arms fold over each other
        for (let i = 0; i < 4; i++)
          rushes.push(
            box({ size: [0.066, 0.012, 0.006] })
              .rotate([0, 0, i * 90])
              .translate([Math.cos((i * Math.PI) / 2) * 0.0, 0, 0.009 + i * 0.0015])
              .translate(i % 2 ? [0, (i === 1 ? 1 : -1) * 0.027, 0] : [(i === 0 ? 1 : -1) * 0.027, 0, 0]),
          );
        return model({ rushes: PolyMesh.merge(...rushes).material(straw) });
      }
      case 'holy_water_font': {
        const plaque = roundedBox({ size: [0.09, 0.14, 0.012], radius: 0.005, center: [0, 0.03, 0.006] });
        const bowl = lathe(
          [
            [0, 0],
            [0.03, 0.004],
            [0.042, 0.03],
            [0.038, 0.03],
            [0.028, 0.01],
            [0, 0.01],
          ],
          { segments: 18 },
        ).translate([0, -0.05, 0.035]);
        const cross = PolyMesh.merge(
          box({ size: [0.008, 0.05, 0.004], center: [0, 0.06, 0.013] }),
          box({ size: [0.03, 0.008, 0.004], center: [0, 0.07, 0.013] }),
        );
        return model({
          font: PolyMesh.merge(plaque, bowl).material({ color: '#e9e4d8', roughness: 0.3 }),
          cross: cross.material({ color: '#2f5d9a', roughness: 0.3 }),
        });
      }
      case 'dresser': {
        const [w, d] = [1.25, 0.46];
        const baseH = 0.88;
        const topH = 1.05;
        const parts: Record<string, PolyMesh> = {};
        const base = PolyMesh.merge(
          plank([w, baseH - 0.08, d], [0, 0.08 + (baseH - 0.08) / 2, 0]),
          plank([w + 0.05, 0.035, d + 0.04], [0, baseH + 0.0175, 0.01]),
          plank([w, 0.08, d - 0.04], [0, 0.04, -0.01]),
        );
        const doors = PolyMesh.merge(
          plank([w / 2 - 0.03, baseH - 0.28, 0.022], [-w / 4, 0.46, d / 2 + 0.011]),
          plank([w / 2 - 0.03, baseH - 0.28, 0.022], [w / 4, 0.46, d / 2 + 0.011]),
          plank([w / 2 - 0.03, 0.14, 0.022], [-w / 4, baseH - 0.1, d / 2 + 0.011]),
          plank([w / 2 - 0.03, 0.14, 0.022], [w / 4, baseH - 0.1, d / 2 + 0.011]),
        );
        // upper rack: back boards, sides, shelves with plate rails, a cornice
        const y0 = baseH + 0.035;
        const shelves = [0.28, 0.58, 0.88].map((y) => y0 + y);
        const upper = PolyMesh.merge(
          plank([w, topH, 0.02], [0, y0 + topH / 2, -0.12]),
          plank([0.03, topH, 0.26], [-w / 2 + 0.015, y0 + topH / 2, -0.01]),
          plank([0.03, topH, 0.26], [w / 2 - 0.015, y0 + topH / 2, -0.01]),
          ...shelves.map((y) => plank([w - 0.06, 0.02, 0.22], [0, y, -0.02])),
          ...shelves.map((y) => plank([w - 0.06, 0.02, 0.012], [0, y + 0.055, 0.07])),
          plank([w + 0.08, 0.07, 0.3], [0, y0 + topH + 0.035, -0.01]),
        );
        parts.dresser = PolyMesh.merge(base, upper)
          .uvBox(1)
          .material({ ...woodMat, color: '#5a6e62' });
        parts.doors = doors.uvBox(1).material({ ...woodMat, color: '#617868' });
        parts.knobs = PolyMesh.merge(
          ...[-0.06, 0.06].map((x) =>
            sphere({ radius: 0.015, segments: 10, rings: 6, center: [x, 0.5, d / 2 + 0.03] }),
          ),
        ).material(brass);
        // blue-and-white delph plates standing on the shelves, leaning against the back
        const plates: PolyMesh[] = [];
        const jugs: PolyMesh[] = [];
        for (const [si, y] of [y0 + 0.02, ...shelves].entries()) {
          if (si === 0) continue;
          const n = si === 3 ? 4 : 5;
          for (let i = 0; i < n; i++) {
            const x = -w / 2 + 0.14 + ((w - 0.28) / (n - 1)) * i;
            const r = si === 3 ? 0.1 : 0.12;
            plates.push(
              cylinder({ radius: r, height: 0.012, segments: 28 })
                .rotate([90 - 12, 0, 0])
                .translate([x, y + 0.012 + r * 0.98, -0.05]),
            );
          }
        }
        // cups hanging on hooks under the lowest shelf, two jugs on the counter top
        for (let i = 0; i < 5; i++) {
          const x = -w / 2 + 0.16 + i * 0.23;
          jugs.push(
            lathe(
              [
                [0, 0],
                [0.03, 0],
                [0.036, 0.06],
                [0.033, 0.065],
                [0, 0.065],
              ],
              { segments: 14 },
            ).translate([x, shelves[0]! - 0.09, 0.05]),
          );
        }
        for (const x of [-0.35, 0.38])
          jugs.push(
            lathe(
              [
                [0, 0],
                [0.05, 0],
                [0.065, 0.08],
                [0.05, 0.16],
                [0.056, 0.2],
                [0, 0.2],
              ],
              { segments: 18 },
            ).translate([x, baseH + 0.035, -0.02]),
          );
        const delph = (q: [number, number, number]) => {
          // white glaze with blue rings and a blue center motif
          const t =
            Math.abs(Math.sin(q[0] * 90 + q[1] * 70)) * 0.3 +
            Math.abs(Math.sin(Math.hypot(q[0], q[1]) * 120));
          return t > 0.95 ? '#2a4f8f' : '#eef0ea';
        };
        parts.plates = PolyMesh.merge(...plates)
          .colorBy(delph)
          .material({ roughness: 0.2 });
        parts.jugs = PolyMesh.merge(...jugs)
          .colorBy(delph)
          .material({ roughness: 0.2 });
        return model(parts)
          .setCollider({ shape: 'box', size: [w, baseH + topH, d], offset: [0, (baseH + topH) / 2, 0] })
          .socket('top', [0, baseH + 0.035, 0.1]);
      }
      case 'range': {
        const [w, h, d] = [0.9, 0.86, 0.62];
        const enamel = { color: '#e6dcc3', roughness: 0.25 };
        const body = roundedBox({
          size: [w, h - 0.06, d],
          radius: 0.025,
          center: [0, 0.06 + (h - 0.06) / 2, 0],
        });
        const hot = box({ size: [w - 0.04, 0.02, d - 0.04], center: [0, h + 0.01, 0] });
        const lids = PolyMesh.merge(
          cylinder({ radius: 0.17, height: 0.05, segments: 28, center: [-0.2, h + 0.045, -0.02] }),
          cylinder({ radius: 0.17, height: 0.05, segments: 28, center: [0.2, h + 0.045, -0.02] }),
        );
        const doors = PolyMesh.merge(
          roundedBox({ size: [0.36, 0.34, 0.03], radius: 0.01, center: [-0.21, 0.45, d / 2 + 0.01] }),
          roundedBox({ size: [0.36, 0.34, 0.03], radius: 0.01, center: [0.21, 0.45, d / 2 + 0.01] }),
          roundedBox({ size: [0.2, 0.16, 0.03], radius: 0.01, center: [0.21, 0.17, d / 2 + 0.01] }),
        );
        const rail = PolyMesh.merge(
          cylinder({ radius: 0.012, height: w + 0.04, segments: 10 })
            .rotate([0, 0, 90])
            .translate([0, h - 0.07, d / 2 + 0.08]),
          box({ size: [0.02, 0.02, 0.08], center: [-w / 2, h - 0.07, d / 2 + 0.04] }),
          box({ size: [0.02, 0.02, 0.08], center: [w / 2, h - 0.07, d / 2 + 0.04] }),
          ...[-0.21, 0.21].map((x) =>
            cylinder({ radius: 0.01, height: 0.14, segments: 8 })
              .rotate([0, 0, 90])
              .translate([x, 0.56, d / 2 + 0.05]),
          ),
        );
        const flue = PolyMesh.merge(
          cylinder({ radius: 0.075, height: 1.6, segments: 20, center: [0.25, h + 0.8, -d / 2 + 0.08] }),
          cylinder({ radius: 0.085, height: 0.05, segments: 20, center: [0.25, h + 0.03, -d / 2 + 0.08] }),
        );
        const feet = PolyMesh.merge(
          ...[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([sx, sz]) =>
            box({ size: [0.06, 0.06, 0.06], center: [(sx! * (w - 0.08)) / 2, 0.03, (sz! * (d - 0.08)) / 2] }),
          ),
        );
        return model({
          body: PolyMesh.merge(body, doors).material(enamel),
          hotplate: PolyMesh.merge(hot, lids).material(chrome),
          rail: rail.material(chrome),
          flue: flue.material({ color: '#1e1c1a', metalness: 0.6, roughness: 0.6 }),
          feet: feet.material({ color: '#1e1c1a' }),
        })
          .setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] })
          .socket('hob', [-0.2, h + 0.07, -0.02]);
      }
      case 'kettle': {
        const body = lathe(
          [
            [0, 0],
            [0.1, 0.002],
            [0.11, 0.05],
            [0.095, 0.12],
            [0.05, 0.15],
            [0.02, 0.158],
            [0, 0.16],
          ],
          { segments: 24 },
        );
        const spout = cylinder({ radius: 0.014, radiusTop: 0.009, height: 0.14, segments: 10 })
          .rotate([0, 0, -55])
          .translate([0.12, 0.09, 0]);
        const handle = torus({ radius: 0.07, tube: 0.008, segments: 20, tubeSegments: 6 })
          .rotate([90, 0, 0])
          .intersect(box({ size: [0.2, 0.1, 0.1], center: [0, 0.05, 0] }))
          .translate([0, 0.145, 0]);
        return model({
          kettle: PolyMesh.merge(body, spout).material({
            color: '#7d7f82',
            metalness: 0.85,
            roughness: 0.35,
          }),
          handle: handle.material({ color: '#1c1a19', roughness: 0.6 }),
        });
      }
      case 'teapot': {
        const body = lathe(
          [
            [0, 0],
            [0.06, 0.002],
            [0.09, 0.05],
            [0.085, 0.1],
            [0.05, 0.13],
            [0.03, 0.14],
            [0.012, 0.16],
            [0, 0.165],
          ],
          { segments: 24 },
        );
        const spout = cylinder({ radius: 0.016, radiusTop: 0.008, height: 0.11, segments: 10 })
          .rotate([0, 0, -50])
          .translate([0.1, 0.08, 0]);
        const handle = torus({ radius: 0.045, tube: 0.009, segments: 18, tubeSegments: 6 })
          .rotate([90, 0, 0])
          .translate([-0.1, 0.08, 0]);
        return model({
          teapot: PolyMesh.merge(body, spout, handle).material({ color: '#4a2a17', roughness: 0.15 }),
        });
      }
      case 'turf_basket': {
        const basket = lathe(
          [
            [0, 0],
            [0.2, 0],
            [0.26, 0.3],
            [0.25, 0.31],
            [0.19, 0.012],
            [0, 0.012],
          ],
          { segments: 28 },
        )
          .jitter(0.004, 3)
          .colorBy((q) => (Math.sin(Math.atan2(q[2], q[0]) * 40 + q[1] * 60) > 0 ? '#8a6a3c' : '#6e5230'));
        const sods: PolyMesh[] = [];
        for (let i = 0; i < 9; i++) {
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(0, 0.13);
          sods.push(
            box({ size: [rng.range(0.16, 0.22), 0.07, 0.08] })
              .jitter(0.012, rng.int(1, 9999))
              .rotate([rng.range(-25, 25), rng.range(0, 180), rng.range(-20, 20)])
              .translate([Math.cos(a) * r, 0.25 + rng.range(0, 0.12), Math.sin(a) * r]),
          );
        }
        return model({
          basket: basket.material({ roughness: 0.95 }),
          turf: PolyMesh.merge(...sods).material({ color: '#2d2118', roughness: 1 }),
        }).setCollider({ shape: 'cylinder', size: [0.52, 0.35, 0.52], offset: [0, 0.175, 0] });
      }
      case 'rosary': {
        const beads: PolyMesh[] = [];
        const n = 48;
        for (let i = 0; i < n; i++) {
          const t = (i / n) * Math.PI * 2;
          const x = Math.cos(t) * 0.07 + Math.sin(t * 3) * 0.008;
          const z = Math.sin(t) * 0.05;
          beads.push(
            sphere({ radius: i % 11 === 0 ? 0.0055 : 0.0038, segments: 8, rings: 5, center: [x, 0.004, z] }),
          );
        }
        for (let i = 1; i <= 5; i++)
          beads.push(
            sphere({ radius: 0.0038, segments: 8, rings: 5, center: [0.07 + i * 0.011, 0.004, 0.012 * i] }),
          );
        const cross = PolyMesh.merge(
          box({ size: [0.03, 0.004, 0.008], center: [0.145, 0.003, 0.075] }),
          box({ size: [0.008, 0.004, 0.02], center: [0.14, 0.003, 0.073] }),
        ).rotate([0, -30, 0], [0.14, 0, 0.074]);
        return model({
          beads: PolyMesh.merge(...beads).material({ color: '#2b1b14', roughness: 0.3 }),
          crucifix: cross.material({ color: '#9a9ea3', metalness: 0.9, roughness: 0.3 }),
        });
      }
      case 'sugan_chair': {
        const s = 0.44;
        const legs = PolyMesh.merge(
          ...[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([sx, sz]) =>
            cylinder({
              radius: 0.022,
              height: sz! < 0 ? 0.95 : 0.46,
              segments: 10,
              center: [(sx! * (s - 0.05)) / 2, sz! < 0 ? 0.475 : 0.23, (sz! * (s - 0.05)) / 2],
            }),
          ),
          ...[0.12, 0.3].map((y) =>
            cylinder({ radius: 0.012, height: s - 0.05, segments: 8 })
              .rotate([0, 0, 90])
              .translate([0, y, (s - 0.05) / 2]),
          ),
          ...[0.7, 0.86].map((y) => box({ size: [s - 0.05, 0.05, 0.02], center: [0, y, -(s - 0.05) / 2] })),
        );
        // woven rope seat: a grid of rope strands with a gentle sag
        const rope: PolyMesh[] = [];
        for (let i = 0; i < 14; i++) {
          const o = -s / 2 + 0.03 + (i / 13) * (s - 0.06);
          rope.push(
            cylinder({ radius: 0.0075, height: s - 0.04, segments: 6 })
              .rotate([90, 0, 0])
              .translate([o, 0.455, 0]),
            cylinder({ radius: 0.0075, height: s - 0.04, segments: 6 })
              .rotate([0, 0, 90])
              .translate([0, 0.462, o]),
          );
        }
        const seat = PolyMesh.merge(...rope).bend(-4);
        return model({
          chair: legs.uvBox(1).material(woodMat),
          seat: seat.material({ color: '#a88a55', roughness: 1 }),
        }).setCollider({ shape: 'box', size: [s, 0.95, s], offset: [0, 0.475, 0] });
      }
    }
    throw new Error(`Unknown kind '${kind}'.`);
  },
});
