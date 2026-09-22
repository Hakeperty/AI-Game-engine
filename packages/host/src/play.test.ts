import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectHost } from './index.ts';

const hosts: ProjectHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

async function coinLevel() {
  const host = await ProjectHost.create(mkdtempSync(join(tmpdir(), 'aige-play-')), { name: 'play' }, { render: null });
  hosts.push(host);
  const call = async (name: string, input: unknown) => {
    const r = await host.call(name, input, 'test');
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return r.result as any;
  };
  await call('batch', {
    commands: [
      {
        tool: 'entity_create',
        input: {
          name: 'Player',
          tags: ['Player'],
          position: [0, 0, 0],
          components: [
            { type: 'MeshRenderer', primitive: 'capsule' },
            { type: 'CharacterController' },
            { type: 'Script', script: 'builtin:PlayerController' },
          ],
        },
      },
      {
        tool: 'entity_create',
        input: {
          name: 'Coin',
          tags: ['Coin'],
          position: [0, 1, -3],
          components: [
            { type: 'MeshRenderer', primitive: 'sphere', color: '#ffc107' },
            { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
            { type: 'Script', script: 'builtin:Collectible' },
          ],
        },
      },
      { tool: 'entity_duplicate', input: { entity: '$1.id', count: 2, offset: [0, 0, -2] } },
      { tool: 'entity_create', input: { name: 'Score', components: [{ type: 'UIText', id: 'score', text: 'Score: 0' }, { type: 'Script', script: 'builtin:HudText', props: { id: 'score', format: 'Score: {score}' } }] } },
    ],
  });
  return { host, call };
}

describe('game_run_headless', () => {
  it('walks the player through the coins and reports score, HUD and probes', async () => {
    const { call } = await coinLevel();
    const res = await call('game_run_headless', {
      seconds: 3,
      inputs: [{ at: 0, axis: 'move_y', value: 1 }],
    });
    expect(res.errors).toEqual([]);
    expect(res.gameState.score).toBe(3);
    expect(res.hud.score).toBe('Score: 3');
    expect(res.events.counts.collect).toBe(3);
    expect(Object.values(res.probes)[0]).toBeDefined();
  }, 60_000);

  it('reports script errors with the script path and line', async () => {
    const { call } = await coinLevel();
    await call('script_write', {
      name: 'broken',
      typecheck: false,
      source: "import { Behaviour } from 'aige';\nexport default class Broken extends Behaviour {\n  update() {\n    (this as any).entity.nope.explode();\n  }\n}\n",
    });
    await call('component_add', { entity: 'Coin', component: { type: 'Script', script: 'scripts/broken.ts' } });
    const res = await call('game_run_headless', { seconds: 1 });
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toContain('scripts/broken.ts');
    expect(res.errors.join('\n')).toMatch(/broken\.ts:4/);
  }, 60_000);

  it('exports a standalone web build', async () => {
    const { host, call } = await coinLevel();
    await call('model_from_template', { template: 'coin', preview: false });
    await call('component_update', { entity: 'Coin', type: 'MeshRenderer', props: { model: 'models/coin.model.ts' } });
    const res = await call('export_web', { smokeTest: false, title: 'Test Game' });
    expect(res.files.map((f: { name: string }) => f.name).sort()).toEqual(['game-data.js', 'index.html', 'player.js']);
    const data = (await host.fs.read('dist/game-data.js'))!;
    const game = JSON.parse(data.replace(/^window\.__AIGE_GAME__ = /, '').replace(/;\s*$/, ''));
    expect(game.title).toBe('Test Game');
    expect(Object.keys(game.models)).toHaveLength(1);
    expect(game.meshKeys['scenes/main.scene.json']).toBeDefined();
    expect((await host.fs.read('dist/index.html'))!).toContain('player.js');
  }, 120_000);

  it('kills runaway scripts with a timeout', async () => {
    const { host, call } = await coinLevel();
    await call('script_write', {
      name: 'hang',
      typecheck: false,
      source: "import { Behaviour } from 'aige';\nexport default class Hang extends Behaviour {\n  update() { while (true) {} }\n}\n",
    });
    await call('component_add', { entity: 'Coin', component: { type: 'Script', script: 'scripts/hang.ts' } });
    const { preparePlay, runPlayTest } = await import('./play.ts');
    const { payload } = await preparePlay(host, { options: { seconds: 1 } });
    await expect(runPlayTest(payload, { timeoutMs: 3000 })).rejects.toThrow(/infinite loop|did not finish/);
  }, 60_000);
});
