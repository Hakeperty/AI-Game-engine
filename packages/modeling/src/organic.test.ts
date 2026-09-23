import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  buildRecipe,
  curves,
  eye,
  icosphere,
  initModeling,
  type PolyMesh,
  plants,
  repairManifold,
  sdf,
  smoothMesh,
  terrain,
  terrainHeight,
  validateMesh,
  validateModel,
} from './index.ts';

beforeAll(async () => {
  await initModeling();
});

const closed = (m: PolyMesh, label = '') => {
  const r = validateMesh(m);
  expect(r.nonManifoldEdges, `${label} non-manifold`).toBe(0);
  expect(r.boundaryEdges, `${label} open edges`).toBe(0);
  expect(r.flippedEdges, `${label} flipped`).toBe(0);
  expect(r.watertight, label).toBe(true);
  expect(r.volume, `${label} volume`).toBeGreaterThan(0);
  return r;
};

const within = (m: PolyMesh, b: { min: number[]; max: number[] }, tol: number) => {
  const mb = m.bounds();
  for (let a = 0; a < 3; a++) {
    expect(mb.min[a]!).toBeGreaterThanOrEqual(b.min[a]! - tol);
    expect(mb.max[a]!).toBeLessThanOrEqual(b.max[a]! + tol);
  }
};

describe('SDF meshing', () => {
  it('produces watertight, manifold output for smooth and hard booleans', () => {
    const shapes = {
      smoothUnion: sdf.sphere(0.5).smoothUnion(sdf.sphere(0.3, [0.5, 0.2, 0]), 0.15),
      hardUnion: sdf.box(0.8).union(sdf.sphere(0.3, [0.4, 0.4, 0.4])),
      smoothSubtract: sdf.sphere(0.5).smoothSubtract(sdf.sphere(0.3, [0.35, 0, 0]), 0.05),
      onionCut: sdf.sphere(0.5).onion(0.06).cutAbove(0.2),
      twist: sdf.box([0.3, 1, 0.3], [0, 0.5, 0], 0.03).twist(180),
      bend: sdf.capsule([0, 0, 0], [0, 1, 0], 0.1).bend(90),
      warp: sdf.sphere(0.5).warp(0.1, 3, 2),
      elongate: sdf.sphere(0.3).elongate([0.3, 0, 0]),
      displaceBy: sdf.cylinder(0.2, 1).displaceBy(([x, , z]) => 0.01 * Math.cos(12 * Math.atan2(z, x)), 0.01),
    };
    for (const [name, s] of Object.entries(shapes)) {
      for (const detail of ['low', 'medium'] as const) closed(s.mesh({ detail }), `${name}/${detail}`);
    }
  });

  it('smoothSubtract carves (inside the cutter is outside the result)', () => {
    const s = sdf.sphere(0.5).smoothSubtract(sdf.sphere(0.25, [0.5, 0, 0]), 0.05);
    expect(s.distance([0.45, 0, 0])).toBeGreaterThan(0);
    expect(s.distance([-0.3, 0, 0])).toBeLessThan(0);
    const full = validateMesh(sdf.sphere(0.5).mesh()).volume;
    expect(closed(s.mesh()).volume).toBeLessThan(full * 0.97);
  });

  it('blob-character and creature templates mesh watertight', async () => {
    for (const name of ['blob-character', 'creature', 'slime']) {
      const mod = await import(join(import.meta.dirname, '..', 'templates', `${name}.model.ts`));
      const report = validateModel(buildRecipe(mod.default, {}));
      for (const part of report.parts) {
        expect(part.report.nonManifoldEdges, `${name}/${part.name}`).toBe(0);
        expect(part.report.watertight, `${name}/${part.name}`).toBe(true);
      }
    }
  });

  it('meshes a 20-primitive creature at medium detail quickly', () => {
    const parts = [sdf.ellipsoid([0.5, 0.4, 0.7], [0, 0.8, 0])];
    for (const x of [-0.3, 0.3])
      for (const z of [-0.4, 0.4]) {
        parts.push(
          sdf.chain(
            [
              [x, 0.7, z],
              [x, 0.35, z + 0.05],
              [x, 0.08, z],
            ],
            [0.13, 0.1, 0.09],
          ),
        );
        parts.push(sdf.ellipsoid([0.11, 0.07, 0.15], [x, 0.07, z + 0.05]));
        parts.push(sdf.sphere(0.12, [x, 0.5, z]));
      }
    parts.push(sdf.sphere(0.35, [0, 1.15, 0.75]), sdf.roundCone([0, 0.9, -0.6], [0, 1.1, -1.1], 0.08, 0.03));
    parts.push(
      sdf.capsule([0.15, 1.35, 0.7], [0.25, 1.65, 0.65], 0.07),
      sdf.capsule([-0.15, 1.35, 0.7], [-0.25, 1.65, 0.65], 0.07),
    );
    parts.push(
      sdf.sphere(0.08, [0.14, 1.22, 1.03]),
      sdf.sphere(0.08, [-0.14, 1.22, 1.03]),
      sdf.sphere(0.06, [0, 1.12, 1.08]),
    );
    expect(parts.length).toBeGreaterThanOrEqual(20);
    const shape = sdf.smoothUnionAll(parts, 0.08).color('#c86a2a').colorByNormal('#f5e3c0', '-y');
    const t0 = performance.now();
    const m = shape.mesh({ detail: 'medium', ao: true });
    const ms = performance.now() - t0;
    closed(m, 'creature');
    expect(ms).toBeLessThan(1500);
  });

  it('decimates, keeps the mesh closed and bakes AO / colors', () => {
    const m = sdf.sphere(0.5).color('#ff0000').mesh({ detail: 'high', decimate: 3000, ao: true });
    const r = closed(m, 'decimated');
    expect(r.triangles).toBeLessThanOrEqual(3000);
    expect(r.triangles).toBeGreaterThan(2500);
    expect(m.f[0]!.c).not.toBeNull();
    expect(r.volume).toBeCloseTo((4 / 3) * Math.PI * 0.125, 1);
  });

  it('SDF color helpers paint vertices', () => {
    const m = sdf
      .sphere(0.4)
      .color('#ff0000')
      .colorByNormal('#0000ff', '-y', 0.5, 0.2)
      .mesh({ colorSmooth: 0 });
    const bottom = m.f.find((f) => f.v.every((v) => m.p[v]![1] < -0.38))!;
    const top = m.f.find((f) => f.v.every((v) => m.p[v]![1] > 0.38))!;
    expect(bottom.c![0]![2]).toBeGreaterThan(0.9);
    expect(top.c![0]![0]).toBeGreaterThan(0.9);
    const spotted = sdf.sphere(0.4).color('#ffffff').colorSpots('#000000', { scale: 8, size: 0.4 }).mesh();
    const dark = spotted.f.filter((f) => f.c![0]![0] < 0.3).length;
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(spotted.f.length);
    const striped = sdf.sphere(0.4).stripes(['#ff0000', '#00ff00'], { width: 0.1 }).mesh();
    expect(new Set(striped.f.map((f) => (f.c![0]![0] > 0.5 ? 'r' : 'g'))).size).toBe(2);
  });
});

describe('organic SDF shapes', () => {
  it('chain follows its points and bounds contain the mesh', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [0.3, 0.5, 0.1],
      [0, 1, 0.3],
      [-0.2, 1.3, 0.2],
    ];
    const s = sdf.chain(pts, (t) => 0.12 - 0.08 * t);
    const m = s.mesh();
    closed(m, 'chain');
    within(m, s.bounds, 0.01);
    for (const p of pts) expect(s.distance(p)).toBeLessThan(0);
    expect(s.distance([0, 0, 0])).toBeCloseTo(-0.12, 2);
    expect(s.distance([2, 2, 2])).toBeGreaterThan(1);
    const poly = sdf.chain(pts, [0.1, 0.08, 0.06, 0.04], { curve: false, smooth: 0.05 });
    closed(poly.mesh(), 'polyline chain');
    within(poly.mesh(), poly.bounds, 0.01);
  });

  it('roundCone and tube are exact-ish and closed', () => {
    const rc = sdf.roundCone([0, 0, 0], [0, 1, 0], 0.3, 0.05);
    expect(rc.distance([0, -0.3, 0])).toBeCloseTo(0, 5);
    expect(rc.distance([0, 1.05, 0])).toBeCloseTo(0, 5);
    closed(rc.mesh(), 'roundCone');
    const t = sdf.tube(curves.helix(0.4, 1, 2, 48), 0.06);
    const m = t.mesh({ detail: 'high' });
    closed(m, 'tube');
    within(m, t.bounds, 0.01);
  });

  it('metaballs merge, carry colors and stay inside their bounds', () => {
    const balls = sdf.metaballs([
      { center: [0, 0.3, 0], radius: 0.3, color: '#ff0000' },
      { center: [0.4, 0.3, 0], radius: 0.25, color: '#0000ff' },
    ]);
    const lone = sdf.metaballs([{ center: [0, 0, 0], radius: 0.3 }]);
    expect(lone.distance([0.3, 0, 0])).toBeCloseTo(0, 3);
    expect(balls.distance([0.2, 0.3, 0])).toBeLessThan(0); // the bridge between them is solid
    const m = balls.mesh();
    closed(m, 'metaballs');
    within(m, balls.bounds, 0.01);
    const cols = m.f.map((f) => f.c![0]!);
    expect(cols.some((c) => c[0] > 0.8)).toBe(true);
    expect(cols.some((c) => c[2] > 0.8)).toBe(true);
  });

  it('domain operators keep correct bounds', () => {
    const base = sdf.box([0.2, 1, 0.3], [0.1, 0.5, 0], 0.02);
    for (const s of [
      base.twist(120),
      base.bend(80),
      base.warp(0.08, 3),
      base.elongate([0.2, 0, 0.1]),
      base.mirror('x'),
    ]) {
      within(s.mesh({ detail: 'low' }), s.bounds, 0.01);
    }
    const cut = sdf.sphere(0.5).cutBelow(0, 0.03);
    expect(cut.mesh().bounds().min[1]).toBeGreaterThan(-0.01);
    expect(cut.bounds.min[1]).toBe(0);
  });
});

describe('mesh organic ops', () => {
  it('smoothMesh removes noise but keeps the volume within 3%', () => {
    const bumpy = icosphere({ radius: 1, detail: 4 }).displace({ amount: 0.08, scale: 4, seed: 3 });
    const v0 = validateMesh(bumpy).volume;
    const smooth = smoothMesh(bumpy, { iterations: 8 });
    const v1 = closed(smooth).volume;
    expect(Math.abs(v1 - v0) / v0).toBeLessThan(0.03);
    const roughness = (m: PolyMesh) => {
      const r = m.p.map((p) => Math.hypot(p[0], p[1], p[2]));
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      return r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
    };
    expect(roughness(smooth)).toBeLessThan(roughness(bumpy) * 0.8);
    // meshes with seams (duplicated vertices) do not tear
    const cube = box({ size: 1 }).subdivide(2).smoothMesh({ iterations: 3 });
    expect(validateMesh(cube).watertight).toBe(true);
  });

  it('decimate reduces triangles and stays closed', () => {
    const dense = icosphere({ radius: 1, detail: 5 });
    const out = dense.decimate(0.1);
    const r = closed(out, 'decimate');
    expect(r.triangles).toBeLessThanOrEqual(Math.ceil(dense.triangleCount * 0.1) + 2);
    expect(r.volume).toBeGreaterThan(4.0);
    expect(dense.decimate(500).triangleCount).toBeLessThanOrEqual(500);
  });

  it('brush modes move the right vertices', () => {
    const ball = icosphere({ radius: 1, detail: 4 });
    const v0 = validateMesh(ball).volume;
    const inflated = ball.brush({ center: [0, 1, 0], radius: 0.5, mode: 'inflate', strength: 0.1 });
    expect(validateMesh(inflated).volume).toBeGreaterThan(v0);
    expect(inflated.bounds().max[1]).toBeCloseTo(1.1, 2);
    expect(inflated.bounds().min[1]).toBeCloseTo(-1, 5); // far side untouched
    const grabbed = ball.brush({ center: [1, 0, 0], radius: 0.4, mode: 'grab', direction: [0.3, 0, 0] });
    expect(grabbed.bounds().max[0]).toBeCloseTo(1.3, 2);
    const flat = ball.brush({ center: [0, 1, 0], radius: 0.6, mode: 'flatten', strength: 1 });
    expect(flat.bounds().max[1]).toBeLessThan(0.99);
    const pinched = ball.brush({ center: [0, 0, 1], radius: 0.5, mode: 'pinch', strength: 0.5 });
    expect(pinched.p.some((p, i) => p[0] !== ball.p[i]![0])).toBe(true);
    const noisy = ball.brush({ center: [0, 0, 1], radius: 0.5, mode: 'noise', strength: 0.05, seed: 2 });
    const smoothed = noisy.brush({ center: [0, 0, 1], radius: 0.6, mode: 'smooth', strength: 1 });
    for (const m of [inflated, grabbed, flat, pinched, noisy, smoothed]) closed(m, 'brush');
    expect(ball.brush({ center: [5, 5, 5], radius: 0.1, mode: 'inflate' }).p).toEqual(ball.p);
  });

  it('bakeAO darkens creases more than exposed surfaces', () => {
    const m = box({ size: [2, 0.2, 2] })
      .subdivide(2, { smooth: false })
      .union(box({ size: [0.4, 1, 0.4], center: [0, 0.5, 0] }))
      .bakeAO({ strength: 1 });
    const shade = (pred: (p: [number, number, number]) => boolean) => {
      const vals: number[] = [];
      for (const f of m.f)
        for (let k = 0; k < f.v.length; k++) if (pred(m.p[f.v[k]!]!)) vals.push(f.c![k]![0]);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const nearPillar = shade((p) => Math.abs(p[1] - 0.1) < 1e-3 && Math.hypot(p[0], p[2]) < 0.45);
    const corner = shade((p) => Math.abs(p[1] - 0.1) < 1e-3 && Math.hypot(p[0], p[2]) > 1.2);
    expect(nearPillar).toBeLessThan(corner);
  });

  it('repairManifold splits edges shared by four faces', () => {
    // two tetrahedra sharing one edge (a classic non-manifold "bowtie")
    const a = icosphere({ radius: 0.3, detail: 0 }).translate([0.3, 0, 0]);
    const t1 = box({ size: 0.5, center: [0.25, 0.25, 0.25] });
    const t2 = box({ size: 0.5, center: [-0.25, -0.25, 0.25] });
    const bow = t1.merge(t2).weld(1e-6);
    expect(validateMesh(bow).nonManifoldEdges).toBeGreaterThan(0);
    const fixed = repairManifold(bow);
    expect(validateMesh(fixed).nonManifoldEdges).toBe(0);
    expect(validateMesh(fixed).watertight).toBe(true);
    expect(validateMesh(a).watertight).toBe(true);
  });
});

describe('generators', () => {
  it('terrain has the requested size, resolution and a closed slab variant', () => {
    const t = terrain({ size: [20, 10], resolution: 40, height: 3, seed: 2 });
    const b = t.bounds();
    expect(b.size[0]).toBeCloseTo(20, 6);
    expect(b.size[2]).toBeCloseTo(10, 6);
    expect(b.max[1]).toBeLessThanOrEqual(3 + 1e-6);
    expect(t.vertexCount).toBe(41 * 21);
    expect(t.faceCount).toBe(40 * 20);
    expect(t.f.every((f) => f.uv && f.c)).toBe(true);
    const r = validateMesh(t);
    expect(r.boundaryEdges).toBe(2 * (40 + 20));
    const h = terrainHeight({ size: [20, 10], resolution: 40, height: 3, seed: 2 });
    expect(t.p[0]![1]).toBeCloseTo(h(-10, -5), 9);
    const slab = terrain({ size: 12, height: 2, slab: 1, island: true, seed: 5 });
    closed(slab, 'slab');
    expect(slab.groups().sort()).toEqual(['bottom', 'side', 'top']);
    // island: the rim is under water, the middle is land
    const ih = terrainHeight({ size: 12, height: 2, island: true, seed: 5 });
    expect(ih(5.9, 5.9)).toBeLessThan(0);
    expect(Math.max(ih(0, 0), ih(1, 1), ih(-1, 0.5))).toBeGreaterThan(0);
    // custom height function
    const bowl = terrain({ size: 4, resolution: 8, height: (x, z) => x * x + z * z, colors: false });
    expect(bowl.bounds().max[1]).toBeCloseTo(8, 6);
    expect(bowl.f[0]!.c).toBeNull();
  });

  it('plants are seeded, closed and deterministic', () => {
    const a = plants.tree({ seed: 4, foliage: 'blobs' });
    const b = plants.tree({ seed: 4, foliage: 'blobs' });
    expect(a.wood.p).toEqual(b.wood.p);
    expect(plants.tree({ seed: 5, foliage: 'blobs' }).wood.p).not.toEqual(a.wood.p);
    expect(validateMesh(a.wood).watertight).toBe(true);
    expect(validateMesh(a.leaves).watertight).toBe(true);
    const skeleton = plants.branches({ levels: 2, children: 3, seed: 1 });
    expect(skeleton.length).toBe(1 + 3 + 9);
    expect(skeleton.filter((s) => s.tip).length).toBe(9);
    closed(plants.leaf({ shape: 'round' }), 'leaf');
    const cloud = plants.tree({ seed: 2, levels: 2, foliage: 'cloud' });
    closed(cloud.leaves, 'cloud canopy');
  });

  it('eye() is a closed mesh looking along +Z', () => {
    const e = eye({ radius: 0.1, iris: '#3366ff' });
    expect(validateMesh(e).watertight).toBe(true);
    const b = e.bounds();
    expect(b.max[2]).toBeGreaterThan(0.1);
    expect(b.min[2]).toBeCloseTo(-0.1, 2);
  });
});

describe('docs example', () => {
  it('the MODELING docs creature example builds watertight', async () => {
    const docs = readFileSync(join(import.meta.dirname, '..', '..', 'host', 'src', 'docs.ts'), 'utf8');
    const m = /\\`\\`\\`ts\r?\n(\/\/ models\/critter\.model\.ts[\s\S]*?)\\`\\`\\`/.exec(docs);
    expect(m, 'critter example present in docs').not.toBeNull();
    const source = m![1]!.replace(/\r/g, '');
    const { buildRecipe: build, ...api } = await import('./index.ts');
    const body = source.replace(/^import[^;]+;\n/m, '').replace('export default ', 'return ');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const recipe = new Function(...Object.keys(api), body)(...Object.values(api));
    const report = validateModel(build(recipe, {}));
    for (const part of report.parts) expect(part.report.watertight, part.name).toBe(true);
    expect(report.triangles).toBeLessThan(30_000);
  });
});
