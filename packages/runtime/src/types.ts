import type { Quaternion, Vector3 } from 'three';

/** [x, y, z] tuple. */
export type V3 = [number, number, number];

/**
 * Anything that can be read as a 3D vector: a three.js Vector3, an `[x, y, z]` array or an `{x, y, z}` object.
 * The runtime accepts this everywhere a vector is expected.
 */
export type Vec3Like = Vector3 | readonly number[] | { x: number; y: number; z: number };

/**
 * A rotation: Euler angles in **degrees** as `[x, y, z]` / `{x, y, z}`, a three.js Quaternion, or a three.js Euler
 * (radians, as three.js always uses).
 */
export type RotationLike = Vec3Like | Quaternion | { isEuler: true; x: number; y: number; z: number };

/** Collider hint produced by model recipes (same shape as `@aige/modeling`'s ColliderHint). */
export interface ColliderHint {
  shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'convex' | 'mesh';
  size?: V3;
  radius?: number;
  height?: number;
  offset?: V3;
}

export interface ModelBounds {
  min: V3;
  max: V3;
  size: V3;
  center: V3;
}

/** What the runtime needs to know about a model asset (the mesh itself is only needed by the renderer). */
export interface ModelInfo {
  bounds: ModelBounds;
  collider: ColliderHint | null;
}

export const SFX_PRESETS = [
  'coin',
  'jump',
  'hit',
  'explosion',
  'powerup',
  'laser',
  'click',
  'win',
  'lose',
] as const;
export type SfxPreset = (typeof SFX_PRESETS)[number];

export type UIAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

/** One HUD element. `world.hud[id]`. */
export interface HudEntry {
  text: string;
  anchor: UIAnchor;
  offset: [number, number];
  fontSize: number;
  color: string;
  visible: boolean;
}

export interface ScriptError {
  message: string;
  /** Script path ('scripts/player.ts', 'builtin:Rotator') or 'engine'. */
  script: string;
  /** Entity name (null for engine errors). */
  entity: string | null;
  entityId: string | null;
  /** Hook that threw ('update', 'onTriggerEnter', ...). */
  hook: string;
  stack: string;
  /** Simulated time in seconds. */
  t: number;
}

export interface LogEntry {
  t: number;
  level: 'info' | 'warn';
  message: string;
  script: string | null;
  entity: string | null;
}

export interface GameEvent {
  t: number;
  name: string;
  data: unknown;
}

export interface GameOver {
  result: 'win' | 'lose';
  message: string;
}

export interface AudioEvent {
  t: number;
  kind: 'play' | 'sfx' | 'stop';
  name: string;
  opts: Record<string, unknown>;
}

export interface SceneLoadEvent {
  t: number;
  name: string;
  path: string | null;
  restart: boolean;
}
