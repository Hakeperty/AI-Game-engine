import type { ComponentData } from '@aige/core';
import RAPIER, {
  type Collider as RCollider,
  type ColliderDesc,
  type EventQueue,
  type KinematicCharacterController,
  type RigidBody as RBody,
  type World as RWorld,
} from '@dimforge/rapier3d-compat';
import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import type { RuntimeEntity } from './entity.ts';
import { DEG, numOr, readRotation, readVec3, vec3Or } from './math.ts';
import type { ColliderHint, ModelInfo, RotationLike, V3, Vec3Like } from './types.ts';

let initPromise: Promise<void> | null = null;

/** Loads the Rapier WASM module (embedded; no network). Safe to call many times. */
export function initPhysics(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/** Gap the character controller keeps from obstacles. */
const CHAR_OFFSET = 0.02;
/** Seconds after walking off a ledge during which a jump is still allowed. */
const COYOTE_TIME = 0.12;
/** Steps a character contact stays alive without being re-detected (prevents enter/exit flicker). */
const CHAR_TOUCH_GRACE = 3;

export type BodyKind = 'dynamic' | 'fixed' | 'kinematic';

export interface CollisionInfo {
  /** Contact normal pointing from the other entity toward this one (normal.y > 0.5: we landed on top of it). */
  normal: Vector3;
  /** A world-space contact point, when known. */
  point: Vector3 | null;
  /** Relative speed of the two bodies when the contact started (m/s). */
  relativeSpeed: number;
}

export interface RaycastHit {
  entity: RuntimeEntity;
  point: Vector3;
  normal: Vector3;
  distance: number;
}

export interface QueryOptions {
  /** Ignore this entity's colliders (for example the caster itself). */
  exclude?: RuntimeEntity | null;
  /** Also hit trigger colliders (default false). */
  triggers?: boolean;
}

/** What the physics world needs from its owner. */
export interface PhysicsHost {
  /** Identity root object holding all entity objects. */
  readonly root: Object3D;
  modelInfo(entity: RuntimeEntity): ModelInfo | undefined;
  warnOnce(key: string, message: string): void;
  /** True while fixedUpdate hooks run. */
  inFixedPhase(): boolean;
}

interface CharacterState {
  controller: KinematicCharacterController;
  collider: RCollider;
  vy: number;
  grounded: boolean;
  jumped: boolean;
  airTime: number;
  jumpRequested: number | null;
  /** Horizontal velocity requested during fixedUpdate (consumed by the next step). */
  velFixed: Vector3;
  /** Horizontal velocity requested during update/lateUpdate (used until the next update phase). */
  velFrame: Vector3;
  velocity: Vector3;
  groundHandle: number | null;
  height: number;
  radius: number;
}

interface BodyRecord {
  entity: RuntimeEntity;
  body: RBody;
  kind: BodyKind | 'character';
  enabled: boolean;
  handles: number[];
  lastMatrix: Float64Array;
  kinematicVelocity: Vector3 | null;
  forces: boolean;
  rb: ComponentData | null;
  applied: { gravityScale: number; linearDamping: number; angularDamping: number; kind: string };
  char: CharacterState | null;
  /** Child entities whose colliders are attached to this body. */
  attached: RuntimeEntity[];
}

interface ColliderRecord {
  handle: number;
  collider: RCollider;
  /** Entity that owns the Collider component. */
  entity: RuntimeEntity;
  /** Body the collider is attached to. */
  owner: BodyRecord;
  sensor: boolean;
}

interface PairState {
  h1: number;
  h2: number;
  byEvent: boolean;
  charLast: number;
  /** Normal from the other collider toward the character collider (for character contacts). */
  charNormal: Vector3 | null;
  charHandle: number;
  charPoint: Vector3 | null;
  touching: boolean;
}

export interface ContactEvent {
  kind: 'trigger' | 'collision';
  enter: boolean;
  /** Entity owning collider A and the body entity it is attached to. */
  a: RuntimeEntity;
  aBody: RuntimeEntity;
  b: RuntimeEntity;
  bBody: RuntimeEntity;
  /** Collision info from A's point of view (null for triggers and exits). */
  info: CollisionInfo | null;
}

interface ShapeSpec {
  shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'cone';
  size: V3;
  radius: number;
  height: number;
  offset: V3;
}

const PRIMITIVE_SHAPES: Record<string, Omit<ShapeSpec, 'offset'>> = {
  box: { shape: 'box', size: [1, 1, 1], radius: 0.5, height: 1 },
  sphere: { shape: 'sphere', size: [1, 1, 1], radius: 0.5, height: 1 },
  cylinder: { shape: 'cylinder', size: [1, 1, 1], radius: 0.5, height: 1 },
  capsule: { shape: 'capsule', size: [1, 2, 1], radius: 0.5, height: 2 },
  cone: { shape: 'cone', size: [1, 1, 1], radius: 0.5, height: 1 },
  plane: { shape: 'box', size: [1, 0.02, 1], radius: 0.5, height: 0.02 },
  torus: { shape: 'cylinder', size: [1, 0.3, 1], radius: 0.5, height: 0.3 },
};

const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _p2 = new Vector3();
const _q2 = new Quaternion();
const _s2 = new Vector3();
const _m = new Matrix4();
const _v = new Vector3();

function pairKey(h1: number, h2: number): string {
  return h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`;
}

function sameMatrix(a: ArrayLike<number>, b: Float64Array, positionOnly: boolean): boolean {
  const eps = 1e-6;
  if (positionOnly) {
    return (
      Math.abs(a[12]! - b[12]!) <= eps && Math.abs(a[13]! - b[13]!) <= eps && Math.abs(a[14]! - b[14]!) <= eps
    );
  }
  // written so that NaN (forced resync) compares as different
  for (let i = 0; i < 16; i++) if (!(Math.abs(a[i]! - b[i]!) <= eps)) return false;
  return true;
}

function parseKind(kind: unknown): BodyKind {
  return kind === 'fixed' || kind === 'kinematic' ? kind : 'dynamic';
}

/**
 * Rapier physics for a World. Owns one Rapier world, maps colliders back to entities, syncs body and
 * entity transforms and turns Rapier events (plus character-controller hits) into enter/exit pairs.
 */
export class PhysicsWorld {
  readonly world: RWorld;
  readonly gravity: Vector3;
  private readonly queue: EventQueue;
  private readonly host: PhysicsHost;
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly attachedTo = new Map<string, { owner: BodyRecord; handles: number[] }>();
  private readonly colliders = new Map<number, ColliderRecord>();
  private readonly characters: BodyRecord[] = [];
  private readonly pairs = new Map<string, PairState>();
  private stepIndex = 0;
  /** New colliders are not in Rapier's broad phase (used by queries and the character controller) until a step runs. */
  private broadphaseDirty = true;
  /** Collision events produced by broad-phase refresh steps, processed with the next real step. */
  private pendingRaw: [number, number, boolean][] = [];

  constructor(host: PhysicsHost, gravity: V3, fixedDt: number) {
    this.host = host;
    this.gravity = new Vector3(...gravity);
    this.world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    this.world.timestep = fixedDt;
    this.queue = new RAPIER.EventQueue(true);
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
    this.bodies.clear();
    this.colliders.clear();
    this.pairs.clear();
    this.characters.length = 0;
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  // -------------------------------------------------------------------------------------------
  // Creation / removal
  // -------------------------------------------------------------------------------------------

  /** Creates the body/colliders for an entity. Call parent-first. */
  addEntity(entity: RuntimeEntity): void {
    const comps = entity.components;
    const cc = comps.find((c) => c.type === 'CharacterController');
    const rb = comps.find((c) => c.type === 'RigidBody') ?? null;
    let cols = comps.filter((c) => c.type === 'Collider');
    if (!cc && !rb && cols.length === 0) return;
    const obj = entity.object3d;
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(_p, _q, _s);
    const pos = _p.clone();
    const rot = _q.clone();
    const scale = new Vector3(Math.abs(_s.x) || 1e-4, Math.abs(_s.y) || 1e-4, Math.abs(_s.z) || 1e-4);

    if (cc) {
      this.addCharacter(entity, cc, rb, cols, pos, scale);
      return;
    }
    if (!rb) {
      const owner = this.movingAncestorBody(entity);
      if (owner) {
        this.attachColliders(owner, entity, cols);
        return;
      }
    }
    const kind: BodyKind = rb ? parseKind(rb.kind) : 'fixed';
    if (rb && cols.length === 0) {
      cols = [{ type: 'Collider', shape: 'auto' }];
      this.host.warnOnce(
        `rb-no-collider:${entity.id}`,
        `'${entity.name}' has a RigidBody but no Collider; using an automatic box collider. Add a Collider component to choose the shape.`,
      );
    }
    const desc =
      kind === 'dynamic'
        ? RAPIER.RigidBodyDesc.dynamic()
        : kind === 'kinematic'
          ? RAPIER.RigidBodyDesc.kinematicPositionBased()
          : RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(pos.x, pos.y, pos.z).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    const applied = { gravityScale: 1, linearDamping: 0, angularDamping: 0.05, kind: kind as string };
    if (rb) {
      applied.gravityScale = numOr(rb.gravityScale, 1);
      applied.linearDamping = numOr(rb.linearDamping, 0);
      applied.angularDamping = numOr(rb.angularDamping, 0.05);
      desc
        .setGravityScale(applied.gravityScale)
        .setLinearDamping(applied.linearDamping)
        .setAngularDamping(applied.angularDamping)
        .setCcdEnabled(!!rb.ccd);
      if (rb.lockRotation) desc.lockRotations();
    }
    const body = this.world.createRigidBody(desc);
    const rec: BodyRecord = {
      entity,
      body,
      kind,
      enabled: true,
      handles: [],
      lastMatrix: Float64Array.from(obj.matrixWorld.elements),
      kinematicVelocity: null,
      forces: false,
      rb,
      applied,
      char: null,
      attached: [],
    };
    const mass = kind === 'dynamic' ? Math.max(1e-3, numOr(rb?.mass, 1)) / cols.length : 0;
    for (const col of cols) {
      const spec = this.shapeSpec(entity, col);
      const cd = this.buildDesc(spec, scale);
      if (mass > 0) cd.setMass(mass);
      this.finishCollider(rec, entity, cd, col);
    }
    this.bodies.set(entity.id, rec);
    entity._body = new BodyApi(rec, this);
    if (!entity.activeInHierarchy) this.setEnabled(entity, false);
  }

  private movingAncestorBody(entity: RuntimeEntity): BodyRecord | null {
    let p = entity._parent;
    while (p) {
      const rec = this.bodies.get(p.id);
      if (rec) return rec.kind === 'dynamic' || rec.kind === 'kinematic' ? rec : null;
      p = p._parent;
    }
    return null;
  }

  /** Collider-only child of a moving body: attach its colliders to that body (compound collider). */
  private attachColliders(owner: BodyRecord, entity: RuntimeEntity, cols: ComponentData[]): void {
    const ownerObj = owner.entity.object3d;
    ownerObj.updateWorldMatrix(true, false);
    ownerObj.matrixWorld.decompose(_p2, _q2, _s2);
    const ownerPose = new Matrix4().compose(_p2, _q2, new Vector3(1, 1, 1));
    const obj = entity.object3d;
    obj.updateWorldMatrix(true, false);
    const rel = ownerPose.invert().multiply(obj.matrixWorld);
    const relPos = new Vector3();
    const relRot = new Quaternion();
    const relScale = new Vector3();
    rel.decompose(relPos, relRot, relScale);
    relScale.set(Math.abs(relScale.x) || 1e-4, Math.abs(relScale.y) || 1e-4, Math.abs(relScale.z) || 1e-4);
    const handles: number[] = [];
    const massEach = owner.kind === 'dynamic' ? 0.25 : 0;
    for (const col of cols) {
      const spec = this.shapeSpec(entity, col);
      const cd = this.buildDesc(spec, relScale);
      const off = new Vector3(
        spec.offset[0] * relScale.x,
        spec.offset[1] * relScale.y,
        spec.offset[2] * relScale.z,
      )
        .applyQuaternion(relRot)
        .add(relPos);
      cd.setTranslation(off.x, off.y, off.z).setRotation({
        x: relRot.x,
        y: relRot.y,
        z: relRot.z,
        w: relRot.w,
      });
      if (massEach > 0) cd.setMass(massEach);
      handles.push(this.finishCollider(owner, entity, cd, col));
    }
    owner.attached.push(entity);
    this.attachedTo.set(entity.id, { owner, handles });
  }

  private finishCollider(
    rec: BodyRecord,
    entity: RuntimeEntity,
    cd: ColliderDesc,
    col: ComponentData,
  ): number {
    const sensor = !!col.isTrigger;
    cd.setSensor(sensor)
      .setFriction(Math.max(0, numOr(col.friction, 0.5)))
      .setRestitution(Math.min(1, Math.max(0, numOr(col.restitution, 0))))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (sensor) {
      // Report kinematic/character and fixed pairs too, so a moving player walking into a static
      // (or script-moved) coin fires onTriggerEnter.
      cd.setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.DEFAULT |
          RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED |
          RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC,
      );
    }
    const collider = this.world.createCollider(cd, rec.body);
    this.broadphaseDirty = true;
    this.colliders.set(collider.handle, { handle: collider.handle, collider, entity, owner: rec, sensor });
    if (rec.entity === entity) rec.handles.push(collider.handle);
    return collider.handle;
  }

  private addCharacter(
    entity: RuntimeEntity,
    cc: ComponentData,
    rb: ComponentData | null,
    cols: ComponentData[],
    pos: Vector3,
    scale: Vector3,
  ): void {
    const height = Math.max(0.1, numOr(cc.height, 1.8) * scale.y);
    const radius = Math.min(height / 2, Math.max(0.05, numOr(cc.radius, 0.4) * Math.max(scale.x, scale.z)));
    // Models stand on y = 0, so the capsule's bottom sits at the entity origin. A centered primitive
    // (MeshRenderer primitive without a model) gets a centered capsule instead.
    const mr = entity.components.find((c) => c.type === 'MeshRenderer');
    const centered = !!mr && !mr.model && !!mr.primitive;
    const centerY = centered ? 0 : height / 2 + CHAR_OFFSET;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z),
    );
    const rec: BodyRecord = {
      entity,
      body,
      kind: 'character',
      enabled: true,
      handles: [],
      lastMatrix: Float64Array.from(entity.object3d.matrixWorld.elements),
      kinematicVelocity: null,
      forces: false,
      rb: null,
      applied: { gravityScale: 1, linearDamping: 0, angularDamping: 0, kind: 'character' },
      char: null,
      attached: [],
    };
    const cd = RAPIER.ColliderDesc.capsule(Math.max(1e-3, height / 2 - radius), radius)
      .setTranslation(0, centerY, 0)
      .setFriction(0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC,
      );
    const collider = this.world.createCollider(cd, body);
    this.broadphaseDirty = true;
    this.colliders.set(collider.handle, {
      handle: collider.handle,
      collider,
      entity,
      owner: rec,
      sensor: false,
    });
    rec.handles.push(collider.handle);

    const controller = this.world.createCharacterController(CHAR_OFFSET);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    const maxSlope = Math.min(89, Math.max(0, numOr(cc.maxSlope, 50))) * DEG;
    controller.setMaxSlopeClimbAngle(maxSlope);
    controller.setMinSlopeSlideAngle(maxSlope);
    const step = Math.max(0, numOr(cc.stepHeight, 0.35)) * scale.y;
    if (step > 0) controller.enableAutostep(step, Math.max(0.05, radius * 0.5), false);
    const snap = Math.max(0, numOr(cc.snapToGround, 0.3));
    if (snap > 0) controller.enableSnapToGround(snap);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(Math.max(0.1, numOr(rb?.mass, 1)));

    rec.char = {
      controller,
      collider,
      vy: 0,
      grounded: false,
      jumped: false,
      airTime: 0,
      jumpRequested: null,
      velFixed: new Vector3(),
      velFrame: new Vector3(),
      velocity: new Vector3(),
      groundHandle: null,
      height,
      radius,
    };
    if (rb) {
      this.host.warnOnce(
        `cc-rb:${entity.id}`,
        `'${entity.name}' has both a CharacterController and a RigidBody; the RigidBody is ignored (the character is moved with entity.character.move()).`,
      );
    }
    for (const col of cols) {
      if (!col.isTrigger) {
        this.host.warnOnce(
          `cc-col:${entity.id}`,
          `'${entity.name}': the CharacterController provides the collision capsule, so its solid Collider is ignored (trigger colliders are kept).`,
        );
        continue;
      }
      const spec = this.shapeSpec(entity, col);
      this.finishCollider(rec, entity, this.buildDesc(spec, scale), col);
    }
    this.bodies.set(entity.id, rec);
    this.characters.push(rec);
    entity._character = new CharacterApi(rec, this);
    entity._body = new BodyApi(rec, this);
    if (!entity.activeInHierarchy) this.setEnabled(entity, false);
  }

  /** Removes an entity's body (or attached colliders). */
  removeEntity(entity: RuntimeEntity): void {
    const rec = this.bodies.get(entity.id);
    if (rec) {
      for (const h of rec.handles) this.colliders.delete(h);
      for (const child of rec.attached) {
        const att = this.attachedTo.get(child.id);
        if (att) for (const h of att.handles) this.colliders.delete(h);
        this.attachedTo.delete(child.id);
      }
      if (rec.char) {
        this.world.removeCharacterController(rec.char.controller);
        this.characters.splice(this.characters.indexOf(rec), 1);
      }
      this.world.removeRigidBody(rec.body);
      this.bodies.delete(entity.id);
    }
    const att = this.attachedTo.get(entity.id);
    if (att) {
      for (const h of att.handles) {
        const c = this.colliders.get(h);
        if (c) this.world.removeCollider(c.collider, true);
        this.colliders.delete(h);
      }
      att.owner.attached = att.owner.attached.filter((e) => e !== entity);
      this.attachedTo.delete(entity.id);
    }
    entity._body = null;
    entity._character = null;
  }

  /** Enables/disables an entity's physics (inactive entities have none). */
  setEnabled(entity: RuntimeEntity, enabled: boolean): void {
    const rec = this.bodies.get(entity.id);
    if (rec && rec.enabled !== enabled) {
      rec.enabled = enabled;
      rec.body.setEnabled(enabled);
      if (enabled) {
        // resync from the transform when re-enabled
        rec.lastMatrix.fill(Number.NaN);
        this.broadphaseDirty = true;
      }
    }
    const att = this.attachedTo.get(entity.id);
    if (att) for (const h of att.handles) this.colliders.get(h)?.collider.setEnabled(enabled);
    if (enabled && att) this.broadphaseDirty = true;
  }

  /**
   * Puts new colliders into Rapier's broad phase with a zero-length step (nothing moves), so the
   * character controller and scene queries see them right away. Without this a character spawned on
   * the ground sinks into it on the first step and the controller never recovers cleanly.
   */
  private refreshBroadphase(): void {
    if (!this.broadphaseDirty) return;
    this.broadphaseDirty = false;
    const dt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step(this.queue);
    this.world.timestep = dt;
    this.queue.drainCollisionEvents((h1, h2, started) => {
      this.pendingRaw.push([h1, h2, started]);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------------------------

  private shapeSpec(entity: RuntimeEntity, col: ComponentData): ShapeSpec {
    const shape = String(col.shape ?? 'auto');
    const offset = vec3Or(col.offset, [0, 0, 0]);
    const info = this.host.modelInfo(entity);
    const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const boundsBox = (i: ModelInfo): ShapeSpec => ({
      shape: 'box',
      size: vec3Or(i.bounds.size, [1, 1, 1]),
      radius: 0.5,
      height: 1,
      offset: add(vec3Or(i.bounds.center, [0, 0, 0]), offset),
    });
    if (shape === 'auto') {
      if (info?.collider) return this.fromHint(info.collider, info, offset);
      if (info) return boundsBox(info);
      const mr = entity.components.find((c) => c.type === 'MeshRenderer');
      if (mr && !mr.model) {
        const prim = PRIMITIVE_SHAPES[String(mr.primitive ?? 'box')] ?? PRIMITIVE_SHAPES.box!;
        return { ...prim, size: [...prim.size], offset };
      }
      if (mr?.model) {
        this.host.warnOnce(
          `no-model-info:${String(mr.model)}`,
          `No bounds known for model '${String(mr.model)}' on '${entity.name}'; its 'auto' collider is a ${vec3Or(col.size, [1, 1, 1]).join('x')} box.`,
        );
      }
      return { shape: 'box', size: vec3Or(col.size, [1, 1, 1]), radius: 0.5, height: 1, offset };
    }
    if (shape === 'convex' || shape === 'mesh') {
      if (info) return boundsBox(info);
      this.host.warnOnce(
        `mesh-collider:${entity.id}`,
        `'${entity.name}': '${shape}' colliders are approximated by a box (no mesh data in the runtime); using size ${vec3Or(col.size, [1, 1, 1]).join('x')}.`,
      );
      return { shape: 'box', size: vec3Or(col.size, [1, 1, 1]), radius: 0.5, height: 1, offset };
    }
    const s = shape === 'sphere' || shape === 'capsule' || shape === 'cylinder' ? shape : 'box';
    return {
      shape: s,
      size: vec3Or(col.size, [1, 1, 1]),
      radius: Math.max(1e-3, numOr(col.radius, 0.5)),
      height: Math.max(1e-3, numOr(col.height, 1)),
      offset,
    };
  }

  private fromHint(hint: ColliderHint, info: ModelInfo, offset: V3): ShapeSpec {
    const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    if (hint.shape === 'convex' || hint.shape === 'mesh' || (hint.shape === 'box' && !hint.size)) {
      return {
        shape: 'box',
        size: vec3Or(info.bounds.size, [1, 1, 1]),
        radius: 0.5,
        height: 1,
        offset: add(
          hint.offset ? vec3Or(hint.offset, [0, 0, 0]) : vec3Or(info.bounds.center, [0, 0, 0]),
          offset,
        ),
      };
    }
    return {
      shape: hint.shape,
      size: vec3Or(hint.size, vec3Or(info.bounds.size, [1, 1, 1])),
      radius: Math.max(1e-3, numOr(hint.radius, 0.5)),
      height: Math.max(1e-3, numOr(hint.height, 1)),
      offset: add(vec3Or(hint.offset, [0, 0, 0]), offset),
    };
  }

  private buildDesc(spec: ShapeSpec, s: Vector3): ColliderDesc {
    const min = 1e-3;
    const rXZ = Math.max(s.x, s.z);
    let cd: ColliderDesc;
    switch (spec.shape) {
      case 'sphere':
        cd = RAPIER.ColliderDesc.ball(Math.max(min, spec.radius * Math.max(s.x, s.y, s.z)));
        break;
      case 'capsule': {
        const r = Math.max(min, spec.radius * rXZ);
        const h = spec.height * s.y;
        cd = RAPIER.ColliderDesc.capsule(Math.max(min, h / 2 - r), r);
        break;
      }
      case 'cylinder':
        cd = RAPIER.ColliderDesc.cylinder(
          Math.max(min, (spec.height * s.y) / 2),
          Math.max(min, spec.radius * rXZ),
        );
        break;
      case 'cone':
        cd = RAPIER.ColliderDesc.cone(
          Math.max(min, (spec.height * s.y) / 2),
          Math.max(min, spec.radius * rXZ),
        );
        break;
      default:
        cd = RAPIER.ColliderDesc.cuboid(
          Math.max(min, (Math.abs(spec.size[0]) * s.x) / 2),
          Math.max(min, (Math.abs(spec.size[1]) * s.y) / 2),
          Math.max(min, (Math.abs(spec.size[2]) * s.z) / 2),
        );
    }
    cd.setTranslation(spec.offset[0] * s.x, spec.offset[1] * s.y, spec.offset[2] * s.z);
    return cd;
  }

  // -------------------------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------------------------

  /** Clears horizontal velocities requested in update() (called at the start of the update phase). */
  beginUpdatePhase(): void {
    for (const rec of this.characters) rec.char!.velFrame.set(0, 0, 0);
  }

  /**
   * Pushes script-driven transform changes into Rapier and moves characters. The caller must have
   * updated world matrices (root.updateMatrixWorld()).
   */
  preStep(dt: number): void {
    this.refreshBroadphase();
    for (const rec of this.bodies.values()) {
      if (!rec.enabled) continue;
      const obj = rec.entity.object3d;
      if (rec.kinematicVelocity && rec.kind === 'kinematic') {
        const v = rec.kinematicVelocity;
        obj.getWorldPosition(_p);
        rec.entity.worldPosition = _p.addScaledVector(v, dt);
        obj.updateWorldMatrix(true, false);
      }
      if (rec.rb) this.syncBodyProps(rec);
      const m = obj.matrixWorld.elements;
      if (sameMatrix(m, rec.lastMatrix, rec.kind === 'character')) continue;
      obj.matrixWorld.decompose(_p, _q, _s);
      const t = { x: _p.x, y: _p.y, z: _p.z };
      const r = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
      const first = Number.isNaN(rec.lastMatrix[0]!);
      if (rec.kind === 'fixed' && !first) {
        // A script moves a static collider: turn it into a kinematic body so it moves smoothly and
        // pushes/carries things.
        rec.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        rec.kind = 'kinematic';
      }
      switch (rec.kind) {
        case 'kinematic':
          if (first) {
            rec.body.setTranslation(t, true);
            rec.body.setRotation(r, true);
          } else {
            rec.body.setNextKinematicTranslation(t);
            rec.body.setNextKinematicRotation(r);
          }
          break;
        case 'character':
          rec.body.setTranslation(t, true);
          rec.char!.vy = 0;
          break;
        default:
          rec.body.setTranslation(t, true);
          rec.body.setRotation(r, true);
      }
      rec.lastMatrix.set(m);
    }
    for (const rec of this.characters) if (rec.enabled) this.moveCharacter(rec, dt);
  }

  private syncBodyProps(rec: BodyRecord): void {
    const rb = rec.rb!;
    const a = rec.applied;
    const gs = numOr(rb.gravityScale, 1);
    if (gs !== a.gravityScale) rec.body.setGravityScale((a.gravityScale = gs), true);
    const ld = numOr(rb.linearDamping, 0);
    if (ld !== a.linearDamping) rec.body.setLinearDamping((a.linearDamping = ld));
    const ad = numOr(rb.angularDamping, 0.05);
    if (ad !== a.angularDamping) rec.body.setAngularDamping((a.angularDamping = ad));
    const kind = parseKind(rb.kind);
    if (kind !== a.kind) {
      a.kind = kind;
      rec.kind = kind;
      rec.body.setBodyType(
        kind === 'dynamic'
          ? RAPIER.RigidBodyType.Dynamic
          : kind === 'kinematic'
            ? RAPIER.RigidBodyType.KinematicPositionBased
            : RAPIER.RigidBodyType.Fixed,
        true,
      );
    }
  }

  private moveCharacter(rec: BodyRecord, dt: number): void {
    const ch = rec.char!;
    const body = rec.body;
    const cur = body.translation();
    ch.vy += this.gravity.y * dt;
    if (ch.jumpRequested !== null) {
      ch.vy = ch.jumpRequested;
      ch.jumpRequested = null;
      ch.grounded = false;
    }
    let dx = (ch.velFixed.x + ch.velFrame.x) * dt;
    let dy = ch.vy * dt;
    let dz = (ch.velFixed.z + ch.velFrame.z) * dt;
    ch.velFixed.set(0, 0, 0);
    // Ride kinematic platforms we stand on.
    let carryY = 0;
    if (ch.groundHandle !== null) {
      const g = this.colliders.get(ch.groundHandle);
      if (g && g.owner.kind === 'kinematic' && g.owner.enabled) {
        const n = g.owner.body.nextTranslation();
        const c = g.owner.body.translation();
        dx += n.x - c.x;
        dy += n.y - c.y;
        dz += n.z - c.z;
        carryY = n.y - c.y;
      }
    }
    const controller = ch.controller;
    controller.computeColliderMovement(
      ch.collider,
      { x: dx, y: dy, z: dz },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const mv = controller.computedMovement();
    const grounded = controller.computedGrounded();
    let ground: number | null = null;
    const n = controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = controller.computedCollision(i);
      const other = c?.collider;
      if (!c || !other) continue;
      const normal = new Vector3(c.normal1.x, c.normal1.y, c.normal1.z);
      if (normal.y > 0.7) ground = other.handle;
      this.touchFromCharacter(ch.collider.handle, other.handle, normal, c.witness1);
    }
    ch.groundHandle = grounded ? (ground ?? ch.groundHandle) : ground;
    if (grounded && ch.vy < 0) ch.vy = 0;
    if (ch.vy > 0 && mv.y - carryY < ch.vy * dt * 0.5) ch.vy = 0; // bumped the head
    body.setNextKinematicTranslation({ x: cur.x + mv.x, y: cur.y + mv.y, z: cur.z + mv.z });
    ch.velocity.set(mv.x / dt, mv.y / dt, mv.z / dt);
    ch.grounded = grounded;
    if (grounded) {
      ch.airTime = 0;
      ch.jumped = false;
    } else ch.airTime += dt;
  }

  private touchFromCharacter(
    hChar: number,
    hOther: number,
    normal: Vector3,
    point: { x: number; y: number; z: number },
  ) {
    const key = pairKey(hChar, hOther);
    let st = this.pairs.get(key);
    if (!st) {
      st = this.newPair(hChar, hOther);
      this.pairs.set(key, st);
    }
    st.charLast = this.stepIndex;
    st.charHandle = hChar;
    st.charNormal = normal;
    st.charPoint = new Vector3(point.x, point.y, point.z);
  }

  private newPair(h1: number, h2: number): PairState {
    return {
      h1: Math.min(h1, h2),
      h2: Math.max(h1, h2),
      byEvent: false,
      charLast: -1e9,
      charNormal: null,
      charHandle: -1,
      charPoint: null,
      touching: false,
    };
  }

  /** Runs one Rapier step and returns the contact/trigger enter/exit events it produced. */
  step(): ContactEvent[] {
    this.world.step(this.queue);
    this.stepIndex++;
    const raw = this.pendingRaw;
    this.pendingRaw = [];
    this.queue.drainCollisionEvents((h1, h2, started) => {
      raw.push([h1, h2, started]);
    });
    for (const [h1, h2, started] of raw) {
      const key = pairKey(h1, h2);
      let st = this.pairs.get(key);
      if (!st) {
        if (!started) continue;
        st = this.newPair(h1, h2);
        this.pairs.set(key, st);
      }
      st.byEvent = started;
    }
    return this.evaluatePairs();
  }

  private evaluatePairs(): ContactEvent[] {
    const out: ContactEvent[] = [];
    for (const [key, st] of this.pairs) {
      const a = this.colliders.get(st.h1);
      const b = this.colliders.get(st.h2);
      if (!a || !b) {
        this.pairs.delete(key);
        continue;
      }
      const alive = a.owner.enabled && b.owner.enabled;
      const touching = alive && (st.byEvent || this.stepIndex - st.charLast <= CHAR_TOUCH_GRACE);
      if (touching !== st.touching) {
        st.touching = touching;
        const sensor = a.sensor || b.sensor;
        out.push({
          kind: sensor ? 'trigger' : 'collision',
          enter: touching,
          a: a.entity,
          aBody: a.owner.entity,
          b: b.entity,
          bBody: b.owner.entity,
          info: touching && !sensor ? this.contactInfo(st, a, b) : null,
        });
      }
      if (!touching) this.pairs.delete(key);
    }
    return out;
  }

  private velocityOf(rec: BodyRecord): Vector3 {
    if (rec.char) return rec.char.velocity.clone();
    if (rec.kind === 'dynamic') {
      const v = rec.body.linvel();
      return new Vector3(v.x, v.y, v.z);
    }
    return rec.kinematicVelocity?.clone() ?? new Vector3();
  }

  private contactInfo(st: PairState, a: ColliderRecord, b: ColliderRecord): CollisionInfo {
    const relativeSpeed = this.velocityOf(a.owner).sub(this.velocityOf(b.owner)).length();
    let normal: Vector3 | null = null;
    let point: Vector3 | null = null;
    if (st.charNormal && this.stepIndex - st.charLast <= CHAR_TOUCH_GRACE) {
      normal = st.charHandle === a.handle ? st.charNormal.clone() : st.charNormal.clone().negate();
      point = st.charPoint?.clone() ?? null;
    } else {
      this.world.contactPair(a.collider, b.collider, (manifold, flipped) => {
        if (normal) return;
        const n = manifold.normal();
        // n points from the manifold's first collider to its second; we want "from b toward a".
        normal = new Vector3(n.x, n.y, n.z).multiplyScalar(flipped ? 1 : -1);
        if (manifold.numSolverContacts() > 0) {
          const p = manifold.solverContactPoint(0);
          if (p) point = new Vector3(p.x, p.y, p.z);
        }
      });
    }
    const nn = normal as Vector3 | null;
    return {
      normal: nn && nn.lengthSq() > 1e-12 ? nn.normalize() : new Vector3(0, 1, 0),
      point,
      relativeSpeed,
    };
  }

  /**
   * Writes dynamic and character body poses back to their entities (as local transforms under the
   * entity's parent).
   */
  postStep(): void {
    for (const rec of this.bodies.values()) {
      if (!rec.enabled) continue;
      const obj = rec.entity.object3d;
      if (rec.kind === 'dynamic') {
        if (rec.forces) {
          rec.body.resetForces(false);
          rec.body.resetTorques(false);
          rec.forces = false;
        }
        if (rec.body.isSleeping()) continue;
        this.writeWorldPose(obj, rec.body.translation(), rec.body.rotation());
      } else if (rec.kind === 'character') {
        this.writeWorldPose(obj, rec.body.translation(), null);
      } else continue;
      obj.updateWorldMatrix(true, false);
      rec.lastMatrix.set(obj.matrixWorld.elements);
    }
  }

  private writeWorldPose(
    obj: Object3D,
    t: { x: number; y: number; z: number },
    r: { x: number; y: number; z: number; w: number } | null,
  ): void {
    const parent = obj.parent;
    if (!parent || parent === this.host.root) {
      obj.position.set(t.x, t.y, t.z);
      if (r) obj.quaternion.set(r.x, r.y, r.z, r.w);
      return;
    }
    parent.updateWorldMatrix(true, false);
    _m.copy(parent.matrixWorld).invert();
    obj.position.set(t.x, t.y, t.z).applyMatrix4(_m);
    if (r) {
      parent.matrixWorld.decompose(_p2, _q2, _s2);
      obj.quaternion.set(r.x, r.y, r.z, r.w).premultiply(_q2.invert());
    }
  }

  /** Calls fn for every dynamic body and character (used for the kill-height check). */
  forEachMoving(fn: (entity: RuntimeEntity, y: number) => void): void {
    for (const rec of this.bodies.values()) {
      if (!rec.enabled || (rec.kind !== 'dynamic' && rec.kind !== 'character')) continue;
      fn(rec.entity, rec.body.translation().y);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Teleport / queries
  // -------------------------------------------------------------------------------------------

  /** Instantly moves an entity's body (and the entity) to a world pose and stops it. */
  teleport(entity: RuntimeEntity, position: Vector3, rotation: Quaternion | null): void {
    entity.worldPosition = position;
    if (rotation) entity.worldQuaternion = rotation;
    const rec = this.bodies.get(entity.id);
    if (!rec) return;
    const obj = entity.object3d;
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(_p, _q, _s);
    rec.body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, true);
    if (rec.kind !== 'character') rec.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    if (rec.kind === 'dynamic') {
      rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (rec.char) {
      rec.char.vy = 0;
      rec.char.velocity.set(0, 0, 0);
      rec.char.groundHandle = null;
    }
    rec.lastMatrix.set(obj.matrixWorld.elements);
  }

  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance = 100,
    opts: QueryOptions = {},
  ): RaycastHit | null {
    const o = readVec3(origin, new Vector3(), 'raycast origin');
    const d = readVec3(direction, new Vector3(), 'raycast direction');
    if (d.lengthSq() < 1e-12) return null;
    d.normalize();
    this.refreshBroadphase();
    const ray = new RAPIER.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const flags = opts.triggers ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const exclude = opts.exclude ? this.excludePredicate(opts.exclude) : undefined;
    const hit = this.world.castRayAndGetNormal(
      ray,
      Math.max(0, maxDistance),
      true,
      flags,
      undefined,
      undefined,
      undefined,
      exclude,
    );
    if (!hit) return null;
    const rec = this.colliders.get(hit.collider.handle);
    if (!rec) return null;
    return {
      entity: rec.entity,
      point: o.clone().addScaledVector(d, hit.timeOfImpact),
      normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
    };
  }

  overlapSphere(center: Vec3Like, radius: number, opts: QueryOptions = {}): RuntimeEntity[] {
    const c = readVec3(center, new Vector3(), 'overlapSphere center');
    this.refreshBroadphase();
    const shape = new RAPIER.Ball(Math.max(1e-3, radius));
    const out: RuntimeEntity[] = [];
    const seen = new Set<RuntimeEntity>();
    const flags = opts.triggers ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const exclude = opts.exclude ? this.excludePredicate(opts.exclude) : undefined;
    this.world.intersectionsWithShape(
      { x: c.x, y: c.y, z: c.z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      (col) => {
        const rec = this.colliders.get(col.handle);
        if (rec && !seen.has(rec.entity) && !rec.entity.destroyed) {
          seen.add(rec.entity);
          out.push(rec.entity);
        }
        return true;
      },
      flags,
      undefined,
      undefined,
      undefined,
      exclude,
    );
    return out;
  }

  private excludePredicate(entity: RuntimeEntity): (c: RCollider) => boolean {
    return (c) => {
      const rec = this.colliders.get(c.handle);
      return !rec || (rec.entity !== entity && rec.owner.entity !== entity);
    };
  }

  /** @internal */ _warnOnce(key: string, message: string): void {
    this.host.warnOnce(key, message);
  }
  /** @internal */ _inFixedPhase(): boolean {
    return this.host.inFixedPhase();
  }
}

/** `entity.body`: velocity, impulses and forces for bodies created from RigidBody/Collider components. */
export class BodyApi {
  private readonly rec: BodyRecord;
  private readonly phys: PhysicsWorld;

  constructor(rec: BodyRecord, phys: PhysicsWorld) {
    this.rec = rec;
    this.phys = phys;
  }

  /** 'dynamic', 'fixed' or 'kinematic' (characters report 'kinematic'). */
  get kind(): BodyKind {
    return this.rec.kind === 'character' ? 'kinematic' : this.rec.kind;
  }

  /** Linear velocity in m/s (a copy). Assign to change it. Kinematic bodies move by it every step. */
  get velocity(): Vector3 {
    const r = this.rec;
    if (r.char) return r.char.velocity.clone();
    if (r.kind === 'dynamic') {
      const v = r.body.linvel();
      return new Vector3(v.x, v.y, v.z);
    }
    return r.kinematicVelocity?.clone() ?? new Vector3();
  }
  set velocity(v: Vec3Like) {
    const r = this.rec;
    const vel = readVec3(v, new Vector3(), 'velocity');
    if (r.char) {
      r.char.vy = vel.y;
      (this.phys._inFixedPhase() ? r.char.velFixed : r.char.velFrame).set(vel.x, 0, vel.z);
    } else if (r.kind === 'dynamic') r.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    else if (r.kind === 'kinematic') r.kinematicVelocity = vel.lengthSq() > 0 ? vel : null;
    else
      this.phys._warnOnce(
        `fixed-vel:${r.entity.id}`,
        `'${r.entity.name}' has a fixed body, so setting its velocity does nothing. Use RigidBody kind 'dynamic' or 'kinematic'.`,
      );
  }

  /** Angular velocity in radians per second (a copy). */
  get angularVelocity(): Vector3 {
    const w = this.rec.body.angvel();
    return new Vector3(w.x, w.y, w.z);
  }
  set angularVelocity(v: Vec3Like) {
    const w = readVec3(v, _v, 'angularVelocity');
    if (this.rec.kind === 'dynamic') this.rec.body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
  }

  get mass(): number {
    return this.rec.body.mass();
  }

  get gravityScale(): number {
    return this.rec.body.gravityScale();
  }
  set gravityScale(v: number) {
    this.rec.body.setGravityScale(v, true);
    this.rec.applied.gravityScale = v;
    if (this.rec.rb) this.rec.rb.gravityScale = v;
  }

  get sleeping(): boolean {
    return this.rec.body.isSleeping();
  }

  /** Instant change of momentum (N*s). Dynamic bodies only (characters: vertical part only). */
  applyImpulse(impulse: Vec3Like): void {
    const i = readVec3(impulse, _v, 'impulse');
    const r = this.rec;
    if (r.char) r.char.vy += i.y;
    else if (r.kind === 'dynamic') r.body.applyImpulse({ x: i.x, y: i.y, z: i.z }, true);
    else this.notDynamic('applyImpulse');
  }

  /** Force (N) applied during the next physics step. Call every fixedUpdate for a continuous push. */
  applyForce(force: Vec3Like): void {
    const f = readVec3(force, _v, 'force');
    const r = this.rec;
    if (r.kind !== 'dynamic') {
      this.notDynamic('applyForce');
      return;
    }
    r.body.addForce({ x: f.x, y: f.y, z: f.z }, true);
    r.forces = true;
  }

  applyTorqueImpulse(torque: Vec3Like): void {
    const t = readVec3(torque, _v, 'torque');
    if (this.rec.kind !== 'dynamic') {
      this.notDynamic('applyTorqueImpulse');
      return;
    }
    this.rec.body.applyTorqueImpulse({ x: t.x, y: t.y, z: t.z }, true);
  }

  /** Teleports the body (and entity) to a world position and stops it. */
  setPosition(position: Vec3Like): void {
    this.phys.teleport(this.rec.entity, readVec3(position, new Vector3(), 'position'), null);
  }

  /** Teleports the body's rotation (Euler degrees, Quaternion or three.js Euler). */
  setRotation(rotation: RotationLike): void {
    this.phys.teleport(
      this.rec.entity,
      this.rec.entity.worldPosition,
      readRotation(rotation, new Quaternion()),
    );
  }

  wakeUp(): void {
    this.rec.body.wakeUp();
  }

  private notDynamic(what: string): void {
    this.phys._warnOnce(
      `not-dynamic:${what}:${this.rec.entity.id}`,
      `${what} only affects dynamic bodies; '${this.rec.entity.name}' is ${this.kind}. Set RigidBody kind to 'dynamic'.`,
    );
  }
}

/** `entity.character`: moves a CharacterController (a kinematic capsule that walks, steps and slides). */
export class CharacterApi {
  private readonly rec: BodyRecord;
  private readonly phys: PhysicsWorld;

  constructor(rec: BodyRecord, phys: PhysicsWorld) {
    this.rec = rec;
    this.phys = phys;
  }

  private get ch(): CharacterState {
    return this.rec.char!;
  }

  /**
   * Walks with a horizontal velocity in m/s (x/z; y is ignored, gravity is applied internally).
   * Call it every frame from update() (or fixedUpdate()). Several calls in one frame add up.
   * `dt` is accepted for compatibility; the physics step uses its own fixed timestep.
   */
  move(velocity: Vec3Like, _dt?: number): void {
    const v = readVec3(velocity, _v, 'velocity');
    const target = this.phys._inFixedPhase() ? this.ch.velFixed : this.ch.velFrame;
    target.x += v.x;
    target.z += v.z;
  }

  /** Jumps with an upward speed (m/s) if grounded (or just walked off a ledge). Returns true if it jumped. */
  jump(speed = 8): boolean {
    const ch = this.ch;
    if (ch.jumpRequested !== null || ch.jumped) return false;
    if (!ch.grounded && ch.airTime > COYOTE_TIME) return false;
    ch.jumpRequested = speed;
    ch.jumped = true;
    return true;
  }

  /** Standing on something. */
  get grounded(): boolean {
    return this.ch.grounded;
  }

  /** Actual velocity during the last physics step (m/s, a copy). */
  get velocity(): Vector3 {
    return this.ch.velocity.clone();
  }

  /** Vertical speed (m/s); positive is up. */
  get verticalSpeed(): number {
    return this.ch.vy;
  }
  set verticalSpeed(v: number) {
    this.ch.vy = v;
  }

  get height(): number {
    return this.ch.height;
  }
  get radius(): number {
    return this.ch.radius;
  }

  /** Instantly moves the character to a world position. */
  teleport(position: Vec3Like): void {
    this.phys.teleport(this.rec.entity, readVec3(position, new Vector3(), 'position'), null);
  }
}
