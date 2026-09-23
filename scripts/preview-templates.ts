// Renders iso previews of the given templates into one folder (visual QA).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHost } from '../packages/host/src/index.ts';
const names = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'aige-tpl-'));
const host = await ProjectHost.create(dir, { name: 'tpl' });
for (const t of names) {
  const r = await host.call<any>('model_from_template', { template: t, preview: false }, 'cli');
  if (!r.ok) { console.log(t, 'FAILED', r.error.message); continue; }
  const p = await host.call<any>('model_preview', { model: t, views: ['iso', 'front'], size: 640 }, 'cli');
  if (p.ok) writeFileSync(join(dir, `${t}.png`), Buffer.from(p.result.images[0].data, 'base64'));
  console.log(t, r.result.triangles, 'tris', JSON.stringify(r.result.size.map((n: number) => +n.toFixed(2))));
}
console.log(dir);
await host.close();
