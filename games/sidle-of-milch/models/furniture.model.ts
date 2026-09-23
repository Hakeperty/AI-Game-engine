import { box, cylinder, defineModel, lathe, model, PolyMesh, p, roundedBox, sdf, sphere } from 'aige/model';

/**
 * Old cabin furniture. Every piece stands on y = 0 and faces +Z (its front, drawers and doors point at +Z).
 * `wear` darkens and roughens the wood, and the fabric of beds is worn and dusty.
 */
const KINDS = [
  'bed',
  'small_bed',
  'dresser',
  'nightstand',
  'round_table',
  'chair',
  'fridge',
  'counter',
  'sink_counter',
  'wall_cabinet',
  'bathtub',
  'basin',
  'toilet',
  'shelf',
  'crate',
  'coat_rack',
  'toy_chest',
  'wardrobe',
] as const;

export default defineModel({
  name: 'furniture',
  description: `Weathered cabin furniture; kind: ${KINDS.join(', ')}. Base at y = 0, front faces +Z.`,
  params: {
    kind: p.choice(KINDS, 'bed'),
    wood: p.color('#6b4a30'),
    fabric: p.color('#8c8577'),
    wear: p.number(0.6, { min: 0, max: 1 }),
    open: p.number(0, { min: 0, max: 1, description: 'Drawer / door opening (0 closed, 1 open)' }),
  },
  build({ kind, wood, fabric, wear, open }, { rng }) {
    const tone = (hex: string, k: number) => {
      const c = hex
        .match(/\w\w/g)!
        .map((h) => Math.max(0, Math.min(255, Math.round(Number.parseInt(h, 16) * k))));
      return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    const woodMat = { color: tone(wood, 1 - wear * 0.25), roughness: 0.85 + wear * 0.1 };
    const darkWood = { color: tone(wood, 0.72 - wear * 0.2), roughness: 0.9 };
    const metal = { color: '#8d8a84', metalness: 0.7, roughness: 0.55 };
    const porcelain = { color: tone('#e8e4da', 1 - wear * 0.15), roughness: 0.3 };
    const plank = (size: [number, number, number], center: [number, number, number], jit = 0.004) =>
      box({ size, center }).jitter(jit * wear, rng.int(1, 99999));
    const legs = (w: number, d: number, h: number, t = 0.05) =>
      PolyMesh.merge(
        ...[
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ].map(([sx, sz]) => plank([t, h, t], [(sx! * (w - t)) / 2, h / 2, (sz! * (d - t)) / 2])),
      );
    const handle = (x: number, y: number, z: number) =>
      box({ size: [0.1, 0.02, 0.025], center: [x, y, z + 0.012] });
    /** Box body with a row of drawers on the front. */
    const drawerUnit = (w: number, h: number, d: number, rows: number, cols = 1, baseY = 0.08) => {
      const body = plank([w, h - baseY, d - 0.02], [0, baseY + (h - baseY) / 2, -0.01]);
      const fronts: PolyMesh[] = [];
      const handles: PolyMesh[] = [];
      const dh = (h - baseY - 0.04) / rows;
      const dw = (w - 0.04) / cols;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const cx = -w / 2 + 0.02 + dw * (c + 0.5);
          const cy = baseY + 0.02 + dh * (r + 0.5);
          const pull = r === rows - 1 && c === 0 ? open * d * 0.6 : 0;
          fronts.push(plank([dw - 0.02, dh - 0.02, 0.025], [cx, cy, d / 2 + pull]));
          if (pull > 0)
            fronts.push(plank([dw - 0.06, dh - 0.06, d * 0.6], [cx, cy - 0.01, d / 2 + pull - d * 0.3]));
          handles.push(handle(cx, cy + dh * 0.15, d / 2 + 0.012 + pull));
        }
      return { body, fronts: PolyMesh.merge(...fronts), handles: PolyMesh.merge(...handles) };
    };

    switch (kind) {
      case 'bed':
      case 'small_bed': {
        const small = kind === 'small_bed';
        const w = small ? 0.9 : 1.05;
        const l = small ? 1.7 : 2.05;
        const frame = PolyMesh.merge(
          plank([w, 0.14, l], [0, 0.32, 0]),
          legs(w, l, 0.3, 0.07),
          plank([w + 0.06, small ? 0.75 : 0.95, 0.07], [0, small ? 0.37 : 0.47, -l / 2]),
          plank([w + 0.06, 0.55, 0.07], [0, 0.27, l / 2]),
        );
        // A rumpled mattress and a thrown-back blanket (he slept here).
        const mattress = roundedBox({ size: [w - 0.06, 0.18, l - 0.1], radius: 0.06, center: [0, 0.47, 0] })
          .subdivide(1)
          .displace({ amount: 0.015, scale: 3, seed: rng.int(1, 999) });
        const blanket = sdf
          .box([w * 0.5, 0.05, l * 0.28], 0.04)
          .translate([0.02, 0.58, l * 0.16])
          .union(sdf.capsule([-w * 0.45, 0.6, -0.05], [w * 0.45, 0.62, -0.1], 0.07), 0.08)
          .displace((q) => Math.sin(q[0] * 13) * 0.012 + Math.sin(q[2] * 9 + q[0] * 4) * 0.015)
          .mesh({ detail: 'low' });
        const pillow = roundedBox({
          size: [w * 0.62, 0.12, 0.38],
          radius: 0.06,
          center: [0.06, 0.61, -l / 2 + 0.3],
        })
          .subdivide(1)
          .rotate([0, rng.range(-8, 8), 0]);
        return model({
          frame: frame.material(woodMat),
          mattress: mattress.material({ color: tone('#bdb6a6', 1 - wear * 0.2), roughness: 0.95 }),
          blanket: blanket.material({ color: tone(fabric, 1 - wear * 0.2), roughness: 1 }),
          pillow: pillow.material({ color: tone('#cfc8b8', 1 - wear * 0.25), roughness: 1 }),
        }).setCollider({ shape: 'box', size: [w, 0.62, l], offset: [0, 0.31, 0] });
      }
      case 'dresser':
      case 'nightstand': {
        const big = kind === 'dresser';
        const [w, h, d] = big ? [1.1, 0.95, 0.5] : [0.45, 0.55, 0.4];
        const u = drawerUnit(w, h, d, big ? 3 : 2, big ? 2 : 1);
        const top = plank([w + 0.04, 0.03, d + 0.02], [0, h + 0.015, 0]);
        return model({
          body: PolyMesh.merge(u.body, top).material(woodMat),
          drawers: u.fronts.material(darkWood),
          handles: u.handles.material(metal),
        })
          .setCollider({ shape: 'box', size: [w, h + 0.03, d], offset: [0, (h + 0.03) / 2, 0] })
          .socket('top', [0, h + 0.03, 0]);
      }
      case 'round_table': {
        const top = cylinder({ radius: 0.62, height: 0.045, segments: 28, center: [0, 0.74, 0] }).jitter(
          0.004 * wear,
          3,
        );
        const post = lathe(
          [
            [0.0, 0.0],
            [0.3, 0.0],
            [0.3, 0.04],
            [0.08, 0.1],
            [0.05, 0.3],
            [0.07, 0.45],
            [0.045, 0.62],
            [0.12, 0.7],
            [0.0, 0.72],
          ],
          { segments: 16 },
        );
        return model({ top: top.material(woodMat), post: post.material(darkWood) })
          .setCollider({ shape: 'cylinder', size: [1.24, 0.76, 1.24], offset: [0, 0.38, 0] })
          .socket('top', [0, 0.765, 0]);
      }
      case 'chair': {
        const s = 0.42;
        const seat = plank([s, 0.035, s], [0, 0.45, 0]);
        const back = PolyMesh.merge(
          plank([0.04, 0.5, 0.04], [-s / 2 + 0.02, 0.7, -s / 2 + 0.02]),
          plank([0.04, 0.5, 0.04], [s / 2 - 0.02, 0.7, -s / 2 + 0.02]),
          plank([s, 0.07, 0.025], [0, 0.88, -s / 2 + 0.02]),
          plank([s, 0.05, 0.025], [0, 0.68, -s / 2 + 0.02]),
        );
        return model({
          chair: PolyMesh.merge(seat, legs(s, s, 0.44, 0.04), back).material(woodMat),
        }).setCollider({
          shape: 'box',
          size: [s, 0.95, s],
          offset: [0, 0.475, 0],
        });
      }
      case 'fridge': {
        const [w, h, d] = [0.68, 1.55, 0.66];
        const body = roundedBox({
          size: [w, h - 0.06, d],
          radius: 0.07,
          center: [0, 0.06 + (h - 0.06) / 2, 0],
        });
        const seam = box({ size: [w - 0.02, 0.012, 0.02], center: [0, 1.08, d / 2] });
        const handles = PolyMesh.merge(
          roundedBox({ size: [0.04, 0.28, 0.05], radius: 0.015, center: [w / 2 - 0.08, 1.28, d / 2 + 0.03] }),
          roundedBox({ size: [0.04, 0.24, 0.05], radius: 0.015, center: [w / 2 - 0.08, 0.86, d / 2 + 0.03] }),
        );
        const feet = legs(w - 0.08, d - 0.1, 0.06, 0.05);
        const grille = box({ size: [w - 0.16, 0.05, 0.01], center: [0, 0.12, d / 2] });
        return model({
          body: body.material({ color: tone('#dcd6c4', 1 - wear * 0.18), roughness: 0.45 }),
          trim: PolyMesh.merge(seam, grille).material({ color: '#3a3833', roughness: 0.7 }),
          handles: handles.material({ color: '#b8b6b0', metalness: 0.9, roughness: 0.35 }),
          feet: feet.material({ color: '#222222' }),
        })
          .setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] })
          .socket('door', [0, 1.25, d / 2 + 0.005]);
      }
      case 'counter':
      case 'sink_counter': {
        const [w, h, d] = [1.2, 0.9, 0.6];
        const u = drawerUnit(w, h - 0.04, d, kind === 'counter' ? 3 : 1, 2);
        let top = plank([w + 0.04, 0.04, d + 0.03], [0, h - 0.02, 0.01]);
        const parts: Record<string, PolyMesh> = {};
        if (kind === 'sink_counter') {
          const basin = roundedBox({ size: [0.5, 0.18, 0.38], radius: 0.05, center: [0, h - 0.07, 0.02] });
          top = top.subtract(box({ size: [0.46, 0.2, 0.34], center: [0, h - 0.06, 0.02] }));
          parts.sink = basin
            .subtract(box({ size: [0.44, 0.2, 0.32], center: [0, h + 0.02, 0.02] }))
            .material({ ...metal, roughness: 0.4 });
          parts.tap = PolyMesh.merge(
            cylinder({ radius: 0.018, height: 0.22, segments: 10, center: [0, h + 0.11, -0.2] }),
            cylinder({ radius: 0.014, height: 0.16, segments: 10, center: [0, h + 0.21, -0.13] }).rotate(
              [90, 0, 0],
              [0, h + 0.21, -0.13],
            ),
            cylinder({ radius: 0.03, height: 0.03, segments: 10, center: [0.08, h + 0.03, -0.2] }),
            cylinder({ radius: 0.03, height: 0.03, segments: 10, center: [-0.08, h + 0.03, -0.2] }),
          ).material({ color: '#a7a39a', metalness: 0.85, roughness: 0.4 });
        }
        return model({
          ...parts,
          body: PolyMesh.merge(u.body, top).material(woodMat),
          drawers: u.fronts.material(darkWood),
          handles: u.handles.material(metal),
        })
          .setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] })
          .socket('top', [0.3, h, 0]);
      }
      case 'wall_cabinet': {
        // Mirror cabinet (hang it on a wall; base at y = 0 so place its entity at ~1.25 m).
        const [w, h, d] = [0.5, 0.6, 0.14];
        const back = plank([w, h, d], [0, h / 2, 0]);
        const hollow = back.subtract(box({ size: [w - 0.04, h - 0.04, d], center: [0, h / 2, 0.02] }));
        const shelf = plank([w - 0.04, 0.015, d - 0.03], [0, h * 0.45, -0.005]);
        const ang = open * 105;
        const hinge: [number, number, number] = [-w / 2, 0, d / 2];
        const door = plank([w, h, 0.025], [0, h / 2, d / 2 + 0.012]).rotate([0, -ang, 0], hinge);
        const mirror = box({ size: [w - 0.06, h - 0.06, 0.004], center: [0, h / 2, d / 2 + 0.026] }).rotate(
          [0, -ang, 0],
          hinge,
        );
        return model({
          cabinet: PolyMesh.merge(hollow, shelf).material(woodMat),
          door: door.material(darkWood),
          mirror: mirror.material({ color: '#b9c3c6', metalness: 1, roughness: 0.12 + wear * 0.2 }),
        })
          .setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] })
          .socket('shelf', [0, h * 0.45 + 0.01, 0]);
      }
      case 'bathtub': {
        const tub = roundedBox({ size: [0.75, 0.55, 1.6], radius: 0.18, segments: 4, center: [0, 0.39, 0] });
        const inner = roundedBox({
          size: [0.63, 0.55, 1.48],
          radius: 0.16,
          segments: 4,
          center: [0, 0.52, 0],
        });
        const feet = PolyMesh.merge(
          ...[
            [-0.28, -0.6],
            [0.28, -0.6],
            [-0.28, 0.6],
            [0.28, 0.6],
          ].map(([x, z]) => sphere({ radius: 0.06, segments: 10, rings: 6, center: [x!, 0.06, z!] })),
        );
        return model({
          tub: tub.subtract(inner).material(porcelain),
          feet: feet.material({ color: '#6d5a3a', metalness: 0.8, roughness: 0.5 }),
        }).setCollider({ shape: 'box', size: [0.75, 0.66, 1.6], offset: [0, 0.33, 0] });
      }
      case 'basin': {
        const bowl = lathe(
          [
            [0.0, 0.62],
            [0.18, 0.64],
            [0.26, 0.78],
            [0.28, 0.84],
            [0.25, 0.85],
            [0.23, 0.8],
            [0.16, 0.68],
            [0.0, 0.67],
          ],
          { segments: 24 },
        );
        const pedestal = lathe(
          [
            [0.0, 0.0],
            [0.16, 0.0],
            [0.1, 0.08],
            [0.08, 0.5],
            [0.14, 0.64],
            [0.0, 0.64],
          ],
          { segments: 16 },
        );
        const tap = cylinder({ radius: 0.015, height: 0.12, segments: 8, center: [0, 0.9, -0.2] });
        return model({
          basin: PolyMesh.merge(bowl, pedestal).material(porcelain),
          tap: tap.material(metal),
        }).setCollider({
          shape: 'cylinder',
          size: [0.56, 0.86, 0.56],
          offset: [0, 0.43, 0],
        });
      }
      case 'toilet': {
        const bowl = lathe(
          [
            [0.0, 0.0],
            [0.14, 0.0],
            [0.13, 0.2],
            [0.2, 0.38],
            [0.0, 0.4],
          ],
          { segments: 20 },
        ).scale([1, 1, 1.3]);
        const tank = roundedBox({ size: [0.42, 0.4, 0.18], radius: 0.03, center: [0, 0.62, -0.26] });
        const seat = cylinder({ radius: 0.21, height: 0.03, segments: 20, center: [0, 0.41, 0.02] }).scale([
          1, 1, 1.25,
        ]);
        return model({
          toilet: PolyMesh.merge(bowl, tank).material(porcelain),
          seat: seat.material(darkWood),
        }).setCollider({
          shape: 'box',
          size: [0.45, 0.82, 0.7],
          offset: [0, 0.41, -0.05],
        });
      }
      case 'shelf': {
        const [w, h, d] = [0.9, 1.6, 0.32];
        const sides = PolyMesh.merge(
          plank([0.03, h, d], [-w / 2, h / 2, 0]),
          plank([0.03, h, d], [w / 2, h / 2, 0]),
        );
        const boards = PolyMesh.merge(
          ...[0.05, 0.45, 0.85, 1.25, 1.58].map((y) => plank([w, 0.025, d], [0, y, 0])),
        );
        return model({
          shelf: PolyMesh.merge(sides, boards, plank([w, h, 0.01], [0, h / 2, -d / 2])).material(woodMat),
        })
          .setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] })
          .socket('shelf_1', [0, 0.47, 0])
          .socket('shelf_2', [0, 0.87, 0])
          .socket('shelf_3', [0, 1.27, 0]);
      }
      case 'crate': {
        const s = 0.5;
        const slats: PolyMesh[] = [];
        for (const y of [0.06, 0.19, 0.32, 0.45]) {
          slats.push(
            plank([s, 0.1, 0.02], [0, y, s / 2 - 0.01]),
            plank([s, 0.1, 0.02], [0, y, -s / 2 + 0.01]),
          );
          slats.push(
            plank([0.02, 0.1, s], [s / 2 - 0.01, y, 0]),
            plank([0.02, 0.1, s], [-s / 2 + 0.01, y, 0]),
          );
        }
        slats.push(plank([s, 0.02, s], [0, 0.01, 0]));
        return model({ crate: PolyMesh.merge(...slats).material(woodMat) }).setCollider({
          shape: 'box',
          size: [s, s, s],
          offset: [0, s / 2, 0],
        });
      }
      case 'coat_rack': {
        // Wall board with three hooks and three old coats.
        const board = plank([0.9, 0.12, 0.03], [0, 1.65, 0]);
        const hooks = PolyMesh.merge(
          ...[-0.3, 0, 0.3].map((x) =>
            cylinder({ radius: 0.012, height: 0.1, segments: 8, center: [x, 1.63, 0.06] }).rotate(
              [70, 0, 0],
              [x, 1.63, 0.03],
            ),
          ),
        );
        const coats = [-0.3, 0, 0.3].map((x, i) =>
          sdf
            .capsule([x, 1.55, 0.09], [x + rng.range(-0.02, 0.02), 0.75 + i * 0.05, 0.1], 0.13 + i * 0.015)
            .union(sdf.sphere([x, 1.52, 0.1], 0.16), 0.08)
            .scale([1, 1, 0.55])
            .displace((q) => Math.sin(q[1] * 18 + x * 7) * 0.012)
            .mesh({ detail: 'low' })
            .material({ color: ['#4a4038', '#3c4148', '#5a3e3a'][i]!, roughness: 1 }),
        );
        return model({
          board: PolyMesh.merge(board).material(woodMat),
          hooks: hooks.material(metal),
          coat_small: coats[0]!,
          coat_mid: coats[1]!,
          coat_big: coats[2]!,
        }).setCollider({
          shape: 'box',
          size: [0.9, 1, 0.3],
          offset: [0, 1.2, 0.12],
        });
      }
      case 'toy_chest': {
        const [w, h, d] = [0.7, 0.42, 0.42];
        const body = plank([w, h, d], [0, h / 2, 0]);
        const lid = plank([w + 0.02, 0.04, d + 0.02], [0, h + 0.02, 0]).rotate(
          [-open * 70, 0, 0],
          [0, h, -d / 2],
        );
        const bands = PolyMesh.merge(
          plank([0.03, h, d + 0.01], [-w * 0.3, h / 2, 0]),
          plank([0.03, h, d + 0.01], [w * 0.3, h / 2, 0]),
        );
        return model({
          body: body.material({ color: '#5d6f84', roughness: 0.9 }),
          lid: lid.material({ color: '#6a7d93', roughness: 0.9 }),
          bands: bands.material(darkWood),
        }).setCollider({
          shape: 'box',
          size: [w, h + 0.04, d],
          offset: [0, (h + 0.04) / 2, 0],
        });
      }
      case 'wardrobe': {
        const [w, h, d] = [1, 1.95, 0.55];
        const body = plank([w, h - 0.06, d - 0.02], [0, 0.06 + (h - 0.06) / 2, -0.01]);
        const doorL = plank([w / 2 - 0.015, h - 0.12, 0.03], [-w / 4, h / 2 + 0.03, d / 2]).rotate(
          [0, -open * 95, 0],
          [-w / 2, 0, d / 2],
        );
        const doorR = plank([w / 2 - 0.015, h - 0.12, 0.03], [w / 4, h / 2 + 0.03, d / 2]);
        const crown = plank([w + 0.06, 0.06, d + 0.04], [0, h + 0.03, 0]);
        return model({
          body: PolyMesh.merge(body, crown, legs(w, d, 0.06, 0.06)).material(woodMat),
          doors: PolyMesh.merge(doorL, doorR).material(darkWood),
          handles: PolyMesh.merge(
            handle(-0.06, 1.0, d / 2 + 0.02).rotate([0, 0, 90], [-0.06, 1, 0]),
            handle(0.06, 1.0, d / 2 + 0.02).rotate([0, 0, 90], [0.06, 1, 0]),
          ).material(metal),
        }).setCollider({ shape: 'box', size: [w, h, d], offset: [0, h / 2, 0] });
      }
    }
  },
});
