import * as api from './api.ts';

/** The scripting API as one object: the host exposes it as the global behind `import ... from 'aige'`. */
export { api };

export * from './audio.ts';
export * from './behaviour.ts';
export * from './builtins.ts';
export { type ComponentRef, type ComponentTypes, DegreesEuler, RuntimeEntity } from './entity.ts';
export * from './headless.ts';
export * from './hud.ts';
export * from './input.ts';
export { cloneProps, hashString, readRotation, readVec3, Rng } from './math.ts';
export {
  BodyApi,
  type BodyKind,
  CharacterApi,
  type CollisionInfo,
  type ContactEvent,
  initPhysics,
  type PhysicsHost,
  PhysicsWorld,
  type QueryOptions,
  type RaycastHit,
} from './physics.ts';
export * from './singletons.ts';
export * from './types.ts';
export * from './world.ts';
