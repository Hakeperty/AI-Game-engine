import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'aige-tex-'));
const host = await ProjectHost.create(dir, { name: 't' });
const call = async (n: string, i: unknown) => {
  const r = await host.call(n, i, 'cli');
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.result as any;
};
await call('texture_generate', {
  name: 'bricks',
  kind: 'bricks',
  colorA: '#b5563c',
  colorB: '#d8cfc4',
  scale: 6,
});
await call('texture_generate', {
  name: 'grass',
  kind: 'noise',
  colorA: '#4f8f3a',
  colorB: '#7bbf5a',
  scale: 8,
});
await call('material_create', {
  name: 'bricks',
  map: 'textures/bricks.png',
  mapRepeat: [2, 2],
  roughness: 0.9,
});
await call('material_create', {
  name: 'grass',
  map: 'textures/grass.png',
  mapRepeat: [20, 20],
  roughness: 1,
});
await call('component_update', {
  entity: 'Ground',
  type: 'MeshRenderer',
  props: { material: 'materials/grass.material.json', color: '#ffffff' },
});
await call('entity_create', {
  name: 'Wall',
  position: [0, 1, 0],
  scale: [4, 2, 0.5],
  components: [{ type: 'MeshRenderer', primitive: 'box', material: 'materials/bricks.material.json' }],
});
const shot = await call('render_screenshot', { views: ['camera'] });
writeFileSync(join(dir, 'tex.png'), Buffer.from(shot.images[0].data, 'base64'));
console.log(join(dir, 'tex.png'));
await host.close();
