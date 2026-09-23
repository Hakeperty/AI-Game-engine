import type { ManifoldToplevel } from 'manifold-3d';
import Module from 'manifold-3d';
import { DEFAULT_MATERIAL, type MaterialSpec, materialKey } from './material.ts';
import type { RGB, V2, V3 } from './math.ts';
import { initDecimator } from './ops/organic.ts';
import { PolyMesh } from './polymesh.ts';

type Wasm = ManifoldToplevel;
type ManifoldObj = InstanceType<Wasm['Manifold']>;

let wasm: Wasm | null = null;
let loading: Promise<Wasm> | null = null;

/** Loads the WASM modules (manifold-3d booleans, meshoptimizer decimation). Call once (await) before using booleans, hull or decimate. */
export async function initModeling(): Promise<void> {
  await initDecimator();
  if (wasm) return;
  loading ??= (async () => {
    const m = await Module();
    m.setup();
    wasm = m;
    return m;
  })();
  await loading;
}

export function modelingReady(): boolean {
  return wasm !== null;
}

function need(): Wasm {
  if (!wasm) throw new Error('Booleans need the geometry engine: call `await initModeling()` first.');
  return wasm;
}

const NUM_PROP = 8; // x y z u v r g b

interface Source {
  id0: number;
  materials: MaterialSpec[];
  tag: string;
}

function toManifold(mesh: PolyMesh, tag: string): { man: ManifoldObj; src: Source } {
  const w = need();
  const tri = mesh.triangulate();
  const matCount = Math.max(1, tri.materials.length);
  const id0 = w.Manifold.reserveIDs(matCount);
  const props: number[] = [];
  const keyToIndex = new Map<string, number>();
  const byMat: number[][] = Array.from({ length: matCount }, () => []);
  for (const f of tri.f) {
    const corners: number[] = [];
    for (let k = 0; k < 3; k++) {
      const p = tri.p[f.v[k]!]!;
      const uv: V2 = f.uv?.[k] ?? [0, 0];
      const c: RGB = f.c?.[k] ?? [1, 1, 1];
      const key = `${f.v[k]}|${uv[0].toFixed(5)},${uv[1].toFixed(5)}|${c[0].toFixed(4)},${c[1].toFixed(4)},${c[2].toFixed(4)}`;
      let idx = keyToIndex.get(key);
      if (idx === undefined) {
        idx = props.length / NUM_PROP;
        props.push(p[0], p[1], p[2], uv[0], uv[1], c[0], c[1], c[2]);
        keyToIndex.set(key, idx);
      }
      corners.push(idx);
    }
    byMat[Math.min(f.m, matCount - 1)]!.push(...corners);
  }
  const triVerts: number[] = [];
  const runIndex: number[] = [];
  const runOriginalID: number[] = [];
  byMat.forEach((list, i) => {
    if (list.length === 0) return;
    runIndex.push(triVerts.length);
    runOriginalID.push(id0 + i);
    triVerts.push(...list);
  });
  runIndex.push(triVerts.length);
  const gl = new w.Mesh({
    numProp: NUM_PROP,
    vertProperties: new Float32Array(props),
    triVerts: new Uint32Array(triVerts),
    runIndex: new Uint32Array(runIndex),
    runOriginalID: new Uint32Array(runOriginalID),
  });
  gl.merge();
  const fail = (why: string) =>
    new Error(
      `Boolean input '${tag}' is not a closed solid (${why}). Booleans need watertight meshes: use box, sphere, cylinder, extrudeShape or lathe with closed ends, not planes or open shapes. Check with mesh.validate().`,
    );
  let man: ManifoldObj;
  try {
    man = new w.Manifold(gl);
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
  const status = man.status();
  if (status !== 'NoError') {
    man.delete();
    throw fail(String(status));
  }
  return { man, src: { id0, materials: tri.materials, tag } };
}

function fromManifold(man: ManifoldObj, sources: Source[]): PolyMesh {
  const gl = man.getMesh();
  const out = new PolyMesh();
  out.materials = [];
  const matIndex = new Map<string, number>();
  const slotFor = (originalID: number): { slot: number; tag: string } => {
    for (const s of sources) {
      const local = originalID - s.id0;
      if (local >= 0 && local < s.materials.length) {
        const mat = s.materials[local]!;
        const key = materialKey(mat);
        let slot = matIndex.get(key);
        if (slot === undefined) {
          slot = out.materials.length;
          out.materials.push(mat);
          matIndex.set(key, slot);
        }
        return { slot, tag: s.tag };
      }
    }
    return { slot: 0, tag: '' };
  };
  const np = gl.numProp;
  const vp = gl.vertProperties;
  const vertCount = vp.length / np;
  for (let i = 0; i < vertCount; i++) out.p.push([vp[i * np]!, vp[i * np + 1]!, vp[i * np + 2]!]);
  const runIndex = gl.runIndex ?? new Uint32Array([0, gl.triVerts.length]);
  const runIDs = gl.runOriginalID ?? new Uint32Array([sources[0]?.id0 ?? 0]);
  for (let r = 0; r < runIDs.length; r++) {
    const { slot, tag } = slotFor(runIDs[r]!);
    const start = runIndex[r]!;
    const end = runIndex[r + 1] ?? gl.triVerts.length;
    for (let t = start; t < end; t += 3) {
      const v = [gl.triVerts[t]!, gl.triVerts[t + 1]!, gl.triVerts[t + 2]!];
      out.f.push({
        v,
        uv: np >= 5 ? v.map((i) => [vp[i * np + 3]!, vp[i * np + 4]!] as V2) : null,
        c: np >= 8 ? v.map((i) => [vp[i * np + 5]!, vp[i * np + 6]!, vp[i * np + 7]!] as RGB) : null,
        g: tag === 'b' ? 'cut' : '',
        m: slot,
        sm: true,
      });
    }
  }
  if (out.materials.length === 0) out.materials = [sources[0]?.materials[0] ?? DEFAULT_MATERIAL];
  // Drop all-white vertex colors so plain materials are not tinted.
  if (out.f.every((f) => f.c?.every((c) => c[0] > 0.999 && c[1] > 0.999 && c[2] > 0.999))) {
    for (const f of out.f) f.c = null;
  }
  return out.weld(1e-6);
}

function binary(a: PolyMesh, b: PolyMesh, op: 'add' | 'subtract' | 'intersect'): PolyMesh {
  const A = toManifold(a, 'a');
  let B: ReturnType<typeof toManifold> | undefined;
  try {
    B = toManifold(b, 'b');
    const r = A.man[op](B.man);
    try {
      return fromManifold(r, [A.src, B.src]);
    } finally {
      r.delete();
    }
  } finally {
    A.man.delete();
    B?.man.delete();
  }
}

/** Solid union of meshes (overlaps removed). */
export function union(...meshes: PolyMesh[]): PolyMesh {
  if (meshes.length === 0) return new PolyMesh();
  return meshes.slice(1).reduce((acc, m) => binary(acc, m, 'add'), meshes[0]!);
}

/** `a` with every other mesh cut away. Cut surfaces get the face group 'cut'. */
export function subtract(a: PolyMesh, ...cutters: PolyMesh[]): PolyMesh {
  return cutters.reduce((acc, m) => binary(acc, m, 'subtract'), a);
}

/** Only the volume shared by all meshes. */
export function intersect(...meshes: PolyMesh[]): PolyMesh {
  if (meshes.length === 0) return new PolyMesh();
  return meshes.slice(1).reduce((acc, m) => binary(acc, m, 'intersect'), meshes[0]!);
}

/** Convex hull around all vertices of the given meshes. */
export function hull(...meshes: PolyMesh[]): PolyMesh {
  const w = need();
  const pts: V3[] = meshes.flatMap((m) => m.p);
  const man = w.Manifold.hull(pts);
  try {
    const src: Source = {
      id0: man.originalID(),
      materials: [meshes[0]?.materials[0] ?? DEFAULT_MATERIAL],
      tag: 'a',
    };
    const out = fromManifold(man, [src]);
    out.materials = [src.materials[0]!];
    for (const f of out.f) f.m = 0;
    return out;
  } finally {
    man.delete();
  }
}
