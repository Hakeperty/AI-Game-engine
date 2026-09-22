import type { V3 } from './math.ts';
import { type Bounds, PolyMesh } from './polymesh.ts';

export interface Socket {
  position: V3;
  rotation: V3;
}

/** Suggested physics collider for entities using this model (used by Collider shape 'auto'). */
export interface ColliderHint {
  shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'convex' | 'mesh';
  size?: V3;
  radius?: number;
  height?: number;
  offset?: V3;
}

export interface ModelPart {
  name: string;
  mesh: PolyMesh;
}

/**
 * A finished model: one or more named parts, optional sockets (attachment points such as 'hand' or 'muzzle')
 * and an optional collider hint.
 */
export class Model {
  parts: ModelPart[] = [];
  sockets: Record<string, Socket> = {};
  collider: ColliderHint | null = null;

  /** Adds a part. Names must be unique; duplicates get a numeric suffix. */
  add(mesh: PolyMesh, name?: string): this {
    let n = name ?? `part${this.parts.length + 1}`;
    let i = 2;
    while (this.parts.some((p) => p.name === n)) n = `${name ?? 'part'}${i++}`;
    this.parts.push({ name: n, mesh });
    return this;
  }

  /** Named attachment point (in model space). */
  socket(name: string, position: V3, rotation: V3 = [0, 0, 0]): this {
    this.sockets[name] = { position, rotation };
    return this;
  }

  setCollider(hint: ColliderHint): this {
    this.collider = hint;
    return this;
  }

  /** All parts merged into a single mesh. */
  merged(): PolyMesh {
    return PolyMesh.merge(...this.parts.map((p) => p.mesh));
  }

  bounds(): Bounds {
    return this.merged().bounds();
  }

  get triangleCount(): number {
    return this.parts.reduce((n, p) => n + p.mesh.triangleCount, 0);
  }
}

/** Builds a model from meshes: model(body, head) or model({ body, head }). */
export function model(...args: (PolyMesh | Record<string, PolyMesh>)[]): Model {
  const m = new Model();
  for (const a of args) {
    if (a instanceof PolyMesh) m.add(a);
    else for (const [name, mesh] of Object.entries(a)) m.add(mesh, name);
  }
  return m;
}

/** Normalizes whatever a recipe returned into a Model. */
export function toModel(value: unknown): Model {
  if (value instanceof Model) return value;
  if (value instanceof PolyMesh) return new Model().add(value, 'main');
  if (Array.isArray(value) && value.every((v) => v instanceof PolyMesh)) {
    const m = new Model();
    for (const mesh of value as PolyMesh[]) m.add(mesh);
    return m;
  }
  if (value && typeof value === 'object' && Object.values(value).every((v) => v instanceof PolyMesh)) {
    return model(value as Record<string, PolyMesh>);
  }
  throw new Error(
    'build() must return a mesh, an array of meshes, an object of named meshes, or model(...).',
  );
}
