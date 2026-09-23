// M9 acceptance, phase 2: build the level through tools (run from the repo root).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';

const out = process.env.OUT!;
const host = await ProjectHost.open(resolve('examples/coin-platformer'));
const call = async (name: string, input: unknown) => {
  const r = await host.call<any>(name, input, 'mcp');
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result;
};

// Sky, fog, void below (falling respawns the player).
await call('entity_delete', { entity: 'Ground' });
await call('scene_settings', {
  background: '#8fc8ff',
  fog: { color: '#cde8ff', near: 30, far: 110 },
  killY: -7,
  ambientIntensity: 0.35,
});
await call('material_create', {
  name: 'sea',
  color: '#2f86d0',
  roughness: 0.25,
  metalness: 0.05,
  opacity: 0.9,
});

type Island = { name: string; pos: [number, number, number]; width: number; depth: number; seed: number };
const islands: Island[] = [
  { name: 'Start Island', pos: [0, 0, 0], width: 7, depth: 3.2, seed: 1 },
  { name: 'Island 2', pos: [0.8, 0.4, -8.5], width: 4.6, depth: 2.4, seed: 2 },
  { name: 'Island 3', pos: [-0.8, 1.2, -15], width: 4.6, depth: 2.6, seed: 3 },
  { name: 'Island 4', pos: [0.6, 2.0, -21.5], width: 4.8, depth: 2.8, seed: 4 },
  { name: 'Island 5', pos: [0, 2.8, -28.5], width: 5, depth: 2.6, seed: 5 },
  { name: 'Goal Island', pos: [0, 3.6, -36.5], width: 7.5, depth: 3.4, seed: 6 },
];

const commands: { tool: string; input: Record<string, unknown> }[] = [
  {
    tool: 'entity_create',
    input: {
      name: 'Sea',
      position: [0, -9, -18],
      scale: [260, 1, 260],
      components: [
        {
          type: 'MeshRenderer',
          primitive: 'plane',
          material: 'materials/sea.material.json',
          castShadow: false,
        },
      ],
    },
  },
  { tool: 'entity_create', input: { name: 'Level' } },
];
for (const i of islands) {
  commands.push({
    tool: 'entity_create',
    input: {
      name: i.name,
      parent: 'Level',
      position: i.pos,
      rotation: [0, i.seed * 47, 0],
      tags: ['Island'],
      components: [
        {
          type: 'MeshRenderer',
          model: 'models/sky-island.model.ts',
          params: { width: i.width, depth: i.depth, seed: i.seed },
        },
        { type: 'Collider', shape: 'auto' },
      ],
    },
  });
}
// Player + camera + HUD.
commands.push(
  {
    tool: 'entity_create',
    input: {
      name: 'Fox',
      tags: ['Player'],
      position: [0, 0, 1.8],
      rotation: [0, 180, 0],
      components: [
        { type: 'MeshRenderer', model: 'models/fox.model.ts' },
        { type: 'CharacterController', height: 0.9, radius: 0.32 },
        { type: 'Script', script: 'builtin:PlayerController', props: { speed: 6, jumpSpeed: 9.5 } },
      ],
    },
  },
  { tool: 'entity_update', input: { entity: 'Main Camera', position: [0, 4.5, 9.8] } },
  {
    tool: 'component_add',
    input: {
      entity: 'Main Camera',
      component: {
        type: 'Script',
        script: 'builtin:FollowCamera',
        props: { target: 'Fox', offset: [0, 4.2, 8], smooth: 5 },
      },
    },
  },
  {
    tool: 'entity_create',
    input: {
      name: 'HUD',
      components: [
        { type: 'UIText', id: 'score', text: 'Coins: 0 / 12', fontSize: 30, anchor: 'top-left' },
        { type: 'Script', script: 'builtin:HudText', props: { id: 'score', format: 'Coins: {score} / 12' } },
      ],
    },
  },
);
// Ground coins (air coins are added after measuring jump arcs).
const coinAt = (name: string, pos: [number, number, number]) => ({
  tool: 'entity_create',
  input: {
    name,
    parent: 'Coins',
    position: pos,
    tags: ['Coin'],
    components: [
      { type: 'MeshRenderer', model: 'models/coin.model.ts' },
      { type: 'Collider', shape: 'sphere', radius: 0.7, isTrigger: true },
      { type: 'Script', script: 'builtin:Collectible', props: { scoreKey: 'score' } },
    ],
  },
});
commands.push({ tool: 'entity_create', input: { name: 'Coins' } });
commands.push(coinAt('Coin', [0, 1, -0.8]), coinAt('Coin', [0, 1, -2.6]));
for (const i of islands.slice(1)) commands.push(coinAt('Coin', [0, i.pos[1] + 1, i.pos[2]]));
// Hazard on island 4 (off the main path), goal flag on the last island.
commands.push(
  {
    tool: 'entity_create',
    input: {
      name: 'Spikes',
      position: [1.9, 2.0, -21.2],
      components: [
        { type: 'MeshRenderer', model: 'models/spike.model.ts', params: { size: 1.2, count: 3 } },
        { type: 'Collider', shape: 'box', size: [1.2, 0.7, 1.2], offset: [0, 0.35, 0], isTrigger: true },
        { type: 'Script', script: 'builtin:Hazard', props: { action: 'respawn' } },
      ],
    },
  },
  {
    tool: 'entity_create',
    input: {
      name: 'Goal Flag',
      position: [0, 3.6, -38.4],
      components: [
        { type: 'MeshRenderer', model: 'models/flag.model.ts', params: { height: 3, cloth: '#ffcf33' } },
        { type: 'Collider', shape: 'box', size: [1.6, 3, 1.6], offset: [0, 1.5, 0], isTrigger: true },
        {
          type: 'Script',
          script: 'builtin:Goal',
          props: { requireAll: 'Coin', message: 'All 12 coins! You win!' },
        },
      ],
    },
  },
);
// Decorations (no colliders: purely visual).
const deco = (
  name: string,
  model: string,
  pos: [number, number, number],
  rot = 0,
  scale = 1,
  params?: Record<string, unknown>,
) => ({
  tool: 'entity_create',
  input: {
    name,
    parent: 'Decor',
    position: pos,
    rotation: [0, rot, 0],
    scale,
    components: [{ type: 'MeshRenderer', model, ...(params ? { params } : {}) }],
  },
});
commands.push(
  { tool: 'entity_create', input: { name: 'Decor' } },
  deco('Tree', 'models/tree-organic.model.ts', [-2.4, 0, -0.6], 30, 0.9),
  deco('Mushroom', 'models/mushroom.model.ts', [2.3, 0, 0.8], 0, 1.4),
  deco('Flower', 'models/flower.model.ts', [1.6, 0, -1.8], 20),
  deco('Flower', 'models/flower.model.ts', [-1.4, 0, 1.4], 80, 1, { style: 'tulip' }),
  deco('Bush', 'models/bush.model.ts', [-2.0, 1.2, -15.8], 0, 0.8),
  deco('Rock', 'models/rock.model.ts', [-1.5, 2.0, -22.3], 40, 0.8),
  deco('Mushroom', 'models/mushroom.model.ts', [1.8, 2.8, -29.4], 60, 1.1),
  deco('Tree', 'models/tree-organic.model.ts', [-2.6, 3.6, -37.2], 200, 1.1),
  deco('Bush', 'models/bush.model.ts', [2.6, 3.6, -35.4], 90, 0.9),
  deco('Flower', 'models/flower.model.ts', [1.5, 3.6, -37.8], 10),
);
const res = await call('batch', { commands });
console.log('batch steps', res.steps, 'failed', res.failed);

// Custom script: level timer.
const timer = await call('script_write', {
  name: 'level-timer',
  source: `import { Behaviour, Game, Time, UI } from 'aige';

/** Shows the run time in the top-right corner and freezes it when the level is won. */
export default class LevelTimer extends Behaviour {
  static props = { id: 'timer' };
  private finished = false;

  start() {
    UI.text(this.props.id, 'Time: 0.0 s', { anchor: 'top-right', fontSize: 26 });
    Game.on('win', () => {
      this.finished = true;
      UI.text(this.props.id, \`Finished in \${Time.time.toFixed(1)} s\`, { anchor: 'top-right', fontSize: 26 });
    });
  }

  update() {
    if (!this.finished) UI.text(this.props.id, \`Time: \${Time.time.toFixed(1)} s\`, { anchor: 'top-right', fontSize: 26 });
  }
}
`,
});
console.log('timer script', JSON.stringify(timer.diagnostics));
await call('component_add', {
  entity: 'HUD',
  component: { type: 'Script', script: 'scripts/level-timer.ts' },
});

console.log('validate', JSON.stringify(await call('scene_validate', {})));
const shot = await call('render_screenshot', { views: ['camera', 'iso'] });
writeFileSync(join(out, 'level.png'), Buffer.from(shot.images[0].data, 'base64'));
console.log('shot', shot.triangles, shot.warnings ?? '');
await host.close();
