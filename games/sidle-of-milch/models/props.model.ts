import {
  box,
  cone,
  cylinder,
  defineModel,
  lathe,
  model,
  PolyMesh,
  p,
  roundedBox,
  sdf,
  sphere,
  torus,
} from 'aige/model';

/**
 * Small story props. Each stands on y = 0 and faces +Z unless noted.
 * - frame_stand: standing picture frame (part 'photo' shows the whole image on its front face, 0..1 UVs)
 * - frame_magnet: a small photo held on a fridge (flat against +Z, origin at its back)
 * - frame_wall: a hanging frame (flat against +Z, origin at its back)
 * - knife: kitchen knife lying flat, blade toward +X; knife_stuck: point-down in the floor
 * - toothbrush_cup: a cup with three toothbrushes
 * - shield: a round wooden shield with a carved whirl (hangs flat against +Z, origin at its back)
 * - bulb: bare bulb on a cord, hanging DOWN from y = 0 (place the entity at the ceiling); part 'glass' glows
 * - cobweb: a corner web (spans +X/+Y/+Z quadrant from the corner at the origin)
 * - dirt: a low mound of dirt; rug: a worn rug; ball, blocks, horse: toys
 */
const KINDS = [
  'frame_stand',
  'frame_magnet',
  'frame_wall',
  'knife',
  'knife_stuck',
  'toothbrush_cup',
  'shield',
  'bulb',
  'cobweb',
  'dirt',
  'rug',
  'ball',
  'blocks',
  'horse',
  'paper',
  'calendar',
  'saucer_milk',
  'horseshoe',
  'jar_sprig',
  'bottle',
  'mug',
  'plates',
  'newspaper',
  'candle',
] as const;

export default defineModel({
  name: 'props',
  description: `Small story props; kind: ${KINDS.join(', ')}. Frames have a 'photo' part (0..1 UVs) for a photo material.`,
  params: {
    kind: p.choice(KINDS, 'frame_stand'),
    size: p.number(1, { min: 0.2, max: 4, description: 'Uniform scale factor' }),
    color: p.color('#6b4a30'),
    glow: p.number(1, { min: 0, max: 20, description: 'Bulb glow intensity' }),
  },
  build({ kind, size: s, color, glow }, { rng }) {
    const wood = { color, roughness: 0.85 };
    const steel = { color: '#b9bcc0', metalness: 1, roughness: 0.28 };
    const photoPlane = (w: number, h: number, center: [number, number, number]) =>
      box({ size: [w, h, 0.002], center }).material({ color: '#ffffff', roughness: 0.55 });

    switch (kind) {
      case 'frame_stand': {
        const [w, h, t, b] = [0.18 * s, 0.13 * s, 0.014 * s, 0.018 * s];
        const frame = PolyMesh.merge(
          box({ size: [w + b * 2, b, t], center: [0, b / 2, 0] }),
          box({ size: [w + b * 2, b, t], center: [0, h + b * 1.5, 0] }),
          box({ size: [b, h, t], center: [-w / 2 - b / 2, h / 2 + b, 0] }),
          box({ size: [b, h, t], center: [w / 2 + b / 2, h / 2 + b, 0] }),
          box({ size: [w, h, 0.004], center: [0, h / 2 + b, -t / 2 + 0.002] }),
        ).rotate([-10, 0, 0]);
        // easel leg behind the frame, leaning forward onto its back
        const leg = box({ size: [0.03 * s, h * 0.9, 0.006 * s], center: [0, h * 0.45, -0.075 * s] }).rotate(
          [18, 0, 0],
          [0, 0, -0.075 * s],
        );
        return model({
          frame: PolyMesh.merge(frame, leg).material({ ...wood, color: '#3d2b1e' }),
          photo: photoPlane(w, h, [0, h / 2 + b, 0.001]).rotate([-10, 0, 0]),
          glass: box({ size: [w, h, 0.002], center: [0, h / 2 + b, t / 2 - 0.001] })
            .rotate([-10, 0, 0])
            .material({ color: '#dfe6ea', roughness: 0.05, opacity: 0.12 }),
        }).setCollider({
          shape: 'box',
          size: [w + b * 2, h + b * 2, 0.08 * s],
          offset: [0, (h + b * 2) / 2, -0.02],
        });
      }
      case 'frame_magnet':
      case 'frame_wall': {
        const wall = kind === 'frame_wall';
        const [w, h] = wall ? [0.3 * s, 0.22 * s] : [0.1 * s, 0.14 * s];
        const parts: Record<string, PolyMesh> = { photo: photoPlane(w, h, [0, 0, 0.004]) };
        if (wall) {
          const b = 0.025 * s;
          parts.frame = PolyMesh.merge(
            box({ size: [w + b * 2, b, 0.02], center: [0, -h / 2 - b / 2, 0.01] }),
            box({ size: [w + b * 2, b, 0.02], center: [0, h / 2 + b / 2, 0.01] }),
            box({ size: [b, h, 0.02], center: [-w / 2 - b / 2, 0, 0.01] }),
            box({ size: [b, h, 0.02], center: [w / 2 + b / 2, 0, 0.01] }),
          ).material({ ...wood, color: '#3d2b1e' });
        } else {
          parts.magnet = cylinder({ radius: 0.012 * s, height: 0.01, segments: 12 })
            .rotate([90, 0, 0])
            .translate([0, h / 2 - 0.015 * s, 0.01])
            .material({ color: '#8a1f1a', roughness: 0.4 });
        }
        return model(parts);
      }
      case 'knife':
      case 'knife_stuck': {
        const bladeLen = 0.2 * s;
        const blade = PolyMesh.merge(
          box({ size: [bladeLen, 0.032 * s, 0.0025], center: [bladeLen / 2, 0, 0] }),
          cone({ radius: 0.016 * s, height: 0.05 * s, segments: 3 })
            .scale([1, 1, 0.08])
            .rotate([0, 0, -90])
            .translate([bladeLen + 0.02 * s, -0.004 * s, 0]),
        ).material(steel);
        const handle = roundedBox({
          size: [0.12 * s, 0.026 * s, 0.02 * s],
          radius: 0.008 * s,
          center: [-0.06 * s, 0, 0],
        }).material({ color: '#2b1d14', roughness: 0.7 });
        const rivets = PolyMesh.merge(
          ...[-0.03, -0.09].map((x) =>
            cylinder({ radius: 0.003 * s, height: 0.022 * s, segments: 8 })
              .rotate([90, 0, 0])
              .translate([x * s, 0, 0]),
          ),
        ).material(steel);
        // Lying flat on its side, or stuck point-down in the floorboards at a slight angle.
        const pose = (m: PolyMesh) =>
          kind === 'knife'
            ? m.rotate([90, 0, 0]).translate([0, 0.0125 * s, 0])
            : m.rotate([0, 0, -80]).translate([0, 0.19 * s, 0]);
        return model({ blade: pose(blade), handle: pose(handle), rivets: pose(rivets) }).socket('grip', [
          -0.06 * s,
          0.0125 * s,
          0,
        ]);
      }
      case 'toothbrush_cup': {
        const cup = lathe(
          [
            [0, 0],
            [0.032, 0],
            [0.036, 0.09],
            [0.033, 0.09],
            [0.029, 0.006],
            [0, 0.006],
          ],
          { segments: 20 },
        ).material({ color: '#c8cfc9', roughness: 0.25, opacity: 0.85 });
        const colors = ['#2f6fa3', '#b33a3a', '#e0b23a'];
        const brushes = colors.map((c, i) => {
          const a = (i / 3) * Math.PI * 2 + rng.range(-0.3, 0.3);
          const lean = rng.range(8, 16);
          const handle = cylinder({ radius: 0.0045, height: 0.17, segments: 8, center: [0, 0.085, 0] });
          const head = box({ size: [0.011, 0.028, 0.006], center: [0, 0.18, 0.004] });
          const bristles = box({ size: [0.009, 0.024, 0.01], center: [0, 0.18, 0.012] });
          const brush = PolyMesh.merge(
            handle.material({ color: c, roughness: 0.35 }),
            head.material({ color: c, roughness: 0.35 }),
            bristles.material({ color: '#e8e6df', roughness: 0.9 }),
          );
          return brush
            .rotate([lean, (a * 180) / Math.PI, 0])
            .translate([Math.cos(a) * 0.012, 0.004, Math.sin(a) * 0.012]);
        });
        return model({ cup, brushes: PolyMesh.merge(...brushes) }).setCollider({
          shape: 'cylinder',
          size: [0.08, 0.2, 0.08],
          offset: [0, 0.1, 0],
        });
      }
      case 'shield': {
        const r = 0.33 * s;
        // Round planked shield with a carved whirl (spiral) and an iron rim and boss.
        const disc = cylinder({ radius: r, height: 0.03, segments: 48 })
          .rotate([90, 0, 0])
          .translate([0, 0, 0.015]);
        // The whirl: a Newgrange-style triple spiral (triskele), three spirals that unwind into each other.
        const arms = [0, 1, 2].map((k) => {
          const base = Math.PI / 2 + (k * Math.PI * 2) / 3;
          const cx = Math.cos(base) * r * 0.34;
          const cy = Math.sin(base) * r * 0.34;
          const pts: [number, number, number][] = [];
          for (let i = 0; i <= 70; i++) {
            const t = i / 70;
            const ang = base + Math.PI + t * Math.PI * 4.4;
            const rad = 0.012 * s + t * r * 0.3;
            pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 0.031]);
          }
          // sweep out from the spiral's end toward the center, joining the other two arms
          const [ex, ey] = pts[pts.length - 1]!;
          for (let i = 1; i <= 12; i++) {
            const t = i / 12;
            pts.push([ex * (1 - t) * (1 - t * 0.2), ey * (1 - t) * (1 - t * 0.2), 0.031]);
          }
          return sdf.tube(pts, 0.011 * s);
        });
        const whirl = sdf.unionAll(arms).mesh({ detail: 'medium' });
        const rim = torus({ radius: r, tube: 0.012 * s, segments: 64, tubeSegments: 8 })
          .rotate([90, 0, 0])
          .translate([0, 0, 0.018]);
        const boss = sphere({ radius: 0.06 * s, segments: 20, rings: 10 })
          .scale([1, 1, 0.45])
          .translate([0, 0, 0.032]);
        return model({
          wood: disc.uvBox(1).material({ color: '#7a5537', roughness: 0.8 }),
          whirl: whirl.material({ color: '#b98a3c', roughness: 0.6, metalness: 0.3 }),
          iron: PolyMesh.merge(rim, boss).material({ color: '#4a4541', metalness: 0.85, roughness: 0.5 }),
        }).setCollider({ shape: 'box', size: [r * 2, r * 2, 0.08], offset: [0, 0, 0.04] });
      }
      case 'bulb': {
        const cord = cylinder({ radius: 0.004, height: 0.5, segments: 6, center: [0, -0.25, 0] });
        const socket = cylinder({ radius: 0.018, height: 0.05, segments: 12, center: [0, -0.525, 0] });
        const glass = sphere({ radius: 0.032, segments: 16, rings: 10, center: [0, -0.58, 0] }).scale(
          [1, 1.25, 1],
          [0, -0.58, 0],
        );
        return model({
          cord: PolyMesh.merge(cord, socket).material({ color: '#1c1a18', roughness: 0.6 }),
          glass: glass.material({
            color: '#ffd9a0',
            emissive: '#ffc070',
            emissiveIntensity: glow,
            roughness: 0.2,
          }),
        }).socket('light', [0, -0.6, 0]);
      }
      case 'cobweb': {
        // A thin, sagging, translucent sheet stretched diagonally across the corner.
        const L = 0.45 * s;
        const sheet = sdf
          .box([L, 0.004, L], [0, 0, 0], 0.001)
          .rotate([45, 0, -35])
          .translate([L * 0.32, L * 0.32, L * 0.32])
          .displaceBy((q) => Math.sin(q[0] * 60) * 0.002 + Math.sin(q[2] * 55) * 0.002, 0.004)
          .mesh({ detail: 'low' });
        return model({
          web: sheet.material({ color: '#d9d9d2', roughness: 1, opacity: 0.22, doubleSided: true }),
        });
      }
      case 'dirt': {
        const mound = sdf
          .ellipsoid([0.45 * s, 0.07 * s, 0.35 * s])
          .smoothUnion(sdf.ellipsoid([0.25 * s, 0.05 * s, 0.2 * s], [0.25 * s, 0, 0.12 * s]), 0.06)
          .displaceBy((q) => Math.sin(q[0] * 23) * 0.01 + Math.sin(q[2] * 19 + q[0] * 7) * 0.01, 0.02)
          .cutBelow(0)
          .mesh({ detail: 'low' });
        return model({ dirt: mound.uvBox(1).material({ color: '#3b3025', roughness: 1 }) });
      }
      case 'rug': {
        const rug = roundedBox({ size: [1.6 * s, 0.012, 1.0 * s], radius: 0.005, center: [0, 0.006, 0] })
          .subdivide(1)
          .displace({ amount: 0.006, scale: 4, seed: 3 });
        return model({ rug: rug.uvBox(1).material({ color: '#6b3a2e', roughness: 1 }) });
      }
      case 'ball':
        return model({
          ball: sphere({ radius: 0.11 * s, segments: 24, rings: 14, center: [0, 0.11 * s, 0] }).material({
            color: '#9b2f2a',
            roughness: 0.6,
          }),
        }).setCollider({ shape: 'sphere', size: [0.22 * s, 0.22 * s, 0.22 * s], offset: [0, 0.11 * s, 0] });
      case 'blocks': {
        const cols = ['#a33b32', '#2f5f93', '#caa13b', '#3f7a45'];
        const blocks = Array.from({ length: 6 }, (_, i) =>
          roundedBox({ size: [0.07, 0.07, 0.07], radius: 0.006 })
            .rotate([0, rng.range(-30, 30), 0])
            .translate([rng.range(-0.15, 0.15), 0.035 + (i > 3 ? 0.07 : 0), rng.range(-0.12, 0.12)])
            .material({ color: cols[i % 4]!, roughness: 0.7 }),
        );
        return model({ blocks: PolyMesh.merge(...blocks) });
      }
      case 'horse': {
        const body = sdf
          .capsule([-0.12, 0.2, 0], [0.12, 0.2, 0], 0.06)
          .smoothUnion(sdf.capsule([0.12, 0.22, 0], [0.19, 0.33, 0], 0.035), 0.03)
          .smoothUnion(sdf.ellipsoid([0.07, 0.035, 0.035], [0.23, 0.35, 0]), 0.02)
          .mesh({ detail: 'low' });
        const legs = PolyMesh.merge(
          ...[
            [-0.1, 0.04],
            [-0.1, -0.04],
            [0.1, 0.04],
            [0.1, -0.04],
          ].map(([x, z]) => cylinder({ radius: 0.014, height: 0.16, segments: 8, center: [x!, 0.1, z!] })),
        );
        const rocker = torus({ radius: 0.5, tube: 0.012, segments: 48, tubeSegments: 6 })
          .intersect(box({ size: [0.5, 0.2, 0.2], center: [0, -0.45, 0] }))
          .translate([0, 0.47, 0]);
        return model({
          horse: PolyMesh.merge(body, legs).material({ color: '#b08455', roughness: 0.7 }),
          rocker: PolyMesh.merge(rocker.translate([0, 0, 0.05]), rocker.translate([0, 0, -0.05])).material({
            color: '#6b4a30',
            roughness: 0.8,
          }),
        });
      }
      case 'paper':
      case 'calendar': {
        // A sheet pinned flat against +Z (origin at its back); part 'photo' carries the image (0..1 UVs).
        const cal = kind === 'calendar';
        const [w, h] = cal ? [0.3 * s, 0.4 * s] : [0.3 * s, 0.225 * s];
        const sheet = box({ size: [w, h, 0.002], center: [0, 0, 0.003] })
          .bend(cal ? 0 : 3)
          .material({ color: '#ffffff', roughness: 0.9 });
        const pin = cal
          ? cylinder({ radius: 0.004, height: 0.03, segments: 6 })
              .rotate([90, 0, 0])
              .translate([0, h / 2 - 0.012, 0.015])
          : sphere({ radius: 0.006, segments: 8, rings: 5, center: [0, h / 2 - 0.015, 0.007] });
        return model({
          photo: sheet,
          pin: pin.material({ color: cal ? '#3a3632' : '#b22222', metalness: 0.5, roughness: 0.5 }),
        });
      }
      case 'saucer_milk': {
        // A saucer of milk left out on the floor. Old custom: an offering so the fairies leave the house alone.
        const saucer = lathe(
          [
            [0, 0],
            [0.05, 0],
            [0.075, 0.012],
            [0.085, 0.02],
            [0.08, 0.021],
            [0.07, 0.014],
            [0, 0.008],
          ],
          { segments: 28 },
        ).material({ color: '#e8e4da', roughness: 0.25 });
        const milk = cylinder({ radius: 0.068, height: 0.004, segments: 28, center: [0, 0.013, 0] }).material(
          {
            color: '#f3f1ea',
            roughness: 0.1,
          },
        );
        return model({ saucer, milk });
      }
      case 'horseshoe': {
        // Iron horseshoe nailed up with the ends pointing up to hold the luck (and keep the fairies out).
        const shoe = torus({ radius: 0.06, tube: 0.011, segments: 24, tubeSegments: 6 })
          .intersect(box({ size: [0.2, 0.2, 0.1], center: [0, -0.035, 0] }))
          .scale([1, 1.15, 0.6])
          .rotate([90, 0, 180])
          .rotate([-90, 0, 0])
          .translate([0, 0, 0.008])
          .jitter(0.002, 5);
        return model({ shoe: shoe.material({ color: '#3b332d', metalness: 0.85, roughness: 0.75 }) });
      }
      case 'jar_sprig': {
        // A jam jar with a hawthorn sprig in it. Bringing hawthorn into a house is said to bring death.
        const jar = lathe(
          [
            [0, 0],
            [0.04, 0],
            [0.042, 0.1],
            [0.035, 0.115],
            [0.036, 0.13],
            [0, 0.13],
          ],
          { segments: 20 },
        ).material({ color: '#c9d4d2', roughness: 0.05, opacity: 0.35 });
        const twigs: PolyMesh[] = [];
        const blossoms: PolyMesh[] = [];
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3);
          const lean = rng.range(10, 35);
          const len = rng.range(0.18, 0.32);
          twigs.push(
            cylinder({ radius: 0.003, radiusTop: 0.0015, height: len, segments: 5, center: [0, len / 2, 0] })
              .rotate([lean, (a * 180) / Math.PI, 0])
              .translate([0, 0.02, 0]),
          );
          for (let k = 0; k < 5; k++) {
            const t = rng.range(0.5, 1);
            const r = Math.sin((lean * Math.PI) / 180) * len * t;
            blossoms.push(
              sphere({ radius: 0.006, segments: 6, rings: 4 }).translate([
                Math.sin(a) * r + rng.range(-0.01, 0.01),
                0.02 + Math.cos((lean * Math.PI) / 180) * len * t,
                Math.cos(a) * r + rng.range(-0.01, 0.01),
              ]),
            );
          }
        }
        return model({
          jar,
          twigs: PolyMesh.merge(...twigs).material({ color: '#3d2e22', roughness: 0.9 }),
          blossoms: PolyMesh.merge(...blossoms).material({ color: '#e9e0d6', roughness: 0.8 }),
        });
      }
      case 'bottle': {
        const bottle = lathe(
          [
            [0, 0],
            [0.036, 0],
            [0.038, 0.17],
            [0.02, 0.22],
            [0.013, 0.26],
            [0.014, 0.29],
            [0, 0.29],
          ],
          { segments: 20 },
        ).material({ color: rng.chance(0.5) ? '#3b5a2a' : '#5a3a1c', roughness: 0.1, opacity: 0.75 });
        return model({ bottle }).setCollider({
          shape: 'cylinder',
          size: [0.08, 0.29, 0.08],
          offset: [0, 0.145, 0],
        });
      }
      case 'mug': {
        const mug = lathe(
          [
            [0, 0],
            [0.04, 0],
            [0.042, 0.095],
            [0.037, 0.095],
            [0.035, 0.008],
            [0, 0.008],
          ],
          { segments: 20 },
        );
        const handle = torus({ radius: 0.028, tube: 0.007, segments: 16, tubeSegments: 6 })
          .rotate([90, 0, 0])
          .translate([0.045, 0.05, 0]);
        const tea = cylinder({ radius: 0.034, height: 0.003, segments: 20, center: [0, 0.06, 0] });
        return model({
          mug: PolyMesh.merge(mug, handle).material({ color: '#d9d2c3', roughness: 0.3 }),
          tea: tea.material({ color: '#2a1a10', roughness: 0.05 }),
        });
      }
      case 'plates': {
        const plates = PolyMesh.merge(
          ...Array.from({ length: 5 }, (_, i) =>
            cylinder({
              radius: 0.12,
              height: 0.012,
              segments: 28,
              center: [rng.range(-0.006, 0.006), 0.006 + i * 0.014, rng.range(-0.006, 0.006)],
            }),
          ),
        ).material({ color: '#e7e3d9', roughness: 0.25 });
        return model({ plates });
      }
      case 'newspaper': {
        const paper = box({ size: [0.36, 0.006, 0.28], center: [0, 0.003, 0] })
          .subdivide(1)
          .displace({ amount: 0.004, scale: 6, seed: 4 })
          .colorBy((q) =>
            Math.abs(Math.sin(q[2] * 90)) > 0.8 && Math.abs(q[0]) < 0.15 ? '#5a5650' : '#d8d2c2',
          );
        return model({ paper: paper.material({ roughness: 0.95 }) });
      }
      case 'candle': {
        // A candle burnt down to a stub in a saucer, with drips of wax.
        const dish = cylinder({ radius: 0.05, height: 0.01, segments: 20, center: [0, 0.005, 0] });
        const stub = cylinder({ radius: 0.018, height: 0.045, segments: 14, center: [0, 0.032, 0] }).jitter(
          0.002,
          3,
        );
        const drips = PolyMesh.merge(
          ...Array.from({ length: 5 }, (_, i) =>
            sphere({ radius: 0.008, segments: 6, rings: 4 })
              .scale([1, 0.5, 1])
              .translate([Math.cos(i * 1.3) * 0.028, 0.012, Math.sin(i * 1.3) * 0.028]),
          ),
        );
        return model({
          dish: dish.material({ color: '#6f6a60', metalness: 0.6, roughness: 0.5 }),
          wax: PolyMesh.merge(stub, drips).material({ color: '#e6dcc4', roughness: 0.6 }),
        });
      }
    }
    throw new Error(`Unknown prop kind '${kind}'.`);
  },
});
