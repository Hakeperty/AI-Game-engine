import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Transform, Vec3 } from './schema/common.ts';
import type { Entity, SceneDoc } from './schema/documents.ts';
import { entityIndex } from './state.ts';

const DEG = MathUtils.DEG2RAD;

export function eulerDegToQuaternion(rot: readonly number[]): Quaternion {
  return new Quaternion().setFromEuler(new Euler(rot[0]! * DEG, rot[1]! * DEG, rot[2]! * DEG, 'XYZ'));
}

export function quaternionToEulerDeg(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return [e.x / DEG, e.y / DEG, e.z / DEG];
}

export function localMatrix(t: Transform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...t.position),
    eulerDegToQuaternion(t.rotation),
    new Vector3(...t.scale),
  );
}

/** World matrix of an entity, composing parent transforms. */
export function worldMatrix(scene: SceneDoc, entity: Entity, index = entityIndex(scene)): Matrix4 {
  const chain: Entity[] = [];
  let cur: Entity | undefined = entity;
  let guard = 0;
  while (cur && guard++ < 1000) {
    chain.unshift(cur);
    cur = cur.parent ? index.get(cur.parent) : undefined;
  }
  const m = new Matrix4();
  for (const e of chain) m.multiply(localMatrix(e.transform));
  return m;
}

export function decompose(m: Matrix4): Transform {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], rotation: quaternionToEulerDeg(q), scale: [s.x, s.y, s.z] };
}

export function worldTransform(scene: SceneDoc, entity: Entity, index = entityIndex(scene)): Transform {
  return decompose(worldMatrix(scene, entity, index));
}

/** Local transform that places `entity` at `world` under `parent` (null = scene root). */
export function localFromWorld(scene: SceneDoc, world: Matrix4, parent: Entity | null): Transform {
  if (!parent) return decompose(world);
  const parentWorld = worldMatrix(scene, parent);
  return decompose(parentWorld.clone().invert().multiply(world));
}
