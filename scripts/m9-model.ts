// M9 helper: (re)create one model from a recipe file and save its preview. Usage: node scripts/m9-model.ts <name> <file> <out.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';
const [name, file, png] = process.argv.slice(2) as [string, string, string];
const host = await ProjectHost.open(resolve('examples/coin-platformer'));
const r = await host.call<any>('model_create', { name, source: readFileSync(file, 'utf8') }, 'mcp');
if (!r.ok) console.log(JSON.stringify(r.error));
else {
  writeFileSync(png, Buffer.from(r.result.images[0].data, 'base64'));
  console.log(name, r.result.triangles, r.result.size.map((n: number) => +n.toFixed(2)), r.result.issues, r.result.buildMs, 'ms');
}
await host.close();
