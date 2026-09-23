// Manual smoke test: create a temp project, add models, render a screenshot + model preview.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'aige-smoke-'));
const t0 = Date.now();
const host = await ProjectHost.create(dir, { name: 'smoke' });
const call = async (name: string, input: unknown) => {
  const r = await host.call(name, input, 'cli');
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result as any;
};
for (const t of ['coin', 'platform', 'tree', 'blob-character', 'crate', 'flag'])
  await call('model_from_template', { template: t, preview: false });
await call('batch', {
  commands: [
    {
      tool: 'entity_create',
      input: {
        name: 'Player',
        position: [0, 0, 2],
        tags: ['Player'],
        components: [{ type: 'MeshRenderer', model: 'models/blob-character.model.ts' }],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Platform',
        position: [4, 1.5, -3],
        components: [{ type: 'MeshRenderer', model: 'models/platform.model.ts' }],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Coin',
        position: [-2, 1, 0],
        components: [{ type: 'MeshRenderer', model: 'models/coin.model.ts' }],
      },
    },
    { tool: 'entity_duplicate', input: { entity: 'Coin', count: 3, offset: [1.2, 0, -1] } },
    {
      tool: 'entity_create',
      input: {
        name: 'Tree',
        position: [-5, 0, -4],
        components: [{ type: 'MeshRenderer', model: 'models/tree.model.ts' }],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Crate',
        position: [2, 0, 1],
        components: [{ type: 'MeshRenderer', model: 'models/crate.model.ts' }],
      },
    },
    {
      tool: 'entity_create',
      input: {
        name: 'Flag',
        position: [4, 1.5, -4],
        components: [{ type: 'MeshRenderer', model: 'models/flag.model.ts' }],
      },
    },
  ],
});
const shot = await call('render_screenshot', {});
writeFileSync(join(dir, 'shot.png'), Buffer.from(shot.images[0].data, 'base64'));
console.log(
  'screenshot',
  shot.images[0].width,
  shot.images[0].height,
  shot.triangles,
  'tris',
  shot.warnings ?? '',
);
const v = await call('scene_validate', {});
console.log('validate', JSON.stringify(v));
console.log('dir', dir, 'ms', Date.now() - t0);
await host.close();
