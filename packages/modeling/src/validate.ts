import type { V3 } from './math.ts';
import { Model } from './model.ts';
import type { PolyMesh } from './polymesh.ts';

export interface MeshReport {
  vertices: number;
  faces: number;
  triangles: number;
  bounds: { min: V3; max: V3; size: V3 };
  /** Every edge shared by exactly two faces with opposite winding. */
  watertight: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  flippedEdges: number;
  degenerateFaces: number;
  /** Closed mesh whose faces point inward. */
  insideOut: boolean;
  volume: number;
  surfaceArea: number;
  materials: number;
  groups: string[];
  issues: string[];
}

export function validateMesh(mesh: PolyMesh): MeshReport {
  const directed = new Map<string, number>();
  const undirected = new Map<string, number>();
  let degenerate = 0;
  mesh.f.forEach((f, i) => {
    if (mesh.faceArea(i) < 1e-10) degenerate++;
    for (let k = 0; k < f.v.length; k++) {
      const a = f.v[k]!;
      const b = f.v[(k + 1) % f.v.length]!;
      directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
    }
  });
  let boundary = 0;
  let nonManifold = 0;
  let flipped = 0;
  for (const [key, n] of undirected) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
    else {
      const [a, b] = key.split('_');
      if ((directed.get(`${a}>${b}`) ?? 0) !== 1) flipped++;
    }
  }
  const watertight = boundary === 0 && nonManifold === 0 && flipped === 0 && mesh.f.length > 0;
  const volume = mesh.volume();
  const b = mesh.bounds();
  const issues: string[] = [];
  if (mesh.f.length === 0) issues.push('Mesh is empty.');
  if (boundary > 0)
    issues.push(`${boundary} open (boundary) edges: the mesh has holes or is a surface, not a solid.`);
  if (nonManifold > 0) issues.push(`${nonManifold} non-manifold edges (shared by more than two faces).`);
  if (flipped > 0) issues.push(`${flipped} edges with inconsistent face winding (some faces are flipped).`);
  if (degenerate > 0) issues.push(`${degenerate} degenerate (zero-area) faces.`);
  if (watertight && volume < 0) issues.push('Mesh is inside-out (normals point inward). Use .flip().');
  const tris = mesh.triangleCount;
  if (tris > 200_000)
    issues.push(`High triangle count (${tris}); consider fewer segments or lower SDF resolution.`);
  return {
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    triangles: tris,
    bounds: { min: b.min, max: b.max, size: b.size },
    watertight,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    flippedEdges: flipped,
    degenerateFaces: degenerate,
    insideOut: watertight && volume < 0,
    volume,
    surfaceArea: mesh.surfaceArea(),
    materials: mesh.materials.length,
    groups: mesh.groups(),
    issues,
  };
}

export interface ModelReport {
  parts: { name: string; report: MeshReport }[];
  triangles: number;
  bounds: { min: V3; max: V3; size: V3 };
  sockets: string[];
  issues: string[];
}

export function validateModel(input: Model | PolyMesh): ModelReport {
  const model = input instanceof Model ? input : new Model().add(input, 'main');
  const parts = model.parts.map((p) => ({ name: p.name, report: validateMesh(p.mesh) }));
  const b = model.bounds();
  const issues = parts.flatMap((p) => p.report.issues.map((i) => `${p.name}: ${i}`));
  const maxSize = Math.max(...b.size);
  if (maxSize > 200) issues.push(`Model is very large (${maxSize.toFixed(1)} m). Units are meters.`);
  if (maxSize < 0.01 && parts.length)
    issues.push(`Model is tiny (${maxSize.toFixed(4)} m). Units are meters.`);
  return {
    parts,
    triangles: model.triangleCount,
    bounds: { min: b.min, max: b.max, size: b.size },
    sockets: Object.keys(model.sockets),
    issues,
  };
}
