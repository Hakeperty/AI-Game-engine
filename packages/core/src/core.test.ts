import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AigeError,
  basicSceneEntities,
  canonicalJson,
  createCoreBus,
  createProjectState,
  defineCommand,
  getScene,
  inputJsonSchema,
  type LogEntry,
  MemoryFs,
  resolveEntity,
  signature,
  TOOL_NAME_RE,
  worldTransform,
} from './index.ts';

function setup() {
  const fs = new MemoryFs();
  const bus = createCoreBus(createProjectState('test'), fs);
  const log: LogEntry[] = [];
  bus.onLog((e) => log.push(e));
  return { bus, fs, log };
}

const scene = (bus: ReturnType<typeof setup>['bus']) => getScene(bus.state);

describe('entities', () => {
  it('creates, updates, deletes with undo/redo', async () => {
    const { bus } = setup();
    const a = await bus.execute('entity_create', { name: 'Player', position: [1, 2, 3], tags: ['Player'] });
    expect(a).toMatchObject({ id: 'e1', name: 'Player', path: 'Player' });
    await bus.execute('entity_update', { entity: 'Player', position: [0, 5, 0], scale: 2 });
    expect(resolveEntity(scene(bus), 'e1').transform).toEqual({
      position: [0, 5, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    });
    await bus.execute('undo');
    expect(resolveEntity(scene(bus), 'e1').transform.position).toEqual([1, 2, 3]);
    await bus.execute('redo');
    expect(resolveEntity(scene(bus), 'e1').transform.position).toEqual([0, 5, 0]);
    await bus.execute('entity_delete', { entity: 'Player' });
    expect(scene(bus).entities).toHaveLength(0);
    await bus.execute('undo');
    expect(scene(bus).entities).toHaveLength(1);
  });

  it('makes sibling names unique and resolves paths', async () => {
    const { bus } = setup();
    const level = await bus.execute('entity_create', { name: 'Level' });
    await bus.execute('entity_create', { name: 'Coin', parent: level.id });
    const second = await bus.execute('entity_create', { name: 'Coin', parent: 'Level' });
    expect(second.name).toBe('Coin (2)');
    expect(resolveEntity(scene(bus), 'Level/Coin (2)').id).toBe(second.id);
  });

  it('gives actionable errors', async () => {
    const { bus } = setup();
    await bus.execute('entity_create', { name: 'Player' });
    const err = await bus.execute('entity_update', { entity: 'Playr', position: [0, 0, 0] }).catch((e) => e);
    expect(err).toBeInstanceOf(AigeError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.hint).toContain("'Player'");
    const unknown = await bus.execute('entity_creat', {}).catch((e) => e);
    expect(unknown.code).toBe('UNKNOWN_COMMAND');
    expect(unknown.hint).toContain('entity_create');
    const bad = await bus
      .execute('entity_create', { name: 'X', components: [{ type: 'Light', kind: 'laser' }] })
      .catch((e) => e);
    expect(bad.code).toBe('INVALID_INPUT');
    expect(bad.hint).toContain('Example Light');
  });

  it('keeps world position when reparenting', async () => {
    const { bus } = setup();
    const parent = await bus.execute('entity_create', {
      name: 'P',
      position: [10, 0, 0],
      rotation: [0, 90, 0],
      scale: 2,
    });
    const child = await bus.execute('entity_create', { name: 'C', position: [1, 2, 3] });
    await bus.execute('entity_update', { entity: child.id, parent: parent.id });
    const s = scene(bus);
    const world = worldTransform(s, resolveEntity(s, child.id)).position;
    for (const [i, v] of world.entries()) expect(v).toBeCloseTo([1, 2, 3][i]!, 5);
    await expect(bus.execute('entity_update', { entity: parent.id, parent: child.id })).rejects.toThrow(
      /descendants/,
    );
  });

  it('duplicates with cumulative offsets and copies children', async () => {
    const { bus } = setup();
    const coin = await bus.execute('entity_create', { name: 'Coin', position: [0, 1, 0] });
    await bus.execute('entity_create', { name: 'Sparkle', parent: coin.id });
    const res = await bus.execute('entity_duplicate', { entity: 'Coin', count: 3, offset: [2, 0, 0] });
    expect(res.created).toHaveLength(3);
    const s = scene(bus);
    expect(s.entities).toHaveLength(8);
    expect(resolveEntity(s, res.created[2].id).transform.position).toEqual([6, 1, 0]);
  });
});

describe('components', () => {
  it('adds, updates and removes components with validation', async () => {
    const { bus } = setup();
    await bus.execute('entity_create', {
      name: 'Lamp',
      components: [{ type: 'Light', kind: 'point', color: 'orange' }],
    });
    let e = resolveEntity(scene(bus), 'Lamp');
    expect(e.components[0]).toMatchObject({ type: 'Light', kind: 'point', color: '#fb8c00', intensity: 1 });
    await bus.execute('component_update', { entity: 'Lamp', type: 'Light', props: { intensity: 4 } });
    e = resolveEntity(scene(bus), 'Lamp');
    expect(e.components[0]).toMatchObject({ kind: 'point', intensity: 4 });
    await expect(
      bus.execute('component_add', { entity: 'Lamp', component: { type: 'Light' } }),
    ).rejects.toThrow(/already has/);
    await bus.execute('component_add', { entity: 'Lamp', component: { type: 'Collider', shape: 'sphere' } });
    await bus.execute('component_add', {
      entity: 'Lamp',
      component: { type: 'Collider', shape: 'box', isTrigger: true },
    });
    await bus.execute('component_remove', { entity: 'Lamp', type: 'Collider', index: 1 });
    e = resolveEntity(scene(bus), 'Lamp');
    expect(e.components.map((c) => c.type)).toEqual(['Light', 'Collider']);
    await expect(
      bus.execute('component_update', { entity: 'Lamp', type: 'Light', props: { brightness: 2 } }),
    ).rejects.toThrow(/Invalid Light properties/);
    // null clears optional props and resets defaulted ones
    await bus.execute('entity_create', {
      name: 'Box',
      components: [{ type: 'MeshRenderer', primitive: 'box', color: 'red', castShadow: false }],
    });
    await bus.execute('component_update', {
      entity: 'Box',
      type: 'MeshRenderer',
      props: { color: null, castShadow: null },
    });
    const box = resolveEntity(scene(bus), 'Box').components[0]!;
    expect('color' in box).toBe(false);
    expect(box.castShadow).toBe(true);
  });
});

describe('batch, undo and replay', () => {
  it('batch of 200 creates then undo restores the original exactly', async () => {
    const { bus } = setup();
    for (const { transform, parent: _p, ...e } of basicSceneEntities()) {
      await bus.execute('entity_create', {
        ...e,
        position: transform.position,
        rotation: transform.rotation,
      });
    }
    const before = canonicalJson(bus.state);
    const commands = Array.from({ length: 200 }, (_, i) => ({
      tool: 'entity_create',
      input: {
        name: `Box ${i}`,
        position: [i, 0, 0],
        components: [{ type: 'MeshRenderer', primitive: 'box' }],
      },
    }));
    const res = await bus.execute('batch', { commands });
    expect(res.steps).toBe(200);
    expect(scene(bus).entities).toHaveLength(203);
    await bus.execute('undo');
    expect(canonicalJson(bus.state)).toBe(before);
  });

  it('batch supports $refs and rolls back atomically on failure', async () => {
    const { bus } = setup();
    const res = await bus.execute('batch', {
      commands: [
        { tool: 'entity_create', input: { name: 'Tower' } },
        { tool: 'entity_create', input: { name: 'Top', parent: '$0.id', position: [0, 5, 0] } },
      ],
    });
    expect(res.results[1].result.path).toBe('Tower/Top');
    const before = canonicalJson(bus.state);
    const err = await bus
      .execute('batch', {
        commands: [
          { tool: 'entity_create', input: { name: 'A' } },
          { tool: 'entity_update', input: { entity: 'Nope', position: [0, 0, 0] } },
        ],
      })
      .catch((e) => e);
    expect(err.message).toMatch(/step 1 \(entity_update\) failed/);
    expect(canonicalJson(bus.state)).toBe(before);
  });

  it('replaying the command log reproduces identical JSON', async () => {
    const { bus, log } = setup();
    await bus.execute('scene_create', { name: 'level1', template: 'basic' });
    await bus.execute('material_create', { name: 'gold', color: '#ffc107', metalness: 1 });
    const c = await bus.execute('entity_create', { name: 'Coin', position: [0, 1, 0] });
    await bus.execute('entity_duplicate', { entity: c.id, count: 4, offset: [1.5, 0, 0] });
    await bus.execute('entity_delete', { entity: 'Coin (3)' });
    await bus.execute('undo');
    await bus.execute('prefab_create', { entity: 'Coin' });
    await bus.execute('prefab_instantiate', {
      prefab: 'coin',
      positions: [
        [0, 3, 0],
        [2, 3, 0],
      ],
    });
    await bus.execute('scene_tree', {});
    const expected = canonicalJson(bus.state);

    const fresh = setup().bus;
    await fresh.replay(log);
    expect(canonicalJson(fresh.state)).toBe(expected);
    expect(log.find((l) => l.name === 'scene_tree')).toBeUndefined();
  });

  it('transaction groups many commands into one undo step', async () => {
    const { bus } = setup();
    await bus.transaction('AI turn', 'agent', async () => {
      await bus.execute('entity_create', { name: 'A' });
      await bus.execute('entity_create', { name: 'B' });
      await bus.execute('entity_update', { entity: 'A', position: [1, 1, 1] });
    });
    expect(bus.historyInfo().undo).toEqual(['AI turn (3 commands)']);
    await bus.execute('undo');
    expect(scene(bus).entities).toHaveLength(0);
  });

  it('file writes are undoable', async () => {
    const { bus, fs } = setup();
    bus.register(
      defineCommand({
        name: 'write_test',
        group: 'test',
        kind: 'mutation',
        tier: 'extended',
        description: 'test',
        input: z.object({ path: z.string(), text: z.string() }),
        async run(ctx, input) {
          await ctx.writeFile(input.path, input.text);
          return {};
        },
      }),
    );
    await bus.execute('write_test', { path: 'scripts/a.ts', text: 'v1' });
    await bus.execute('write_test', { path: 'scripts/a.ts', text: 'v2' });
    expect(fs.files.get('scripts/a.ts')).toBe('v2');
    await bus.execute('undo');
    expect(fs.files.get('scripts/a.ts')).toBe('v1');
    await bus.execute('undo');
    expect(fs.files.has('scripts/a.ts')).toBe(false);
    await bus.execute('redo', { steps: 2 });
    expect(fs.files.get('scripts/a.ts')).toBe('v2');
  });
});

describe('tool definitions', () => {
  it('every command has a valid name, JSON schema and description', () => {
    const { bus } = setup();
    for (const cmd of bus.list()) {
      expect(cmd.name).toMatch(TOOL_NAME_RE);
      expect(cmd.description.length).toBeGreaterThan(20);
      const schema = inputJsonSchema(cmd);
      expect(schema.type).toBe('object');
      expect(JSON.stringify(schema)).not.toContain('prefixItems');
    }
  });

  it('renders compact signatures', () => {
    const sig = signature(
      z.object({ kind: z.enum(['a', 'b']).default('a'), pos: z.tuple([z.number(), z.number(), z.number()]) }),
    );
    expect(sig).toBe("{ kind?: 'a'|'b' = 'a', pos: [x,y,z] }");
  });

  it('canonical JSON is stable and rounded', () => {
    expect(canonicalJson({ b: 1, id: 'x', a: [0.1 + 0.2, -0, 1 / 3] })).toBe(
      '{\n  "id": "x",\n  "a": [0.3, 0, 0.33333],\n  "b": 1\n}\n',
    );
  });
});
