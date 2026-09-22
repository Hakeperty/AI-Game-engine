import type {
  AudioSource,
  Camera,
  CharacterController,
  Collider,
  ComponentData,
  Light,
  MeshRenderer,
  RigidBody,
  Script,
  UIText,
} from '@aige/core';
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { z } from 'zod';
import type { Behaviour, BehaviourClass } from './behaviour.ts';
import { DEG, RAD, readRotation, readVec3 } from './math.ts';
import type { BodyApi, CharacterApi } from './physics.ts';
import type { RotationLike, V3, Vec3Like } from './types.ts';
import type { World } from './world.ts';

type PropsOf<D> = D extends { schema: infer S extends z.ZodType } ? z.output<S> : never;

/** Live component props by type, as returned by `entity.get(type)`. */
export interface ComponentTypes {
  MeshRenderer: { type: 'MeshRenderer' } & PropsOf<typeof MeshRenderer>;
  Light: { type: 'Light' } & PropsOf<typeof Light>;
  Camera: { type: 'Camera' } & PropsOf<typeof Camera>;
  RigidBody: { type: 'RigidBody' } & PropsOf<typeof RigidBody>;
  Collider: { type: 'Collider' } & PropsOf<typeof Collider>;
  CharacterController: { type: 'CharacterController' } & PropsOf<typeof CharacterController>;
  Script: { type: 'Script' } & PropsOf<typeof Script>;
  AudioSource: { type: 'AudioSource' } & PropsOf<typeof AudioSource>;
  UIText: { type: 'UIText' } & PropsOf<typeof UIText>;
}

export type ComponentRef<K extends string = string> = K | { type: K };

/** Live view of an entity's local rotation as Euler angles in degrees (XYZ order). */
export class DegreesEuler {
  private readonly obj: Object3D;
  constructor(obj: Object3D) {
    this.obj = obj;
  }
  get x(): number {
    return this.obj.rotation.x * RAD;
  }
  set x(v: number) {
    this.obj.rotation.x = v * DEG;
  }
  get y(): number {
    return this.obj.rotation.y * RAD;
  }
  set y(v: number) {
    this.obj.rotation.y = v * DEG;
  }
  get z(): number {
    return this.obj.rotation.z * RAD;
  }
  set z(v: number) {
    this.obj.rotation.z = v * DEG;
  }
  set(x: number, y: number, z: number): this {
    this.obj.rotation.set(x * DEG, y * DEG, z * DEG, 'XYZ');
    return this;
  }
  toArray(): V3 {
    return [this.x, this.y, this.z];
  }
  toString(): string {
    return `(${this.toArray()
      .map((n) => n.toFixed(1))
      .join(', ')})°`;
  }
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * A live entity in a running game, backed by a three.js Object3D. Transform properties are live:
 * `entity.position.x += 1` moves it. Rotations use **degrees**.
 *
 * `forward` is the direction the entity faces: +Z for objects and models (models face +Z), -Z for
 * Camera and Light entities (the way they look/shine). `lookAt()` points `forward` at a target.
 */
export class RuntimeEntity {
  readonly isRuntimeEntity = true;
  readonly id: string;
  readonly world: World;
  /** The three.js object that holds this entity's transform. */
  readonly object3d: Object3D;
  tags: string[];
  /** Component data (live). Prefer `get(type)`. */
  components: ComponentData[];
  prefab: string | undefined;

  /** @internal */ _active: boolean;
  /** @internal */ _parent: RuntimeEntity | null = null;
  /** @internal */ _children: RuntimeEntity[] = [];
  /** @internal */ _behaviours: Behaviour[] = [];
  /** @internal */ _body: BodyApi | null = null;
  /** @internal */ _character: CharacterApi | null = null;
  /** @internal */ _pendingDestroy = false;
  /** @internal */ _destroyed = false;
  /** @internal */ _fallen = false;
  /** @internal Spawn pose in world space, used by respawn(). */
  readonly _spawnPosition = new Vector3();
  /** @internal */ readonly _spawnQuaternion = new Quaternion();
  private readonly _rotation: DegreesEuler;
  private readonly _proxies = new WeakMap<object, object>();

  constructor(
    world: World,
    doc: {
      id: string;
      name: string;
      tags?: string[];
      active?: boolean;
      components?: ComponentData[];
      prefab?: string;
    },
  ) {
    this.world = world;
    this.id = doc.id;
    this.object3d = new Object3D();
    this.object3d.name = doc.name;
    this.object3d.userData.entityId = doc.id;
    this.tags = [...(doc.tags ?? [])];
    this.components = doc.components ?? [];
    this.prefab = doc.prefab;
    this._active = doc.active !== false;
    this.object3d.visible = this._active;
    this._rotation = new DegreesEuler(this.object3d);
  }

  // -------------------------------------------------------------------------------------------
  // Identity & state
  // -------------------------------------------------------------------------------------------

  get name(): string {
    return this.object3d.name;
  }
  set name(v: string) {
    this.object3d.name = String(v);
  }

  hasTag(tag: string): boolean {
    return this.tags.includes(tag);
  }
  addTag(tag: string): void {
    if (!this.tags.includes(tag)) this.tags.push(tag);
  }
  removeTag(tag: string): void {
    this.tags = this.tags.filter((t) => t !== tag);
  }

  /** The entity's own active flag. Inactive entities are hidden, have no physics and run no scripts. */
  get active(): boolean {
    return this._active;
  }
  set active(v: boolean) {
    this.setActive(v);
  }
  setActive(active: boolean): void {
    active = !!active;
    if (active === this._active) return;
    this._active = active;
    this.object3d.visible = active;
    this.world._onActiveChanged(this);
  }
  /** True when this entity and all of its parents are active. */
  get activeInHierarchy(): boolean {
    let e: RuntimeEntity | null = this;
    while (e) {
      if (!e._active) return false;
      e = e._parent;
    }
    return true;
  }

  get parent(): RuntimeEntity | null {
    return this._parent;
  }
  /** Re-parents the entity (keeps its world transform by default). null = scene root. */
  setParent(parent: RuntimeEntity | string | null, keepWorldTransform = true): void {
    this.world._reparent(this, parent, keepWorldTransform);
  }
  get children(): RuntimeEntity[] {
    return this._children.filter((c) => !c._destroyed);
  }

  /** True once destroy() was called (the entity is removed at the end of the frame). */
  get destroyed(): boolean {
    return this._destroyed || this._pendingDestroy;
  }
  get alive(): boolean {
    return !this.destroyed;
  }

  destroy(delay = 0): void {
    this.world.destroy(this, delay);
  }

  /** Moves the entity back to where it spawned and stops its motion. */
  respawn(): void {
    this.world.respawn(this);
  }

  // -------------------------------------------------------------------------------------------
  // Transform (local = relative to the parent)
  // -------------------------------------------------------------------------------------------

  /** Local position (live Vector3). Assign `[x, y, z]` or a Vector3 to move. */
  get position(): Vector3 {
    return this.object3d.position;
  }
  set position(v: Vec3Like) {
    readVec3(v, this.object3d.position, 'position');
  }

  /** Local rotation in degrees (live). Assign `[x, y, z]` degrees, a Quaternion or a three.js Euler. */
  get rotation(): DegreesEuler {
    return this._rotation;
  }
  set rotation(r: RotationLike) {
    readRotation(r, this.object3d.quaternion);
  }

  /** Local rotation as a quaternion (live). */
  get quaternion(): Quaternion {
    return this.object3d.quaternion;
  }
  set quaternion(q: RotationLike) {
    readRotation(q, this.object3d.quaternion);
  }

  /** Local scale (live Vector3). Assign a number for uniform scale. */
  get scale(): Vector3 {
    return this.object3d.scale;
  }
  set scale(v: Vec3Like | number) {
    readVec3(v, this.object3d.scale, 'scale');
  }

  /** World-space position (a copy). Assigning moves the entity in world space. */
  get worldPosition(): Vector3 {
    return this.object3d.getWorldPosition(new Vector3());
  }
  set worldPosition(v: Vec3Like) {
    const p = readVec3(v, new Vector3(), 'worldPosition');
    const parent = this.object3d.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(p);
    }
    this.object3d.position.copy(p);
  }

  /** World-space rotation (a copy). */
  get worldQuaternion(): Quaternion {
    return this.object3d.getWorldQuaternion(new Quaternion());
  }
  set worldQuaternion(r: RotationLike) {
    const q = readRotation(r, new Quaternion());
    const parent = this.object3d.parent;
    if (parent) {
      parent.getWorldQuaternion(_q2);
      q.premultiply(_q2.invert());
    }
    this.object3d.quaternion.copy(q);
  }

  /** World-space scale (a copy). */
  get worldScale(): Vector3 {
    return this.object3d.getWorldScale(new Vector3());
  }

  private get lookAxis(): number {
    return this.components.some((c) => c.type === 'Camera' || c.type === 'Light') ? -1 : 1;
  }

  /** Direction the entity faces, in world space (+Z for objects, -Z for cameras and lights). */
  get forward(): Vector3 {
    return new Vector3(0, 0, this.lookAxis).applyQuaternion(this.object3d.getWorldQuaternion(_q)).normalize();
  }
  /** The entity's right, in world space (`forward x up`). */
  get right(): Vector3 {
    return new Vector3(-this.lookAxis, 0, 0)
      .applyQuaternion(this.object3d.getWorldQuaternion(_q))
      .normalize();
  }
  /** The entity's up (+Y), in world space. */
  get up(): Vector3 {
    return new Vector3(0, 1, 0).applyQuaternion(this.object3d.getWorldQuaternion(_q)).normalize();
  }

  /** Rotates the entity so `forward` points at a world position or another entity. */
  lookAt(target: Vec3Like | RuntimeEntity, up: Vec3Like = UP): void {
    const t = (target as RuntimeEntity).isRuntimeEntity
      ? (target as RuntimeEntity).worldPosition
      : readVec3(target, new Vector3(), 'lookAt target');
    const eye = this.worldPosition;
    if (eye.distanceToSquared(t) < 1e-12) return;
    const u = readVec3(up, _v2, 'up');
    if (this.lookAxis < 0) _m.lookAt(eye, t, u);
    else _m.lookAt(t, eye, u);
    const q = _q.setFromRotationMatrix(_m);
    const parent = this.object3d.parent;
    if (parent) {
      parent.getWorldQuaternion(_q2);
      q.premultiply(_q2.invert());
    }
    this.object3d.quaternion.copy(q);
  }

  /** Moves by `delta`. space 'self' (default) uses the entity's own axes, 'world' uses world axes. */
  translate(delta: Vec3Like, space: 'self' | 'world' = 'self'): void {
    const d = readVec3(delta, new Vector3(), 'translate delta');
    if (space === 'world') {
      this.worldPosition = this.worldPosition.add(d);
    } else {
      this.object3d.position.add(d.applyQuaternion(this.object3d.quaternion));
    }
  }

  /** Rotates by Euler degrees `[x, y, z]`. space 'self' (default) or 'world'. */
  rotate(eulerDeg: RotationLike, space: 'self' | 'world' = 'self'): void {
    const q = readRotation(eulerDeg, new Quaternion());
    if (space === 'world') {
      const parent = this.object3d.parent;
      if (parent) {
        const pq = parent.getWorldQuaternion(new Quaternion());
        // world-space delta expressed in parent space: pq^-1 * q * pq
        q.premultiply(pq.clone().invert()).multiply(pq);
      }
      this.object3d.quaternion.premultiply(q);
    } else {
      this.object3d.quaternion.multiply(q);
    }
  }

  /** Distance in world space to a point or another entity. */
  distanceTo(target: Vec3Like | RuntimeEntity): number {
    const t = (target as RuntimeEntity).isRuntimeEntity
      ? (target as RuntimeEntity).worldPosition
      : readVec3(target, _v, 'distanceTo target');
    return this.worldPosition.distanceTo(t);
  }

  // -------------------------------------------------------------------------------------------
  // Components & scripts
  // -------------------------------------------------------------------------------------------

  /**
   * The first component of a type, as live props (mutating them updates the game), or null.
   * Example: `this.entity.get('Light').intensity = 3`.
   */
  get<K extends keyof ComponentTypes>(type: ComponentRef<K>): ComponentTypes[K] | null;
  get(type: ComponentRef): ComponentData | null;
  get(type: ComponentRef): ComponentData | null {
    const t = typeof type === 'string' ? type : type?.type;
    const c = this.components.find((x) => x.type === t);
    return c ? this.liveComponent(c) : null;
  }

  /** All components of a type (live). */
  getAll<K extends keyof ComponentTypes>(type: ComponentRef<K>): ComponentTypes[K][];
  getAll(type: ComponentRef): ComponentData[];
  getAll(type: ComponentRef): ComponentData[] {
    const t = typeof type === 'string' ? type : type?.type;
    return this.components.filter((x) => x.type === t).map((c) => this.liveComponent(c));
  }

  has(type: ComponentRef): boolean {
    const t = typeof type === 'string' ? type : type?.type;
    return this.components.some((x) => x.type === t);
  }

  private liveComponent(c: ComponentData): ComponentData {
    let p = this._proxies.get(c);
    if (!p) {
      const world = this.world;
      const self = this;
      p = new Proxy(c, {
        set(target, key, value) {
          (target as any)[key] = value;
          world._markComponentDirty(self, target);
          return true;
        },
        deleteProperty(target, key) {
          delete (target as any)[key];
          world._markComponentDirty(self, target);
          return true;
        },
      });
      this._proxies.set(c, p);
    }
    return p as ComponentData;
  }

  /** Behaviours attached to this entity. */
  get scripts(): Behaviour[] {
    return [...this._behaviours];
  }

  /** A behaviour on this entity by class, class name or script path ('scripts/enemy.ts', 'builtin:Rotator'). */
  getScript<T extends Behaviour<any>>(cls: abstract new (...args: any[]) => T): T | null;
  getScript(cls: string): Behaviour | null;
  getScript(cls: string | (abstract new (...args: any[]) => Behaviour<any>)): Behaviour | null {
    if (typeof cls === 'string') {
      const name = cls.replace(/^builtin:/, '');
      return (
        this._behaviours.find(
          (b) => b.script === cls || b.script === `builtin:${name}` || b.constructor.name === name,
        ) ?? null
      );
    }
    return this._behaviours.find((b) => b instanceof cls) ?? null;
  }

  /** Adds a behaviour at runtime (class, script path or 'builtin:Name'). awake() runs immediately. */
  addScript<T extends Behaviour<any>>(cls: new () => T, props?: Record<string, unknown>): T;
  addScript(cls: string | BehaviourClass, props?: Record<string, unknown>): Behaviour | null;
  addScript(cls: string | BehaviourClass, props: Record<string, unknown> = {}): Behaviour | null {
    return this.world._addScript(this, cls, props);
  }

  /** Physics body API (null when the entity has no RigidBody/Collider). */
  get body(): BodyApi | null {
    return this._body;
  }

  /** Character controller API (null without a CharacterController component). */
  get character(): CharacterApi | null {
    return this._character;
  }

  toString(): string {
    return `${this.name}(${this.id})`;
  }

  toJSON(): unknown {
    return { entity: this.id, name: this.name };
  }
}
