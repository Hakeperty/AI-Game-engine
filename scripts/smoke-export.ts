// Builds a tiny coin game through the tools, play-tests it headlessly, exports it and smoke-tests the web build.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'aige-export-'));
const host = await ProjectHost.create(dir, { name: 'mini-coins' });
const call = async (name: string, input: unknown) => {
  const r = await host.call(name, input, 'cli');
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result as any;
};
const t0 = Date.now();
for (const t of ['blob-character', 'coin', 'platform', 'flag'])
  await call('model_from_template', { template: t, preview: false });
await call('batch', {
  commands: [
    {
      tool: 'entity_create',
      input: {
        name: 'Player',
        tags: ['Player'],
        components: [
          { type: 'MeshRenderer', model: 'models/blob-character.model.ts' },
          { type: 'CharacterController', height: 1.2, radius: 0.45 },
          { type: 'Script', script: 'builtin:PlayerController' },
        ],
      },
    },
    { tool: 'entity_update', input: { entity: 'Main Camera', position: [0, 5, 9] } },
    {
      tool: 'component_add',
      input: { entity: 'Main Camera', component: { type: 'Script', script: 'builtin:FollowCamera' } },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Coin',
        tags: ['Coin'],
        position: [0, 1, -3],
        components: [
          { type: 'MeshRenderer', model: 'models/coin.model.ts' },
          { type: 'Collider', shape: 'sphere', radius: 0.5, isTrigger: true },
          { type: 'Script', script: 'builtin:Collectible' },
          { type: 'Script', script: 'builtin:Bobber' },
        ],
      },
    },
    { tool: 'entity_duplicate', input: { entity: 'Coin', count: 3, offset: [0, 0, -2] } },
    {
      tool: 'entity_create',
      input: {
        name: 'Platform',
        position: [0, 1, -14],
        components: [
          { type: 'MeshRenderer', model: 'models/platform.model.ts', params: { width: 5, depth: 5 } },
          { type: 'Collider', shape: 'auto' },
        ],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Goal',
        position: [0, 1, -14],
        components: [
          { type: 'MeshRenderer', model: 'models/flag.model.ts' },
          { type: 'Collider', shape: 'box', size: [1, 3, 1], offset: [0, 1.5, 0], isTrigger: true },
          {
            type: 'Script',
            script: 'builtin:Goal',
            props: { requireAll: 'Coin', message: 'All coins collected - you win!' },
          },
        ],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'HUD',
        components: [
          { type: 'UIText', id: 'score', text: 'Coins: 0', fontSize: 28 },
          { type: 'Script', script: 'builtin:HudText', props: { id: 'score', format: 'Coins: {score} / 4' } },
        ],
      },
    },
  ],
});
console.log('validate', JSON.stringify((await call('scene_validate', {})).errors));
const play = await call('game_run_headless', {
  seconds: 12,
  inputs: [
    { at: 0, axis: 'move_y', value: 1 },
    { at: 3.4, action: 'jump' },
    { at: 4.0, action: 'jump' },
  ],
  screenshotsAt: [1.5],
});
console.log(
  'play',
  JSON.stringify({
    over: play.over,
    state: play.gameState,
    hud: play.hud,
    errors: play.errors,
    events: play.events.counts,
    probe: Object.values(play.probes)[0],
  }),
);
if (play.images?.[0]) writeFileSync(join(dir, 'play.png'), Buffer.from(play.images[0].data, 'base64'));
const exp = await call('export_web', { title: 'Mini Coins' });
console.log('export', JSON.stringify({ path: exp.absolutePath, files: exp.files, smoke: exp.smoke }));
if (exp.images?.[0]) writeFileSync(join(dir, 'export.png'), Buffer.from(exp.images[0].data, 'base64'));
console.log('dir', dir, 'ms', Date.now() - t0);
await host.close();
