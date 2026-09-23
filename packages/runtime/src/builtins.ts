import { Quaternion, Vector3 } from 'three';
import { Behaviour, type BehaviourClass } from './behaviour.ts';
import type { RuntimeEntity } from './entity.ts';
import { numOr, round, vec3Or } from './math.ts';
import { Audio, Game, Input, Physics, UI } from './singletons.ts';
import type { SfxPreset } from './types.ts';

const UP = new Vector3(0, 1, 0);

/** The entity itself or its nearest ancestor carrying `tag` (so a collider child of the Player counts). */
function taggedSelfOrAncestor(e: RuntimeEntity | null, tag: string): RuntimeEntity | null {
  let cur = e;
  while (cur) {
    if (cur.hasTag(tag)) return cur;
    cur = cur.parent;
  }
  return null;
}

function formatValue(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(round(v, 2));
  if (v === undefined || v === null) return '0';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Spins the entity. props: speed = degrees per second per axis [x, y, z] (a number spins around Y). */
export class Rotator extends Behaviour {
  static override props: Record<string, unknown> = { speed: [0, 90, 0], space: 'self' };
  override update(dt: number): void {
    const s = this.props.speed;
    const v = typeof s === 'number' ? [0, s, 0] : vec3Or(s, [0, 90, 0]);
    this.entity.rotate([v[0]! * dt, v[1]! * dt, v[2]! * dt], this.props.space === 'world' ? 'world' : 'self');
  }
}

/** Alias of Rotator. */
export const Spinner = Rotator;

/** Bobs the entity up and down. props: height (m), speed (radians per second). */
export class Bobber extends Behaviour {
  static override props: Record<string, unknown> = { height: 0.25, speed: 2 };
  private baseY = 0;
  private t = 0;
  override start(): void {
    this.baseY = this.entity.position.y;
    const p = this.entity.worldPosition;
    this.t = (p.x + p.z) * 0.37; // de-sync neighbours, deterministically
  }
  override update(dt: number): void {
    this.t += dt;
    const h = numOr(this.props.height, 0.25);
    this.entity.position.y = this.baseY + Math.sin(this.t * numOr(this.props.speed, 2)) * h;
  }
}

const JUMP_BUFFER_SECONDS = 0.15;

/**
 * Third-person movement from the move_x / move_y axes, 'sprint' and 'jump' actions. Uses the entity's
 * CharacterController when present (else a dynamic RigidBody, else moves the transform), faces the
 * movement direction, and moves relative to the primary camera: move_y > 0 walks away from the camera.
 */
export class PlayerController extends Behaviour {
  static override props: Record<string, unknown> = {
    speed: 6,
    sprintMultiplier: 1.6,
    jumpSpeed: 9,
    turnSpeed: 12,
    cameraRelative: true,
    respawnOnFall: true,
  };
  private vy = 0;
  private baseY = 0;
  private jumpBuffer = 0;
  /** Last movement direction (world space, unit length or zero). */
  readonly moveDirection = new Vector3();

  override start(): void {
    this.baseY = this.entity.position.y;
  }

  override update(dt: number): void {
    const p = this.props;
    const { x, y } = Input.vector('move_x', 'move_y');
    const dir = this.moveDirection.set(0, 0, 0);
    if (x !== 0 || y !== 0) {
      const cam = p.cameraRelative ? this.world.primaryCamera() : null;
      if (cam && cam !== this.entity) {
        const fwd = cam.forward.setY(0);
        if (fwd.lengthSq() < 1e-6) fwd.copy(cam.up).setY(0); // looking straight down: screen-up
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new Vector3(-fwd.z, 0, fwd.x); // forward x up
        dir.addScaledVector(right, x).addScaledVector(fwd, y);
      } else {
        dir.set(x, 0, -y);
      }
    }
    const sprint = numOr(p.sprintMultiplier, 1.6);
    const speed = numOr(p.speed, 6) * (Input.held('sprint') ? sprint : 1);
    const vel = dir.clone().multiplyScalar(speed);
    // Jump buffering: a press shortly before landing still jumps (feels right, and makes scripted
    // play-tests robust to small timing errors).
    if (Input.pressed('jump')) this.jumpBuffer = JUMP_BUFFER_SECONDS;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    const jump = this.jumpBuffer > 0;
    const jumpSpeed = numOr(p.jumpSpeed, 9);
    const ch = this.entity.character;
    const body = this.entity.body;
    if (ch) {
      ch.move(vel, dt);
      if (jump && ch.jump(jumpSpeed)) this.jumpBuffer = 0;
    } else if (body && body.kind === 'dynamic') {
      const v = body.velocity;
      v.x = vel.x;
      v.z = vel.z;
      if (jump && this.groundedByRay()) v.y = jumpSpeed;
      body.velocity = v;
    } else {
      this.entity.translate(vel.multiplyScalar(dt), 'world');
      // simple jump without physics: lands back at the starting height
      const pos = this.entity.position;
      if (jump && pos.y <= this.baseY + 1e-3) this.vy = jumpSpeed;
      if (this.vy !== 0 || pos.y > this.baseY) {
        this.vy += Physics.gravity.y * dt;
        pos.y += this.vy * dt;
        if (pos.y <= this.baseY) {
          pos.y = this.baseY;
          this.vy = 0;
        }
      }
    }
    const turn = numOr(p.turnSpeed, 12);
    if (dir.lengthSq() > 1e-4 && turn > 0) {
      const target = new Quaternion().setFromAxisAngle(UP, Math.atan2(dir.x, dir.z));
      this.entity.quaternion.slerp(target, 1 - Math.exp(-turn * dt));
    }
  }

  private groundedByRay(): boolean {
    const s = this.entity.worldScale;
    const hit = Physics.raycast(this.entity.worldPosition, [0, -1, 0], Math.abs(s.y) * 0.5 + 0.15, {
      exclude: this.entity,
    });
    return !!hit;
  }

  override onFall(): void {
    if (this.props.respawnOnFall === false) return;
    this.entity.respawn();
    this.vy = 0;
    Game.emit('respawn', { entity: this.entity.name, reason: 'fall' });
  }
}

/**
 * Smoothly follows a target (entity name/id or tag; falls back to the 'Player' tag) from a world-space
 * offset and looks at it. Put it on the camera.
 */
export class FollowCamera extends Behaviour {
  static override props: Record<string, unknown> = {
    target: 'Player',
    offset: [0, 5, 9],
    smooth: 6,
    lookAtOffset: [0, 1, 0],
  };
  private target: RuntimeEntity | null = null;

  private resolveTarget(): RuntimeEntity | null {
    if (this.target?.alive) return this.target;
    const ref = this.props.target;
    let e: RuntimeEntity | null = null;
    if (ref && typeof ref === 'object' && (ref as RuntimeEntity).isRuntimeEntity) e = ref as RuntimeEntity;
    else if (typeof ref === 'string' && ref) {
      e = this.world.find(ref, { quiet: true }) ?? this.world.findAll({ tag: ref })[0] ?? null;
    }
    e ??= this.world.findAll({ tag: 'Player' })[0] ?? null;
    if (!e) {
      this.world.warnOnce(
        `follow:${this.entity.id}`,
        `FollowCamera on '${this.entity.name}': target '${String(ref)}' not found (no entity with that name, id or tag).`,
      );
    }
    this.target = e;
    return e;
  }

  override start(): void {
    this.follow(0, true);
  }

  override lateUpdate(dt: number): void {
    this.follow(dt, false);
  }

  private follow(dt: number, snap: boolean): void {
    const target = this.resolveTarget();
    if (!target) return;
    const tp = target.worldPosition;
    const desired = tp.clone().add(new Vector3(...vec3Or(this.props.offset, [0, 5, 9])));
    const smooth = numOr(this.props.smooth, 6);
    const k = snap || !(smooth > 0) ? 1 : 1 - Math.exp(-smooth * dt);
    this.entity.worldPosition = this.entity.worldPosition.lerp(desired, k);
    this.entity.lookAt(tp.add(new Vector3(...vec3Or(this.props.lookAtOffset, [0, 1, 0]))));
  }
}

/**
 * A pickup. When an entity tagged `playerTag` touches it: adds `value` to Game.state[scoreKey], emits
 * 'collect', plays `sfx` and destroys itself. Emits 'allCollected' when none of its kind are left
 * (same first tag, or any Collectible if it has no tags). Give it a trigger Collider.
 */
export class Collectible extends Behaviour {
  static override props: Record<string, unknown> = {
    scoreKey: 'score',
    value: 1,
    sfx: 'coin',
    playerTag: 'Player',
    spin: true,
  };
  private collected = false;

  override update(dt: number): void {
    if (this.props.spin) this.entity.rotate([0, 120 * dt, 0], 'world');
  }

  override onTriggerEnter(other: RuntimeEntity): void {
    this.collect(other);
  }

  override onCollisionEnter(other: RuntimeEntity): void {
    this.collect(other);
  }

  private collect(other: RuntimeEntity): void {
    if (this.collected || this.entity.destroyed) return;
    const tag = String(this.props.playerTag ?? 'Player');
    const player = taggedSelfOrAncestor(other, tag);
    if (!player) return;
    this.collected = true;
    const key = String(this.props.scoreKey || 'score');
    const value = numOr(this.props.value, 1);
    const total = (Number(Game.state[key]) || 0) + value;
    Game.state[key] = total;
    Game.emit('collect', {
      entity: this.entity.name,
      id: this.entity.id,
      by: player.name,
      scoreKey: key,
      value,
      total,
    });
    if (this.props.sfx) Audio.sfx(this.props.sfx as SfxPreset);
    this.entity.destroy();
    const kind = this.entity.tags[0];
    const remaining = kind
      ? this.world.findAll({ tag: kind }).length
      : this.world.findAll().filter((e) => e.getScript(Collectible)).length;
    if (remaining === 0) Game.emit('allCollected', { scoreKey: key, total, tag: kind ?? null });
  }
}

/** Keeps a HUD text in sync with Game.state. format: 'Score: {score}' ({key} = Game.state[key]). */
export class HudText extends Behaviour {
  static override props: Record<string, unknown> = { id: 'score', format: 'Score: {score}' };
  private last: string | null = null;

  override start(): void {
    this.refresh();
  }

  override update(): void {
    this.refresh();
  }

  private refresh(): void {
    const format = String(this.props.format ?? '');
    const state = Game.state;
    const text = format.replace(/\{(\w+)\}/g, (_, k: string) => formatValue(state[k]));
    if (text === this.last) return;
    this.last = text;
    // Prefer this entity's own UIText; otherwise the element named by `id`.
    UI.text(this.world.hudKeyOf(this.entity) ?? String(this.props.id ?? 'score'), text);
  }
}

/**
 * Wins the game when the player touches it. requireAll: a tag ('Coin') that must be fully collected
 * first (true = every Collectible), or null.
 */
export class Goal extends Behaviour {
  static override props: Record<string, unknown> = {
    playerTag: 'Player',
    requireAll: null,
    message: 'You win!',
  };

  override onTriggerEnter(other: RuntimeEntity): void {
    this.reach(other);
  }

  override onCollisionEnter(other: RuntimeEntity): void {
    this.reach(other);
  }

  private reach(other: RuntimeEntity): void {
    if (Game.over || !taggedSelfOrAncestor(other, String(this.props.playerTag ?? 'Player'))) return;
    const req = this.props.requireAll;
    if (req) {
      const left =
        typeof req === 'string'
          ? this.world.findAll({ tag: req }).length
          : this.world.findAll().filter((e) => e.getScript(Collectible)).length;
      if (left > 0) {
        Game.emit('goalLocked', { remaining: left, tag: typeof req === 'string' ? req : null });
        this.log(`Goal is locked: ${left} ${typeof req === 'string' ? req : 'collectible'}(s) left.`);
        return;
      }
    }
    Game.win(String(this.props.message ?? 'You win!'));
  }
}

/** Hurts the player on touch. action 'respawn' (default) sends it back to its spawn point, 'lose' ends the game. */
export class Hazard extends Behaviour {
  static override props: Record<string, unknown> = {
    playerTag: 'Player',
    action: 'respawn',
    message: 'You died!',
    sfx: 'hit',
  };

  override onTriggerEnter(other: RuntimeEntity): void {
    this.hit(other);
  }

  override onCollisionEnter(other: RuntimeEntity): void {
    this.hit(other);
  }

  private hit(other: RuntimeEntity): void {
    const player = taggedSelfOrAncestor(other, String(this.props.playerTag ?? 'Player'));
    if (!player || Game.over) return;
    if (this.props.sfx) Audio.sfx(this.props.sfx as SfxPreset);
    if (this.props.action === 'lose') {
      Game.lose(String(this.props.message ?? 'You died!'));
      return;
    }
    player.respawn();
    Game.emit('respawn', { entity: player.name, reason: 'hazard', hazard: this.entity.name });
  }
}

/**
 * Moves back and forth between its start position and start + offset, taking `duration` seconds each
 * way (eased). Characters standing on it ride along.
 */
export class MovingPlatform extends Behaviour {
  static override props: Record<string, unknown> = { offset: [0, 0, 4], duration: 3 };
  private readonly base = new Vector3();
  private t = 0;

  override start(): void {
    this.base.copy(this.entity.position);
  }

  override fixedUpdate(dt: number): void {
    this.t += dt;
    const d = Math.max(0.05, numOr(this.props.duration, 3));
    const phase = (this.t / d) % 2;
    const k = phase <= 1 ? phase : 2 - phase;
    const e = k * k * (3 - 2 * k);
    const off = vec3Or(this.props.offset, [0, 0, 4]);
    this.entity.position.set(this.base.x + off[0] * e, this.base.y + off[1] * e, this.base.z + off[2] * e);
  }
}

/** Destroys the entity after `seconds`. */
export class Lifetime extends Behaviour {
  static override props: Record<string, unknown> = { seconds: 5 };
  private t = 0;
  override update(dt: number): void {
    this.t += dt;
    if (this.t >= numOr(this.props.seconds, 5)) this.entity.destroy();
  }
}

/** Built-in behaviours by name, usable as `script: 'builtin:Name'`. */
export const builtinBehaviours: Record<string, BehaviourClass> = {
  Rotator,
  Spinner,
  Bobber,
  PlayerController,
  FollowCamera,
  Collectible,
  HudText,
  Goal,
  Hazard,
  MovingPlatform,
  Lifetime,
};
