// M9 acceptance, phase 1: project + models (run from the repo root).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';

const dir = resolve('examples/coin-platformer');
rmSync(dir, { recursive: true, force: true });
const host = await ProjectHost.create(dir, { name: 'coin-platformer', description: 'Floating-island coin platformer built by an AI through AIGE tools' });
const out = process.env.OUT!;
const call = async (name: string, input: unknown) => {
  const r = await host.call<any>(name, input, 'mcp');
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const island = await call('model_create', { name: 'sky-island', source: readFileSync(join(out, 'sky-island.model.ts'), 'utf8') });
writeFileSync(join(out, 'sky-island.png'), Buffer.from(island.images[0].data, 'base64'));
console.log('sky-island', island.triangles, island.size, island.issues, island.buildMs, 'ms');
const fox = await call('model_from_template', { template: 'creature', name: 'fox' });
writeFileSync(join(out, 'fox.png'), Buffer.from(fox.images[0].data, 'base64'));
console.log('fox', fox.size, fox.params);
for (const t of ['coin', 'flag', 'spike', 'mushroom', 'bush', 'tree-organic', 'flower', 'rock']) {
  const r = await call('model_from_template', { template: t, preview: false });
  console.log(t, r.size.map((n: number) => +n.toFixed(2)), r.triangles);
}
await host.close();
