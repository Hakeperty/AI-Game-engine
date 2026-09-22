import { Box3, type Camera, PerspectiveCamera, Sphere, Vector3 } from 'three';

export type ViewKind = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'camera' | 'custom';

export interface ViewSpec {
  kind: ViewKind;
  /** For 'custom': camera position and look-at target. */
  position?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  label?: string;
}

const DIRECTIONS: Record<Exclude<ViewKind, 'camera' | 'custom'>, [number, number, number]> = {
  iso: [1, 0.75, 1.1],
  front: [0, 0.12, 1],
  back: [0, 0.12, -1],
  right: [1, 0.12, 0],
  left: [-1, 0.12, 0],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
};

export const VIEW_LABELS: Record<ViewKind, string> = {
  iso: 'ISO',
  front: 'FRONT (+Z)',
  back: 'BACK (-Z)',
  right: 'RIGHT (+X)',
  left: 'LEFT (-X)',
  top: 'TOP (+Y)',
  bottom: 'BOTTOM',
  camera: 'GAME CAMERA',
  custom: 'CUSTOM',
};

/** A perspective camera that frames `bounds` from a preset direction. */
export function framingCamera(kind: Exclude<ViewKind, 'camera' | 'custom'>, bounds: Box3, aspect: number, fov = 35): PerspectiveCamera {
  const cam = new PerspectiveCamera(fov, aspect, 0.01, 10000);
  const sphere = bounds.isEmpty() ? new Sphere(new Vector3(), 1) : bounds.getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  const vFov = (fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
  const dir = new Vector3(...DIRECTIONS[kind]).normalize();
  cam.position.copy(sphere.center).addScaledVector(dir, dist);
  if (kind === 'top' || kind === 'bottom') cam.up.set(0, 0, -1);
  cam.lookAt(sphere.center);
  cam.near = Math.max(0.01, dist - radius * 3);
  cam.far = dist + radius * 3;
  cam.updateProjectionMatrix();
  return cam;
}

export function customCamera(view: ViewSpec, aspect: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(view.fov ?? 50, aspect, 0.05, 2000);
  cam.position.set(...(view.position ?? [5, 5, 5]));
  cam.lookAt(new Vector3(...(view.target ?? [0, 0, 0])));
  cam.updateProjectionMatrix();
  return cam;
}

/** Grid layout for N views: 1 = full, 2 = side by side, 3-4 = 2x2. */
export function layoutFor(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: Math.ceil(count / 3) };
}

export function projectToScreen(p: Vector3, camera: Camera, w: number, h: number): { x: number; y: number; visible: boolean } {
  const v = p.clone().project(camera);
  return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 };
}
