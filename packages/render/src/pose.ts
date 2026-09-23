/**
 * Skeletal poses for skinned character models (AIGE humanoid convention: identity bind rotations, so a clip
 * rotation is the bone's local rotation). Evaluates an Animator pose state with the built-in clip library
 * (@aige/core) and writes it onto the bones of a loaded GLB.
 */
import {
  type AnimPoseState,
  builtinClip,
  type CompiledClip,
  compileClip,
  evaluatePoseState,
  poseState,
  REFERENCE_HIPS_HEIGHT,
  readPoseState,
} from '@aige/core';
import { type Bone, type Object3D, Quaternion, type SkinnedMesh, Vector3 } from 'three';

const compiled = new Map<string, CompiledClip | null>();

function resolveClip(name: string): CompiledClip | null {
  let c = compiled.get(name);
  if (c === undefined) {
    const clip = builtinClip(name);
    c = clip ? compileClip(clip) : null;
    compiled.set(name, c);
  }
  return c;
}

/** Pose state of an entity's Animator component: its `_pose` (runtime snapshots) or its initial clip at t=0. */
export function animatorPoseState(animator: Record<string, unknown>): AnimPoseState {
  return readPoseState(animator._pose) ?? poseState(String(animator.initial ?? 'idle'), 0);
}

/** True when the object contains skinned meshes. */
export function hasSkin(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

const JAW_AXIS = new Vector3(1, 0, 0);
const tmpQ = new Quaternion();

/**
 * Applies a pose state to the bones under `root` (bones are matched by name). Unknown clips leave the bind
 * pose. The hips offset is scaled from the reference hip height to this skeleton's.
 */
export function applyPoseState(root: Object3D, state: AnimPoseState): void {
  const bones = new Map<string, Bone>();
  root.traverse((o) => {
    if ((o as Bone).isBone) bones.set(o.name, o as Bone);
  });
  if (bones.size === 0) return;
  for (const b of bones.values()) {
    if (!b.userData.bindPos) b.userData.bindPos = b.position.toArray();
  }
  const pose = evaluatePoseState(state, resolveClip);
  for (const [name, b] of bones) {
    const bind = b.userData.bindPos as number[];
    b.position.set(bind[0]!, bind[1]!, bind[2]!);
    const q = pose.rot[name];
    if (q) b.quaternion.set(q[0], q[1], q[2], q[3]);
    else b.quaternion.identity();
  }
  const hips = bones.get('hips');
  if (hips) {
    const bind = hips.userData.bindPos as number[];
    const k = (bind[1] ?? REFERENCE_HIPS_HEIGHT) / REFERENCE_HIPS_HEIGHT;
    hips.position.set(bind[0]! + pose.hips[0] * k, bind[1]! + pose.hips[1] * k, bind[2]! + pose.hips[2] * k);
  }
  const jaw = bones.get('jaw');
  if (jaw && pose.mouth)
    jaw.quaternion.multiply(tmpQ.setFromAxisAngle(JAW_AXIS, (pose.mouth * 18 * Math.PI) / 180));
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh) {
      // posed bounds for framing; the bind-pose sphere would cull lying poses
      m.frustumCulled = false;
      m.computeBoundingBox();
      m.computeBoundingSphere();
    }
  });
}
