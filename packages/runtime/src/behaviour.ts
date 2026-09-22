import type { RuntimeEntity } from './entity.ts';
import type { CollisionInfo } from './physics.ts';
import type { FindQuery, InstantiateOptions, World } from './world.ts';

export interface BehaviourInit {
  entity: RuntimeEntity;
  world: World;
  /** Static props merged with the Script component's props. */
  props: Record<string, any>;
  /** Only the Script component's props (explicit per-instance overrides). */
  overrides: Record<string, unknown>;
  script: string;
}

// Set while World constructs a behaviour, so `entity`, `world` and `props` are already available in
// field initializers and constructors of user classes.
let pendingInit: BehaviourInit | null = null;

/**
 * Base class for game scripts. A script file default-exports a class extending Behaviour:
 *
 * ```ts
 * import { Behaviour, Input } from 'aige';
 * export default class Spin extends Behaviour {
 *   static props = { speed: 90 };
 *   update(dt: number) { this.entity.rotate([0, this.props.speed * dt, 0]); }
 * }
 * ```
 *
 * Lifecycle: all `awake()`, then all `start()` before the first frame, then every frame
 * `fixedUpdate(dt)` -> physics -> collision/trigger callbacks -> `update(dt)` -> `lateUpdate(dt)`.
 * Every hook is optional. Errors thrown by a hook are reported with the script path and entity and
 * never stop the game (a behaviour is disabled after 20 errors).
 */
export abstract class Behaviour<P extends Record<string, any> = Record<string, any>> {
  /** Default props. Merged with the Script component's `props` into `this.props`. */
  static props: Record<string, unknown> = {};

  /** The entity this behaviour is attached to. */
  entity!: RuntimeEntity;
  /** The running world. */
  world!: World;
  /** Static props merged with the Script component's props. */
  props: P;
  /** Disabled behaviours receive no callbacks. */
  enabled = true;
  /** Where this behaviour came from: 'scripts/player.ts' or 'builtin:Rotator'. */
  script = '';

  constructor() {
    const init = pendingInit;
    this.props = (init?.props ?? {}) as P;
    if (init) {
      this.entity = init.entity;
      this.world = init.world;
      this.script = init.script;
    }
  }

  /** Called once when the behaviour is created (before any start()). */
  awake?(): void;
  /** Called once before the behaviour's first update. */
  start?(): void;
  /** Called every frame. `dt` is in seconds. */
  update?(dt: number): void;
  /** Called at the fixed physics rate (project.physics.fixedTimestep), before the physics step. */
  fixedUpdate?(dt: number): void;
  /** Called every frame after all update() calls (cameras). */
  lateUpdate?(dt: number): void;
  /** Called when the entity is destroyed. */
  onDestroy?(): void;
  /** A solid collider started touching this entity. `info.normal` points from `other` toward this entity. */
  onCollisionEnter?(other: RuntimeEntity, info: CollisionInfo): void;
  onCollisionExit?(other: RuntimeEntity): void;
  /** Another collider entered a trigger (isTrigger) involving this entity. Fires on both entities. */
  onTriggerEnter?(other: RuntimeEntity): void;
  onTriggerExit?(other: RuntimeEntity): void;
  /** The entity (with a RigidBody or CharacterController) fell below scene.settings.killY. */
  onFall?(): void;

  /** Finds an entity by id, 'Parent/Child' path or name. Returns null (and logs a hint) when missing. */
  find(ref: string): RuntimeEntity | null {
    return this.world.find(ref);
  }

  /** All entities matching a tag and/or name. A string is treated as a tag. */
  findAll(query?: FindQuery | string): RuntimeEntity[] {
    return this.world.findAll(query);
  }

  /** Another behaviour on the same entity. */
  getScript<T extends Behaviour<any>>(cls: abstract new (...args: any[]) => T): T | null {
    return this.entity.getScript(cls);
  }

  /** Spawns a prefab ('prefabs/coin.prefab.json' or 'coin') or clones an entity. */
  instantiate(prefab: string | RuntimeEntity, opts?: InstantiateOptions): RuntimeEntity {
    return this.world.instantiate(prefab, opts);
  }

  /** Destroys an entity (default: this one) at the end of the frame, or after `delay` seconds. */
  destroy(target: RuntimeEntity = this.entity, delay = 0): void {
    this.world.destroy(target, delay);
  }

  /** Logs a message, tagged with this script and entity. */
  log(...args: unknown[]): void {
    this.world.logFrom(this, 'info', args);
  }

  warn(...args: unknown[]): void {
    this.world.logFrom(this, 'warn', args);
  }
}

/** A class usable as a behaviour: `new ()` returning a Behaviour, optionally with static `props`. */
export type BehaviourClass = (new () => Behaviour<any>) & { props?: Record<string, unknown> };

/** Constructs a behaviour with `entity`, `world` and `props` already set during construction. */
export function constructBehaviour(cls: BehaviourClass, init: BehaviourInit): Behaviour {
  const prev = pendingInit;
  pendingInit = init;
  try {
    const inst = new cls() as Behaviour;
    // Classes that do not extend Behaviour (or override the fields) still get the essentials.
    inst.entity = init.entity;
    inst.world = init.world;
    if (!inst.props || typeof inst.props !== 'object') inst.props = init.props;
    else if (inst.props !== init.props) inst.props = { ...init.props, ...inst.props, ...init.overrides };
    if (typeof inst.enabled !== 'boolean') inst.enabled = true;
    inst.script = init.script;
    return inst;
  } finally {
    pendingInit = prev;
  }
}
