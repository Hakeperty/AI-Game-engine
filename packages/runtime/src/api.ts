// The scripting API: what game scripts get from `import { ... } from 'aige'`.
// Everything here is a plain value (class, singleton object or function) so the host can expose the
// whole module as one global to sandboxed scripts.

export { Color, Euler, MathUtils, Quaternion, Vector3 } from 'three';
export { Behaviour, type BehaviourClass } from './behaviour.ts';
export {
  Bobber,
  builtinBehaviours,
  Collectible,
  FollowCamera,
  Goal,
  Hazard,
  HudText,
  Lifetime,
  MovingPlatform,
  PlayerController,
  Rotator,
  Spinner,
} from './builtins.ts';
export { type ComponentRef, type ComponentTypes, DegreesEuler, RuntimeEntity } from './entity.ts';
export type { BodyApi, CharacterApi, CollisionInfo, QueryOptions, RaycastHit } from './physics.ts';
export { Audio, Debug, Game, Input, Physics, Random, Scene, Time, UI } from './singletons.ts';
export type { GameOver, HudEntry, RotationLike, SfxPreset, V3, Vec3Like } from './types.ts';
export type { FindQuery, InstantiateOptions, World } from './world.ts';

// Component type tokens for entity.get(...): `this.entity.get(UIText).text = 'Hi'`.
export const MeshRenderer = { type: 'MeshRenderer' } as const;
export const Light = { type: 'Light' } as const;
export const Camera = { type: 'Camera' } as const;
export const RigidBody = { type: 'RigidBody' } as const;
export const Collider = { type: 'Collider' } as const;
export const CharacterController = { type: 'CharacterController' } as const;
export const Script = { type: 'Script' } as const;
export const AudioSource = { type: 'AudioSource' } as const;
export const UIText = { type: 'UIText' } as const;
