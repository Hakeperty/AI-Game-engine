import vm from 'node:vm';
import {
  createProjectDoc,
  createSceneDoc,
  type Entity,
  type PrefabDoc,
  parseComponent,
  type SceneDoc,
} from '@aige/core';
import { Behaviour, Game, Input, Random, type RuntimeEntity, Scene } from 'aige';
import { describe, expect, it } from 'vitest';
import {
  api,
  type BehaviourClass,
  NullAudio,
  runHeadless,
  ScriptedInput,
  synthesizeSfx,
  World,
} from './index.ts';

type V3 = [number, number, number];

interface EntOpts {
  position?: V3;
  rotation?: V3;
  scale?: V3;
  tags?: string[];
  parent?: string | null;
  active?: boolean;
  components?: Record<string, unknown>[];
}

function add(scene: SceneDoc, name: string, o: EntOpts = {}): Entity {
  const e: Entity = {
    id: `e${scene.nextId++}`,
    name,
    parent: o.parent ?? null,
    active: o.active ?? true,
    tags: o.tags ?? [],
    transform: {
      position: o.position ?? [0, 0, 0],
      rotation: o.rotation ?? [0, 0, 0],
      scale: o.scale ?? [1, 1, 1],
    },
    components: (o.components ?? []).map((c) => parseComponent(c)),
  };
  scene.entities.push(e);
  return e;
}

function ground(scene: SceneDoc, size = 40): Entity {
  return add(scene, 'Ground', {
    position: [0, -0.5, 0],
    scale: [size, 1, size],
    tags: ['Ground'],
    components: [
      { type: 'MeshRenderer', primitive: 'box' },
      { type: 'Collider', shape: 'box' },
    ],
  });
}

function camera(scene: SceneDoc): Entity {
  return add(scene, 'Main Camera', {
    position: [0, 6, 12],
    rotation: [-22, 0, 0],
    components: [{ type: 'Camera' }],
  });
}

function player(scene: SceneDoc, scripts: Record<string, unknown>[] = [], position: V3 = [0, 0, 0]): Entity {
  return add(scene, 'Player', {
    position,
    tags: ['Player'],
    components: [{ type: 'CharacterController' }, ...scripts],
  });
}

function makeWorld(scene: SceneDoc, scripts: Record<string, BehaviourClass> = {}, extra: object = {}) {
  return World.create({
    scene,
    project: createProjectDoc('test'),
    scripts,
    audio: new NullAudio(),
    ...extra,
  });
}

/** Test script that walks the character toward -Z. */
class WalkForward extends Behaviour {
  static override props = { speed: 4 };
  override update(dt: number) {
    this.entity.character?.move([0, 0, -this.props.speed], dt);
  }
}

/** Records trigger/collision callbacks into a shared log. */
const contactLog: string[] = [];
class ContactRecorder extends Behaviour {
  override onTriggerEnter(other: RuntimeEntity) {
    contactLog.push(`${this.entity.name}:triggerEnter:${other.name}`);
  }
  override onTriggerExit(other: RuntimeEntity) {
    contactLog.push(`${this.entity.name}:triggerExit:${other.name}`);
  }
  override onCollisionEnter(other: RuntimeEntity) {
    contactLog.push(`${this.entity.name}:collisionEnter:${other.name}`);
  }
}

describe('physics', () => {
  it('a dynamic ball dropped onto a fixed box comes to rest on top of it', async () => {
    const scene = createSceneDoc('drop');
    ground(scene, 10);
    add(scene, 'Ball', {
      position: [0, 5, 0],
      components: [
        { type: 'MeshRenderer', primitive: 'sphere' },
        { type: 'RigidBody', kind: 'dynamic', mass: 1 },
        { type: 'Collider', shape: 'sphere', radius: 0.5 },
      ],
    });
    const world = await makeWorld(scene);
    const ball = world.find('Ball')!;
    expect(ball.body?.kind).toBe('dynamic');
    for (let i = 0; i < 180; i++) world.step();
    expect(ball.worldPosition.y).toBeGreaterThan(0.45);
    expect(ball.worldPosition.y).toBeLessThan(0.55);
    expect(Math.abs(ball.body!.velocity.y)).toBeLessThan(0.05);
    world.dispose();
  });

  it("'auto' colliders fit primitives and scale with the entity", async () => {
    const scene = createSceneDoc('auto');
    ground(scene, 10);
    add(scene, 'Crate', {
      position: [0, 4, 0],
      scale: [2, 2, 2],
      components: [
        { type: 'MeshRenderer', primitive: 'box' },
        { type: 'RigidBody', kind: 'dynamic' },
        { type: 'Collider', shape: 'auto' },
      ],
    });
    const world = await makeWorld(scene);
    for (let i = 0; i < 150; i++) world.step();
    // 2 m cube rests with its center 1 m above the ground
    expect(world.find('Crate')!.worldPosition.y).toBeCloseTo(1, 1);
    world.dispose();
  });

  it('raycast hits the ground and reports the entity, point and normal', async () => {
    const scene = createSceneDoc('ray');
    ground(scene);
    const world = await makeWorld(scene);
    // queries see colliders right away, even before the first step
    const hit = world.physics.raycast([0, 10, 0], [0, -1, 0], 50);
    expect(hit?.entity.name).toBe('Ground');
    expect(hit!.point.y).toBeCloseTo(0, 3);
    expect(hit!.normal.y).toBeCloseTo(1, 3);
    expect(hit!.distance).toBeCloseTo(10, 3);
    expect(world.physics.overlapSphere([0, 0, 0], 0.5).map((e) => e.name)).toEqual(['Ground']);
    world.dispose();
  });

  it('fires onTriggerEnter on BOTH the coin and the character walking into it', async () => {
    contactLog.length = 0;
    const scene = createSceneDoc('trigger');
    ground(scene);
    player(scene, [
      { type: 'Script', script: 'scripts/walk.ts' },
      { type: 'Script', script: 'scripts/recorder.ts' },
    ]);
    add(scene, 'Coin', {
      position: [0, 1, -3],
      tags: ['Coin'],
      components: [
        { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
        { type: 'Script', script: 'scripts/recorder.ts' },
      ],
    });
    const world = await makeWorld(scene, {
      'scripts/walk.ts': WalkForward,
      'scripts/recorder.ts': ContactRecorder,
    });
    for (let i = 0; i < 120; i++) world.step();
    expect(contactLog).toContain('Coin:triggerEnter:Player');
    expect(contactLog).toContain('Player:triggerEnter:Coin');
    // the player keeps walking and leaves the trigger again
    expect(contactLog).toContain('Player:triggerExit:Coin');
    // no collision callbacks against the ground for the trigger
    expect(contactLog.filter((l) => l.startsWith('Coin:collision'))).toEqual([]);
    world.dispose();
  });

  it('reports a script-moved (bobbing) trigger against a character too', async () => {
    contactLog.length = 0;
    const scene = createSceneDoc('bob');
    ground(scene);
    player(scene, [
      { type: 'Script', script: 'scripts/walk.ts' },
      { type: 'Script', script: 'scripts/recorder.ts' },
    ]);
    add(scene, 'Gem', {
      position: [0, 1, -3],
      components: [
        { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
        { type: 'Script', script: 'builtin:Bobber' },
        { type: 'Script', script: 'scripts/recorder.ts' },
      ],
    });
    const world = await makeWorld(scene, {
      'scripts/walk.ts': WalkForward,
      'scripts/recorder.ts': ContactRecorder,
    });
    for (let i = 0; i < 120; i++) world.step();
    expect(contactLog).toContain('Gem:triggerEnter:Player');
    expect(contactLog).toContain('Player:triggerEnter:Gem');
    world.dispose();
  });

  it('character stands on the ground and rides a moving platform', async () => {
    const scene = createSceneDoc('platform');
    add(scene, 'Platform', {
      position: [0, -0.25, 0],
      scale: [3, 0.5, 3],
      components: [
        { type: 'MeshRenderer', primitive: 'box' },
        { type: 'Collider', shape: 'box' },
        { type: 'Script', script: 'builtin:MovingPlatform', props: { offset: [4, 0, 0], duration: 2 } },
      ],
    });
    player(scene, [], [0, 0.05, 0]);
    const world = await makeWorld(scene);
    const p = world.find('Player')!;
    for (let i = 0; i < 30; i++) world.step();
    expect(p.character!.grounded).toBe(true);
    for (let i = 0; i < 90; i++) world.step(); // 2 s total: platform reached x = 4
    const plat = world.find('Platform')!;
    expect(plat.worldPosition.x).toBeGreaterThan(3.5);
    expect(p.worldPosition.x).toBeGreaterThan(3);
    expect(p.worldPosition.y).toBeGreaterThan(-0.1);
    world.dispose();
  });
});

describe('built-in behaviours', () => {
  it('PlayerController + ScriptedInput walks away from the camera and jumps', async () => {
    const scene = createSceneDoc('pc');
    ground(scene);
    camera(scene);
    player(scene, [{ type: 'Script', script: 'builtin:PlayerController' }]);
    const world = await makeWorld(scene);
    const result = runHeadless(world, {
      seconds: 2.5,
      inputs: [
        { at: 0.2, axis: 'move_y', value: 1, type: 'hold', duration: 1 },
        { at: 1.5, action: 'jump', type: 'tap' },
      ],
      probes: ['Player'],
    });
    expect(result.errors).toEqual([]);
    const samples = result.probes.Player!;
    const at = (t: number) => samples.find((s) => s.t >= t - 1e-6)!;
    // forward = away from the camera = -Z (camera at +Z looking toward -Z)
    expect(at(1.3).position[2]).toBeLessThan(-4);
    expect(Math.abs(at(1.3).position[0])).toBeLessThan(0.05);
    const zAfterStop = at(1.4).position[2];
    expect(Math.abs(at(2.4).position[2] - zAfterStop)).toBeLessThan(0.05); // stopped
    // jumped: well above the ground shortly after the tap, then landed again
    const peak = Math.max(...samples.filter((s) => s.t > 1.5 && s.t < 2.3).map((s) => s.position[1]));
    expect(peak).toBeGreaterThan(1);
    expect(at(1.4).grounded).toBe(true);
    expect(result.final.entities.Player!.grounded).toBe(true);
    // faces the movement direction: models face +Z, so walking to -Z means ~180 degrees of yaw
    const p = world.find('Player')!;
    expect(p.forward.z).toBeLessThan(-0.9);
    world.dispose();
  });

  it('Collectible adds to Game.state.score, plays a sound and destroys itself', async () => {
    const scene = createSceneDoc('collect');
    ground(scene);
    player(scene, [{ type: 'Script', script: 'scripts/walk.ts' }]);
    add(scene, 'Coin', {
      position: [0, 1, -2],
      tags: ['Coin'],
      components: [
        { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
        { type: 'Script', script: 'builtin:Collectible', props: { value: 5 } },
      ],
    });
    add(scene, 'Score', {
      components: [
        { type: 'UIText', id: 'score', text: 'Score: 0' },
        { type: 'Script', script: 'builtin:HudText', props: { format: 'Score: {score}' } },
      ],
    });
    const audio = new NullAudio();
    const world = await makeWorld(scene, { 'scripts/walk.ts': WalkForward }, { audio });
    const r = runHeadless(world, { seconds: 1.5 });
    expect(r.errors).toEqual([]);
    expect(r.final.gameState.score).toBe(5);
    expect(world.find('Coin', { quiet: true })).toBeNull();
    expect(r.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['collect', 'allCollected', 'audio:sfx']),
    );
    expect(r.events.find((e) => e.name === 'collect')!.data).toMatchObject({
      entity: 'Coin',
      by: 'Player',
      total: 5,
    });
    expect(audio.calls).toContainEqual({ kind: 'sfx', name: 'coin', opts: {} });
    expect(r.final.hud.score!.text).toBe('Score: 5');
    expect(r.final.counts.destroyed).toBe(1);
    // the snapshot no longer contains the coin and shows the updated HUD text
    const snap = world.snapshotScene();
    expect(snap.entities.some((e) => e.name === 'Coin')).toBe(false);
    expect(snap.entities.find((e) => e.name === 'Score')!.components[0]).toMatchObject({ text: 'Score: 5' });
    world.dispose();
  });

  it('Goal wins the game (and stays locked until all coins are collected)', async () => {
    const scene = createSceneDoc('goal');
    ground(scene);
    player(scene, [{ type: 'Script', script: 'scripts/walk.ts' }]);
    add(scene, 'Coin', {
      position: [0, 1, -2],
      tags: ['Coin'],
      components: [
        { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
        { type: 'Script', script: 'builtin:Collectible' },
      ],
    });
    add(scene, 'Flag', {
      position: [0, 1, -5],
      components: [
        { type: 'Collider', shape: 'box', size: [2, 2, 0.5], isTrigger: true },
        { type: 'Script', script: 'builtin:Goal', props: { requireAll: 'Coin', message: 'Level complete!' } },
      ],
    });
    const world = await makeWorld(scene, { 'scripts/walk.ts': WalkForward });
    const r = runHeadless(world, { seconds: 5 });
    expect(r.final.over).toEqual({ result: 'win', message: 'Level complete!' });
    expect(r.simulatedSeconds).toBeLessThan(2.5); // stopped on game over
    expect(r.events.map((e) => e.name)).toContain('win');
    world.dispose();

    // Without collecting the coin the goal is locked.
    const scene2 = createSceneDoc('goal2');
    ground(scene2);
    player(scene2, [{ type: 'Script', script: 'scripts/walk.ts' }]);
    add(scene2, 'Coin', {
      position: [5, 1, 0],
      tags: ['Coin'],
      components: [
        { type: 'Collider', isTrigger: true },
        { type: 'Script', script: 'builtin:Collectible' },
      ],
    });
    add(scene2, 'Flag', {
      position: [0, 1, -3],
      components: [
        { type: 'Collider', shape: 'box', size: [2, 2, 0.5], isTrigger: true },
        { type: 'Script', script: 'builtin:Goal', props: { requireAll: 'Coin' } },
      ],
    });
    const world2 = await makeWorld(scene2, { 'scripts/walk.ts': WalkForward });
    const r2 = runHeadless(world2, { seconds: 2 });
    expect(r2.final.over).toBeNull();
    expect(r2.events.find((e) => e.name === 'goalLocked')?.data).toMatchObject({ remaining: 1 });
    world2.dispose();
  });

  it('Hazard with action lose ends the game', async () => {
    const scene = createSceneDoc('hazard');
    ground(scene);
    player(scene, [{ type: 'Script', script: 'scripts/walk.ts' }]);
    add(scene, 'Lava', {
      position: [0, 0.5, -3],
      components: [
        { type: 'Collider', shape: 'box', size: [4, 1, 1], isTrigger: true },
        { type: 'Script', script: 'builtin:Hazard', props: { action: 'lose', message: 'Burnt!' } },
      ],
    });
    const world = await makeWorld(scene, { 'scripts/walk.ts': WalkForward });
    const r = runHeadless(world, { seconds: 3 });
    expect(r.final.over).toEqual({ result: 'lose', message: 'Burnt!' });
    world.dispose();
  });

  it('falling below killY calls onFall, and PlayerController respawns', async () => {
    const fell: string[] = [];
    class FallWatcher extends Behaviour {
      override onFall() {
        fell.push(this.entity.name);
      }
    }
    const scene = createSceneDoc('fall');
    scene.settings.killY = -5;
    add(scene, 'Rock', {
      position: [0, 0, 0],
      components: [
        { type: 'RigidBody' },
        { type: 'Collider', shape: 'sphere' },
        { type: 'Script', script: 'scripts/fall.ts' },
      ],
    });
    add(scene, 'Junk', { position: [3, 0, 0], components: [{ type: 'RigidBody' }, { type: 'Collider' }] });
    player(scene, [{ type: 'Script', script: 'builtin:PlayerController' }], [10, 2, 0]);
    add(scene, 'Ghost', { position: [20, 0, 0], components: [{ type: 'CharacterController' }] });
    const world = await makeWorld(scene, { 'scripts/fall.ts': FallWatcher });
    const r = runHeadless(world, { seconds: 2, probes: ['Player'] });
    expect(fell).toEqual(['Rock']);
    // no onFall handler: destroyed with a clear log line
    expect(world.find('Junk', { quiet: true })).toBeNull();
    expect(r.logs.some((l) => l.includes("'Junk' fell below killY"))).toBe(true);
    // a character without a handler is respawned instead of destroyed
    expect(world.find('Ghost', { quiet: true })).not.toBeNull();
    expect(r.logs.some((l) => l.includes("'Ghost' fell below killY (-5) and was respawned"))).toBe(true);
    // the player was respawned (possibly more than once) and is above killY
    expect(r.events.filter((e) => e.name === 'respawn').length).toBeGreaterThanOrEqual(1);
    const ys = r.probes.Player!.map((s) => s.position[1]);
    expect(Math.min(...ys)).toBeGreaterThan(-6);
    expect(ys.some((y) => y > 1)).toBe(true);
    world.dispose();
  });
});

describe('world', () => {
  it('runs awake before start before update, and fixedUpdate before update', async () => {
    const order: string[] = [];
    class A extends Behaviour {
      override awake() {
        order.push(`${this.entity.name}.awake`);
      }
      override start() {
        order.push(`${this.entity.name}.start`);
      }
      override fixedUpdate() {
        order.push(`${this.entity.name}.fixed`);
      }
      override update() {
        order.push(`${this.entity.name}.update`);
      }
      override lateUpdate() {
        order.push(`${this.entity.name}.late`);
      }
    }
    const scene = createSceneDoc('order');
    add(scene, 'X', { components: [{ type: 'Script', script: 'scripts/a.ts' }] });
    add(scene, 'Y', { components: [{ type: 'Script', script: 'scripts/a.ts' }] });
    const world = await makeWorld(scene, { 'scripts/a.ts': A });
    expect(order).toEqual(['X.awake', 'Y.awake', 'X.start', 'Y.start']);
    order.length = 0;
    world.step();
    expect(order).toEqual(['X.fixed', 'Y.fixed', 'X.update', 'Y.update', 'X.late', 'Y.late']);
    order.length = 0;
    world.update(1 / 30); // two fixed steps, one update
    expect(order.filter((o) => o === 'X.fixed')).toHaveLength(2);
    expect(order.filter((o) => o === 'X.update')).toHaveLength(1);
    world.dispose();
  });

  it('merges static props with component props and exposes the scripting singletons', async () => {
    let seen: Record<string, unknown> = {};
    class P extends Behaviour {
      static override props = { speed: 3, color: 'red', list: [1, 2] };
      speedField = 1;
      override start() {
        seen = { ...this.props, field: this.speedField, t: 0 };
        Game.state.started = true;
        Game.emit('ready', { name: this.entity.name });
      }
    }
    const scene = createSceneDoc('props');
    add(scene, 'Thing', {
      components: [{ type: 'Script', script: 'scripts/p.ts', props: { speed: 7, speedField: 42 } }],
    });
    const events: string[] = [];
    const world = await World.create({
      scene,
      project: createProjectDoc('t'),
      scripts: { 'scripts/p.ts': P },
    });
    world.on('game', (g) => events.push(g.name));
    expect(seen).toMatchObject({ speed: 7, color: 'red', list: [1, 2], field: 42 });
    expect(world.gameState.started).toBe(true);
    world.dispose();
  });

  it('instantiates prefabs, destroys at end of frame, and resolves find()', async () => {
    const prefab: PrefabDoc = {
      format: 'aige.prefab',
      version: 1,
      name: 'Bullet',
      entities: [
        {
          id: 'p1',
          name: 'Bullet',
          parent: null,
          active: true,
          tags: ['Bullet'],
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [parseComponent({ type: 'MeshRenderer', primitive: 'sphere' })],
        },
        {
          id: 'p2',
          name: 'Trail',
          parent: 'p1',
          active: true,
          tags: [],
          transform: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [],
        },
      ],
    };
    const spawned: string[] = [];
    class Spawner extends Behaviour {
      override start() {
        const b = Scene.instantiate('bullet', { position: [1, 2, 3] });
        spawned.push(b.id);
        b.destroy(0.5);
      }
    }
    const scene = createSceneDoc('spawn');
    const lvl = add(scene, 'Level');
    add(scene, 'Spawner', { parent: lvl.id, components: [{ type: 'Script', script: 'scripts/spawner.ts' }] });
    const world = await makeWorld(
      scene,
      { 'scripts/spawner.ts': Spawner },
      {
        prefabs: { 'prefabs/bullet.prefab.json': prefab },
      },
    );
    expect(world.find('Level/Spawner')?.name).toBe('Spawner');
    const bullet = world.find('Bullet')!;
    expect(bullet.id).toBe(spawned[0]);
    expect(bullet.prefab).toBe('prefabs/bullet.prefab.json');
    expect(bullet.worldPosition.toArray()).toEqual([1, 2, 3]);
    expect(world.find('Bullet/Trail')!.worldPosition.z).toBeCloseTo(4);
    expect(world.findAll({ tag: 'Bullet' })).toHaveLength(1);
    for (let i = 0; i < 40; i++) world.step();
    expect(world.find('Bullet', { quiet: true })).toBeNull();
    expect(world.find('Trail', { quiet: true })).toBeNull();
    world.dispose();
  });

  it('two runs with the same inputs and seed give the same stateHash', async () => {
    class Spawner extends Behaviour {
      private t = 0;
      override update(dt: number) {
        this.t += dt;
        if (this.t > 0.2) {
          this.t = 0;
          Scene.instantiate('Template', { position: [Random.range(-3, 3), 6, Random.range(-3, 3)] });
          Game.state.spawned = (Game.state.spawned ?? 0) + 1;
        }
        if (Input.pressed('jump')) Game.state.jumps = (Game.state.jumps ?? 0) + 1;
      }
    }
    const build = () => {
      const scene = createSceneDoc('det');
      ground(scene);
      add(scene, 'Template', {
        position: [0, 30, 0],
        components: [
          { type: 'MeshRenderer', primitive: 'box' },
          { type: 'RigidBody' },
          { type: 'Collider', restitution: 0.3 },
        ],
      });
      add(scene, 'Spawner', { components: [{ type: 'Script', script: 'scripts/spawner.ts' }] });
      return scene;
    };
    const inputs = [
      { at: 0.5, action: 'jump', type: 'tap' as const },
      { at: 1.0, key: 'Space', type: 'tap' as const },
    ];
    const run = async (seed: number) => {
      const world = await makeWorld(build(), { 'scripts/spawner.ts': Spawner }, { seed });
      const r = runHeadless(world, { seconds: 3, inputs });
      world.dispose();
      return r;
    };
    const a = await run(7);
    const b = await run(7);
    const c = await run(8);
    expect(a.final.gameState).toMatchObject({ jumps: 2 });
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.stateHash).not.toBe(c.stateHash);
  });

  it('reports a throwing script with its path and entity, disables it after 20 errors, and keeps running', async () => {
    let ticks = 0;
    class Bad extends Behaviour {
      override update() {
        (this as any).missing.property = 1;
      }
    }
    class Good extends Behaviour {
      override update() {
        ticks++;
      }
    }
    const scene = createSceneDoc('errors');
    add(scene, 'Enemy', { components: [{ type: 'Script', script: 'scripts/bad.ts' }] });
    add(scene, 'Counter', {
      components: [
        { type: 'Script', script: 'scripts/good.ts' },
        { type: 'Script', script: 'scripts/typo.ts' },
      ],
    });
    const world = await makeWorld(scene, { 'scripts/bad.ts': Bad, 'scripts/good.ts': Good });
    const r = runHeadless(world, { seconds: 1 });
    expect(r.frames).toBe(60);
    expect(ticks).toBe(60);
    const bad = r.errors.find((e) => e.script === 'scripts/bad.ts')!;
    expect(bad).toMatchObject({ entity: 'Enemy', hook: 'update', count: 20 });
    expect(bad.message).toMatch(/TypeError/);
    expect(bad.stack).toMatch(/at /);
    expect(r.logs.some((l) => l.includes('disabled after 20 errors'))).toBe(true);
    // a missing script is reported with a did-you-mean hint
    const missing = r.errors.find((e) => e.script === 'scripts/typo.ts')!;
    expect(missing.message).toMatch(/not found/);
    world.dispose();
  });

  it('snapshotScene round-trips transforms (including parented, rotated and scaled entities)', async () => {
    const scene = createSceneDoc('snap');
    const parent = add(scene, 'Parent', { position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] });
    add(scene, 'Child', {
      parent: parent.id,
      position: [0.5, 0, -1],
      rotation: [10, 20, 30],
      scale: [1, 0.5, 1],
    });
    add(scene, 'Light', {
      position: [0, 10, 0],
      rotation: [-50, 30, 0],
      components: [{ type: 'Light', intensity: 2 }],
    });
    const world = await makeWorld(scene);
    world.step();
    const snap = world.snapshotScene();
    expect(snap.format).toBe('aige.scene');
    expect(snap.nextId).toBe(scene.nextId);
    for (const orig of scene.entities) {
      const s = snap.entities.find((e) => e.id === orig.id)!;
      expect(s.parent).toBe(orig.parent);
      expect(s.components).toEqual(orig.components);
      for (let i = 0; i < 3; i++) {
        expect(s.transform.position[i]).toBeCloseTo(orig.transform.position[i]!, 5);
        expect(s.transform.rotation[i]).toBeCloseTo(orig.transform.rotation[i]!, 3);
        expect(s.transform.scale[i]).toBeCloseTo(orig.transform.scale[i]!, 5);
      }
    }
    // moving the child in world space is stored back as a local transform under the parent
    const child = world.find('Child')!;
    child.worldPosition = [5, 5, 5];
    const snap2 = world.snapshotScene();
    const local = snap2.entities.find((e) => e.name === 'Child')!.transform.position;
    const world2 = await makeWorld(snap2);
    expect(world2.find('Child')!.worldPosition.distanceTo({ x: 5, y: 5, z: 5 } as any)).toBeLessThan(1e-4);
    expect(local).not.toEqual([5, 5, 5]);
    world.dispose();
    world2.dispose();
  });

  it('entity transform helpers use degrees and a sensible forward', async () => {
    const scene = createSceneDoc('xf');
    add(scene, 'Box');
    add(scene, 'Cam', { components: [{ type: 'Camera' }] });
    const world = await makeWorld(scene);
    const box = world.find('Box')!;
    box.rotation = [0, 90, 0];
    expect(box.rotation.y).toBeCloseTo(90);
    expect(box.forward.x).toBeCloseTo(1); // objects face +Z; +90 deg yaw turns +Z into +X
    box.rotation.y = 0;
    box.lookAt([0, 0, -10]);
    expect(box.forward.z).toBeCloseTo(-1);
    const cam = world.find('Cam')!;
    expect(cam.forward.z).toBeCloseTo(-1); // cameras look along -Z
    cam.lookAt([10, 0, 0]);
    expect(cam.forward.x).toBeCloseTo(1);
    box.position = [1, 2, 3];
    box.translate([0, 0, 1], 'world');
    expect(box.position.toArray()).toEqual([1, 2, 4]);
    box.scale = 2;
    expect(box.scale.toArray()).toEqual([2, 2, 2]);
    expect(() => {
      box.position = 'nope' as any;
    }).toThrow(/Expected a position like \[x, y, z\]/);
    world.dispose();
  });
});

describe('headless runner', () => {
  it('returns probes (~10 per second) and scene captures', async () => {
    const scene = createSceneDoc('probe');
    ground(scene);
    add(scene, 'Ball', {
      position: [0, 3, 0],
      components: [{ type: 'RigidBody' }, { type: 'Collider', shape: 'sphere' }],
    });
    add(scene, 'Spinner', {
      components: [{ type: 'Script', script: 'builtin:Spinner', props: { speed: [0, 90, 0] } }],
    });
    const world = await makeWorld(scene);
    const r = runHeadless(world, { seconds: 2, probes: ['Ball', 'Nope'], captureAt: [0, 1, 1.5] });
    expect(r.frames).toBe(120);
    expect(r.simulatedSeconds).toBeCloseTo(2, 5);
    const samples = r.probes.Ball!;
    expect(samples.length).toBeGreaterThanOrEqual(20);
    expect(samples.length).toBeLessThanOrEqual(22);
    expect(samples[0]!.position[1]).toBeCloseTo(3, 3);
    expect(samples[samples.length - 1]!.position[1]).toBeCloseTo(0.5, 1);
    expect(r.probes.Nope).toEqual([]);
    expect(r.final.entities.Nope).toBeNull();
    expect(r.captures.map((c) => c.t)).toEqual([0, 1, 1.5]);
    const ballAt = (i: number) =>
      r.captures[i]!.scene.entities.find((e) => e.name === 'Ball')!.transform.position[1];
    expect(ballAt(0)).toBeCloseTo(3, 3);
    expect(ballAt(1)).toBeLessThan(1);
    const spin = r.captures[1]!.scene.entities.find((e) => e.name === 'Spinner')!.transform.rotation[1];
    expect(spin).toBeCloseTo(90, 0);
    expect(typeof r.stateHash).toBe('string');
    world.dispose();
  });

  it('runs 30 s with ~200 entities quickly', async () => {
    const scene = createSceneDoc('perf');
    ground(scene, 100);
    camera(scene);
    player(scene, [{ type: 'Script', script: 'builtin:PlayerController' }]);
    for (let i = 0; i < 120; i++) {
      add(scene, `Coin${i}`, {
        position: [(i % 12) * 3 - 18, 1, Math.floor(i / 12) * 3 - 30],
        tags: ['Coin'],
        components: [
          { type: 'Collider', shape: 'sphere', isTrigger: true },
          { type: 'Script', script: 'builtin:Collectible' },
          { type: 'Script', script: 'builtin:Bobber' },
        ],
      });
    }
    for (let i = 0; i < 40; i++) {
      add(scene, `Crate${i}`, {
        position: [(i % 8) * 2 - 8, 1 + Math.floor(i / 8) * 1.2, 10],
        components: [{ type: 'MeshRenderer', primitive: 'box' }, { type: 'RigidBody' }, { type: 'Collider' }],
      });
    }
    for (let i = 0; i < 40; i++) {
      add(scene, `Tree${i}`, {
        position: [i * 2 - 40, 1, 25],
        components: [{ type: 'Collider', shape: 'cylinder', height: 2 }],
      });
    }
    const world = await makeWorld(scene);
    const r = runHeadless(world, {
      seconds: 30,
      inputs: [
        { at: 0, axis: 'move_y', value: 1, type: 'press' },
        { at: 0.5, axis: 'move_x', value: 0.5, type: 'hold', duration: 3 },
      ],
      probes: ['Player'],
    });
    expect(r.errors).toEqual([]);
    expect(r.frames).toBe(1800);
    expect(r.final.gameState.score).toBeGreaterThan(0);
    expect(r.wallMs).toBeLessThan(10_000);
    world.dispose();
  });
});

describe('audio synth', () => {
  it('synthesizes every preset deterministically', () => {
    for (const p of [
      'coin',
      'jump',
      'hit',
      'explosion',
      'powerup',
      'laser',
      'click',
      'win',
      'lose',
    ] as const) {
      const a = synthesizeSfx(p, 22050);
      expect(a.length).toBeGreaterThan(100);
      expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0.05);
      expect(synthesizeSfx(p, 22050)).toEqual(a);
    }
  });

  it('ScriptedInput taps for exactly one frame and holds for a duration', () => {
    const s = new ScriptedInput([
      { at: 0, action: 'jump', type: 'tap' },
      { at: 0.1, key: 'KeyW', type: 'hold', duration: 0.2 },
    ]);
    s.poll(0, 0);
    expect(s.actionDown('jump')).toBe(true);
    s.poll(1 / 60, 1);
    expect(s.actionDown('jump')).toBeUndefined();
    s.poll(0.1, 6);
    expect(s.isKeyDown('KeyW')).toBe(true);
    s.poll(0.29, 17);
    expect(s.isKeyDown('KeyW')).toBe(true);
    s.poll(0.31, 18);
    expect(s.isKeyDown('KeyW')).toBe(false);
  });
});

describe('host integration', () => {
  it('runs scripts evaluated in a separate vm realm (like the host sandbox)', async () => {
    // What the host does: compile to CJS with `aige` mapped to a global, evaluate in a fresh context.
    const code = `
      const { Behaviour, Game, Input, Vector3 } = require('aige');
      class Mover extends Behaviour {
        static props = { speed: [0, 0, -2], label: 'mover' };
        start() { Game.state.label = this.props.label; this.hits = 0; }
        update(dt) {
          const s = this.props.speed;
          this.entity.position = [this.entity.position.x + s[0] * dt, 1, this.entity.position.z + s[2] * dt];
          if (Input.pressed('jump')) Game.state.jumped = true;
          if (this.entity.position.z < -1 && !Game.state.threw) { Game.state.threw = true; null.boom; }
        }
      }
      module.exports = { default: Mover };
    `;
    const module = { exports: {} as any };
    const context = vm.createContext({ require: (id: string) => (id === 'aige' ? api : undefined), module });
    new vm.Script(code, { filename: 'scripts/mover.ts' }).runInContext(context);

    const scene = createSceneDoc('vm');
    add(scene, 'Box', {
      components: [{ type: 'Script', script: 'scripts/mover.ts', props: { label: 'hello' } }],
    });
    const world = await makeWorld(scene, { 'scripts/mover.ts': module.exports });
    const r = runHeadless(world, { seconds: 1, inputs: [{ at: 0.5, action: 'jump' }], probes: ['Box'] });
    expect(r.final.gameState).toMatchObject({ label: 'hello', jumped: true, threw: true });
    expect(r.final.entities.Box!.position[2]).toBeCloseTo(-2, 1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      script: 'scripts/mover.ts',
      entity: 'Box',
      hook: 'update',
      count: 1,
    });
    expect(r.errors[0]!.message).toMatch(/TypeError: Cannot read properties of null/);
    expect(r.errors[0]!.stack).toMatch(/scripts\/mover\.ts/);
    world.dispose();
  });

  it('Scene.load keeps Game.state; Game.restart resets it', async () => {
    class Level extends Behaviour {
      override start() {
        Game.state.visits = (Game.state.visits ?? 0) + 1;
        Game.state[this.world.sceneName] = true;
      }
      override update() {
        if (Input.pressed('jump')) Scene.load('level2');
        if (Input.pressed('fire')) Game.restart();
      }
    }
    const main = createSceneDoc('main');
    add(main, 'Director', { components: [{ type: 'Script', script: 'scripts/level.ts' }] });
    const level2 = createSceneDoc('level2');
    add(level2, 'Director2', { components: [{ type: 'Script', script: 'scripts/level.ts' }] });
    const world = await makeWorld(
      main,
      { 'scripts/level.ts': Level },
      {
        scenes: { 'scenes/level2.scene.json': level2 },
      },
    );
    const loads: string[] = [];
    world.on('sceneLoad', (s) => loads.push(`${s.name}:${s.restart}`));
    const r = runHeadless(world, {
      seconds: 1,
      inputs: [
        { at: 0.2, action: 'jump' },
        { at: 0.6, action: 'fire' },
      ],
    });
    expect(loads).toEqual(['level2:false', 'main:true']);
    expect(r.events.map((e) => e.name)).toEqual(['sceneLoad', 'restart']);
    // restart cleared the state gathered on main + level2, then main started again
    expect(r.final.gameState).toEqual({ visits: 1, main: true });
    expect(world.sceneName).toBe('main');
    expect(world.find('Director')).not.toBeNull();
    world.dispose();
  });

  it('tracks spawned/destroyed entities and mutated components for renderers', async () => {
    const scene = createSceneDoc('changes');
    add(scene, 'Lamp', { components: [{ type: 'Light', kind: 'point', intensity: 1 }] });
    add(scene, 'Proto', { components: [{ type: 'MeshRenderer', primitive: 'box' }] });
    const world = await makeWorld(scene);
    world.drainChanges();
    const lamp = world.find('Lamp')!;
    lamp.get('Light')!.intensity = 3;
    expect(lamp.components[0]!.intensity).toBe(3);
    const clone = world.instantiate(world.find('Proto')!, { position: [0, 2, 0], name: 'Clone' });
    world.find('Proto')!.destroy();
    lamp.setActive(false);
    const spin = clone.addScript('builtin:Rotator', { speed: [0, 180, 0] });
    expect(spin).not.toBeNull();
    world.step();
    const ch = world.drainChanges();
    expect(ch.components).toEqual([lamp.id]);
    expect(ch.spawned.map((e) => e.name)).toEqual(['Clone']);
    expect(ch.destroyed).toEqual([scene.entities[1]!.id]);
    expect(ch.active).toEqual([lamp.id]);
    const snap = world.snapshotScene();
    const c = snap.entities.find((e) => e.name === 'Clone')!;
    expect(c.transform.position).toEqual([0, 2, 0]);
    expect(c.components.map((x) => x.type)).toEqual(['MeshRenderer', 'Script']);
    expect(snap.entities.find((e) => e.name === 'Lamp')!.active).toBe(false);
    expect(snap.nextId).toBeGreaterThan(scene.nextId);
    world.dispose();
  });

  it('spawned trigger pickups work immediately', async () => {
    class CoinSpawner extends Behaviour {
      override start() {
        Scene.instantiate('coin', { position: [0, 1, -2] });
      }
    }
    const coin: PrefabDoc = {
      format: 'aige.prefab',
      version: 1,
      name: 'coin',
      entities: [
        {
          id: 'c',
          name: 'Coin',
          parent: null,
          active: true,
          tags: ['Coin'],
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [
            parseComponent({ type: 'Collider', shape: 'sphere', isTrigger: true }),
            parseComponent({ type: 'Script', script: 'builtin:Collectible' }),
          ],
        },
      ],
    };
    const scene = createSceneDoc('spawned');
    ground(scene);
    player(scene, [{ type: 'Script', script: 'scripts/walk.ts' }]);
    add(scene, 'Spawner', { components: [{ type: 'Script', script: 'scripts/spawn.ts' }] });
    const world = await makeWorld(
      scene,
      { 'scripts/walk.ts': WalkForward, 'scripts/spawn.ts': CoinSpawner },
      { prefabs: { 'prefabs/coin.prefab.json': coin } },
    );
    const r = runHeadless(world, { seconds: 1.5 });
    expect(r.errors).toEqual([]);
    expect(r.final.gameState.score).toBe(1);
    // spawned in start() during World.create, collected during the run
    expect(r.final.counts).toMatchObject({ spawned: 0, destroyed: 1 });
    world.dispose();
  });
});
