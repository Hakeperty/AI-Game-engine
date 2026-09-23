import { proceduralTexture, type RgbaImage } from '../image.ts';
import type { MaterialSpec } from '../material.ts';
import { dot, normalize, srgbToLinear, type V3 } from '../math.ts';
import {
  type ColliderHint,
  Model,
  type ModelAnimation,
  type PartSkin,
  type Skeleton,
  type Socket,
} from '../model.ts';
import { type PolyMesh, triangulatePolygon } from '../polymesh.ts';

/** GPU-ready triangle data for one material. Colors are linear RGB. */
export interface MeshPrimitive {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  uvs: Float32Array<ArrayBuffer> | null;
  colors: Float32Array<ArrayBuffer> | null;
  indices: Uint32Array<ArrayBuffer>;
  material: MaterialSpec;
  texture: RgbaImage | null;
  /** Skinned parts: 4 joint indices per vertex. */
  joints?: Uint16Array<ArrayBuffer>;
  /** Skinned parts: 4 weights per vertex (sum 1). */
  weights?: Float32Array<ArrayBuffer>;
}

export interface MeshPartData {
  name: string;
  primitives: MeshPrimitive[];
}

export interface MeshData {
  parts: MeshPartData[];
  sockets: Record<string, Socket>;
  collider: ColliderHint | null;
  bounds: { min: V3; max: V3; size: V3; center: V3 };
  triangleCount: number;
  vertexCount: number;
  /** Skinned models: joint hierarchy (bind pose, identity rotations). */
  skeleton?: Skeleton | null;
  animations?: ModelAnimation[];
}

export interface MeshDataOptions {
  /** Faces meeting at less than this angle (degrees) share smooth normals. Default 40. */
  smoothAngle?: number;
}

/** Converts a model (or single mesh) into render-ready triangle buffers, split by material. */
export function toMeshData(input: Model | PolyMesh, opts: MeshDataOptions = {}): MeshData {
  const model = input instanceof Model ? input : new Model().add(input, 'main');
  const parts: MeshPartData[] = [];
  let triangleCount = 0;
  let vertexCount = 0;
  for (const part of model.parts) {
    const prims = meshToPrimitives(part.mesh, opts.smoothAngle ?? 40, model.skeleton ? part.skin : undefined);
    for (const p of prims) {
      triangleCount += p.indices.length / 3;
      vertexCount += p.positions.length / 3;
    }
    parts.push({ name: part.name, primitives: prims });
  }
  return {
    parts,
    sockets: model.sockets,
    collider: model.collider,
    bounds: model.bounds(),
    triangleCount,
    vertexCount,
    ...(model.skeleton ? { skeleton: model.skeleton, animations: model.animations } : {}),
  };
}

function meshToPrimitives(mesh: PolyMesh, smoothAngle: number, skin?: PartSkin): MeshPrimitive[] {
  const cosT = Math.cos((smoothAngle * Math.PI) / 180);
  const faceN: V3[] = mesh.f.map((_, i) => mesh.faceNormal(i));
  const faceA: number[] = mesh.f.map((_, i) => mesh.faceArea(i));
  const vertFaces: number[][] = mesh.p.map(() => []);
  mesh.f.forEach((f, i) => {
    for (const v of f.v) vertFaces[v]!.push(i);
  });
  const hasColors = mesh.f.some((f) => f.c);
  const hasUv = mesh.f.some((f) => f.uv);
  const byMat = new Map<number, number[]>();
  mesh.f.forEach((f, i) => {
    const list = byMat.get(f.m) ?? [];
    list.push(i);
    byMat.set(f.m, list);
  });
  const out: MeshPrimitive[] = [];
  for (const [matIndex, faces] of byMat) {
    const material = mesh.materials[matIndex] ?? mesh.materials[0]!;
    const flat = material.flatShading;
    const pos: number[] = [];
    const nor: number[] = [];
    const uvs: number[] = [];
    const cols: number[] = [];
    const jnt: number[] = [];
    const wts: number[] = [];
    const idx: number[] = [];
    const cache = new Map<string, number>();
    const corner = (fi: number, k: number): number => {
      const f = mesh.f[fi]!;
      const v = f.v[k]!;
      let n = faceN[fi]!;
      if (f.sm && !flat) {
        const acc: V3 = [0, 0, 0];
        for (const fj of vertFaces[v]!) {
          const other = mesh.f[fj]!;
          if (!other.sm || dot(faceN[fj]!, n) < cosT) continue;
          const w = faceA[fj]! || 1e-9;
          acc[0] += faceN[fj]![0] * w;
          acc[1] += faceN[fj]![1] * w;
          acc[2] += faceN[fj]![2] * w;
        }
        const s = normalize(acc);
        if (s[0] || s[1] || s[2]) n = s;
      }
      const uv = f.uv?.[k] ?? [0, 0];
      const c = f.c?.[k] ?? [1, 1, 1];
      const key = `${v}|${n[0].toFixed(4)},${n[1].toFixed(4)},${n[2].toFixed(4)}|${uv[0].toFixed(5)},${uv[1].toFixed(5)}|${c[0].toFixed(3)},${c[1].toFixed(3)},${c[2].toFixed(3)}`;
      let i = cache.get(key);
      if (i === undefined) {
        i = pos.length / 3;
        const p = mesh.p[v]!;
        pos.push(p[0], p[1], p[2]);
        nor.push(n[0], n[1], n[2]);
        if (hasUv) uvs.push(uv[0], 1 - uv[1]);
        if (hasColors) cols.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
        if (skin) {
          for (let k = 0; k < 4; k++) {
            jnt.push(skin.joints[v * 4 + k] ?? 0);
            wts.push(skin.weights[v * 4 + k] ?? 0);
          }
        }
        cache.set(key, i);
      }
      return i;
    };
    for (const fi of faces) {
      const f = mesh.f[fi]!;
      const tris = f.v.length === 3 ? [[0, 1, 2]] : triangulatePolygon(f.v.map((k) => mesh.p[k]!));
      for (const t of tris) idx.push(corner(fi, t[0]!), corner(fi, t[1]!), corner(fi, t[2]!));
    }
    if (idx.length === 0) continue;
    out.push({
      positions: new Float32Array(pos),
      normals: new Float32Array(nor),
      uvs: hasUv ? new Float32Array(uvs) : null,
      colors: hasColors ? new Float32Array(cols) : null,
      indices: new Uint32Array(idx),
      material,
      texture: material.texture ? proceduralTexture(material.texture) : null,
      ...(skin ? { joints: new Uint16Array(jnt), weights: new Float32Array(wts) } : {}),
    });
  }
  return out;
}
