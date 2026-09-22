import { beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  buildRecipe,
  capsule,
  cone,
  curves,
  cylinder,
  decodePng,
  defineModel,
  encodePng,
  exportGlb,
  extrudeShape,
  icosphere,
  importGlb,
  initModeling,
  lathe,
  model,
  p,
  plane,
  proceduralTexture,
  roundedBox,
  sdf,
  shapes,
  sphere,
  toMeshData,
  torus,
  tube,
  validateMesh,
  validateModel,
} from './index.ts';

beforeAll(async () => {
  await initModeling();
});

const euler = (m: { vertexCount: number; faceCount: number }, edges: number) =>
  m.vertexCount - edges + m.faceCount;
function edgeCount(m: ReturnType<typeof box>): number {
  const set = new Set<string>();
  for (const f of m.f)
    for (let k = 0; k < f.v.length; k++) {
      const a = f.v[k]!;
      const b = f.v[(k + 1) % f.v.length]!;
      set.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  return set.size;
}

describe('primitives', () => {
  it('box is a watertight unit cube with named faces', () => {
    const b = box({ size: [2, 1, 3] });
    const r = validateMesh(b);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(6, 6);
    expect(euler(b, edgeCount(b))).toBe(2);
    expect(b.groups().sort()).toEqual(['back', 'bottom', 'front', 'left', 'right', 'top']);
    expect(b.select('top').map((i) => b.faceNormal(i))).toEqual([[0, 1, 0]]);
  });

  it.each([
    ['sphere', () => sphere({ radius: 1, segments: 48, rings: 24 }), (4 / 3) * Math.PI],
    ['icosphere', () => icosphere({ radius: 1, detail: 3 }), (4 / 3) * Math.PI],
    ['cylinder', () => cylinder({ radius: 1, height: 2, segments: 64 }), 2 * Math.PI],
    ['cone', () => cone({ radius: 1, height: 3, segments: 64 }), Math.PI],
    [
      'torus',
      () => torus({ radius: 1, tube: 0.25, segments: 64, tubeSegments: 32 }),
      2 * Math.PI * Math.PI * 1 * 0.0625,
    ],
    [
      'capsule',
      () => capsule({ radius: 0.5, height: 2, segments: 48, rings: 16 }),
      Math.PI * 0.25 * 1 + (4 / 3) * Math.PI * 0.125,
    ],
    ['roundedBox', () => roundedBox({ size: 1, radius: 0.1, segments: 4 }), 1 - 0.0172],
    ['chamferBox', () => roundedBox({ size: 1, radius: 0.1, segments: 1 }), 1 - 0.0233],
  ])('%s is watertight, outward-facing and has the right volume', (_, make, volume) => {
    const m = make();
    const r = validateMesh(m);
    expect(r.issues).toEqual([]);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeGreaterThan(0);
    expect(r.volume).toBeCloseTo(volume, 1);
  });

  it('plane is an open surface facing up', () => {
    const r = validateMesh(plane({ size: [4, 2], segments: [4, 2] }));
    expect(r.watertight).toBe(false);
    expect(r.faces).toBe(8);
  });

  it('lathe builds a closed vase from a profile', () => {
    const vase = lathe(
      [
        [0, 0],
        [0.4, 0],
        [0.5, 0.3],
        [0.25, 0.8],
        [0.3, 1],
        [0, 1],
      ],
      { segments: 32 },
    );
    const r = validateMesh(vase);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeGreaterThan(0);
  });

  it('extrudeShape builds a watertight star with a chamfer', () => {
    const star = extrudeShape(shapes.star(5, 1, 0.45), { depth: 0.3, bevel: 0.05 });
    const r = validateMesh(star);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeGreaterThan(0);
    expect(star.bounds().size[1]).toBeCloseTo(0.3, 6);
  });

  it('tube sweeps along a curve', () => {
    const t = tube(curves.helix(0.5, 2, 2, 64), 0.08, { segments: 10 });
    const r = validateMesh(t);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeGreaterThan(0);
  });
});

describe('operations', () => {
  it('extrude keeps the mesh closed and grows the volume', () => {
    const m = box().extrude('top', 0.5);
    const r = validateMesh(m);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(1.5, 6);
    expect(m.bounds().max[1]).toBeCloseTo(1, 6);
  });

  it('inset + negative extrude makes a recessed panel', () => {
    const m = box().inset('front', 0.1).extrude('front', -0.2);
    const r = validateMesh(m);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(1 - 0.8 * 0.8 * 0.2, 5);
  });

  it('subdivide rounds a box towards a sphere and stays closed', () => {
    const m = box().subdivide(3);
    const r = validateMesh(m);
    expect(r.watertight).toBe(true);
    expect(r.faces).toBe(6 * 4 ** 3);
    expect(r.volume).toBeGreaterThan(0.3);
    expect(r.volume).toBeLessThan(1);
  });

  it('mirror welds the seam', () => {
    const half = box({ size: [1, 1, 1], center: [0.5, 0, 0] });
    const m = half.mirror('x');
    expect(m.bounds().size[0]).toBeCloseTo(2, 6);
  });

  it('displace is deterministic for a seed', () => {
    const a = icosphere({ detail: 3 }).displace({ amount: 0.1, seed: 4 });
    const b = icosphere({ detail: 3 }).displace({ amount: 0.1, seed: 4 });
    expect(a.p).toEqual(b.p);
    expect(validateMesh(a).watertight).toBe(true);
  });

  it('colors and materials carry through to mesh data', () => {
    const m = box()
      .color('#ff0000')
      .color('#00ff00', 'top')
      .material({ color: '#ffffff', roughness: 0.3 })
      .material({ color: '#ffcc00', metalness: 1 }, 'front');
    const data = toMeshData(m);
    expect(data.parts[0]!.primitives).toHaveLength(2);
    expect(data.parts[0]!.primitives[0]!.colors).not.toBeNull();
    expect(data.triangleCount).toBe(12);
    // flat box: every face has its own 4 vertices
    expect(data.vertexCount).toBe(24);
  });
});

describe('booleans', () => {
  it('subtract produces a manifold result with the expected volume', () => {
    const result = box({ size: 2 }).subtract(cylinder({ radius: 0.5, height: 3, segments: 64 }));
    const r = validateMesh(result);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(8 - Math.PI * 0.25 * 2, 1);
    expect(result.groups()).toContain('cut');
  });

  it('union and intersect', () => {
    const a = box({ size: 1 });
    const b = box({ size: 1, center: [0.5, 0, 0] });
    expect(validateMesh(a.union(b)).volume).toBeCloseTo(1.5, 5);
    expect(validateMesh(a.intersect(b)).volume).toBeCloseTo(0.5, 5);
  });

  it('keeps per-input materials', () => {
    const a = box({ size: 1 }).material({ color: '#ff0000' });
    const b = sphere({ radius: 0.6 }).material({ color: '#0000ff' });
    const u = a.union(b);
    expect(u.materials.map((m) => m.color).sort()).toEqual(['#0000ff', '#ff0000']);
  });

  it('rejects open meshes with a helpful message', () => {
    expect(() => plane().union(box())).toThrow(/not a closed solid/);
  });
});

describe('sdf', () => {
  it('meshes a smooth union into a closed, correctly oriented surface', () => {
    const blob = sdf
      .sphere(0.5)
      .color('#6cc24a')
      .smoothUnion(sdf.sphere(0.35, [0, 0.6, 0]).color('#ffffff'), 0.2)
      .mesh({ resolution: 40 });
    const r = validateMesh(blob);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeGreaterThan((4 / 3) * Math.PI * 0.125 * 0.9);
    expect(blob.f[0]!.c).not.toBeNull();
  });

  it('sphere volume converges', () => {
    const m = sdf.sphere(1).mesh({ resolution: 64 });
    expect(validateMesh(m).volume).toBeCloseTo((4 / 3) * Math.PI, 1);
  });
});

describe('recipes and glTF', () => {
  const coin = defineModel({
    name: 'coin',
    params: { radius: p.number(0.5, { min: 0.1, max: 2 }), color: p.color('#ffc107') },
    build: ({ radius, color }) =>
      model({
        body: cylinder({ radius, height: 0.12, segments: 32 })
          .rotate([90, 0, 0])
          .material({ color, metalness: 1, roughness: 0.3 }),
      })
        .socket('top', [0, radius, 0])
        .setCollider({ shape: 'cylinder', radius, height: 0.12 }),
  });

  it('builds with defaults, overrides and clamping', () => {
    const m = buildRecipe(coin, { radius: 5 });
    expect(m.bounds().size[0]).toBeCloseTo(4, 5);
    expect(() => buildRecipe(coin, { size: 1 })).toThrow(/Unknown parameter 'size'/);
    expect(() => buildRecipe(coin, { color: 'gold' })).toThrow(/must be a color/);
  });

  it('round-trips through GLB', async () => {
    const m = buildRecipe(coin, {});
    const glb = await exportGlb(m);
    expect(glb.byteLength).toBeGreaterThan(1000);
    const back = await importGlb(glb);
    expect(back.parts).toHaveLength(1);
    expect(back.parts[0]!.mesh.materials[0]!.color).toBe('#ffc107');
    expect(back.sockets.top?.position[1]).toBeCloseTo(0.5, 5);
    expect(back.collider?.shape).toBe('cylinder');
    const report = validateModel(back);
    expect(report.parts[0]!.report.watertight).toBe(true);
    expect(report.bounds.size[0]).toBeCloseTo(1, 4);
  });

  it('encodes and decodes PNG textures', () => {
    const img = proceduralTexture({ kind: 'checker', size: 32, colorA: '#ff0000', colorB: '#0000ff' });
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(32);
    expect(Array.from(back.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });
});
